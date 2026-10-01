// opencode-free-model-router - plugin entry: chat.message free routing + session state.
//
// DOUBLE-LOAD GUARD (comment by design - accepted limitation, README enforces install):
// opencode evaluates EVERY copy of this file it finds, so installing this plugin in
// both the global (~/.config/opencode/plugins) and a project scope fires two copies.
// Each copy owns an independent module-level session store, so a /free toggle set
// through one copy is invisible to the other and both rewrites run (the second pass
// sees already-stripped text). No runtime globalThis latch here - single-scope
// install is the enforced contract.
//
// ONE-EXPORT INVARIANT: opencode loads every *.ts it finds as a plugin and aborts
// the whole load if the default export is not a function ("Plugin export is not a
// function"). This file must therefore stay self-contained and keep exactly one
// export - the default plugin function.
import { type Plugin } from "@opencode-ai/plugin";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- catalog discovery + pure routing (file-private, zero exports) ---------
// The ONLY network/process I/O in this plugin lives inside fetchCatalog().
// Callers never set reasoningEffort here (never a `max` default on muse-spark
// free ids - leave it unset upstream).
// ---------------------------------------------------------------------------

interface FreeCatalog {
  zen: string[];
  go: string[];
}

type CandidateSource = "pin" | "configured" | "built-in";

interface Candidate {
  pick: ModelPick;
  source: CandidateSource;
}

interface ListOptions {
  /** Session id, used only to hold the "unusable id" warning to once per session. */
  sessionID?: string;
  pin?: string | null;
  role?: string;
  zdrOnly?: boolean;
  policy?: Policy;
}

interface ModelPick {
  providerID: string;
  modelID: string;
}

const ZEN_PROVIDER = "opencode";
const GO_PROVIDER = "opencode-go";
const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const CATALOG_TTL_MS = 60 * 60 * 1000; // 1h cache - idle refresh stays stale-only
const SOURCE_TIMEOUT_MS = 10_000; // every source is bounded; failure degrades to pinned
const MODELS_BIN_ENV = "OPENCODE_FREE_ROUTER_MODELS_BIN";
const DEFAULT_MODELS_BIN = "opencode";

// Unsuffixed ids that are free despite lacking the -free suffix (todo 2 recon).
const FREE_ALLOWLIST: readonly string[] = ["big-pickle"];

// ZDR-safe = space-bunny-free + longcat-2.5-preview-free ONLY, both providers (todo 2).
const ZDR_SAFE_IDS: readonly string[] = ["space-bunny-free", "longcat-2.5-preview-free"];
const ZDR_PREFERRED_ORDER: readonly string[] = ["space-bunny-free", "longcat-2.5-preview-free"];

// Role -> default free model id; unknown/absent role falls back to "general".
const ROLE_DEFAULT_IDS: Record<string, string> = {
  general: "mimo-v2.6-flash-free",
  code: "deepseek-v4-flash-free",
  plan: "deepseek-v4-flash-free",
  orchestration: "deepseek-v4-flash-free",
  subagent: "deepseek-v4-flash-free",
  research: "muse-spark-1.3-contributor-free",
  writing: "muse-spark-1.3-contributor-free",
  title: "mimo-v2.6-flash-free",
  compact: "deepseek-v4-flash-free",
  summarize: "deepseek-v4-flash-free",
};

// Pinned fallback locked by todo 2 recon 2026-09-29: returned (never thrown) when a
// source fails, times out, or returns a non-2xx.
const PINNED: FreeCatalog = {
  zen: [
    "jev-1.13-free",
    "deepseek-v4-flash-free",
    "muse-spark-1.3-contributor-free",
    "muse-spark-1.2-contributor-free",
    "mimo-v2.6-flash-free",
    "space-bunny-free",
    "longcat-2.5-preview-free",
    "mimo-v2.5-free",
    "ling-3.0-flash-fin-free",
    "nemotron-3-ultra-free",
    "nemotron-3.5-lightning-free",
    "big-pickle",
  ],
  go: ["space-bunny-free", "longcat-2.5-preview-free"],
};

interface CatalogCache {
  value: FreeCatalog;
  at: number;
}

let cache: CatalogCache | null = null;
let inflight: Promise<FreeCatalog> | null = null;

function pinnedClone(): FreeCatalog {
  return { zen: [...PINNED.zen], go: [...PINNED.go] };
}

// Rejects after ms regardless of whether the underlying promise ever settles, so a
// signal-ignoring or hung fetch cannot block the caller past the bound.
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("source timeout")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function extractZenIds(body: unknown): string[] {
  const ids: string[] = [];
  const collect = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (typeof item === "string") {
        ids.push(item);
        continue;
      }
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        const id = rec["id"] ?? rec["model"] ?? rec["name"];
        if (typeof id === "string") ids.push(id);
      }
    }
  };
  if (Array.isArray(body)) {
    collect(body);
    return ids;
  }
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    collect(rec["data"] ?? rec["models"] ?? rec["list"]);
  }
  return ids;
}

function parseGoModels(stdout: string): string[] {
  const ids: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const token = line.split(/\s+/)[0] ?? "";
    const slash = token.indexOf("/");
    if (slash <= 0) continue;
    if (token.slice(0, slash) !== GO_PROVIDER) continue;
    const id = token.slice(slash + 1);
    if (id) ids.push(id);
  }
  return ids;
}

