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
// ONE-EXPORT INVARIANT: V1's legacy loader iterates every runtime export and aborts
// the whole load if one is not a function/object with `server` ("Plugin export is not
// a function"). V2 decodes only the default export. This file must therefore stay
// self-contained and keep exactly one runtime export - the default dual entrypoint
// `{ id, setup, server }`. Type-only declarations are erased and safe.
//
// DUAL ENTRYPOINT: V2 calls `setup(ctx)` and ignores `server`; V1 calls `server(ctx)`
// and ignores `setup`. The same file can be installed once at
// <config-dir>/plugins/free-model-router.ts (V1 and V2 both auto-discover it).
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- host adapters (structural types only; no runtime plugin imports) ------
interface V1Context {
  client?: any;
  directory?: string;
  [key: string]: unknown;
}

interface V2Registration {
  dispose(): Promise<void> | void;
}

interface V2Context {
  location?: { directory?: string };
  session: {
    get(input: { sessionID: string }): Promise<any>;
    switchModel(input: {
      sessionID: string;
      model: { providerID: string; id: string; variant?: string };
    }): Promise<any>;
    synthetic(input: {
      sessionID: string;
      text: string;
      description?: string;
      resume?: boolean;
    }): Promise<any>;
    hook(
      name: string,
      callback: (event: any) => Promise<void> | void,
    ): Promise<V2Registration>;
  };
  command: {
    transform(
      callback: (editor: { add(definition: any): void }) => void,
    ): Promise<V2Registration>;
  };
  tool: {
    hook(
      name: string,
      callback: (event: any) => Promise<void> | void,
    ): Promise<V2Registration>;
  };
}

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

// Unsuffixed ids that are free despite lacking the -free suffix.
const FREE_ALLOWLIST: readonly string[] = ["big-pickle"];

// ZDR blocklist (lowercase substrings): free-tier model families documented as
// using prompts for training or logging them beyond zero-retention, per the Zen
// privacy docs (https://opencode.ai/docs/zen, checked 2026-11-07). Everything
// else fails OPEN under zdr-only, matching Zen's stated default (zero-retention
// with no training use, except the named trainers). A blocklist instead of an
// allowlist because free models rotate every few weeks: an allowlist silently
// decays into "paid fallback for everything", while this list only needs an
// edit when a NEW trainer is documented. Tighten it without a code change via
// "zdrBlock": ["extra-substring"] in the project or global config.
const ZDR_BLOCKED_SUBSTRINGS: readonly string[] = [
  "big-pickle", // stealth free: collected data may train the model
  "mimo-v2.5", // free period: collected data may train the model
  "mimo-v2.6", // free period: collected data may train the model
  "inkling", // Thinking Machines free tier: data retained, may be used for monitoring and training
  "ling-", // free tier: collected data may train the model
  "fledge", // free preview: collected data may train the model
  "nemotron", // NVIDIA free endpoints: sessions logged for security/improvement
  "muse-spark", // contributor free: prompts/completions train future Meta models
  "contributor", // any "-contributor-" tier: the program name implies data contribution
  "exo-", // free period: collected data may train the model
  "jev-", // TypeSafe: prompts retained per privacy policy (not zero-retention)
];

/** Built-in family match: `sub` must start at the id or right after a non-alphanumeric
 *  character, so "ling-" blocks "ling-3.0" but not "sterling-x". User "zdrBlock"
 *  entries stay plain substrings (deliberately broad). */
function hasFamilyToken(id: string, sub: string): boolean {
  for (let at = id.indexOf(sub); at !== -1; at = id.indexOf(sub, at + 1)) {
    if (at === 0 || !/[a-z0-9]/.test(id[at - 1])) return true;
  }
  return false;
}

function isZdrSafe(modelID: string, extraBlocked: readonly string[] = []): boolean {
  if (typeof modelID !== "string") return false;
  const id = modelID.toLowerCase();
  for (const sub of ZDR_BLOCKED_SUBSTRINGS) {
    if (hasFamilyToken(id, sub)) return false;
  }
  if (Array.isArray(extraBlocked)) {
    for (const sub of extraBlocked) {
      if (typeof sub === "string" && sub !== "" && id.includes(sub.toLowerCase())) return false;
    }
  }
  return true;
}

// Role -> default free model id; unknown/absent role falls back to "general".
// The build/research family default is a live ZDR-safe flash model; the
// October 2026 default (muse-spark-1.3-contributor-free) is retired from the
// live catalog, and entries missing from the catalog fall through to the
// rest of the free list with a one-per-session warning.
const ROLE_DEFAULT_IDS: Record<string, string> = {
  general: "mimo-v2.6-flash-free",
  build: "deepseek-v4.1-flash-free",
  code: "deepseek-v4.1-flash-free",
  plan: "deepseek-v4.1-flash-free",
  orchestration: "deepseek-v4.1-flash-free",
  subagent: "deepseek-v4.1-flash-free",
  research: "deepseek-v4.1-flash-free",
  writing: "deepseek-v4.1-flash-free",
  // Research family. `explore` is core opencode's recon agent; `explorer` and `librarian`
  // are the OMO slim spellings (slim renamed `explore` -> `explorer` and added a docs-research
  // `librarian`). They are listed as real keys rather than aliases because readPolicyFile
  // warns about any `prefer` role missing here (L1102), so a per-role prefer naming a slim
  // agent must not be rejected as an unknown role.
  explore: "deepseek-v4.1-flash-free",
  explorer: "deepseek-v4.1-flash-free",
  librarian: "deepseek-v4.1-flash-free",
  title: "mimo-v2.6-flash-free",
  compact: "deepseek-v4.1-flash-free",
  summarize: "deepseek-v4.1-flash-free",
};

