// opencode-free-model-router - pure routing logic + dual-provider discovery (contract, todo 3).
// Imports nothing from the plugin package; the ONLY network/process I/O in this module lives
// inside fetchCatalog(). Callers never set reasoningEffort here (never a `max` default on
// muse-spark free ids - leave it unset upstream).

export interface FreeCatalog {
  zen: string[];
  go: string[];
}

export interface PickOptions {
  preferredId?: string;
  role?: string;
  zdrOnly?: boolean;
}

export interface ModelPick {
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
export async function fetchCatalog(): Promise<FreeCatalog> {
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

// Stale-only refresh entry for idle handlers: returns the fresh cache untouched and only
// refetches once the TTL has elapsed (so an idle ticker cannot cause fetch spam).
export async function refreshCatalogIfStale(): Promise<FreeCatalog> {
  if (cache && Date.now() - cache.at < CATALOG_TTL_MS) return cache.value;
  return fetchCatalog();
}

// Suffix -free match plus the pinned unsuffixed allowlist (big-pickle).
export function detectFree(ids: string[]): string[] {
  if (!Array.isArray(ids)) return [];
  const free: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    if (id.endsWith("-free") || FREE_ALLOWLIST.includes(id)) free.push(id);
  }
  return free;
}

// preferredId (bare or "provider/id") wins; else role-mapped default; zdrOnly restricts to
// the ZDR-safe set. Returns null - never throws - on empty/malformed catalogs.
export function pickFree(catalog: FreeCatalog | null | undefined, opts: PickOptions = {}): ModelPick | null {
  const entries = toEntries(catalog);
  if (entries.length === 0) return null;
  const zdrOnly = opts !== null && opts !== undefined && opts.zdrOnly === true;
  const allowed = zdrOnly ? entries.filter((e) => isZdrSafe(e.modelID)) : entries;
  if (allowed.length === 0) return null;

  const options = opts ?? {};
  const preferred = typeof options.preferredId === "string" ? options.preferredId : "";
  if (preferred.length > 0) {
    const slash = preferred.indexOf("/");
    const prefProvider = slash > 0 ? preferred.slice(0, slash) : "";
    const prefId = slash > 0 ? preferred.slice(slash + 1) : preferred;
    const hit = allowed.find(
      (e) => e.modelID === prefId && (prefProvider.length === 0 || e.providerID === prefProvider),
    );
    if (hit) return hit;
  }

  const role = typeof options.role === "string" && options.role.length > 0 ? options.role : undefined;
  const candidates: (string | undefined)[] = [];
  if (role && ROLE_DEFAULT_IDS[role]) candidates.push(ROLE_DEFAULT_IDS[role]);
  candidates.push(ROLE_DEFAULT_IDS["general"]);
  for (const id of candidates) {
    if (!id) continue;
    const hit = allowed.find((e) => e.modelID === id);
    if (hit) return hit;
  }

  if (zdrOnly) {
    for (const id of ZDR_PREFERRED_ORDER) {
      const hit = allowed.find((e) => e.modelID === id);
      if (hit) return hit;
    }
  }
  return allowed[0] ?? null;
}

// Splits "@free" (plus optional id token, bare or provider-qualified) off the text. A token
// is only consumed as requestedId when it is a free id (detectFree), so ordinary words that
// merely follow the tag survive in clean untouched.
export function parseFreeTag(text: string): { clean: string; requestedId: string | null } {
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
export function nextCandidate(catalog: FreeCatalog | null | undefined, failedIds: string[]): ModelPick | null {
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
