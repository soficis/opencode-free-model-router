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

export default async (ctx: Parameters<Plugin>[0]) => ({
  "chat.message": chatMessage,
});

// __APPEND_HANDLERS_BELOW__
