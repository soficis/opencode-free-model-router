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

export default async (ctx: Parameters<Plugin>[0]) => ({
  "chat.message": chatMessage,
  "command.execute.before": commandExecuteBefore,
  "tool.execute.before": toolExecuteBefore,
});

// __APPEND_HANDLERS_BELOW__
