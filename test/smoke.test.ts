// Smoke suite: imports ONLY ../lib (pure logic). Run: bun test/smoke.test.ts (or npx -y tsx).
import { detectFree, nextCandidate, parseFreeTag, pickFree, type FreeCatalog } from "../lib";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string): void {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
}

const cat: FreeCatalog = { zen: ["big-pickle", "space-bunny-free", "longcat-2.5-preview-free", "other-free"], go: ["go-free"] };

// detectFree
check(detectFree(["x-free", "paid-model", "big-pickle"]).includes("x-free"), "detectFree keeps -free ids");
check(!detectFree(["paid-model"]).includes("paid-model"), "detectFree drops paid ids");
check(detectFree([]).length === 0, "detectFree empty");

// pickFree
const p = pickFree(cat);
check(p !== null && typeof p.modelID === "string", "pickFree returns a pick");
check(pickFree({ zen: [], go: [] }) === null, "pickFree empty catalog -> null");
check(pickFree(null) === null, "pickFree null catalog -> null");
check(pickFree(cat, { preferredId: "other-free" })?.modelID === "other-free", "pickFree honors preferredId");
check(pickFree(cat, { preferredId: "opencode-go/go-free" })?.providerID === "opencode-go", "pickFree provider-qualified pin");

// zdr-only (dotfile mode "zdr-only" maps to zdrOnly: true)
const z = pickFree(cat, { zdrOnly: true });
check(z !== null && ["space-bunny-free", "longcat-2.5-preview-free"].includes(z.modelID), "zdrOnly restricts to ZDR-safe ids");
check(pickFree({ zen: ["other-free"], go: [] }, { zdrOnly: true }) === null, "zdrOnly with no safe id -> null");
check(pickFree(cat, { zdrOnly: false }) !== null, "zdrOnly false = all mode");

// parseFreeTag
const t = parseFreeTag("hello @free world");
check(!t.clean.includes("@free") && t.clean.includes("hello"), "parseFreeTag strips tag");
check(parseFreeTag("@free other-free do it").requestedId === "other-free", "parseFreeTag captures free id");
check(parseFreeTag("no tag here").requestedId === null && parseFreeTag("no tag here").clean === "no tag here", "parseFreeTag no-op without tag");

// nextCandidate
const n1 = nextCandidate(cat, []);
check(n1 !== null, "nextCandidate first pick");
const n2 = nextCandidate(cat, [`${n1!.providerID}/${n1!.modelID}`]);
check(n2 !== null && n2.modelID !== n1!.modelID, "nextCandidate excludes failed id");
const all = [...cat.zen.map((m) => `opencode/${m}`), ...cat.go.map((m) => `opencode-go/${m}`)];
check(nextCandidate(cat, all) === null, "nextCandidate exhausted -> null");

console.log(`${pass} pass ${fail} fail`);
process.exit(fail ? 1 : 0);
