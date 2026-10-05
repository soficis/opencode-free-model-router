// Smoke suite. Section 1 = hook-driven equivalents of the former lib.ts unit checks
// (the plugin exposes exactly ONE export, so the suite drives the default export's
// hook surface with a stub ctx/client); section 2 = hook-level 429 failover;
// section 3 = parentID mode inheritance. Run: bun test/smoke.test.ts.
import pluginFn from "../free-model-router";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string): void {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
}

// Test-side oracle for the free-id rule: -free suffix or the pinned unsuffixed
// allowlist. Stated here so the suite never imports plugin internals.
const isFreeId = (id: string): boolean => id.endsWith("-free") || id === "big-pickle";

// ---- Section 1 setup: both catalog sources fail, so fetchCatalog() -------
// deterministically returns the pinned list - zero network/CLI.
process.env["OPENCODE_FREE_ROUTER_MODELS_BIN"] = "fmr-test-no-such-binary";
process.env["OPENCODE_FREE_ROUTER_GLOBAL_CONFIG"] = join(process.cwd(), "test", "fixtures", "no-such-global-config.json");
globalThis.fetch = () => Promise.reject(new Error("offline test stub"));

const PAID = { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" };
const PROJ = join(process.cwd(), "test");
const toasts: string[] = [];
const sessionParents = new Map<string, string | undefined>();
const sessionDirs = new Map<string, string>();
const sessionGets = new Map<string, number>();
let callSeq = 0;

const ctx = {
  directory: PROJ,
  client: {
    tui: {
      showToast: async (a: { body?: { message?: unknown } }): Promise<void> => {
        toasts.push(String(a?.body?.message ?? ""));
      },
    },
    session: {
      get: async (a: { path?: { id?: string } }): Promise<{ data: { id?: string; directory?: string; parentID?: string } }> => {
        const id = String(a?.path?.id ?? "");
        sessionGets.set(id, (sessionGets.get(id) ?? 0) + 1);
        return { data: { id, directory: sessionDirs.get(id) ?? PROJ, parentID: sessionParents.get(id) } };
      },
    },
  },
};

const hooks = await pluginFn(ctx as unknown as Parameters<typeof pluginFn>[0]);

const modelKey = (m: { providerID: string; modelID: string }): string => `${m.providerID}/${m.modelID}`;

async function routeOnce(sessionID: string, text: string, opts?: { agent?: string }) {
  const out = {
    message: { model: { providerID: PAID.providerID, modelID: PAID.modelID } },
    parts: [{ type: "text", text }],
  };
  // Only set the key when asked: an omitted opts must leave the hook input byte-identical.
  const input: { sessionID: string; agent?: string } = { sessionID };
  if (opts !== undefined && opts.agent !== undefined) input.agent = opts.agent;
  await hooks["chat.message"](input, out);
  return { model: out.message.model, text: String(out.parts[0]?.text ?? "") };
}

async function toolAfter(sessionID: string, body: string): Promise<void> {
  callSeq += 1;
  await hooks["tool.execute.after"]({ tool: "bash", sessionID, callID: `c${callSeq}` }, { output: body });
}

async function freeOn(sessionID: string): Promise<void> {
  await hooks["command.execute.before"]({ command: "free", sessionID, arguments: "on" }, { parts: [] });
}

async function freeOff(sessionID: string): Promise<void> {
  await hooks["command.execute.before"]({ command: "free", sessionID, arguments: "off" }, { parts: [] });
}

// ---- Section 1: tag parsing, free-id detection, candidate selection -------
// Each check observes the hook surface only: the rewritten message text proves
// what parseFreeTag/detectFree consumed, the chosen model proves what pickFree
// selected.

const keep = await routeOnce("p-keep", "@free nemotron-3.5-lightning-free do it");
check(keep.text === "do it", "detectFree keeps -free ids");

const drop = await routeOnce("p-drop", "@free mimo-v2.6-flash do it");
check(drop.text === "mimo-v2.6-flash do it", "detectFree drops paid ids");

const bare = await routeOnce("p-empty", "@free");
check(bare.text === "" && modelKey(bare.model) === "opencode/mimo-v2.6-flash-free", "detectFree empty");

const anyPick = await routeOnce("p-pick", "@free ping");
check(modelKey(anyPick.model) !== modelKey(PAID) && isFreeId(anyPick.model.modelID), "pickFree returns a pick");

const pref = await routeOnce("p-pref", "@free ling-3.0-flash-fin-free x");
check(pref.model.modelID === "ling-3.0-flash-fin-free", "pickFree honors preferredId");

const pin = await routeOnce("p-pinf", "@free opencode-go/space-bunny-free x");
check(pin.model.providerID === "opencode-go" && pin.model.modelID === "space-bunny-free", "pickFree provider-qualified pin");

// Project policy zdr-only: a non-ZDR request must fall through to a ZDR-safe id.
sessionDirs.set("p-zdr", join(PROJ, "fixtures", "zdr-only"));
const zdr = await routeOnce("p-zdr", "@free muse-spark-1.3-contributor-free x");
check(["opencode/space-bunny-free", "opencode/longcat-2.5-preview-free", "opencode-go/space-bunny-free", "opencode-go/longcat-2.5-preview-free"].includes(modelKey(zdr.model)), "zdrOnly restricts to ZDR-safe ids");

const allMode = await routeOnce("p-all", "@free muse-spark-1.3-contributor-free x");
check(allMode.model.modelID === "muse-spark-1.3-contributor-free", "zdrOnly false = all mode");

// NextCandidate returns null once every scoped (ZDR-safe) id is in failedIds,
// and that null is what restores the paid model -- assert on that outcome.
sessionDirs.set("p-zdr-ex", join(PROJ, "fixtures", "zdr-only"));
await freeOn("p-zdr-ex");
let zdrExhausted: string | null = null;
for (let i = 0; i < 25; i++) {
  const r = await routeOnce("p-zdr-ex", "loop");
  if (modelKey(r.model) === modelKey(PAID)) {
    zdrExhausted = modelKey(r.model);
    break;
  }
  await toolAfter("p-zdr-ex", "HTTP 429 Too Many Requests");
}
check(zdrExhausted === modelKey(PAID), "zdrOnly with no safe id left -> no free pick");

const stripped = await routeOnce("p-strip", "@free do it");
check(stripped.text === "do it", "parseFreeTag strips tag");

const captured = await routeOnce("p-caps", "@free jev-1.13-free now");
check(captured.text === "now" && captured.model.modelID === "jev-1.13-free", "parseFreeTag captures free id");

const noop = await routeOnce("p-noop", "no tag here");
check(noop.text === "no tag here" && modelKey(noop.model) === modelKey(PAID), "parseFreeTag no-op without tag");

// ---- Section 2: hook-level 429 failover (real plugin hooks, pinned catalog) ----
const sidA = "fail-a";
const a1 = await routeOnce(sidA, "@free ping");
check(modelKey(a1.model) !== modelKey(PAID) && isFreeId(a1.model.modelID), "A: @free routes the message to a free model");
check(a1.text === "ping", "A: @free tag is stripped before the model sees the prompt");
await toolAfter(sidA, "HTTP 429 Too Many Requests");
const a2 = await routeOnce(sidA, "@free ping");
check(modelKey(a2.model) !== modelKey(a1.model), "A: 429 failover moves off the failed candidate");
check(isFreeId(a2.model.modelID), "A: the failover candidate is still free");
check(a2.text === "ping", "A: tag stripped on the failover turn too");

// The failover walk restarts at the first pinned entry, then steps forward.
check(modelKey(a2.model) === "opencode/jev-1.13-free", "nextCandidate first pick");
await toolAfter(sidA, "HTTP 429 Too Many Requests");
const a3 = await routeOnce(sidA, "@free ping");
check(a3.model.modelID === "muse-spark-1.3-contributor-free" && modelKey(a3.model) !== modelKey(a2.model), "nextCandidate excludes failed id");

let exhausted: string | null = null;
for (let i = 0; i < 25; i++) {
  const r = await routeOnce(sidA, "@free ping");
  if (modelKey(r.model) === modelKey(PAID)) {
    exhausted = modelKey(r.model);
    break;
  }
  await toolAfter(sidA, "HTTP 429 Too Many Requests");
}
check(exhausted === modelKey(PAID), "nextCandidate exhausted -> null");

const rateBodies = [
  "HTTP 429 Too Many Requests",
  "FreeUsageLimitError: free usage limit reached",
  "rate limit exceeded, retry after 30s",
  "rate-limit backoff required",
  "provider quota exhausted",
];
for (const [i, body] of rateBodies.entries()) {
  const sid = `fail-b-${i}`;
  const first = await routeOnce(sid, "@free go");
  await toolAfter(sid, body);
  const second = await routeOnce(sid, "@free go");
  const changed = modelKey(second.model) !== modelKey(first.model);
  const stillFree = isFreeId(second.model.modelID);
  check(changed && stillFree, `B: "${body}" triggers a free-to-free failover`);
}

const sidN = "fail-neg";
const neg1 = await routeOnce(sidN, "@free go");
await toolAfter(sidN, "Error: connect ECONNREFUSED 127.0.0.1:1");
const neg2 = await routeOnce(sidN, "@free go");
check(modelKey(neg2.model) === modelKey(neg1.model), "B: a non-rate-limit failure does not fail over");

const sidC = "fail-c";
await freeOn(sidC);
const c1 = await routeOnce(sidC, "mode on needs no tag");
check(modelKey(c1.model) !== modelKey(PAID) && isFreeId(c1.model.modelID), "C: /free on routes an untagged message");

let restored: string | null = null;
for (let i = 0; i < 25; i++) {
  const r = await routeOnce(sidC, "loop");
  if (modelKey(r.model) === modelKey(PAID)) {
    restored = modelKey(r.model);
    break;
  }
  await toolAfter(sidC, "HTTP 429 Too Many Requests");
}
check(restored === modelKey(PAID), "C: paid model restored once every free candidate is exhausted");
check(toasts.some((t) => t.includes("free candidates exhausted")), "C: exhaustion notice reaches the user");
const c2 = await routeOnce(sidC, "after restore");
check(modelKey(c2.model) === modelKey(PAID), "C: paid restore sticks on later turns");

const d1 = await routeOnce("fail-d", "@free after exhaustion");
check(modelKey(d1.model) === modelKey(a1.model), "D: a fresh session ignores another session's failedIds");

// ---- Section 3: parentID mode inheritance (subagent sessions) ----
const parE = "inherit-par-e";
sessionParents.set("child-e", parE);
await freeOn(parE);
const e1 = await routeOnce("child-e", "untagged child turn");
check(modelKey(e1.model) !== modelKey(PAID) && isFreeId(e1.model.modelID), "E: child session inherits parent's /free on");
const eGets = sessionGets.get("child-e") ?? 0;
await routeOnce("child-e", "second child turn");
check((sessionGets.get("child-e") ?? 0) === eGets, "E: session.get is called once per session (meta cached)");

sessionParents.set("child-gc", "child-e");
const gc1 = await routeOnce("child-gc", "untagged grandchild turn");
check(modelKey(gc1.model) !== modelKey(PAID) && isFreeId(gc1.model.modelID), "E: grandchild inherits through a chain (parent of parent)");

sessionParents.set("child-off", "inherit-par-off");
await freeOn("inherit-par-off");
await freeOff("inherit-par-off");
const offChild = await routeOnce("child-off", "untagged child of off parent");
check(modelKey(offChild.model) === modelKey(PAID), "E: child of a /free off parent stays on the paid model");

sessionParents.set("child-ghost", "never-created-parent");
const ghost = await routeOnce("child-ghost", "untagged child of missing parent");
check(modelKey(ghost.model) === modelKey(PAID), "E: missing/deleted parent resolves to off (no throw)");

sessionParents.set("cycle-a", "cycle-b");
sessionParents.set("cycle-b", "cycle-a");
const cycleStart = Date.now();
const cyc = await routeOnce("cycle-a", "untagged cycle turn");
const cycleMs = Date.now() - cycleStart;
check(modelKey(cyc.model) === modelKey(PAID) && cycleMs < 1900, "E: parent cycle terminates within the 2s deadline");

const POLICY_OFF_DIR = join(PROJ, "fixtures", "policy-off");
sessionDirs.set("child-policy-off", POLICY_OFF_DIR);
sessionParents.set("child-policy-off", parE);
const polOff = await routeOnce("child-policy-off", "untagged policy-off turn");
check(modelKey(polOff.model) === modelKey(PAID) && polOff.text === "untagged policy-off turn", "E: project policy off beats inherited mode on");

const parF = "inherit-par-f";
sessionParents.set("child-f", parF);
await freeOn(parF);
const fParent1 = await routeOnce(parF, "@free parent first");
await toolAfter(parF, "HTTP 429 Too Many Requests");
const childF1 = await routeOnce("child-f", "@free child first");
check(modelKey(childF1.model) === modelKey(fParent1.model), "E: child does not inherit parent's failedIds (fresh chain)");

// ---- Section 4: prefer (global + project, merged per role) -----------------
// Fixture ids must exist in the plugin's PINNED catalog: prefer-ids use
// opencode/mimo-v2.5-free and opencode-go/space-bunny-free and
// opencode-go/longcat-2.5-preview-free. Every message carries the bare
// "@free" tag so the tag parser cannot also capture a requestedId pin.
const GLOBAL_DIR = join(PROJ, "fixtures", "prefer-global");
const globalRoles = join(GLOBAL_DIR, "free-model-router.json"); // {"prefer":{"research":...}}
const globalBlanket = join(GLOBAL_DIR, "blanket.json"); // {"prefer":"opencode/jev-1.13-free"}
const globalEdit = join(GLOBAL_DIR, "edit.json"); // rewritten mid-test, then restored

// The global path is read at call time inside getPolicy, so the override has
// to stay installed for the whole awaited body - a synchronous restore would
// tear it down before the hook ever read it.
async function withGlobalConfig<T>(path: string, body: () => Promise<T>): Promise<T> {
  const prev = process.env.OPENCODE_FREE_ROUTER_GLOBAL_CONFIG;
  process.env.OPENCODE_FREE_ROUTER_GLOBAL_CONFIG = path;
  try {
    return await body();
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_FREE_ROUTER_GLOBAL_CONFIG;
    else process.env.OPENCODE_FREE_ROUTER_GLOBAL_CONFIG = prev;
  }
}

const preferStringDir = join(PROJ, "fixtures", "prefer-string");
const preferListDir = join(PROJ, "fixtures", "prefer-list");
const preferRolesDir = join(PROJ, "fixtures", "prefer-roles");
const preferBadDir = join(PROJ, "fixtures", "prefer-badjson");

const strDir = "prefer-string-sid";
sessionDirs.set(strDir, preferStringDir);
const pString = await routeOnce(strDir, "@free say hi", { agent: "general" });
check(modelKey(pString.model) === "opencode/mimo-v2.5-free", "D: a string prefer routes to that model");

const listDir = "prefer-list-sid";
sessionDirs.set(listDir, preferListDir);
const pList = await routeOnce(listDir, "@free say hi", { agent: "general" });
check(
  modelKey(pList.model) === "opencode/mimo-v2.5-free",
  "D: an ordered prefer list routes to its first entry",
);

const rolesResearch = "prefer-roles-research";
sessionDirs.set(rolesResearch, preferRolesDir);
const pRole = await routeOnce(rolesResearch, "@free say hi", { agent: "research" });
check(modelKey(pRole.model) === "opencode-go/space-bunny-free", "D: a per-role prefer applies to that role");

const rolesCode = "prefer-roles-code";
sessionDirs.set(rolesCode, preferRolesDir);
const pRoleDefault = await routeOnce(rolesCode, "@free say hi", { agent: "code" });
check(
  modelKey(pRoleDefault.model) === "opencode/mimo-v2.5-free",
  "D: a per-role default applies to an unnamed role",
);

// OMO slim's agent spellings are real roles, not unknown ones: per-role prefers
// for `explorer`/`librarian` must apply with no unknown-role warning, and the
// catch-all must still answer every role the named entries do not cover.
const preferSlimDir = join(PROJ, "fixtures", "prefer-slim-roles");
const slimExplorer = "prefer-slim-explorer";
sessionDirs.set(slimExplorer, preferSlimDir);
const slimWarnMark = toasts.length;
const pSlimExplorer = await routeOnce(slimExplorer, "@free say hi", { agent: "explorer" });
check(
  modelKey(pSlimExplorer.model) === "opencode/muse-spark-1.3-contributor-free",
  "D: a per-role prefer for the slim explorer name applies",
);
const slimLibrarian = "prefer-slim-librarian";
sessionDirs.set(slimLibrarian, preferSlimDir);
const pSlimLibrarian = await routeOnce(slimLibrarian, "@free say hi", { agent: "librarian" });
check(
  modelKey(pSlimLibrarian.model) === "opencode/muse-spark-1.3-contributor-free",
  "D: a per-role prefer for the slim librarian name applies",
);
const slimOther = "prefer-slim-other";
sessionDirs.set(slimOther, preferSlimDir);
const pSlimOther = await routeOnce(slimOther, "@free say hi", { agent: "general" });
check(
  modelKey(pSlimOther.model) === "opencode/space-bunny-free",
  "D: the catch-all prefer still answers a role the slim entries do not name",
);
const slimWarns = toasts.slice(slimWarnMark).filter((t) => t.indexOf("unknown role") !== -1);
check(slimWarns.length === 0, "D: slim agent names in prefer are recognized roles (no unknown-role warning)");

// Review Focus 1: a global named role must win for that role, while the
// project's blanket prefer still answers every other role. Tiers are picked
// from, never concatenated, so neither id may appear twice in one chain.
await withGlobalConfig(globalRoles, async () => {
  const gResearch = "prefer-global-research";
  sessionDirs.set(gResearch, preferStringDir);
  const r1 = await routeOnce(gResearch, "@free say hi", { agent: "research" });
  check(
    modelKey(r1.model) === "opencode-go/longcat-2.5-preview-free",
    "D: a global named role wins over a project blanket prefer",
  );
  const gGeneral = "prefer-global-general";
  sessionDirs.set(gGeneral, preferStringDir);
  const r2 = await routeOnce(gGeneral, "@free say hi", { agent: "general" });
  check(
    modelKey(r2.model) === "opencode/mimo-v2.5-free",
    "D: a project blanket prefer still answers roles the global does not name",
  );
});

await withGlobalConfig(globalBlanket, async () => {
  const bothGeneral = "prefer-global-vs-project";
  sessionDirs.set(bothGeneral, preferListDir);
  const r = await routeOnce(bothGeneral, "@free say hi", { agent: "general" });
  check(
    modelKey(r.model) === "opencode/mimo-v2.5-free",
    "D: a project prefer beats a global prefer for the same role",
  );
});

// Review Focus 5: editing the GLOBAL config between two messages must change
// routing on the next message - the policy cache revalidates the global file's
// mtime, not just the project's. utimesSync bumps mtime so the assertion cannot
// pass or fail on filesystem timestamp granularity.
const globalEditOriginal = readFileSync(globalEdit, "utf8");
await withGlobalConfig(globalEdit, async () => {
  writeFileSync(globalEdit, '{"prefer":"opencode/mimo-v2.5-free"}');
  const editSid = "prefer-global-edit";
  const e1 = await routeOnce(editSid, "@free say hi");
  writeFileSync(globalEdit, '{"prefer":"opencode/jev-1.13-free"}');
  const future = Date.now() / 1000 + 5;
  utimesSync(globalEdit, future, future);
  const e2 = await routeOnce(editSid, "@free say hi");
  check(
    modelKey(e1.model) === "opencode/mimo-v2.5-free" &&
      modelKey(e2.model) === "opencode/jev-1.13-free" &&
      modelKey(e1.model) !== modelKey(e2.model),
    "D: an edited global config takes effect on the next message",
  );
});
writeFileSync(globalEdit, globalEditOriginal);

const badSid = "prefer-badjson-sid";
sessionDirs.set(badSid, preferBadDir);
const toastMark = toasts.length;
const pBad = await routeOnce(badSid, "@free say hi", { agent: "general" });
const badToasts = toasts.slice(toastMark).filter((t) => t.includes("free-model-router.json"));
check(
  modelKey(pBad.model) !== modelKey(PAID) && isFreeId(pBad.model.modelID),
  "D: malformed prefer JSON still routes to a free model",
);
check(badToasts.length === 1, "D: malformed prefer JSON warns exactly once");

// ---- Section 5: candidate chain (order, unknown ids, zdr filtering) -------
// Ordering is asserted through ROUTING here. The chain TEXT is a later task's
// deliverable, so counting entries in it is deliberately deferred.
const unknownFirstDir = join(PROJ, "fixtures", "prefer-unknown-first");
const allUnknownDir = join(PROJ, "fixtures", "prefer-all-unknown");
const nonFreeDir = join(PROJ, "fixtures", "prefer-nonfree");
const dupDir = join(PROJ, "fixtures", "prefer-dup");
const zdrPrefDir = join(PROJ, "fixtures", "prefer-zdr");

// Review Focus 2, first half: an unknown id is skipped and named exactly once,
// and the chain stays non-empty because a valid entry follows it.
const unknownFirst = "cand-unknown-first";
sessionDirs.set(unknownFirst, unknownFirstDir);
const markUnknown = toasts.length;
const pUnknown = await routeOnce(unknownFirst, "@free say hi", { agent: "general" });
const unknownWarns = toasts.slice(markUnknown).filter((t) => t.includes("nope-9-free"));
check(
  modelKey(pUnknown.model) === "opencode-go/space-bunny-free",
  "D: an unknown prefer id is skipped for the next entry",
);
check(unknownWarns.length === 1, "D: an unknown prefer id warns exactly once");

// Review Focus 2, second half: every configured id unknown must still land on a
// free model (the built-in default), never on the paid one.
const allUnknown = "cand-all-unknown";
sessionDirs.set(allUnknown, allUnknownDir);
const pAllUnknown = await routeOnce(allUnknown, "@free say hi", { agent: "general" });
check(
  isFreeId(pAllUnknown.model.modelID) && modelKey(pAllUnknown.model) !== modelKey(PAID),
  "D: an all-unknown prefer falls back to the built-in free default",
);

// Review Focus 3: a real model that is not free-tier is absent from the free
// catalog, so it is dropped exactly like an unknown id.
const nonFree = "cand-non-free";
sessionDirs.set(nonFree, nonFreeDir);
const markNonFree = toasts.length;
const pNonFree = await routeOnce(nonFree, "@free say hi", { agent: "general" });
check(
  isFreeId(pNonFree.model.modelID) && modelKey(pNonFree.model) !== modelKey(PAID),
  "D: a prefer id that is not free-tier is skipped",
);
check(
  toasts.slice(markNonFree).filter((t) => t.includes(PAID.modelID)).length === 1,
  "D: a not-free prefer id warns exactly once",
);

// Dedupe keeps the first occurrence, so a repeated id - bare and qualified -
// still resolves to the single entry it names.
const dup = "cand-dup";
sessionDirs.set(dup, dupDir);
const pDup = await routeOnce(dup, "@free say hi", { agent: "general" });
check(modelKey(pDup.model) === "opencode/mimo-v2.5-free", "D: duplicate and bare/qualified ids resolve to one candidate");

// zdr-only drops the configured non-safe entry and keeps the safe one.
const zdrPref = "cand-zdr";
sessionDirs.set(zdrPref, zdrPrefDir);
const pZdr = await routeOnce(zdrPref, "@free say hi", { agent: "general" });
check(
  modelKey(pZdr.model) === "opencode-go/space-bunny-free",
  "D: zdr-only keeps only safe models from the configured list",
);
// zdr-only discarding a CONFIGURED entry is a silent preference loss unless the plugin
// says so. The built-in tail tier being filtered is the mode working, so it is not named.
const zdrDropped = "cand-zdr-dropped";
sessionDirs.set(zdrDropped, zdrPrefDir);
const markDropped = toasts.length;
await routeOnce(zdrDropped, "@free say hi", { agent: "general" });
check(
  toasts.slice(markDropped).filter((t) => t.includes("mimo-v2.5-free")).length === 1,
  "D: zdr-only names a configured model it dropped",
);

// The session pin set by /free <id> prepends to the configured chain. This also
// covers the pin being READ at all: before candidateList the /free pin was
// stored on session state and never consulted.
const pinSid = "cand-pin";
sessionDirs.set(pinSid, preferStringDir);
await hooks["command.execute.before"](
  { command: "free", sessionID: pinSid, arguments: "opencode/longcat-2.5-preview-free" },
  { parts: [] },
);
const pPin = await routeOnce(pinSid, "@free say hi", { agent: "general" });
check(
  modelKey(pPin.model) === "opencode/longcat-2.5-preview-free",
  "D: a /free pin prepends to the configured prefer list",
);

// ---- section 6: failover walks the configured preferences ----
sessionDirs.set("fail-pref", join(PROJ, "fixtures", "prefer-failover"));
const fp1 = await routeOnce("fail-pref", "@free say hi");
check(
  modelKey(fp1.model) === "opencode/jev-1.13-free",
  "D: the first configured preference is picked over the built-in default",
);
await toolAfter("fail-pref", "HTTP 429 Too Many Requests");
const fp2 = await routeOnce("fail-pref", "@free say hi");
check(
  modelKey(fp2.model) === "opencode-go/longcat-2.5-preview-free",
  "D: failover follows the configured preferences",
);

// Review Focus 4: a pin naming a model that does not exist must not empty the
// chain or throw; the configured preference still serves the turn. Uses a fresh
// session because a chain that already failed a candidate continues from the
// next entry, which would mask what the broken pin did.
sessionDirs.set("fail-pin", join(PROJ, "fixtures", "prefer-failover"));
const fpToastMark = toasts.length;
const fp3 = await routeOnce("fail-pin", "@free nope-9-free say hi");
check(
  modelKey(fp3.model) === "opencode/jev-1.13-free",
  "D: a pin naming an unknown model leaves the chain unchanged",
);
check(
  toasts.slice(fpToastMark).some((t) => t.indexOf("nope-9-free") !== -1),
  "D: an unknown pin warns once naming the id it could not resolve",
);

// ---- section 7: /free prints the effective chain ----
const chainSid = "chain-1";
sessionDirs.set(chainSid, join(PROJ, "fixtures", "prefer-failover"));
await freeOn(chainSid);
await hooks["command.execute.before"](
  { command: "free", sessionID: chainSid, arguments: "opencode/mimo-v2.5-free" },
  { parts: [] },
);
type ChainOut = Parameters<typeof hooks["command.execute.before"]>[1];
const chainOut: ChainOut = { parts: [] };
await hooks["command.execute.before"](
  { command: "free", sessionID: chainSid, arguments: "" },
  chainOut,
);
const chainText = String((chainOut.parts[0] as { text?: unknown } | undefined)?.text ?? "");
check(
  chainText.indexOf("Usage: /free on | /free off") !== -1,
  "E: the no-arg reply keeps the usage line",
);
check(
  chainText.indexOf("1. opencode/mimo-v2.5-free (pin)") !== -1,
  "E: the pin is listed first and labelled pin",
);
check(
  chainText.indexOf("(configured)") !== -1,
  "E: configured preferences are labelled configured",
);
check(
  chainText.indexOf("(built-in)") !== -1,
  "E: the catalog tail tier is labelled built-in",
);
check(
  /\+\d+ more\.$/.test(chainText),
  "E: a long chain is capped and says how many entries were elided",
);

// ---- section 8: /free auto - role-allowlist routing ----
// auto differs from on in three ways: untagged turns are gated on the agent role
// instead of always routing, /free auto clears a stale pin, and the status line
// names the allowlist. The default allowlist is ["explore", "explorer",
// "librarian", "research"] - the research family under both host spellings
// (core opencode's `explore`; OMO slim's `explorer`/`librarian`), all of which
// reach the chat.message hook (title/compaction/summary call the model directly).
async function freeAuto(sessionID: string): Promise<string> {
  const out: ChainOut = { parts: [] };
  await hooks["command.execute.before"]({ command: "free", sessionID, arguments: "auto" }, out);
  return String((out.parts[0] as { text?: unknown } | undefined)?.text ?? "");
}

async function delegateOnce(
  sessionID: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ providerID: string; modelID: string } | undefined> {
  callSeq += 1;
  const out = { args };
  await hooks["tool.execute.before"]({ tool, sessionID, callID: `d${callSeq}` }, out);
  return (out.args as { model?: { providerID: string; modelID: string } }).model;
}

const autoDir = (name: string): string => join(PROJ, "fixtures", name);
const autoSid = (name: string): string => `auto-${name}`;

// F1: the default allowlist routes explore, on an otherwise unconfigured project.
const f1 = autoSid("explore");
await freeAuto(f1);
const f1r = await routeOnce(f1, "untagged explore turn", { agent: "explore" });
check(
  modelKey(f1r.model) === "opencode/muse-spark-1.3-contributor-free" && isFreeId(f1r.model.modelID),
  "F: auto routes an untagged explore turn to the explore default",
);
// F2/F3: a non-allowlisted role, and the empty-agent fallback (general), both stay paid.
const f2 = autoSid("build");
await freeAuto(f2);
const f2r = await routeOnce(f2, "untagged build turn", { agent: "build" });
check(modelKey(f2r.model) === modelKey(PAID), "F: auto leaves a build turn on the paid model");
const f3 = await routeOnce(f2, "untagged no-agent turn");
check(modelKey(f3.model) === modelKey(PAID), "F: auto treats a missing agent as general (paid)");
// F4: an explicit tag still overrides the allowlist.
const f4r = await routeOnce(f2, "@free tagged build turn", { agent: "build" });
check(
  modelKey(f4r.model) !== modelKey(PAID) && isFreeId(f4r.model.modelID) && f4r.text === "tagged build turn",
  "F: @free routes a build turn under auto and the tag is stripped",
);
// F5: a model argument still flips the session out of auto into on.
const f5 = autoSid("pin-wins");
await freeAuto(f5);
await hooks["command.execute.before"](
  { command: "free", sessionID: f5, arguments: "opencode/jev-1.13-free" },
  { parts: [] },
);
const f5r = await routeOnce(f5, "untagged build turn", { agent: "build" });
check(
  modelKey(f5r.model) === "opencode/jev-1.13-free",
  "F: /free <model-id> leaves auto and pins the model for every role",
);
// F6: entering auto must clear a pin recorded earlier, or it would outrank the role default.
const f6 = autoSid("stale-pin");
await freeAuto(f6);
await hooks["command.execute.before"](
  { command: "free", sessionID: f6, arguments: "opencode/jev-1.13-free" },
  { parts: [] },
);
await freeAuto(f6);
const f6r = await routeOnce(f6, "untagged explore turn", { agent: "explore" });
check(
  modelKey(f6r.model) === "opencode/muse-spark-1.3-contributor-free",
  "F: /free auto clears a stale pin so the role default wins",
);
// F7: children inherit auto and are judged on their OWN role.
const f7Par = autoSid("auto-parent");
const f7Exp = autoSid("auto-child-explore");
const f7Bld = autoSid("auto-child-build");
sessionParents.set(f7Exp, f7Par);
sessionParents.set(f7Bld, f7Par);
await freeAuto(f7Par);
const f7r = await routeOnce(f7Exp, "untagged child turn", { agent: "explore" });
check(modelKey(f7r.model) !== modelKey(PAID) && isFreeId(f7r.model.modelID), "F: a child of an auto parent routes when its role is allowlisted");
const f7b = await routeOnce(f7Bld, "untagged child turn", { agent: "build" });
check(modelKey(f7b.model) === modelKey(PAID), "F: a child of an auto parent stays paid for a non-allowlisted role");
// F8: delegation reads the child role from subagent_type.
const f8 = autoSid("delegate");
await freeAuto(f8);
const f8exp = await delegateOnce(f8, "delegate_task", { subagent_type: "explore", prompt: "go" });
check(f8exp !== undefined && isFreeId(f8exp.modelID), "F: auto stamps an allowlisted subagent_type with a free model");
const f8omo = await delegateOnce(f8, "call_omo_agent", { subagent_type: "explore", prompt: "go" });
check(f8omo !== undefined && isFreeId(f8omo.modelID), "F: auto also stamps call_omo_agent for an allowlisted role");
const f8bld = await delegateOnce(f8, "delegate_task", { subagent_type: "build", prompt: "go" });
check(f8bld === undefined, "F: a non-allowlisted subagent_type is left untouched under auto");
const f8none = await delegateOnce(f8, "delegate_task", { prompt: "go" });
check(f8none === undefined, "F: a missing subagent_type is left untouched under auto");
const f8task = await delegateOnce(f8, "task", { subagent_type: "explore" });
check(f8task === undefined, "F: the core task tool is never stamped (no model param)");
const f8off = autoSid("delegate-off");
await freeAuto(f8off);
await freeOff(f8off);
const f8offM = await delegateOnce(f8off, "delegate_task", { subagent_type: "explore", prompt: "go" });
check(f8offM === undefined, "F: an off session never stamps a delegated model");

// F9: auto.roles REPLACES the default list rather than extending it.
const f9 = autoSid("custom");
sessionDirs.set(f9, autoDir("auto-custom")); // {"auto":{"roles":["oracle"]}}
await freeAuto(f9);
const f9o = await routeOnce(f9, "untagged oracle turn", { agent: "oracle" });
check(modelKey(f9o.model) !== modelKey(PAID) && isFreeId(f9o.model.modelID), "F: a custom allowlisted role routes under auto");
const f9e = await routeOnce(f9, "untagged explore turn", { agent: "explore" });
check(modelKey(f9e.model) === modelKey(PAID), "F: a custom list replaces the default (explore no longer routes)");
// F10: an empty list routes nothing at all.
const f10 = autoSid("empty");
sessionDirs.set(f10, autoDir("auto-empty")); // {"auto":{"roles":[]}}
await freeAuto(f10);
const f10r = await routeOnce(f10, "untagged explore turn", { agent: "explore" });
check(modelKey(f10r.model) === modelKey(PAID), "F: an empty auto.roles list routes nothing");
// F11: a project in off mode wins over an allowlisted role.
const f11 = autoSid("off-project");
sessionDirs.set(f11, autoDir("auto-off")); // {"mode":"off","auto":{"roles":["explore"]}}
const f11r = await routeOnce(f11, "untagged explore turn", { agent: "explore" });
check(modelKey(f11r.model) === modelKey(PAID) && f11r.text === "untagged explore turn", "F: project mode off beats the auto allowlist");
// F12/F8b: a malformed or blank list warns once and falls back to the defaults.
const f12Mark = toasts.length;
const f12 = autoSid("bad");
sessionDirs.set(f12, autoDir("auto-bad")); // {"auto":{"roles":"explore"}}
await freeAuto(f12);
const f12r = await routeOnce(f12, "untagged explore turn", { agent: "explore" });
const f12Warn = toasts.slice(f12Mark).filter((t) => t.indexOf('"auto" in') !== -1);
check(
  modelKey(f12r.model) === "opencode/muse-spark-1.3-contributor-free" && f12Warn.length === 1,
  "F: a malformed auto block warns exactly once and uses the default roles",
);
const f12bMark = toasts.length;
const f12b = autoSid("blank");
sessionDirs.set(f12b, autoDir("auto-blank")); // {"auto":{"roles":[" "]}}
await freeAuto(f12b);
const f12br = await routeOnce(f12b, "untagged explore turn", { agent: "explore" });
check(
  modelKey(f12br.model) === "opencode/muse-spark-1.3-contributor-free" &&
    toasts.slice(f12bMark).filter((t) => t.indexOf('"auto" in') !== -1).length === 1,
  "F: an all-blank role list is treated as a typo and warns once",
);
// F13: unroutable roles warn but the rest of the list still routes.
const f13Mark = toasts.length;
const f13 = autoSid("unroutable");
sessionDirs.set(f13, autoDir("auto-unroutable")); // {"auto":{"roles":["title","explore"]}}
await freeAuto(f13);
const f13r = await routeOnce(f13, "untagged explore turn", { agent: "explore" });
const f13Warn = toasts.slice(f13Mark).filter((t) => t.indexOf("can never route") !== -1 && t.indexOf("title") !== -1);
check(
  modelKey(f13r.model) === "opencode/muse-spark-1.3-contributor-free" && f13Warn.length === 1,
  "F: an unroutable role warns once by name and the remaining roles still route",
);
// F14: project auto.roles beats the global list, which applies when no project file does.
const globalAutoOracle = join(GLOBAL_DIR, "auto-oracle.json"); // {"auto":{"roles":["oracle"]}}
const f14a = autoSid("global-only");
await withGlobalConfig(globalAutoOracle, async () => {
  await freeAuto(f14a);
  const g = await routeOnce(f14a, "untagged oracle turn", { agent: "oracle" });
  check(modelKey(g.model) !== modelKey(PAID) && isFreeId(g.model.modelID), "F: a global auto.roles list applies when the project has no policy file");
  const ge = await routeOnce(f14a, "untagged explore turn", { agent: "explore" });
  check(modelKey(ge.model) === modelKey(PAID), "F: the global list replaces the default (explore does not route)");
});
const f14b = autoSid("project-beats-global");
sessionDirs.set(f14b, autoDir("auto-project-wins")); // {"auto":{"roles":["explore"]}}
await withGlobalConfig(globalAutoOracle, async () => {
  await freeAuto(f14b);
  const pe = await routeOnce(f14b, "untagged explore turn", { agent: "explore" });
  check(modelKey(pe.model) !== modelKey(PAID) && isFreeId(pe.model.modelID), "F: a project auto.roles list overrides the global one");
  const po = await routeOnce(f14b, "untagged oracle turn", { agent: "oracle" });
  check(modelKey(po.model) === modelKey(PAID), "F: the overridden global role no longer routes");
});
// F15: the status lines name the full allowlist and drop the old "reserved" wording.
const f15 = autoSid("status");
const f15On = await freeAuto(f15);
check(
  f15On.indexOf("Auto routes free for: explore, explorer, librarian, research.") !== -1 &&
    f15On.indexOf("reserved") === -1,
  "F: /free auto names the active roles and no longer says reserved",
);
const f15Out: ChainOut = { parts: [] };
await hooks["command.execute.before"]({ command: "free", sessionID: f15, arguments: "" }, f15Out);
const f15Text = String((f15Out.parts[0] as { text?: unknown } | undefined)?.text ?? "");
check(
  f15Text.indexOf("Auto routes free for: explore, explorer, librarian, research.") !== -1,
  "F: the no-arg status in auto names the allowlist",
);
const f15Off = autoSid("status-off");
await freeOff(f15Off);
const f15OffOut: ChainOut = { parts: [] };
await hooks["command.execute.before"]({ command: "free", sessionID: f15Off, arguments: "" }, f15OffOut);
const f15OffText = String((f15OffOut.parts[0] as { text?: unknown } | undefined)?.text ?? "");
check(f15OffText.indexOf("Auto routes") === -1, "F: the no-arg status in off does not advertise auto routing");
// F16: a 429 on an auto-routed turn still walks the chain (chat path only).
const f16 = autoSid("failover");
await freeAuto(f16);
const f16a = await routeOnce(f16, "untagged explore turn", { agent: "explore" });
await toolAfter(f16, "HTTP 429 rate limit");
const f16b = await routeOnce(f16, "untagged explore turn", { agent: "explore" });
check(
  modelKey(f16a.model) !== modelKey(f16b.model) && isFreeId(f16b.model.modelID),
  "F: a 429 under auto fails over to a different free model",
);
// F17: /free off still wins over an allowlisted role.
const f17 = autoSid("off-after-auto");
await freeAuto(f17);
await freeOff(f17);
const f17r = await routeOnce(f17, "untagged explore turn", { agent: "explore" });
check(modelKey(f17r.model) === modelKey(PAID), "F: /free off after auto leaves explore on the paid model");

// F18-F20: the widened default allowlist covers OMO slim's research agents too.
// Each fresh session enters auto and then takes its OWN untagged chat.message
// turn on an otherwise unconfigured project, which is how a slim subagent is
// routed (slim delegates through the native task tool, which is never stamped).
const f18 = autoSid("slim-explorer");
await freeAuto(f18);
const f18r = await routeOnce(f18, "untagged explorer turn", { agent: "explorer" });
check(
  modelKey(f18r.model) === "opencode/muse-spark-1.3-contributor-free" && isFreeId(f18r.model.modelID),
  "F: auto routes an untagged explorer turn to the research default",
);
const f19 = autoSid("slim-librarian");
await freeAuto(f19);
const f19r = await routeOnce(f19, "untagged librarian turn", { agent: "librarian" });
check(
  modelKey(f19r.model) === "opencode/muse-spark-1.3-contributor-free" && isFreeId(f19r.model.modelID),
  "F: auto routes an untagged librarian turn to the research default",
);
const f20 = autoSid("research-family");
await freeAuto(f20);
const f20r = await routeOnce(f20, "untagged research turn", { agent: "research" });
check(
  modelKey(f20r.model) === "opencode/muse-spark-1.3-contributor-free" && isFreeId(f20r.model.modelID),
  "F: auto routes an untagged research turn to the research default",
);
// F21: the widened allowlist is still a gate, not a blanket: a role outside the
// research family stays on the paid model under auto with no explicit tag.
const f21 = autoSid("build-still-paid");
await freeAuto(f21);
const f21r = await routeOnce(f21, "untagged build turn", { agent: "build" });
check(
  modelKey(f21r.model) === modelKey(PAID),
  "F: auto still leaves a non-research role such as build on the paid model",
);

console.log(`${pass} pass ${fail} fail`);
process.exit(fail ? 1 : 0);