// Pinned fallback, refreshed 2026-11-09 against the live catalog
// (`opencode models` on both providers plus the Zen endpoint): returned
// (never thrown) when a source fails, times out, or returns a non-2xx.
// The October 2026 snapshot (space-bunny, muse-spark, jev, ling, nemotron)
// is retired from the live catalog and was dropped here; longcat returned as
// longcat-2.5-free and is pinned again on both providers.
const PINNED: FreeCatalog = {
  zen: [
    "beam-free",
    "big-pickle",
    "crouton-alpha-free",
    "deepseek-v4.1-flash-free",
    "flint-40b-free",
    "glm-5.3-flash-free",
    "iceman-free",
    "inkling-2-small-free",
    "longcat-2.5-free",
    "mimo-v2.6-flash-free",
  ],
  go: ["beam-free", "crouton-alpha-free", "iceman-contributor-free", "longcat-2.5-free"],
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

// (isZdrSafe lives next to ZDR_BLOCKED_SUBSTRINGS above.)

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
      // Recursion guard: the spawned `opencode models` loads this same plugin, which would spawn
      // another `opencode models`, forever (fork bomb + leaked loopback listeners, 2026-10-04).
      if (process.env["OPENCODE_FMR_NO_SPAWN"]) throw new Error("child of catalog probe; no recursion");
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
              env: { ...process.env, OPENCODE_FMR_NO_SPAWN: "1" },
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
  void notify(message, sessionID);
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

  // Deliberately not in the spec's candidate list: without this final tier the chain is one
  // entry long when nothing is configured, so a single 429 would strand the session on the
  // paid model instead of walking the rest of the catalog.
  for (const entry of entries) {
    const key = `${entry.providerID}/${entry.modelID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ pick: entry, source: "built-in" });
  }

  let chain = resolved;
  if (zdrOnly) {
    // Blocklist (built-in families plus the project's/global "zdrBlock") fails
    // open: undocumented models route, matching Zen's stated default. Unknown
    // or missing ids never reach this filter (matchSpec already dropped them).
    const extra = policy?.zdrBlock ?? [];
    chain = resolved.filter((c) => isZdrSafe(c.pick.modelID, extra));
    // Only a configured pin or prefer entry is worth naming: dropping the built-in tail tier is
    // the mode working as designed, so warning there would fire on every message of every project.
    const dropped = resolved
      .filter((c) => !isZdrSafe(c.pick.modelID, extra) && c.source !== "built-in")
      .map((c) => c.pick.modelID);
    if (dropped.length > 0) {
      warnOnce(
        sessionID,
        "zdr-only-dropped",
        `free: mode "zdr-only" ignored ${dropped.join(", ")}; those models are not zero-data-retention.`,
      );
    }
    if (chain.length === 0) {
      warnOnce(
        sessionID,
        "zdr-only-exhausted",
        "free: no free model in this session's chain is zero-data-retention; staying on the paid model.",
      );
    }
  }
  return chain;
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

// The ONE shape every 429 failover site uses: rebuild the same ordered chain the picker
// used, then take the first entry this session has not already failed. Sharing it is the
// point - a preference must not be honoured on the first turn and ignored on the next.
async function nextInChain(
  sessionID: string,
  role: string,
  pin: string | null,
  failedIds: string[],
): Promise<Candidate | null> {
  const policy = await getPolicy(sessionID);
  if (policy.mode === "off") return null;
  const candidates = candidateList(await fetchCatalog(), {
    sessionID,
    pin,
    role,
    zdrOnly: policy.mode === "zdr-only",
    policy,
  });
  return firstAvailable(candidates, failedIds);
}

// ---- end inlined lib block -------------------------------------------------

/** Per-session routing state; default mode is "off" (tag-only routing). */
interface SessionState {
  mode: "on" | "off" | "auto";
  /** Reserved for 429 failover: free-model ids already rejected this session. */
  failedIds: string[];
  /** Reserved for command/failover: last non-free model, restored when free chain ends. */
  priorModel: { providerID: string; modelID: string } | null;
  /** V2: the free model this plugin last applied to the session (not a tool stamp). */
  lastApplied?: ModelRef | null;
  /** V2: restore priorModel at idle after a one-shot @free turn. */
  restoreOnIdle?: boolean;
  /** V2: one-shot notice guard after the free chain is exhausted. */
  exhaustedNotified?: boolean;
  /**
   * V2: prompt admission sequence. The session model is global, so two
   * prompts admitted at once would race: each hook captures the counter at
   * entry and skips its switchModel when a newer prompt has since taken
   * ownership. Sequential prompts are unaffected.
   */
  promptSeq?: number;
  /**
   * Subagent sessions: the ancestor whose mode and pin this session follows
   * LIVE, so a later /free off or re-pin in the parent reaches children that
   * already exist (background or resumed). Cleared once /free runs in the
   * child itself.
   */
  inheritFrom?: string;
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

// Subagent sessions carry parentID (session.get): on FIRST touch inherit the
// nearest ancestor's mode AND preferred pin - failedIds, failoverStore and
// priorModel stay per-session. Creating the store entry below is the cache
// (one walk per session); no ancestor state -> "off". seen-set cycle guard,
// depth <= 16, one shared 2s deadline for the whole walk, and the function
// never rejects (hooks contract).
function syncInherited(state: SessionState): void {
  if (state.inheritFrom === undefined) return;
  const ancestor = sessionStore.get(state.inheritFrom);
  if (ancestor === undefined) return;
  // An ancestor that itself inherits is synced first (chains are short and
  // acyclic: inheritFrom always points at an entry that existed earlier).
  syncInherited(ancestor);
  state.mode = ancestor.mode;
  const pin = (ancestor as SessionStateWithPin).preferredId;
  if (pin !== undefined) (state as SessionStateWithPin).preferredId = pin;
  else delete (state as SessionStateWithPin).preferredId;
}

async function resolveSession(sessionID: string): Promise<SessionState> {
  const existing = sessionStore.get(sessionID);
  if (existing !== undefined) {
    syncInherited(existing);
    return existing;
  }
  const deadlineAt = Date.now() + 2000;
  let mode: SessionState["mode"] = "off";
  let pin: string | null = null;
  let from: string | undefined;
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
        // A /free pin is session state, not catalog state: without this the
        // child routes its role default (research -> deepseek-free) instead
        // of the model the user actually pinned.
        pin = (ancestor as SessionStateWithPin).preferredId ?? null;
        from = pid;
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
    if (pin !== null) (state as SessionStateWithPin).preferredId = pin;
    if (from !== undefined) state.inheritFrom = from;
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

  const role = typeof input.agent === "string" && input.agent !== "" ? input.agent : "general";

  let policy: Policy | null = null;
  if (!tagged && state.mode !== "on") {
    if (state.mode !== "auto") return;
    policy = await getPolicy(input.sessionID);
    if (policy.mode === "off" || !effectiveAutoRoles(policy).has(role)) return;
  }
  policy ??= await getPolicy(input.sessionID);

  if (policy.mode === "off") {
    // Project opted out: the tag is still stripped, but nothing routes.
    for (const entry of rewritten) entry.part.text = entry.text;
    return;
  }
  // The full catalog, not scopedCatalog: candidateList does the zdr narrowing itself, so a
  // configured id that exists but is not ZDR-safe is reported as filtered, not as unknown.
  const catalog = await fetchCatalog();
  const candidates = candidateList(catalog, {
    sessionID: input.sessionID,
    pin: requestedId ?? (state as SessionStateWithPin).preferredId ?? null,
    role,
    zdrOnly: policy.mode === "zdr-only",
    policy,
  });
  // First candidate, deliberately NOT filtered by failedIds: with the built-in default the
  // chain is one entry long, so skipping a failed id here would strand every later message
  // on a paid model. Failover owns the skip; see the nextInChain call sites.
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
const FREE_USAGE = "/free on | /free off | /free auto | /free <model-id | provider/model-id>";

function parseFreeArgumentCore(
  arg: string,
): { mode: "on" | "off" | "auto"; pin: string | null } | null {
  if (arg === "") return null;
  const lower = arg.toLowerCase();
  if (FREE_MODES.has(lower)) return { mode: lower as "on" | "off" | "auto", pin: null };
  const slash = arg.indexOf("/");
  if (slash < 0) {
    // Bare model id, e.g. `/free beam-free`: accept anything the free
    // detector recognizes so users don't have to spell the provider.
    // matchSpec resolves it against the catalog (zen first) at pick time.
    if (FREE_ID_SEGMENT.test(arg) && detectFree([arg]).length > 0) return { mode: "on", pin: arg };
    return null;
  }
  if (slash === 0 || slash !== arg.lastIndexOf("/")) return null;
  const provider = arg.slice(0, slash);
  const modelID = arg.slice(slash + 1);
  if (!FREE_ID_SEGMENT.test(provider) || !FREE_ID_SEGMENT.test(modelID)) return null;
  if (FREE_MODES.has(provider.toLowerCase()) || FREE_MODES.has(modelID.toLowerCase())) return null;
  return { mode: "on", pin: `${provider}/${modelID}` };
}

// Git for Windows (MSYS2) rewrites a leading "/free ..." argv element into an
// absolute Windows path before any native process sees it:
//   opencode run "/free opencode-go/beam-free"
// arrives as "C:/Program Files/Git/free opencode-go/beam-free".
// Recover the argument so the CLI keeps working from Git Bash. Only a path
// whose final segment is exactly "free" qualifies, and the recovered tail must
// parse as a real /free argument, so ordinary prompts are left untouched.
function demangleFreeArgument(raw: string): string | null {
  const m = /^[A-Za-z]:[\\/][\s\S]*[\\/]free(?:[ \t]+([\s\S]*))?$/.exec(raw.trim());
  if (m === null) return null;
  const tail = (m[1] ?? "").trim();
  if (tail !== "" && parseFreeArgumentCore(tail) === null) return null;
  return tail;
}

function parseFreeArgument(
  raw: string,
): { mode: "on" | "off" | "auto"; pin: string | null } | null {
  const arg = raw.trim();
  const direct = parseFreeArgumentCore(arg);
  if (direct !== null) return direct;
  const demangled = demangleFreeArgument(arg);
  return demangled === null ? null : parseFreeArgumentCore(demangled);
}

/** Git Bash path mangling is repaired before any /free argument is interpreted. */
function normalizeFreeArgument(raw: string): string {
  const arg = raw.trim();
  const demangled = demangleFreeArgument(arg);
  return demangled === null ? arg : demangled;
}

type SessionStateWithPin = SessionState & { preferredId?: string };

interface FreeCommandStatus {
  text: string;
  policyOff: boolean;
  summary: boolean;
}

/**
 * Shared /free semantics for V1's command hook and V2's native command/prompt
 * fallback. Mutates session state and returns the user-facing status text; the
 * caller owns delivery (V1 replaces prompt parts, V2 emits a synthetic message).
 */
async function freeCommandStatus(sessionID: string, raw: string): Promise<FreeCommandStatus> {
  const state = await resolveSession(sessionID);
  const policy = await getPolicy(sessionID);
  if (policy.mode === "off") {
    return { text: POLICY_OFF_TEXT, policyOff: true, summary: false };
  }
  const arg = normalizeFreeArgument(raw);
  const parsed = parseFreeArgument(arg);
  // /free run inside a subagent session takes ownership of its own mode.
  if (parsed !== null) delete state.inheritFrom;
  const shown = arg.slice(0, 64);
  let text: string;
  let summary = false;
  if (parsed === null) {
    text =
      shown === ""
        ? `free: no argument. Mode unchanged (${state.mode}). Usage: ${FREE_USAGE}.`
        : `free: unknown argument "${shown}". Mode unchanged (${state.mode}). Usage: ${FREE_USAGE}.`;
    if (shown === "") {
      const chain = candidateList(await fetchCatalog(), {
        sessionID,
        pin: (state as SessionStateWithPin).preferredId ?? null,
        role: "general",
        zdrOnly: policy.mode === "zdr-only",
        policy,
      });
      text = `${text} ${formatChain(chain)}`;
      if (state.mode === "auto") text = `${text} ${formatAutoRoles(policy)}`;
      summary = true;
    }
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
    delete (state as SessionStateWithPin).preferredId;
    text = `free mode: auto for this session. ${formatAutoRoles(policy)} Other turns stay on your paid model; @free still routes a single message and /free on routes everything.`;
  }
  return { text, policyOff: false, summary };
}

async function commandExecuteBefore(
  input: CommandBeforeInput,
  output: CommandBeforeOutput,
): Promise<void> {
  if (input.command !== "free") return;
  const raw = typeof input.arguments === "string" ? input.arguments : "";
  const result = await freeCommandStatus(input.sessionID, raw);
  if (result.policyOff) await notify(result.text, input.sessionID);
  else if (result.summary) await notify(await catalogSummary(), input.sessionID);
  // prompt.ts keeps its own reference to this array - replace contents in place.
  output.parts.splice(0, output.parts.length, { type: "text", text: result.text });
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

  // Session gate: off passes through; auto only for allowlisted child roles;
  // an off session never fetches the catalog.
  const state = await resolveSession(input.sessionID);
  if (state.mode === "off") return;

  const policy = await getPolicy(input.sessionID);
  if (policy.mode === "off") return;
  let role: string | undefined;
  if (state.mode === "auto") {
    const raw = output.args !== null && typeof output.args === "object" ? (output.args as { subagent_type?: unknown }).subagent_type : undefined;
    role = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
    if (role === undefined || !effectiveAutoRoles(policy).has(role)) return;
  }
  const chain = candidateList(await fetchCatalog(), {
    sessionID: input.sessionID,
    pin: (state as SessionStateWithPin).preferredId ?? null,
    role,
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
// nextInChain(candidates, failedIds) - cap = catalog length, never a retry
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
// "usage.?limit" covers V2's drain error text, "Free usage limit reached",
// which carries neither the error class name nor a status code.
const RATE_LIMIT_RE = /429|FreeUsageLimitError|usage.?limit|rate.?limit|quota/i;

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
    const next = await nextInChain(
      input.sessionID,
      typeof input.agent === "string" && input.agent !== "" ? input.agent : "general",
      (state as SessionStateWithPin).preferredId ?? null,
      state.failedIds,
    );
    if (next) {
      post.providerID = next.pick.providerID;
      post.modelID = next.pick.modelID;
      fo.current = { providerID: next.pick.providerID, modelID: next.pick.modelID };
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
    const next = await nextInChain(
      input.sessionID,
      "general",
      (state as SessionStateWithPin).preferredId ?? null,
      state.failedIds,
    );
    if (next) {
      (args as { model?: ModelRef }).model = {
        providerID: next.pick.providerID,
        modelID: next.pick.modelID,
      };
      fo.current = { providerID: next.pick.providerID, modelID: next.pick.modelID };
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
    if (await nextInChain(sid, "general", (state as SessionStateWithPin).preferredId ?? null, state.failedIds))
      return; // room left: next route walks there

    // Exhausted: paid-restore event fires exactly once per session, and the
    // notice is shown to the user right here (README: "a notice is produced").
    if (!fo.restored) {
      fo.restored = true;
      fo.restores = 1;
      const prior = state.priorModel;
      fo.notice =
        `free: rate-limited on ${failed} - free candidates exhausted for this session; ` +
        `restored paid model ${prior ? `${prior.providerID}/${prior.modelID}` : "(session default)"}.`;
      await notify(fo.notice, sid);
    }
    fo.current = null;
  } catch {
    // hooks never throw: malformed payloads degrade to a no-op
  }
}

// ---- V2 host adapter + hooks ----------------------------------------------
// V2 has no per-message model field. The prompt hook runs before admission and
// is awaited; switchModel commits SessionEvent.ModelSelected through the durable
// projector before the runner resolves the turn, so awaiting it here routes the
// CURRENT turn. The session model is session-global: concurrent admissions race
// (last prompt hook wins) - documented in the README.

async function v2SessionInfo(sessionID: string): Promise<any | null> {
  try {
    if (!pluginCtx.v2) return null;
    const res: any = await pluginCtx.v2.session.get({ sessionID });
    const data = res?.data ?? res;
    return data !== null && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

async function v2CurrentModel(
  sessionID: string,
  known?: any,
): Promise<ModelRef | null> {
  const info = known !== undefined ? known : await v2SessionInfo(sessionID);
  const m = info?.model;
  if (m === null || typeof m !== "object") return null;
  const providerID = typeof m.providerID === "string" ? m.providerID : "";
  const modelID =
    typeof m.id === "string" ? m.id : typeof m.modelID === "string" ? m.modelID : "";
  return providerID !== "" && modelID !== "" ? { providerID, modelID } : null;
}

async function v2SwitchModel(sessionID: string, pick: ModelRef): Promise<boolean> {
  try {
    if (!pluginCtx.v2) return false;
    await pluginCtx.v2.session.switchModel({
      sessionID,
      model: { providerID: pick.providerID, id: pick.modelID },
    });
    return true;
  } catch {
    return false;
  }
}

async function v2RestoreIfNeeded(
  sessionID: string,
  state: SessionState,
  force = false,
): Promise<boolean> {
  const current = await v2CurrentModel(sessionID);
  if (current === null) return false;
  const applied = state.lastApplied ?? null;
  const ours =
    applied !== null &&
    current.providerID === applied.providerID &&
    current.modelID === applied.modelID;
  const free = detectFree([current.modelID]).length > 0;
  if (!ours && !(force && free)) return false;
  const prior = state.priorModel;
  if (prior === null) {
    state.lastApplied = null;
    state.restoreOnIdle = false;
    return false;
  }
  const ok = await v2SwitchModel(sessionID, prior);
  if (ok) {
    state.lastApplied = null;
    state.restoreOnIdle = false;
    state.exhaustedNotified = false;
  }
  return ok;
}

function v2Role(info: any): string {
  return typeof info?.agent === "string" && info.agent !== "" ? info.agent : "general";
}

// PowerShell's native-argument shim can pass a quoted prompt with the quotes
// still attached. Accept "/free ..." and "\"/free ...\"" as the same command.
function unwrapCommandText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

/** Normalize a textual /free invocation, including Git Bash's rewritten path. */
function freeCommandText(text: string): string | null {
  const trimmed = unwrapCommandText(text);
  if (trimmed === "/free" || trimmed.startsWith("/free ")) return trimmed;
  const demangled = demangleFreeArgument(trimmed);
  if (demangled === null) return null;
  return demangled === "" ? "/free" : `/free ${demangled}`;
}

// Expanded markdown-template detector. When a free.md custom command shadows
// the native V2 registration (config commands activate in `post`, after user
// plugins, and every definition shares one name-keyed map), its `execute`
// never runs and this hook sees the EXPANDED template instead of "/free ...".
// Our free.md opens with "Arguments received: $ARGUMENTS", so the expanded
// prompt opens with "Arguments received: <args>". Returns the <args> text,
// or null when the prompt is not such a template. A hand-typed prompt that
// happens to open with that line is vanishingly rare, and answering it with
// a status echo is benign.
function matchExpandedFreeTemplate(text: string): string | null {
  const firstLine = text.split("\n", 1)[0].trim();
  const prefix = "Arguments received:";
  if (!firstLine.startsWith(prefix)) return null;
  return firstLine.slice(prefix.length).trim();
}

// Shared answer path for every textual /free invocation the prompt hook can
// see: literal "/free ..." (`opencode run`, TUI fallback) and the expanded
// markdown template above. Records mode/pin via freeCommandStatus and turns
// this turn into a status echo so the model never reads it as a task.
async function v2AnswerFreeCommand(
  sessionID: string,
  prompt: { text: string },
  arg: string,
): Promise<void> {
  const result = await freeCommandStatus(sessionID, arg);
  const state = getSession(sessionID);
  if (state.mode === "off" || result.policyOff) await v2RestoreIfNeeded(sessionID, state);
  const status = result.summary ? `${result.text} ${await catalogSummary()}` : result.text;
  // The command already triggered a model turn, so make that turn a clean
  // echo instead of letting the model interpret the status as a task.
  const flat = status.replace(/\s+/g, " ").trim();
  prompt.text = `Do not call any tools. Reply with the quoted status line verbatim and nothing else: ${JSON.stringify(flat)}`;
}

async function v2OnPrompt(event: any): Promise<void> {
  try {
    const sessionID = typeof event?.sessionID === "string" ? event.sessionID : "";
    if (sessionID === "") return;
    const prompt = event?.prompt;
    if (prompt === null || typeof prompt !== "object") return;
    const rawText = typeof prompt.text === "string" ? prompt.text : "";
    // Admission ticket: a newer prompt admitted while this hook awaits its
    // own catalog/policy reads owns the session model, not this one.
    // resolveSession (not getSession): getSession would create the entry as
    // "off" first and poison parentID inheritance for subagent sessions.
    const ticketState = await resolveSession(sessionID);
    ticketState.promptSeq = (ticketState.promptSeq ?? 0) + 1;
    const mySeq = ticketState.promptSeq;
    const parsed = parseFreeTag(rawText);
    if (parsed.clean !== rawText) prompt.text = parsed.clean;
    const tagged = parsed.requestedId !== null || parsed.clean !== rawText;

    // `opencode run` sends "/free ..." as literal prompt text (no slash parser).
    // Handle it here so the CLI has the same command surface as the TUI.
    // freeCommandText also recovers Git Bash's path-rewritten form
    // ("C:/Program Files/Git/free ...").
    const command = freeCommandText(rawText);
    if (command !== null) {
      await v2AnswerFreeCommand(sessionID, prompt, command.slice("/free".length).trim());
      return;
    }

    // A shadowing free.md arrives here as its expanded template (see
    // matchExpandedFreeTemplate). Without this branch the pin never engages
    // and a weak model reads the template as a research task.
    const mdArg = matchExpandedFreeTemplate(rawText);
    if (mdArg !== null) {
      await v2AnswerFreeCommand(sessionID, prompt, mdArg);
      return;
    }

    const state = await resolveSession(sessionID);
    const info = await v2SessionInfo(sessionID);
    const role = v2Role(info);
    const policy = await getPolicy(sessionID);

    if (policy.mode === "off") {
      await v2RestoreIfNeeded(sessionID, state);
      return;
    }

    let shouldRoute = tagged;
    if (!shouldRoute) {
      if (state.mode === "on") shouldRoute = true;
      else if (state.mode === "auto" && effectiveAutoRoles(policy).has(role)) shouldRoute = true;
    }
    if (!shouldRoute) {
      // A one-shot free turn that failed before idle must not leak into this turn.
      if (state.restoreOnIdle || state.lastApplied) await v2RestoreIfNeeded(sessionID, state);
      return;
    }

    const candidates = candidateList(await fetchCatalog(), {
      sessionID,
      pin: parsed.requestedId ?? (state as SessionStateWithPin).preferredId ?? null,
      role,
      zdrOnly: policy.mode === "zdr-only",
      policy,
    });
    const chosen = firstAvailable(candidates, state.failedIds);
    // A newer prompt was admitted while this hook was awaiting: it owns the
    // session model now, so this stale turn switches nothing (and stays
    // silent - the newer prompt reports for itself).
    if ((state.promptSeq ?? 0) !== mySeq) return;
    if (chosen === null) {
      await v2RestoreIfNeeded(sessionID, state, true);
      if (!state.exhaustedNotified) {
        state.exhaustedNotified = true;
        // Not awaited: this runs inside the prompt hook, before admission.
        void notify(
          "free: no free candidate left for this session; using the paid model.",
          sessionID,
        );
      }
      return;
    }

    // Capture the model being replaced, but never overwrite the paid snapshot
    // when the current model is already the free model this plugin applied.
    const current = await v2CurrentModel(sessionID, info);
    const applied = state.lastApplied ?? null;
    const currentIsOurs =
      current !== null &&
      applied !== null &&
      current.providerID === applied.providerID &&
      current.modelID === applied.modelID;
    if (current !== null && !currentIsOurs && detectFree([current.modelID]).length === 0) {
      state.priorModel = current;
    }

    // Re-check ownership right before the commit.
    if ((state.promptSeq ?? 0) !== mySeq) return;
    if (await v2SwitchModel(sessionID, chosen.pick)) {
      state.lastApplied = chosen.pick;
      state.restoreOnIdle = tagged && state.mode !== "on";
      state.exhaustedNotified = false;
    }
  } catch {
    // hooks never throw
  }
}

async function v2OnIdle(event: any): Promise<void> {
  try {
    const sessionID = typeof event?.sessionID === "string" ? event.sessionID : "";
    if (sessionID === "") return;
    const state = sessionStore.get(sessionID);
    if (!state || !state.restoreOnIdle) return;
    await v2RestoreIfNeeded(sessionID, state);
  } catch {
    // hooks never throw
  }
}

/**
 * Shared rate-limit failover: record `failed`, move to the next free candidate,
 * or restore the paid model once the chain is exhausted. Returns true on
 * exhaustion. A stale ticket (newer prompt admitted) records but never switches.
 */
async function v2FailOver(
  sessionID: string,
  state: SessionState,
  failed: string,
  mySeq: number,
): Promise<boolean> {
  if (state.failedIds.indexOf(failed) === -1) state.failedIds.push(failed);
  const info = await v2SessionInfo(sessionID);
  const next = await nextInChain(
    sessionID,
    v2Role(info),
    (state as SessionStateWithPin).preferredId ?? null,
    state.failedIds,
  );
  if (next !== null) {
    if ((state.promptSeq ?? 0) === mySeq && (await v2SwitchModel(sessionID, next.pick)))
      state.lastApplied = next.pick;
    return false;
  }
  const restored = await v2RestoreIfNeeded(sessionID, state, true);
  if (!state.exhaustedNotified) {
    state.exhaustedNotified = true;
    // Not awaited: callers are the retry and tool hooks, which hold the turn.
    void notify(
      `free: rate-limited on ${failed}; free candidates exhausted.${restored ? " Restored the paid model." : ""}`,
      sessionID,
    );
  }
  return true;
}

async function v2OnRetry(event: any): Promise<void> {
  try {
    const sessionID = typeof event?.sessionID === "string" ? event.sessionID : "";
    if (sessionID === "") return;
    const m = event?.model;
    const providerID = typeof m?.providerID === "string" ? m.providerID : "";
    const modelID =
      typeof m?.id === "string" ? m.id : typeof m?.modelID === "string" ? m.modelID : "";
    if (providerID === "" || modelID === "") return;
    const err = event?.error ?? {};
    const errText = `${err.type ?? ""} ${err.message ?? ""} ${err.status ?? ""}`;
    if (err.status !== 429 && !RATE_LIMIT_RE.test(errText)) return;

    const state = await resolveSession(sessionID);
    // Ticket taken after the first suspension: a prompt admitted later owns
    // the session model, so this handler records the failure but switches
    // nothing once it is stale.
    const mySeq = state.promptSeq ?? 0;
    const applied = state.lastApplied ?? null;
    const ours =
      applied !== null &&
      applied.providerID === providerID &&
      applied.modelID === modelID;
    if (!ours && detectFree([modelID]).length === 0) return;

    const exhausted = await v2FailOver(sessionID, state, `${providerID}/${modelID}`, mySeq);
    if (exhausted) event.decision = { retry: false };
  } catch {
    // hooks never throw
  }
}

// V2's native delegation tool. Its input names the child agent `agent` and takes
// `model` as a "provider/model[#variant]" STRING. oh-my-opencode-slim stamps its
// preset model (e.g. "opencode-go/deepseek-v4.1-flash#max") into input.model
// from its own execute.before hook, and only when input.model is not already a
// string. Hook order between plugins is not guaranteed, so this hook always
// overwrites: whichever runs first, the child is created on the free model and
// slim's wrapper sees a string model and preserves it (preserveModel).
const V2_DELEGATION_TOOL = "subagent";

async function v2OnToolBefore(event: any): Promise<void> {
  try {
    const tool = typeof event?.tool === "string" ? event.tool : "";
    const isSubagent = tool.toLowerCase() === V2_DELEGATION_TOOL;
    if (!isSubagent && !DELEGATION_TOOLS.has(tool)) return;
    const sessionID = typeof event?.sessionID === "string" ? event.sessionID : "";
    if (sessionID === "") return;
    const input = event?.input;
    if (input === null || typeof input !== "object") return;
    // Resuming an existing child: its model is session state, and the child's
    // own prompt hook (which inherits mode and pin) routes it.
    if (isSubagent && typeof input.sessionID === "string" && input.sessionID !== "") return;
    const state = await resolveSession(sessionID);
    if (state.mode === "off") return;
    const policy = await getPolicy(sessionID);
    if (policy.mode === "off") return;
    const rawRole = isSubagent ? (input.agent ?? input.subagent_type) : input.subagent_type;
    const childRole =
      typeof rawRole === "string" && rawRole.trim() !== "" ? rawRole.trim() : undefined;
    let role: string | undefined;
    if (state.mode === "auto") {
      role = childRole;
      if (role === undefined || !effectiveAutoRoles(policy).has(role)) return;
    }
    const chain = candidateList(await fetchCatalog(), {
      sessionID,
      pin: (state as SessionStateWithPin).preferredId ?? null,
      role,
      zdrOnly: policy.mode === "zdr-only",
      policy,
    });
    const chosen = firstAvailable(chain, state.failedIds);
    if (chosen === null) return;
    try {
      if (isSubagent) {
        // No #variant: a paid preset's variant (e.g. "max") need not exist on
        // the free model.
        input.model = `${chosen.pick.providerID}/${chosen.pick.modelID}`;
      } else {
        (input as { model?: ModelRef }).model = {
          providerID: chosen.pick.providerID,
          modelID: chosen.pick.modelID,
        };
      }
    } catch {
      // frozen args: best-effort
    }
  } catch {
    // hooks never throw
  }
}

async function v2OnToolAfter(event: any): Promise<void> {
  try {
    if (event?.status !== "error") return;
    const tool = typeof event?.tool === "string" ? event.tool : "";
    if (tool !== "task" && tool.toLowerCase() !== V2_DELEGATION_TOOL && !DELEGATION_TOOLS.has(tool))
      return;
    const sessionID = typeof event?.sessionID === "string" ? event.sessionID : "";
    if (sessionID === "") return;
    if (!RATE_LIMIT_RE.test(harvestFailureText(event?.error))) return;

    const state = await resolveSession(sessionID);
    // Same admission ticket as the retry hook: a newer prompt owns the model.
    const mySeq = state.promptSeq ?? 0;
    const current = await v2CurrentModel(sessionID);
    if (current === null || detectFree([current.modelID]).length === 0) return;
    await v2FailOver(sessionID, state, `${current.providerID}/${current.modelID}`, mySeq);
  } catch {
    // hooks never throw
  }
}

async function v2CommandExecute(input: any): Promise<void> {
  try {
    const sessionID = typeof input?.sessionID === "string" ? input.sessionID : "";
    if (sessionID === "") return;
    const raw = typeof input?.prompt?.text === "string" ? input.prompt.text : "";
    const result = await freeCommandStatus(sessionID, raw);
    const state = getSession(sessionID);
    if (state.mode === "off" || result.policyOff) await v2RestoreIfNeeded(sessionID, state);
    const text = result.summary ? `${result.text} ${await catalogSummary()}` : result.text;
    // Synthetic messages render in the session without waking a model turn.
    await notify(text, sessionID);
  } catch {
    // commands never throw
  }
}

async function v2Setup(ctx: V2Context): Promise<() => Promise<void>> {
  pluginCtx = { kind: "v2", v2: ctx, directory: ctx?.location?.directory };
  const regs: V2Registration[] = [];
  const add = async (
    work: () => Promise<V2Registration> | V2Registration | undefined,
  ): Promise<void> => {
    try {
      const reg = await work();
      if (reg && typeof reg.dispose === "function") regs.push(reg);
    } catch {
      // one unavailable hook must not disable the rest
    }
  };
  await add(() => ctx.session.hook("prompt", v2OnPrompt));
  await add(() => ctx.session.hook("experimental.idle", v2OnIdle));
  await add(() => ctx.session.hook("retry", v2OnRetry));
  await add(() => ctx.tool.hook("execute.before", v2OnToolBefore));
  await add(() => ctx.tool.hook("execute.after", v2OnToolAfter));
  await add(() =>
    ctx.command.transform((editor) => {
      editor.add({
        name: "free",
        description:
          "Flip this session between free and paid model routing (on, off, auto, or model-id | provider/model-id)",
        execute: v2CommandExecute,
      });
    }),
  );
  return async () => {
    for (const reg of regs) {
      try {
        await reg.dispose();
      } catch {
        // best-effort cleanup
      }
    }
  };
}

async function v1Server(ctx: V1Context) {
  pluginCtx = { kind: "v1", client: ctx?.client, directory: ctx?.directory };
  // Startup toast: fire-and-forget so plugin init never waits on discovery.
  void catalogSummary().then((summary) => notify(summary), () => undefined);
  return {
    "chat.message": withChatFailover,
    "command.execute.before": commandExecuteBefore,
    "tool.execute.before": withToolFailover,
    "tool.execute.after": toolExecuteAfter,
  };
}

const plugin = {
  id: "opencode-free-model-router",
  setup: v2Setup,
  server: v1Server,
};

export default plugin;

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
  autoRoles: string[] | null; // null = use DEFAULT_AUTO_ROLES; [] = route nothing
  zdrBlock: string[]; // extra blocked substrings for zdr-only, merged project+global
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

// Roles routed to free models while the session mode is "auto". `chat.message` only
// fires for real user turns, so these are the agents that can actually reach the gate.
// The research family is listed under both host spellings on purpose: core opencode
// registers `explore`, OMO slim registers `explorer` (plus a research-only `librarian`).
// Slim has no `call_omo_agent`/`delegate_task` and delegates through the native `task`
// tool, which toolExecuteBefore skips by design, so a slim subagent is routed by its own
// `chat.message` turn - which only works if its agent name is in this allowlist.
const DEFAULT_AUTO_ROLES: readonly string[] = ["explore", "explorer", "librarian", "research"];
// chat.message never fires for these agents (title/compaction call the LLM directly),
// so listing them can never route anything. Warn instead of silently accepting a dead config.
const UNROUTABLE_AUTO_ROLES = new Set(["title", "compaction", "summary"]);
const POLICY_OFF_TEXT =
  "free: routing is disabled for this project by .opencode/free-model-router.json (mode \"off\"). Nothing was changed.";
const TRAINING_RISK_TEXT =
  "free: free-tier models may use your prompts for training. Add .opencode/free-model-router.json with {\"mode\": \"zdr-only\"} to restrict routing to zero-data-retention models, or \"off\" to disable.";

function emptyPolicy(): Policy {
  return { mode: "all", preferByRole: {}, preferDefault: null, autoRoles: null, zdrBlock: [] };
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

/**
 * `auto.roles` is a bare-array-or-nothing key: only `{"roles": [...]}` is valid, so a
 * mis-written `"auto": ["explore"]` warns instead of silently routing. Role names are
 * case-sensitive exact matches (they are opencode agent names).
 */
function parseAutoRoles(raw: unknown): { roles: string[] | null; invalid: boolean; unroutable: string[] } {
  if (raw === undefined) return { roles: null, invalid: false, unroutable: [] };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { roles: null, invalid: true, unroutable: [] };
  const list = (raw as { roles?: unknown }).roles;
  if (list === undefined) return { roles: null, invalid: false, unroutable: [] };
  if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) return { roles: null, invalid: true, unroutable: [] };
  const roles = [...new Set(list.map((item) => (item as string).trim()).filter((item) => item !== ""))];
  // An all-blank list is a typo, not "route nothing"; only an explicit [] disables routing.
  if (list.length > 0 && roles.length === 0) return { roles: null, invalid: true, unroutable: [] };
  return { roles, invalid: false, unroutable: roles.filter((role) => UNROUTABLE_AUTO_ROLES.has(role)) };
}

interface PolicyFileRead {
  policy: Policy;
  malformed: boolean;
  modeInvalid: boolean;
  preferInvalid: boolean;
  unknownRoles: string[];
  autoInvalid: boolean;
  autoUnroutable: string[];
  zdrBlockInvalid: boolean;
}

function readPolicyFile(file: string): PolicyFileRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { policy: emptyPolicy(), malformed: true, modeInvalid: false, preferInvalid: false, unknownRoles: [], autoInvalid: false, autoUnroutable: [], zdrBlockInvalid: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { policy: emptyPolicy(), malformed: true, modeInvalid: false, preferInvalid: false, unknownRoles: [], autoInvalid: false, autoUnroutable: [], zdrBlockInvalid: false };
  }
  const obj = parsed as { mode?: unknown; prefer?: unknown; auto?: unknown; zdrBlock?: unknown };
  const mode = typeof obj.mode === "string" && POLICY_MODES.has(obj.mode) ? (obj.mode as PolicyMode) : "all";
  const prefer = parsePrefer(obj.prefer);
  const auto = parseAutoRoles(obj.auto);
  const zb = obj.zdrBlock === undefined ? { ids: [] as string[], invalid: false } : toIdList(obj.zdrBlock);
  const unknownRoles = Object.keys(prefer.byRole).filter((role) => !(role in ROLE_DEFAULT_IDS));
  return {
    policy: { mode, preferByRole: prefer.byRole, preferDefault: prefer.fallback, autoRoles: auto.roles, zdrBlock: zb.ids },
    malformed: false,
    modeInvalid: obj.mode !== undefined && mode === "all",
    preferInvalid: prefer.invalid,
    unknownRoles,
    autoInvalid: auto.invalid,
    autoUnroutable: auto.unroutable,
    zdrBlockInvalid: zb.invalid,
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
  if (read.autoInvalid) {
    warns.push(`free: "auto" in ${label} must be {"roles": ["agent-name", ...]}; using the default auto roles.`);
  }
  if (read.autoUnroutable.length > 0) {
    warns.push(
      `free: auto role(s) in ${label} can never route (those agents bypass chat.message): ${read.autoUnroutable.join(", ")}.`,
    );
  }
  if (read.zdrBlockInvalid) {
    warns.push(`free: "zdrBlock" in ${label} must be a string or a list of strings; ignoring it.`);
  }
  return warns;
}

const policyCache = new Map<string, PolicyCacheEntry>();
const sessionMetaCache = new Map<string, { directory: string; parentID: string | null }>();
const toastedSessions = new Set<string>();
let pluginCtx: {
  kind?: "v1" | "v2";
  client?: any;
  directory?: string;
  v2?: V2Context;
} = {};

/**
 * Best-effort user notice; never throws, never blocks longer than 2s.
 * V1: TUI toast when a TUI is attached, otherwise a server-log line (visible
 * in `opencode run` with --print-logs). V2: session.synthetic (resume:false
 * queues it; wake:true makes a user-initiated command visibly produce a
 * reply). No session id => no-op in V2.
 */
/** Race `work` against a timer that is always cleared (no 2s leftover handle). */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function notify(message: string, sessionID?: string, wake = false): Promise<void> {
  try {
    if (pluginCtx.kind === "v2" && pluginCtx.v2) {
      if (typeof sessionID !== "string" || sessionID === "") return;
      await withTimeout(
        pluginCtx.v2.session.synthetic({ sessionID, text: message, resume: wake }),
        2000,
      );
      return;
    }
    const show = pluginCtx.client?.tui?.showToast;
    if (typeof show !== "function") {
      // Headless (e.g. `opencode run`): no TUI to toast, so leave the notice
      // in the server log instead of dropping it silently.
      try {
        console.warn(`[free-model-router] ${message}`);
      } catch {
        // notice is advisory
      }
      return;
    }
    await withTimeout(
      show.call(pluginCtx.client.tui, { body: { message, variant: "info" } }),
      2000,
    );
  } catch {
    // notice is advisory
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
    const v2 = pluginCtx.kind === "v2" ? pluginCtx.v2 : undefined;
    const get = pluginCtx.client?.session?.get;
    let pending: Promise<any> | null = null;
    if (v2) pending = Promise.resolve(v2.session.get({ sessionID }));
    else if (typeof get === "function") {
      pending = Promise.resolve(get.call(pluginCtx.client.session, { path: { id: sessionID } }));
    }
    if (pending !== null) {
      const res: any = await withTimeout(pending, Math.max(0, deadlineAt - Date.now()));
      const data = v2 ? (res?.data ?? res) : res?.data;
      const d = data?.location?.directory ?? data?.directory;
      if (typeof d === "string" && d !== "") dir = d;
      const p = data?.parentID;
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

    // The global file supplies preferences and auto roles: `mode` stays project-scoped so a
    // per-user file can never opt a project out of routing.
    if (gMtimeMs !== -1) {
      const global = readPolicyFile(gFile);
      policy = {
        mode: policy.mode,
        preferByRole: { ...global.policy.preferByRole, ...policy.preferByRole },
        preferDefault: policy.preferDefault ?? global.policy.preferDefault,
        autoRoles: policy.autoRoles ?? global.policy.autoRoles,
        zdrBlock: [...new Set([...global.policy.zdrBlock, ...policy.zdrBlock])],
      };
      warns.push(...policyWarnings(global, "the global free-model-router.json"));
    }

    policyCache.set(sessionID, { dir, mtimeMs, globalPath: gFile, globalMtimeMs: gMtimeMs, policy });
    if (warns.length > 0) {
      toastedSessions.add(sessionID);
      // Fire-and-forget: getPolicy runs inside prompt/tool hooks, and an awaited
      // notice (up to 2s each) would hold up admission of the user's turn.
      void (async () => {
        for (const warn of warns) await notify(warn, sessionID);
      })();
    }
    return policy;
  } catch {
    return emptyPolicy();
  }
}

/** Catalog for this session: narrowed to ZDR-safe ids when the project says zdr-only. */
async function scopedCatalog(sessionID: string) {
  const catalog = await fetchCatalog();
  const policy = await getPolicy(sessionID);
  if (policy.mode !== "zdr-only") return catalog;
  const extra = policy.zdrBlock ?? [];
  return {
    zen: catalog.zen.filter((id) => isZdrSafe(id, extra)),
    go: catalog.go.filter((id) => isZdrSafe(id, extra)),
  };
}

// ---- catalog summary toast (todo 9) ----------------------------------------
const SUMMARY_MAX = 200;

/** One-line free-catalog summary (<= ~200 chars): per-provider counts + first ids. */
// The tail tier is far longer than SUMMARY_MAX, so cap by entry count and say
// how many were elided; truncating mid-id would name a model the user cannot select.
const CHAIN_MAX = 6;

function effectiveAutoRoles(policy: Policy): Set<string> {
  return new Set(policy.autoRoles ?? DEFAULT_AUTO_ROLES);
}

function formatAutoRoles(policy: Policy): string {
  const roles = [...effectiveAutoRoles(policy)];
  return roles.length === 0 ? "Auto routes nothing (auto.roles is empty)." : `Auto routes free for: ${roles.join(", ")}.`;
}

function formatChain(candidates: Candidate[]): string {
  if (candidates.length === 0) return "Candidates: none available right now.";
  const shown = candidates
    .slice(0, CHAIN_MAX)
    .map((c, i) => `${i + 1}. ${c.pick.providerID}/${c.pick.modelID} (${c.source})`)
    .join("; ");
  const rest = candidates.length - CHAIN_MAX;
  return rest > 0 ? `Candidates in order: ${shown}; +${rest} more.` : `Candidates in order: ${shown}.`;
}

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