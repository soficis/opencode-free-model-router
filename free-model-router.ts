// opencode-free-model-router - plugin entry: chat.message free routing + session state.
//
// DOUBLE-LOAD GUARD (comment by design - accepted limitation, README enforces install):
// opencode evaluates EVERY copy of this file it finds, so installing this plugin in
// both the global (~/.config/opencode/plugins) and a project scope fires two copies.
// Each copy owns an independent module-level session store, so a /free toggle set
// through one copy is invisible to the other and both rewrites run (the second pass
// sees already-stripped text). No runtime globalThis latch here - single-scope
// install is the enforced contract.
import { fetchCatalog, parseFreeTag, pickFree } from "./lib";
import { type Plugin } from "@opencode-ai/plugin";

/** Per-session routing state; default mode is "off" (tag-only routing). */
export interface SessionState {
  mode: "on" | "off" | "auto";
  /** Reserved for 429 failover: free-model ids already rejected this session. */
  failedIds: string[];
  /** Reserved for command/failover: last non-free model, restored when free chain ends. */
  priorModel: { providerID: string; modelID: string } | null;
}

/** Per-session store keyed by chat.message input.sessionID. */
export const sessionStore = new Map<string, SessionState>();

/** Lazily create the default (mode "off") state for a session. */
export function getSession(sessionID: string): SessionState {
  let state = sessionStore.get(sessionID);
  if (!state) {
    state = { mode: "off", failedIds: [], priorModel: null };
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
  const state = getSession(input.sessionID);

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

  const catalog = await fetchCatalog();
  const opts: { preferredId?: string; role?: string } = {};
  if (requestedId !== null) opts.preferredId = requestedId;
  if (typeof input.agent === "string" && input.agent !== "") opts.role = input.agent;
  const picked = pickFree(catalog, opts);

  if (picked) {
    // In place: mutate the EXISTING model object, never rebind output.message.model.
    output.message.model.providerID = picked.providerID;
    output.message.model.modelID = picked.modelID;
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
  const state = getSession(input.sessionID);
  const raw = typeof input.arguments === "string" ? input.arguments : "";
  const parsed = parseFreeArgument(raw);
  const shown = raw.trim().slice(0, 64);
  let text: string;
  if (parsed === null) {
    text =
      shown === ""
        ? `free: no argument. Mode unchanged (${state.mode}). Usage: ${FREE_USAGE}.`
        : `free: unknown argument "${shown}". Mode unchanged (${state.mode}). Usage: ${FREE_USAGE}.`;
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
  const state = getSession(input.sessionID);
  if (state.mode !== "on") return;

  const picked = pickFree(await fetchCatalog());
  if (!picked) return;

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
// stages a notice for the todo-9 toast (this todo never calls showToast).
// failedIds live only in this process's session store: a fresh sessionID
// starts a fresh chain (never persisted across sessions).

import { detectFree, nextCandidate } from "./lib";

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
export interface FailoverState {
  /** Free model this session most recently routed/stamped; null = none active. */
  current: { providerID: string; modelID: string } | null;
  /** One-shot guard: the paid-restore transition fires at most once. */
  restored: boolean;
  /** Paid restores performed this session; the harness asserts this stays 1. */
  restores: number;
  /** Staged notice text for the todo-9 toast (showToast is todo 9's job). */
  notice: string | null;
}

/** SessionID -> failover state; entries are created only on a free route. */
export const failoverStore = new Map<string, FailoverState>();

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
// run, then apply the failover chain to whatever it picked (pickFree itself
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
    const next = nextCandidate(await fetchCatalog(), state.failedIds);
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
    const next = nextCandidate(await fetchCatalog(), state.failedIds);
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
    const catalog = await fetchCatalog();
    const cap = catalog.zen.length + catalog.go.length; // plan: cap = catalog length
    if (state.failedIds.length < cap && state.failedIds.indexOf(failed) === -1) {
      state.failedIds.push(failed);
    }
    if (nextCandidate(catalog, state.failedIds)) return; // room left: next route walks there

    // Exhausted: paid-restore event fires exactly once per session.
    if (!fo.restored) {
      fo.restored = true;
      fo.restores = 1;
      const prior = state.priorModel;
      fo.notice =
        `free: rate-limited on ${failed} - free candidates exhausted for this session; ` +
        `restored paid model ${prior ? `${prior.providerID}/${prior.modelID}` : "(session default)"}.`;
    }
    fo.current = null;
  } catch {
    // hooks never throw: malformed payloads degrade to a no-op
  }
}

export default async (ctx: Parameters<Plugin>[0]) => ({
  "chat.message": withChatFailover,
  "command.execute.before": commandExecuteBefore,
  "tool.execute.before": withToolFailover,
  "tool.execute.after": toolExecuteAfter,
});

// __APPEND_HANDLERS_BELOW__