function toEntries(catalog: FreeCatalog | null | undefined): ModelPick[] {
  if (!catalog || typeof catalog !== "object") return [];
  const entries: ModelPick[] = [];
  const push = (list: unknown, providerID: string): void => {
    if (!Array.isArray(list)) return;
    for (const id of list) {
      if (typeof id === "string") entries.push({ providerID, modelID: id });
    }
  };
  push(catalog.zen, ZEN_PROVIDER);
  push(catalog.go, GO_PROVIDER);
  return entries;
}

function isZdrSafe(modelID: string): boolean {
  return ZDR_SAFE_IDS.includes(modelID);
}

// Live discovery. Zen = unauthenticated GET of the models endpoint; Go = `opencode models`
// CLI parsing (worker-verified source, todo 2). Module-state TTL cache (>= 1h) plus in-flight
// dedupe; any source failure returns the pinned fallback for that side, never a throw.
async function fetchCatalog(): Promise<FreeCatalog> {
  if (cache && Date.now() - cache.at < CATALOG_TTL_MS) return cache.value;
  if (inflight) return inflight;
  inflight = (async (): Promise<FreeCatalog> => {
    let zen: string[] | null = null;
    let go: string[] | null = null;

    // The only HTTP call in this module.
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
      try {
        const res = await withTimeout(fetch(ZEN_MODELS_URL, { signal: controller.signal }), SOURCE_TIMEOUT_MS);
        if (res.ok) {
          const body: unknown = await withTimeout(res.json(), SOURCE_TIMEOUT_MS);
          zen = detectFree(extractZenIds(body));
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      zen = null;
    }

    // The only process call in this module (opencode models CLI).
    try {
      const envBin = process.env[MODELS_BIN_ENV];
      const bin = envBin && envBin.length > 0 ? envBin : DEFAULT_MODELS_BIN;
      const { execFile } = await import("node:child_process");
      const isWin = process.platform === "win32";
      const command = isWin ? process.env["ComSpec"] ?? "cmd.exe" : bin;
      const args = isWin ? ["/c", bin, "models"] : ["models"];
      const stdout = await withTimeout(
        new Promise<string>((resolve, reject) => {
          execFile(
            command,
            args,
            {
              timeout: SOURCE_TIMEOUT_MS,
              maxBuffer: 4 * 1024 * 1024,
              windowsHide: true,
              encoding: "utf8",
            },
            (err, out) => {
              if (err) reject(err);
              else resolve(String(out));
            },
          );
        }),
        SOURCE_TIMEOUT_MS,
      );
      go = detectFree(parseGoModels(stdout));
    } catch {
      go = null;
    }

    const value: FreeCatalog = {
      zen: zen && zen.length > 0 ? zen : pinnedClone().zen,
      go: go && go.length > 0 ? go : pinnedClone().go,
    };
    cache = { value, at: Date.now() };
    return value;
  })().catch((): FreeCatalog => {
    // Absolute guard: degrade to pinned (and cache it) instead of ever rejecting.
    const value = pinnedClone();
    cache = { value, at: Date.now() };
    return value;
  });
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

// Suffix -free match plus the pinned unsuffixed allowlist (big-pickle).
function detectFree(ids: string[]): string[] {
  if (!Array.isArray(ids)) return [];
  const free: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    if (id.endsWith("-free") || FREE_ALLOWLIST.includes(id)) free.push(id);
  }
  return free;
}

// Resolves one id spec ("id" or "provider/id") against the allowed entries.
// Returns null for an id the catalog does not carry, so callers can skip it.
function matchSpec(allowed: ModelPick[], spec: string): ModelPick | null {
  const slash = spec.indexOf("/");
  const provider = slash > 0 ? spec.slice(0, slash) : "";
  const id = slash > 0 ? spec.slice(slash + 1) : spec;
  return (
    allowed.find((e) => e.modelID === id && (provider.length === 0 || e.providerID === provider)) ?? null
  );
}

// One ordered candidate chain per (session, role): the session pin first, then the user's
// configured prefer list, then the built-in role default. The picker and the 429 failover
// walk this same list, so a preference cannot be honoured on the first turn and silently
// dropped on the next. Unusable ids are dropped with one warning per session so a stale
// config degrades to the next source instead of stranding the user on a paid model.
const warnedSpecs = new Set<string>();

function warnOnce(sessionID: string, key: string, message: string): void {
  const dedupe = `${sessionID}::${key}`;
  if (warnedSpecs.has(dedupe)) return;
  warnedSpecs.add(dedupe);
  void notify(message);
}

function candidateList(catalog: FreeCatalog | null | undefined, opts: ListOptions = {}): Candidate[] {
  const entries = toEntries(catalog);
  if (entries.length === 0) return [];
  const options = opts ?? {};
  const zdrOnly = options.zdrOnly === true;
  const role = typeof options.role === "string" && options.role.length > 0 ? options.role : undefined;
  const policy = options.policy;

  let baseIds: readonly string[];
  let baseSource: CandidateSource;
  const rolePref = policy !== undefined && role !== undefined ? policy.preferByRole[role] : undefined;
  const blanket = policy !== undefined ? policy.preferDefault : null;
  if (Array.isArray(rolePref) && rolePref.length > 0) {
    baseIds = rolePref;
    baseSource = "configured";
  } else if (Array.isArray(blanket) && blanket.length > 0) {
    baseIds = blanket;
    baseSource = "configured";
  } else {
    const roleKey = role !== undefined && ROLE_DEFAULT_IDS[role] !== undefined ? role : "general";
    baseIds = [ROLE_DEFAULT_IDS[roleKey] ?? ROLE_DEFAULT_IDS["general"]];
    baseSource = "built-in";
  }

  const specs: Array<{ spec: string; source: CandidateSource }> = [];
  const pin = typeof options.pin === "string" ? options.pin.trim() : "";
  if (pin.length > 0) specs.push({ spec: pin, source: "pin" });
  for (const id of baseIds) {
    if (typeof id === "string" && id.length > 0) specs.push({ spec: id, source: baseSource });
  }

  const sessionID = typeof options.sessionID === "string" ? options.sessionID : "";
  const resolved: Candidate[] = [];
  const seen = new Set<string>();
  for (const item of specs) {
    const hit = matchSpec(entries, item.spec);
    if (hit === null) {
      warnOnce(sessionID, item.spec, `free: "${item.spec}" is not a free model this router can use; skipping it.`);
      continue;
    }
    const key = `${hit.providerID}/${hit.modelID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ pick: hit, source: item.source });
  }

  let chain = resolved;
  if (zdrOnly) {
    chain = resolved.filter((c) => isZdrSafe(c.pick.modelID));
    if (chain.length === 0) {
      warnOnce(
        sessionID,
        "zdr-only-exhausted",
        "free: no configured model is zero-data-retention; using the built-in ZDR-safe models.",
      );
      for (const id of ZDR_PREFERRED_ORDER) {
        const hit = matchSpec(entries, id);
        if (hit === null) continue;
        const key = `${hit.providerID}/${hit.modelID}`;
        if (seen.has(key)) continue;
        seen.add(key);
        chain.push({ pick: hit, source: "built-in" });
      }
    }
  }
  if (chain.length === 0) return firstCatalogEntry(entries, zdrOnly, seen);
  return chain;
}

// Last rung of the degradation ladder: without it a stale prefer list would send the
// user straight to a paid model instead of to any free one.
function firstCatalogEntry(entries: ModelPick[], zdrOnly: boolean, seen: Set<string>): Candidate[] {
  const pool = zdrOnly ? entries.filter((e) => isZdrSafe(e.modelID)) : entries;
  const first = pool[0];
  if (first === undefined) return [];
  if (seen.has(`${first.providerID}/${first.modelID}`)) return [];
  return [{ pick: first, source: "built-in" }];
}

// First candidate that has not already failed this session, matched bare or
// provider-qualified - the same two-way match the old nextCandidate used.
function firstAvailable(candidates: Candidate[], failedIds: string[]): Candidate | null {
  if (!Array.isArray(candidates)) return null;
  const failed = new Set(Array.isArray(failedIds) ? failedIds.filter((f) => typeof f === "string") : []);
  for (const candidate of candidates) {
    if (failed.has(candidate.pick.modelID)) continue;
    if (failed.has(`${candidate.pick.providerID}/${candidate.pick.modelID}`)) continue;
    return candidate;
  }
  return null;
}

// Splits "@free" (plus optional id token, bare or provider-qualified) off the text. A token
// is only consumed as requestedId when it is a free id (detectFree), so ordinary words that
// merely follow the tag survive in clean untouched.
function parseFreeTag(text: string): { clean: string; requestedId: string | null } {
  if (typeof text !== "string" || text.length === 0) return { clean: "", requestedId: null };
  let requestedId: string | null = null;
  const clean = text
    .replace(/@free(?![A-Za-z0-9_-])(?:\s+|\/)([A-Za-z0-9][A-Za-z0-9._/-]*)/g, (match, id?: string) => {
      if (!id || requestedId !== null) return match;
      const norm = id.replace(/[./_-]+$/, "");
      if (!norm) return match;
      const idPart = norm.indexOf("/") >= 0 ? norm.slice(norm.indexOf("/") + 1) : norm;
      if (detectFree([idPart]).length === 0) return match;
      requestedId = norm;
      return "";
    })
    .replace(/@free(?![A-Za-z0-9_-])[.,;:!?]*/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { clean, requestedId };
}

// First catalog entry (zen order, then go) whose id is not in failedIds - matched bare or
// provider-qualified. Null when exhausted or catalog empty.
function nextCandidate(catalog: FreeCatalog | null | undefined, failedIds: string[]): ModelPick | null {
  const entries = toEntries(catalog);
  if (entries.length === 0) return null;
  const failed = new Set(Array.isArray(failedIds) ? failedIds.filter((f) => typeof f === "string") : []);
  for (const entry of entries) {
    if (failed.has(entry.modelID)) continue;
    if (failed.has(`${entry.providerID}/${entry.modelID}`)) continue;
    return entry;
  }
  return null;
}

// ---- end inlined lib block -------------------------------------------------

/** Per-session routing state; default mode is "off" (tag-only routing). */
interface SessionState {
  mode: "on" | "off" | "auto";
  /** Reserved for 429 failover: free-model ids already rejected this session. */
  failedIds: string[];
  /** Reserved for command/failover: last non-free model, restored when free chain ends. */
  priorModel: { providerID: string; modelID: string } | null;
}

/** Per-session store keyed by chat.message input.sessionID. */
const sessionStore = new Map<string, SessionState>();

/** Lazily create the default (mode "off") state for a session. */
function getSession(sessionID: string): SessionState {
  let state = sessionStore.get(sessionID);
  if (!state) {
    state = { mode: "off", failedIds: [], priorModel: null };
    sessionStore.set(sessionID, state);
  }
  return state;
}

// Subagent sessions carry parentID (session.get): on FIRST touch inherit ONLY the
// nearest ancestor's mode - failedIds, failoverStore and priorModel stay
// per-session. Creating the store entry below is the cache (one walk per session);
// no ancestor state -> "off". seen-set cycle guard, depth <= 16, one shared 2s
// deadline for the whole walk, and the function never rejects (hooks contract).
async function resolveSession(sessionID: string): Promise<SessionState> {
  const existing = sessionStore.get(sessionID);
  if (existing !== undefined) return existing;
  const deadlineAt = Date.now() + 2000;
  let mode: SessionState["mode"] = "off";
  try {
    const seen = new Set<string>([sessionID]);
    let current = sessionID;
    for (let depth = 0; depth < 16; depth++) {
      const meta = await sessionMeta(current, deadlineAt);
      const pid = meta.parentID;
      if (pid === null || seen.has(pid)) break;
      seen.add(pid);
      const ancestor = sessionStore.get(pid);
      if (ancestor !== undefined) {
        mode = ancestor.mode;
        break;
      }
      current = pid;
      if (Date.now() >= deadlineAt) break;
    }
  } catch {
    // already degraded to the default mode
  }
  let state = sessionStore.get(sessionID);
  if (state === undefined) {
    state = { mode, failedIds: [], priorModel: null };
    sessionStore.set(sessionID, state);
  }
  return state;
}

interface ModelRef {
  providerID: string;
  modelID: string;
}

interface ChatMessageInput {
  sessionID: string;
  agent?: string;
  model?: ModelRef;
  messageID?: string;
  variant?: string;
}

interface ChatMessageOutput {
  message: { model: ModelRef; [key: string]: unknown };
  parts: Array<{ type?: unknown; text?: unknown; [key: string]: unknown }>;
}

async function chatMessage(input: ChatMessageInput, output: ChatMessageOutput): Promise<void> {
  const state = await resolveSession(input.sessionID);

  // Pass 1: strip @free from text parts only. Non-text parts are never touched.
  let tagged = false;
  let requestedId: string | null = null;
  const rewritten: Array<{ part: { text?: unknown }; text: string }> = [];
  for (const part of output.parts) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    const parsed = parseFreeTag(part.text);
    if (parsed.clean !== part.text || parsed.requestedId !== null) {
      tagged = true;
      if (requestedId === null) requestedId = parsed.requestedId;
    }
    rewritten.push({ part, text: parsed.clean });
  }

  // Route only on an explicit @free tag or when this session is switched on.
  if (!tagged && state.mode !== "on") return;

  const policy = await getPolicy(input.sessionID);
  if (policy.mode === "off") {
    // Project opted out: the tag is still stripped, but nothing routes.
    for (const entry of rewritten) entry.part.text = entry.text;
    return;
  }
  // The full catalog, not scopedCatalog: candidateList does the zdr narrowing itself, so a
  // configured id that exists but is not ZDR-safe is reported as filtered, not as unknown.
  const catalog = await fetchCatalog();
  const role = typeof input.agent === "string" && input.agent !== "" ? input.agent : "general";
  const candidates = candidateList(catalog, {
    sessionID: input.sessionID,
    pin: requestedId ?? (state as SessionStateWithPin).preferredId ?? null,
    role,
    zdrOnly: policy.mode === "zdr-only",
    policy,
  });
  // First candidate, deliberately NOT filtered by failedIds: with the built-in default the
  // chain is one entry long, so skipping a failed id here would strand every later message
  // on a paid model. Failover owns the skip; see the nextCandidate call sites.
  const chosen = candidates.length > 0 ? candidates[0] : null;

  if (chosen) {
    // In place: mutate the EXISTING model object, never rebind output.message.model.
    output.message.model.providerID = chosen.pick.providerID;
    output.message.model.modelID = chosen.pick.modelID;
  }
  // Strip the tag even when no free candidate exists so @free never reaches the LLM.
  for (const entry of rewritten) entry.part.text = entry.text;
}

interface CommandBeforeInput {
  command: string;
  sessionID: string;
  arguments: string;
}

interface CommandBeforeOutput {
  parts: Array<{ type?: unknown; text?: unknown; [key: string]: unknown }>;
}

const FREE_MODES = new Set(["on", "off", "auto"]);
const FREE_ID_SEGMENT = /^[A-Za-z0-9._-]+$/;
const FREE_USAGE = "/free on | /free off | /free auto | /free <provider/model-id>";

function parseFreeArgument(
  raw: string,
): { mode: "on" | "off" | "auto"; pin: string | null } | null {
  const arg = raw.trim();
  if (arg === "") return null;
  const lower = arg.toLowerCase();
  if (FREE_MODES.has(lower)) return { mode: lower as "on" | "off" | "auto", pin: null };
  const slash = arg.indexOf("/");
  if (slash <= 0 || slash !== arg.lastIndexOf("/")) return null;
  const provider = arg.slice(0, slash);
  const modelID = arg.slice(slash + 1);
  if (!FREE_ID_SEGMENT.test(provider) || !FREE_ID_SEGMENT.test(modelID)) return null;
  if (FREE_MODES.has(provider.toLowerCase()) || FREE_MODES.has(modelID.toLowerCase())) return null;
  return { mode: "on", pin: `${provider}/${modelID}` };
}

type SessionStateWithPin = SessionState & { preferredId?: string };

async function commandExecuteBefore(
  input: CommandBeforeInput,
  output: CommandBeforeOutput,
): Promise<void> {
  if (input.command !== "free") return;
  const state = await resolveSession(input.sessionID);
  if ((await getPolicy(input.sessionID)).mode === "off") {
    output.parts.splice(0, output.parts.length, { type: "text", text: POLICY_OFF_TEXT });
    await notify(POLICY_OFF_TEXT);
    return;
  }
  const raw = typeof input.arguments === "string" ? input.arguments : "";
  const parsed = parseFreeArgument(raw);
  const shown = raw.trim().slice(0, 64);
  let text: string;
  if (parsed === null) {
    text =
      shown === ""
        ? `free: no argument. Mode unchanged (${state.mode}). Usage: ${FREE_USAGE}.`
        : `free: unknown argument "${shown}". Mode unchanged (${state.mode}). Usage: ${FREE_USAGE}.`;
    if (shown === "") await notify(await catalogSummary());
  } else if (parsed.mode === "off") {
    state.mode = "off";
    delete (state as SessionStateWithPin).preferredId;
    text = "free mode: off for this session. Paid model routing restored.";
  } else if (parsed.mode === "on") {
    state.mode = "on";
    if (parsed.pin !== null) (state as SessionStateWithPin).preferredId = parsed.pin;
    text =
      parsed.pin === null
        ? "free mode: on for this session. Messages route to a free model when one is available."
        : `free mode: on for this session. Preferred free model recorded: ${parsed.pin}.`;
  } else {
    state.mode = "auto";
    text =
      "free mode: auto for this session (reserved - no automatic routing; the free tag still routes; use /free on to route without a tag).";
  }
  // prompt.ts keeps its own reference to this array - replace contents in place.
  output.parts.splice(0, output.parts.length, { type: "text", text });
}

interface ToolBeforeInput {
  tool: string;
  sessionID: string;
  callID: string;
}

interface ToolBeforeOutput {
  args: unknown;
}

const DELEGATION_TOOLS = new Set(["call_omo_agent", "delegate_task"]);

async function toolExecuteBefore(
  input: ToolBeforeInput,
  output: ToolBeforeOutput,
): Promise<void> {
  // Core `task` has no `model` param (tool/task.ts#L43-L62, decode strips
  // unknowns tool/tool.ts#L108-L130) so pinned subagents keep their models;
  // unpinned ones inherit the rerouted parent (task.ts#L181-L184).
  if (input.tool === "task") return; // log-skip: recognized, never inject
  // Any other tool (core read/write/bash, OMO absent) is a strict no-op.
  if (!DELEGATION_TOOLS.has(input.tool)) return;

  // Session gate: only "/free on" reroutes delegation; off/auto pass through
  // untouched, and an off session never fetches the catalog.
  const state = await resolveSession(input.sessionID);
  if (state.mode !== "on") return;

  const policy = await getPolicy(input.sessionID);
  if (policy.mode === "off") return;
  const chain = candidateList(await fetchCatalog(), {
    sessionID: input.sessionID,
    zdrOnly: policy.mode === "zdr-only",
    policy,
  });
  if (chain.length === 0) return;
  const picked = chain[0].pick;

  // Stamp onto the EXISTING args object: session/tools.ts#L106-L110 discards
  // the trigger return value, so rebinding output.args would never reach
  // item.execute(args, ...) - only in-place property mutation propagates.
  const args = output.args;
  if (args === null || typeof args !== "object") return; // malformed: no-op, no throw
  try {
    (args as { model?: ModelRef }).model = {
      providerID: picked.providerID,
      modelID: picked.modelID,
    };
  } catch {
    // frozen/non-extensible args: injection is best-effort, hooks never throw.
  }
}

// ---- 429 failover (todo 7) ------------------------------------------------
// Contract (plan todo 7): tool.execute.after output text matching
// 429|FreeUsageLimitError|rate.?limit|quota for the session's current free
// model records it in state.failedIds; every later route walks via
// nextCandidate(catalog, failedIds) - cap = catalog length, never a retry
// loop. Exhaustion restores the session's prior paid model exactly once and
// shows a notice toast in that same turn (the README-promised notice).
// failedIds live only in this process's session store: a fresh sessionID
// starts a fresh chain (never persisted across sessions).

interface ToolAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  args?: unknown;
}

interface ToolAfterOutput {
  title?: unknown;
  output?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

/** Free-tier failure signatures (enforcement: HTTP 429 / FreeUsageLimitError). */
const RATE_LIMIT_RE = /429|FreeUsageLimitError|rate.?limit|quota/i;

/** Failover state kept alongside the todo-4 SessionState, never inside it. */
interface FailoverState {
  /** Free model this session most recently routed/stamped; null = none active. */
  current: { providerID: string; modelID: string } | null;
  /** One-shot guard: the paid-restore transition fires at most once. */
  restored: boolean;
  /** Paid restores performed this session; the harness asserts this stays 1. */
  restores: number;
  /** Notice text shown via notify() on the paid-restore turn; kept for assertions. */
  notice: string | null;
}

/** SessionID -> failover state; entries are created only on a free route. */
const failoverStore = new Map<string, FailoverState>();

function getFailover(sessionID: string): FailoverState {
  let fo = failoverStore.get(sessionID);
  if (!fo) {
    fo = { current: null, restored: false, restores: 0, notice: null };
    failoverStore.set(sessionID, fo);
  }
  return fo;
}

// Depth/breadth-bounded string harvest over the tool.execute.after output so a
// 429 embedded in title/output/metadata at any nesting (circular included) is
// found without throwing or hanging. input.args is NEVER read: hostile tool
// args cannot steer failover.
function harvestFailureText(output: unknown): string {
  const parts: string[] = [];
  let budget = 512;
  let chars = 0;
  const walk = (value: unknown, depth: number): void => {
    if (budget <= 0 || chars > 100_000) return;
    if (typeof value === "string") {
      parts.push(value);
      chars += value.length;
      return;
    }
    if (depth <= 0 || value === null || typeof value !== "object") return;
    budget -= 1;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth - 1);
      return;
    }
    for (const key of Object.keys(value)) walk((value as Record<string, unknown>)[key], depth - 1);
  };
  try {
    walk(output, 3);
  } catch {
    // exotic getter/proxy: treat as having no matchable text
  }
  return parts.join("\n");
}

// chat.message wrapper: snapshot the pre-free model, let the untouched router
// run, then apply the failover chain to whatever it picked (candidateList itself
// has no failedIds knowledge, so a failed first candidate is re-computed here).
async function withChatFailover(input: ChatMessageInput, output: ChatMessageOutput): Promise<void> {
  const pre = {
    providerID: output.message.model.providerID,
    modelID: output.message.model.modelID,
  };
  await chatMessage(input, output);

  const post = output.message.model;
  const routed = post.providerID !== pre.providerID || post.modelID !== pre.modelID;
  if (!routed) {
    // Session is on its own model right now: drop any stale free marker
    // WITHOUT creating store entries for sessions that never route free.
    const stale = failoverStore.get(input.sessionID);
    if (stale) stale.current = null;
    return;
  }

  // A free pick was applied: capture the pre-free (paid) model for restore.
  const state = getSession(input.sessionID);
  if (state.priorModel === null) state.priorModel = { providerID: pre.providerID, modelID: pre.modelID };
  const fo = getFailover(input.sessionID);

  if (state.failedIds.length > 0) {
    const next = nextCandidate(await scopedCatalog(input.sessionID), state.failedIds);
    if (next) {
      post.providerID = next.providerID;
      post.modelID = next.modelID;
      fo.current = { providerID: next.providerID, modelID: next.modelID };
      return;
    }
    // Chain exhausted (cap = catalog length): present the restored paid model.
    // The one-shot restore EVENT (count + notice) fires in toolExecuteAfter;
    // this branch only keeps the message on the paid value.
    const restore = state.priorModel ?? pre;
    post.providerID = restore.providerID;
    post.modelID = restore.modelID;
    fo.current = null;
    return;
  }
  fo.current = { providerID: post.providerID, modelID: post.modelID };
}

// tool.execute.before wrapper: a delegation stamp is also a free model in
// flight, so it must honor failedIds too (otherwise a failed candidate would be
// re-stamped). Non-delegation/mode-off calls are exact no-ops (no fetch).
async function withToolFailover(input: ToolBeforeInput, output: ToolBeforeOutput): Promise<void> {
  const args = output.args;
  const isObj = args !== null && typeof args === "object";
  const pre = isObj ? (args as { model?: ModelRef }).model : undefined;
  const preSnap =
    pre !== null && typeof pre === "object" ? { providerID: pre.providerID, modelID: pre.modelID } : undefined;

  await toolExecuteBefore(input, output);
  if (!isObj) return;

  const after = (args as { model?: ModelRef }).model;
  if (after === pre || after === undefined) return;

  const state = getSession(input.sessionID);
  const fo = getFailover(input.sessionID);

  if (state.failedIds.length > 0) {
    const next = nextCandidate(await scopedCatalog(input.sessionID), state.failedIds);
    if (next) {
      (args as { model?: ModelRef }).model = { providerID: next.providerID, modelID: next.modelID };
      fo.current = { providerID: next.providerID, modelID: next.modelID };
      return;
    }
    // Chain exhausted: undo the stamp - restore the caller's own paid model,
    // or drop the key when there was none (or it was itself a free id).
    try {
      if (preSnap && detectFree([preSnap.modelID]).length === 0) {
        (args as { model?: ModelRef }).model = { providerID: preSnap.providerID, modelID: preSnap.modelID };
      } else {
        delete (args as { model?: ModelRef }).model;
      }
    } catch {
      // frozen args: best-effort, hooks never throw
    }
    fo.current = null;
    return;
  }
  fo.current = { providerID: after.providerID, modelID: after.modelID };
}

// tool.execute.after: the 429/rate-limit signal itself. No-create lookups and
// early returns keep ordinary tool traffic from ever touching the store.
async function toolExecuteAfter(input: ToolAfterInput, output: ToolAfterOutput): Promise<void> {
  try {
    const sid =
      input !== null && typeof input === "object" && typeof input.sessionID === "string"
        ? input.sessionID
        : "";
    if (sid === "") return; // malformed input: no state touched
    const fo = failoverStore.get(sid);
    if (!fo || fo.current === null) return; // no free model in effect -> not "for the current free model"

    const text = harvestFailureText(output);
    if (!RATE_LIMIT_RE.test(text)) return; // non-429 failures must NOT fail over

    const state = getSession(sid);
    const failed = `${fo.current.providerID}/${fo.current.modelID}`;
    const catalog = await scopedCatalog(sid);
    const cap = catalog.zen.length + catalog.go.length; // plan: cap = catalog length
    if (state.failedIds.length < cap && state.failedIds.indexOf(failed) === -1) {
      state.failedIds.push(failed);
    }
    if (nextCandidate(catalog, state.failedIds)) return; // room left: next route walks there

    // Exhausted: paid-restore event fires exactly once per session, and the
    // notice is shown to the user right here (README: "a notice is produced").
    if (!fo.restored) {
      fo.restored = true;
      fo.restores = 1;
      const prior = state.priorModel;
      fo.notice =
        `free: rate-limited on ${failed} - free candidates exhausted for this session; ` +
        `restored paid model ${prior ? `${prior.providerID}/${prior.modelID}` : "(session default)"}.`;
      await notify(fo.notice);
    }
    fo.current = null;
  } catch {
    // hooks never throw: malformed payloads degrade to a no-op
  }
}

export default async (ctx: Parameters<Plugin>[0]) => {
  pluginCtx = ctx as typeof pluginCtx;
  // Startup toast: fire-and-forget so plugin init never waits on discovery.
  void catalogSummary().then(notify, () => undefined);
  return {
    "chat.message": withChatFailover,
    "command.execute.before": commandExecuteBefore,
    "tool.execute.before": withToolFailover,
    "tool.execute.after": toolExecuteAfter,
  };
};

// ---- per-project policy file (todo 8) --------------------------------------
// <project>/.opencode/free-model-router.json = {"mode": "all"|"zdr-only"|"off"}.
// A standalone dotfile (the main config rejects unknown keys with
// ConfigInvalidError). Cached per session, re-validated by mtime on each use.

type PolicyMode = "all" | "zdr-only" | "off";
type RolePreferenceMap = Record<string, string[]>;
interface Policy {
  mode: PolicyMode;
  preferByRole: RolePreferenceMap; // named roles only; `default` / `*` excluded
  preferDefault: string[] | null; // merged catch-all, or null to use the built-in
}
interface PolicyCacheEntry {
  dir: string;
  mtimeMs: number; // -1 = file absent
  globalPath: string;
  globalMtimeMs: number; // -1 = global file absent
  policy: Policy;
}

const POLICY_FILE = join(".opencode", "free-model-router.json");
const GLOBAL_CONFIG_ENV = "OPENCODE_FREE_ROUTER_GLOBAL_CONFIG";
const POLICY_MODES = new Set<string>(["all", "zdr-only", "off"]);
const POLICY_OFF_TEXT =
  "free: routing is disabled for this project by .opencode/free-model-router.json (mode \"off\"). Nothing was changed.";
const TRAINING_RISK_TEXT =
  "free: free-tier models may use your prompts for training. Add .opencode/free-model-router.json with {\"mode\": \"zdr-only\"} to restrict routing to zero-data-retention models, or \"off\" to disable.";

function emptyPolicy(): Policy {
  return { mode: "all", preferByRole: {}, preferDefault: null };
}

/**
 * Resolved at CALL time, never in a module-level const: tests install the
 * OPENCODE_FREE_ROUTER_GLOBAL_CONFIG override after this module is imported,
 * and a frozen const would silently ignore it.
 */
function globalConfigPath(): string {
  const override = process.env[GLOBAL_CONFIG_ENV];
  if (typeof override === "string" && override !== "") return override;
  return join(homedir(), ".config", "opencode", "free-model-router.json");
}

function toIdList(raw: unknown): { ids: string[]; invalid: boolean } {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return { ids: trimmed === "" ? [] : [trimmed], invalid: false };
  }
  if (Array.isArray(raw)) {
    const ids: string[] = [];
    let invalid = false;
    for (const item of raw) {
      if (typeof item !== "string") {
        invalid = true;
        continue;
      }
      const trimmed = item.trim();
      if (trimmed !== "") ids.push(trimmed);
    }
    return { ids, invalid };
  }
  return { ids: [], invalid: true };
}

/** `prefer` accepts a string, an ordered list, or a per-role object; `default`/`*` is the catch-all. */
function parsePrefer(raw: unknown): { byRole: RolePreferenceMap; fallback: string[] | null; invalid: boolean } {
  if (raw === undefined) return { byRole: {}, fallback: null, invalid: false };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    const flat = toIdList(raw);
    return { byRole: {}, fallback: flat.ids.length === 0 ? null : flat.ids, invalid: flat.invalid };
  }
  const byRole: RolePreferenceMap = {};
  let fallback: string[] | null = null;
  let invalid = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = toIdList(value);
    if (parsed.invalid) invalid = true;
    if (parsed.ids.length === 0) continue;
    if (key === "default" || key === "*") fallback = parsed.ids;
    else byRole[key] = parsed.ids;
  }
  return { byRole, fallback, invalid };
}

interface PolicyFileRead {
  policy: Policy;
  malformed: boolean;
  modeInvalid: boolean;
  preferInvalid: boolean;
  unknownRoles: string[];
}

function readPolicyFile(file: string): PolicyFileRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { policy: emptyPolicy(), malformed: true, modeInvalid: false, preferInvalid: false, unknownRoles: [] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { policy: emptyPolicy(), malformed: true, modeInvalid: false, preferInvalid: false, unknownRoles: [] };
  }
  const obj = parsed as { mode?: unknown; prefer?: unknown };
  const mode = typeof obj.mode === "string" && POLICY_MODES.has(obj.mode) ? (obj.mode as PolicyMode) : "all";
  const prefer = parsePrefer(obj.prefer);
  const unknownRoles = Object.keys(prefer.byRole).filter((role) => !(role in ROLE_DEFAULT_IDS));
  return {
    policy: { mode, preferByRole: prefer.byRole, preferDefault: prefer.fallback },
    malformed: false,
    modeInvalid: obj.mode !== undefined && mode === "all",
    preferInvalid: prefer.invalid,
    unknownRoles,
  };
}

function policyWarnings(read: PolicyFileRead, label: string): string[] {
  const warns: string[] = [];
  if (read.malformed || read.modeInvalid) {
    warns.push(`free: ${label} is invalid (expected {"mode": "all"|"zdr-only"|"off"}); using mode "all".`);
  }
  if (read.preferInvalid) {
    warns.push(`free: "prefer" in ${label} is not a string, a list of strings, or a per-role object; ignoring it.`);
  }
  if (read.unknownRoles.length > 0) {
    warns.push(`free: unknown role(s) in "prefer" in ${label} ignored: ${read.unknownRoles.join(", ")}.`);
  }
  return warns;
}

const policyCache = new Map<string, PolicyCacheEntry>();
const sessionMetaCache = new Map<string, { directory: string; parentID: string | null }>();
const toastedSessions = new Set<string>();
let pluginCtx: { client?: any; directory?: string } = {};

/** Best-effort TUI toast; never throws, never blocks longer than 2s. */
async function notify(message: string): Promise<void> {
  try {
    const show = pluginCtx.client?.tui?.showToast;
    if (typeof show !== "function") return;
    await Promise.race([
      show.call(pluginCtx.client.tui, { body: { message, variant: "info" } }),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  } catch {
    // toast is advisory
  }
}

// One session.get per session (cached) yields BOTH the project directory (policy)
// and parentID (inheritance walk). The deadline bounds the API call so a hung
// client cannot stall a hook; on timeout/error we degrade to the plugin directory
// with no parent - never reject, cache the fallback so we do not retry forever.
async function sessionMeta(sessionID: string, deadlineAt: number): Promise<{ directory: string; parentID: string | null }> {
  const cached = sessionMetaCache.get(sessionID);
  if (cached !== undefined) return cached;
  let dir = typeof pluginCtx.directory === "string" ? pluginCtx.directory : process.cwd();
  let parentID: string | null = null;
  try {
    const get = pluginCtx.client?.session?.get;
    if (typeof get === "function") {
      const budget = Math.max(0, deadlineAt - Date.now());
      const res: any = await Promise.race([
        get.call(pluginCtx.client.session, { path: { id: sessionID } }),
        new Promise((resolve) => setTimeout(resolve, budget)),
      ]);
      const d = res?.data?.directory;
      if (typeof d === "string" && d !== "") dir = d;
      const p = res?.data?.parentID;
      if (typeof p === "string" && p !== "") parentID = p;
    }
  } catch {
    // fall back to the plugin's directory, no parent
  }
  const meta = { directory: dir, parentID };
  sessionMetaCache.set(sessionID, meta);
  return meta;
}

/** Resolve the merged policy for a session (mtime-gated cache, never throws). */
async function getPolicy(sessionID: string): Promise<Policy> {
  try {
    const dir = (await sessionMeta(sessionID, Date.now() + 2000)).directory;
    const file = join(dir, POLICY_FILE);
    const gFile = globalConfigPath();
    let mtimeMs = -1;
    let gMtimeMs = -1;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      // absent
    }
    try {
      gMtimeMs = statSync(gFile).mtimeMs;
    } catch {
      // absent
    }
    const hit = policyCache.get(sessionID);
    if (
      hit &&
      hit.dir === dir &&
      hit.mtimeMs === mtimeMs &&
      hit.globalPath === gFile &&
      hit.globalMtimeMs === gMtimeMs
    ) {
      return hit.policy;
    }
    const warns: string[] = [];
    let policy = emptyPolicy();
    if (mtimeMs === -1) {
      if (!toastedSessions.has(sessionID)) warns.push(TRAINING_RISK_TEXT);
    } else {
      const read = readPolicyFile(file);
      policy = read.policy;
      warns.push(...policyWarnings(read, POLICY_FILE));
    }

    // The global file supplies preferences only: `mode` stays project-scoped so a
    // per-user file can never opt a project out of routing.
    if (gMtimeMs !== -1) {
      const global = readPolicyFile(gFile);
      policy = {
        mode: policy.mode,
        preferByRole: { ...global.policy.preferByRole, ...policy.preferByRole },
        preferDefault: policy.preferDefault ?? global.policy.preferDefault,
      };
      warns.push(...policyWarnings(global, "the global free-model-router.json"));
    }

    policyCache.set(sessionID, { dir, mtimeMs, globalPath: gFile, globalMtimeMs: gMtimeMs, policy });
    if (warns.length > 0) {
      toastedSessions.add(sessionID);
      for (const warn of warns) await notify(warn);
    }
    return policy;
  } catch {
    return emptyPolicy();
  }
}

/** Catalog for this session: narrowed to ZDR-safe ids when the project says zdr-only. */
async function scopedCatalog(sessionID: string) {
  const catalog = await fetchCatalog();
  if ((await getPolicy(sessionID)).mode !== "zdr-only") return catalog;
  return { zen: catalog.zen.filter(isZdrSafe), go: catalog.go.filter(isZdrSafe) };
}

// ---- catalog summary toast (todo 9) ----------------------------------------
const SUMMARY_MAX = 200;

/** One-line free-catalog summary (<= ~200 chars): per-provider counts + first ids. */
async function catalogSummary(): Promise<string> {
  try {
    const c = await fetchCatalog();
    const fmt = (label: string, ids: string[]) => `${label} ${ids.length}${ids.length ? ` (${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ", ..." : ""})` : ""}`;
    const text = `free models: ${fmt("opencode", c.zen)}; ${fmt("opencode-go", c.go)}`;
    return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 3)}...` : text;
  } catch {
    return "free models: catalog unavailable";
  }
}

// __APPEND_HANDLERS_BELOW__