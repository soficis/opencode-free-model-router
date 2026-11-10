# opencode-free-model-router

Your OpenCode bill can drop to zero for the boring work.

This [OpenCode](https://opencode.ai) plugin sends chat turns to free-tier models from the **opencode** (Zen) and **opencode-go** providers. When a free model hits a 429 rate limit, the plugin tries the next one. When the free quota runs out, your paid model takes over.

One file supports **OpenCode 1.x and 2.x**. The default export carries both entrypoints: V1 calls `server()`, V2 calls `setup()`. The V1 hook surface is unchanged.

Free models are cheap but come with strings. They can vanish. They can throttle you. Some train on your prompts. So free routing is opt-in. You choose per message, per session, or per project.

---

## Install

Paste this into any OpenCode chat:

> *"Install the OpenCode free model router plugin from `https://github.com/soficis/opencode-free-model-router`"*

Or install it by hand. Pick **one scope**: global (`~/.config/opencode`) or project (`<project>/.opencode`). OpenCode loads every copy it finds. Two copies run with unsynchronized session state.

| File | Destination | Needed on |
| --- | --- | --- |
| `free-model-router.ts` | `<config-dir>/plugins/free-model-router.ts` | V1 and V2 |
| `command/free.md` | `<config-dir>/command/free.md` | V1 only — NEVER on V2 (a `free.md` shadows and breaks the native command, see below) |

`<config-dir>` is `~/.config/opencode` on Linux and macOS. On Windows it is `%USERPROFILE%\.config\opencode`.

V2 auto-discovers a single `.ts` or `.js` file in either `<config-dir>/plugins/` or `<config-dir>/plugin/`, so the same path works. It also auto-discovers project plugins in `<project>/.opencode/plugins/`. If you list a plugin in the `plugin` config field instead, point at a **directory**, not a file; V2 rejects configured file paths.

#### Linux / macOS
```bash
mkdir -p ~/.config/opencode/plugins ~/.config/opencode/command
cp free-model-router.ts ~/.config/opencode/plugins/free-model-router.ts
cp command/free.md ~/.config/opencode/command/free.md
```

#### Windows (PowerShell)
```powershell
New-Item -ItemType Directory -Force -Path "$HOME\.config\opencode\plugins", "$HOME\.config\opencode\command"
Copy-Item free-model-router.ts "$HOME\.config\opencode\plugins\free-model-router.ts"
Copy-Item command\free.md "$HOME\.config\opencode\command\free.md"
```

The `command/` copy is only needed on V1. On V2 you MUST skip it — and delete it if a previous install put it there: markdown commands register after plugins and silently shadow the native `/free`, so the plugin never sees the invocation and a weak model reads the raw template as a research task. V2 registers `/free` natively with zero-turn status replies.

Restart OpenCode (or run `/reload` in V2). Run `/free`. It prints the routing status and the candidate chain.

---

## Use it

### Route one message (`@free`)

Add `@free` to a message. Optionally name a model.

```text
@free explain this stack trace
@free beam-free refactor this helper function
@free opencode-go/longcat-2.5-free write a test suite
```

Write model IDs bare (`beam-free`) or with a provider (`opencode/beam-free`, `opencode-go/beam-free`).

### Route a whole session (`/free`)

| Command | Effect |
| --- | --- |
| `/free on` | Sends every later message in this session to free models |
| `/free off` | Returns to your paid model (the default) |
| `/free auto` | Sends only allowlisted agent roles to free models (default: `explore`, `explorer`, `librarian`, `research`) |
| `/free <model-id \| provider/model-id>` | Turns free routing on and pins that model first (bare id resolves against the catalog, Zen first) |
| `/free` | Shows the mode, a usage summary, and the candidate chain |

### See the candidate chain

Run `/free` with no arguments:

```text
free: mode unchanged (off). Usage: /free on | /free off | /free auto | /free <model-id | provider/model-id>.
Candidates in order: 1. opencode/longcat-2.5-free (pin); 2. opencode/beam-free (configured); 3. opencode/deepseek-v4.1-flash-free (built-in); +9 more.
```

---

## Pick your free model (`prefer`)

Without config, the router picks a built-in model for each agent role. `deepseek-v4.1-flash-free` handles coding, planning, and the research family (`explore`, `explorer`, `librarian`, `research`); `mimo-v2.6-flash-free` handles general tasks (note: it is a documented trainer, so under `/free on` your ordinary chat turns may be used for training unless you set `prefer` or `"mode": "zdr-only"`). Both are checked against the live catalog at runtime: if a default has been retired, the router warns once per session and falls through to the rest of the free catalog.

You can override that. Add a `prefer` key to either config file:

| Scope | Path | Purpose |
| --- | --- | --- |
| **Global** | `~/.config/opencode/free-model-router.json` | Default for all your projects |
| **Project** | `<project>/.opencode/free-model-router.json` | Overrides global |

Set `OPENCODE_FREE_ROUTER_GLOBAL_CONFIG` to move the global file.

```json
{
  "prefer": {
    "default": ["opencode/beam-free", "opencode/longcat-2.5-free"],
    "build": "opencode/deepseek-v4.1-flash-free"
  }
}
```

Keys are agent roles: `build`, `plan`, `general`, `explore`, `explorer`, `librarian`, `research`, or your own. The research family is covered under both host spellings: core opencode registers `explore`, OMO slim registers `explorer` and `librarian`. A `prefer` entry naming any of them is a recognized role, so the same policy works on either host. Values are a model string or an ordered fallback list. Use `"default"` (or `*`) as the catch-all. On a 429 or an exhausted free quota ("Free usage limit reached"), the router moves to the next model in the list.

### Which model wins

The router takes the first match in this order:

1. Session pin (`/free <model-id>` or `@free <model-id>`)
2. Project role
3. Global role
4. Project `"default"`
5. Global `"default"`
6. Built-in role default
7. Rest of the free catalog
8. Your paid model

### Subagents follow the session

`/free` applies to everything the session spawns, not just the turns you type. When an orchestrator delegates (core `task`, oh-my-opencode-slim's V2 `subagent` tool, or OMO's `delegate_task` / `call_omo_agent`), the child is started on the session's free pick even if that agent is configured for a paid model. Child sessions follow the parent's mode and pin live: `/free off` or a new pin in the parent reaches children that already exist. Running `/free` inside a child gives that child its own mode. Under `/free auto`, only allowlisted child roles are routed.

### Choose roles for `/free auto` (`auto.roles`)

In `/free auto` mode, only listed roles go to free models. Your main coding turns (`build`, `plan`, `general`) stay on your paid model. The built-in default is the research family: `explore`, `explorer`, `librarian`, `research`.

```json
{
  "auto": {
    "roles": ["explore", "explorer", "librarian", "research"]
  }
}
```

- **Schema:** `{"auto": {"roles": ["agent-name", ...]}}`. A bare array like `{"auto": [...]}` is invalid and triggers a warning.
- **Replace, not extend:** Your list replaces the built-in default (`["explore", "explorer", "librarian", "research"]`). Set `"roles": []` to turn auto routing off.
- **Cascade:** Project config beats global config. With neither set, `["explore", "explorer", "librarian", "research"]` applies.
- **Hosts:** Both host spellings are covered: core opencode registers `explore`, OMO slim registers `explorer` and `librarian`. The same `auto.roles` policy works on either host.
- **Unroutable roles:** `title`, `compaction`, and `summary` cannot be routed. OpenCode calls the LLM directly for them and skips the `chat.message` hook. Listing them produces a warning.
- **Privacy:** The research agents (`explore`, `explorer`, `librarian`) read your workspace files and send their contents to a free-tier model. If that worries you, set `"mode": "zdr-only"`.

---

## Set a privacy policy per project (`mode`)

Create `<project>/.opencode/free-model-router.json`:

```json
{
  "mode": "zdr-only"
}
```

| Mode | Behavior |
| --- | --- |
| `"all"` | Allows any free model. This is the default. A one-time notice warns about prompt training. |
| `"zdr-only"` | Allows only models not documented to train on or log prompts (blocklist below). Drops documented trainers from preference chains with a warning. If nothing in the chain qualifies, stays on the paid model. |
| `"off"` | Disables free routing. `@free` tags are stripped and ignored. `/free` toggles are blocked. Every request stays on paid models. |

> **Privacy note:** `mode` is project-scoped only. A global config cannot force or disable a mode for a project.

#### Tightening `zdr-only` without a code change (`zdrBlock`)

Zen's default is zero-retention with no training use, so `zdr-only` fails open: new undocumented models route. If you distrust a model family, add substrings (matched case-insensitively against the model ID) to either config file:

```json
{
  "mode": "zdr-only",
  "zdrBlock": ["my-new-trainer"]
}
```

Project and global lists merge (union). A malformed `zdrBlock` triggers a warning and is ignored.

---

## Catalog and ZDR reference

The router discovers the live catalog at runtime from the Zen endpoint and `opencode models`. The table below is the last manually verified snapshot (November 2026), not a guarantee: free models come and go, and the October 2026 lineup (`space-bunny`, `muse-spark-contributor`, `jev`, `ling`, `nemotron`) has since been retired (longcat has returned as `longcat-2.5-free`). `crouton-alpha-free` was removed from both providers in November 2026 (it became the paid `muse-ember-1.0`, which the router never routes to). When a listed model is absent, the router skips it and falls through to the rest of the live free catalog.

`zdr-only` works from a blocklist, not an allowlist, because the lineup rotates faster than any allowlist can be maintained. Zen's stated default is zero-retention with no training use, so every model routes under `zdr-only` **except** the documented trainers below (matched as case-insensitive substrings, so future versions of the same families stay blocked). The blocklist also guards `exo-`, a documented trainer family with no live model at snapshot time. No regular updates needed: the list only changes when a *new* trainer is documented. You can additionally block families yourself with `zdrBlock` (above) without touching the code.

| Provider | Model ID | Routes under `zdr-only` | Retention & Training Policy |
| --- | --- | :---: | --- |
| `opencode` | `beam-free` | **Yes** | Zero-retention default; no documented training use |
| `opencode` | `deepseek-v4.1-flash-free` | **Yes** | Zero-retention default; no documented training use |
| `opencode` | `flint-40b-free` | **Yes** | Zero-retention default; no documented training use |
| `opencode` | `glm-5.3-flash-free` | **Yes** | Zero-retention default; no documented training use |
| `opencode` | `iceman-free` | **Yes** | Zero-retention default; no documented training use |
| `opencode` | `longcat-2.5-free` | **Yes** | Zero-retention, no training use; hosted in China; 100 requests/day |
| `opencode-go` | `beam-free` | **Yes** | Zero-retention default; no documented training use |
| `opencode-go` | `iceman-contributor-free` | No | "Contributor" tier is blocked under zdr-only until the provider documents zero retention |
| `opencode-go` | `longcat-2.5-free` | **Yes** | Zero-retention, no training use; hosted in China; 100 requests/day |
| `opencode` | `big-pickle` | No | Stealth free model; collected data may be used to improve model |
| `opencode` | `inkling-2-small-free` | No | Free tier; data retained and may be used for performance monitoring and model training |
| `opencode` | `mimo-v2.6-flash-free` | No | Free tier; collected data may be used to improve model |
| `opencode` | `mimo-v2.5-free` | No | Free tier; collected data may be used to improve model (retired, stays blocked) |
| `opencode` | `ling-3.1-flash-free` | No | Free tier; collected data may be used to improve model (retired, stays blocked) |
| `opencode` | `ling-3.0-flash-fin-free` | No | Free tier; collected data may be used to improve model (retired, stays blocked) |
| `opencode` | `fledge-alpha-free` | No | Free preview; collected data may be used to improve model (retired, stays blocked) |
| `opencode` | `nemotron-3-ultra-free` | No | NVIDIA trial endpoint; logged for security & service improvement (retired, stays blocked) |
| `opencode` | `nemotron-3.5-lightning-free` | No | NVIDIA trial endpoint; logged for security & service improvement (retired, stays blocked) |
| `opencode` | `muse-spark-1.3-contributor-free` | No | Contributor tier; prompts/completions train future Meta models (retired, stays blocked) |
| `opencode` | `jev-1.13-free` | No | Structured decision model; data retained per TypeSafe AI policy (retired, stays blocked) |

---

## OpenCode 2.x compatibility

The same `free-model-router.ts` runs on both generations. V2 calls the plugin's `setup()` entrypoint; V1 calls `server()`. V1 keeps the original `chat.message` / command / tool hooks. V2 uses the new domain hooks:

| V1 hook | V2 replacement |
| --- | --- |
| `chat.message` | `session.hook("prompt")` |
| `command.execute.before` | native `command.transform` (`/free`) plus a literal `/free` prompt fallback |
| `tool.execute.before` / `after` | `tool.hook("execute.before")` / `("execute.after")` |
| TUI toast | synthetic session message |

### How per-message routing works in V2

V2 has no model field on a prompt. The plugin's `prompt` hook runs before the turn is admitted and calls `session.switchModel(...)`; that switch commits before the model request, so it applies to the **current** turn. After a one-shot `@free` turn, the `experimental.idle` hook restores your paid model. If a turn fails before idle runs, the next non-free prompt restores it.

429 failover uses the V2 `retry` hook: the failed free model is recorded, the next candidate is selected, and the session model is switched for the retry/next turn. When the chain is exhausted, the plugin restores your paid model and stops retrying.

### V2 caveats

- **Session-level model.** The switch is per session, not per request. Normal sequential use is per-turn. Two prompts admitted at the same time race; the latest prompt wins and the stale one is dropped without switching (V2 prompt-sequence guard).
- **Notices are session messages.** A V2 server plugin cannot show a TUI toast. Status and warnings are admitted as synthetic messages instead. In the desktop app each one appears as a collapsed **Updates** row whose visible line is the notice itself, prefixed `/free` (for example `/free mode: on for this session. Next turn: opencode-go/beam-free.`). They cost no tokens and never reach the model. V1 still uses toasts in the TUI; headless V1 (`opencode run`) writes `[free-model-router] ...` to the server log instead.
- **`/free` is native in V2 — do not install `command/free.md` there.** A `free.md` in any `command/` dir registers after the plugin and shadows the native command; the plugin's `execute` never runs and the model receives the raw template. (If one slips through anyway, the prompt hook now recognizes the expanded `Arguments received:` template and still records the pin.)
- **`title`, `compaction`, and `summary`** are still not routable in V2.

### CLI

`opencode run` is a client of the background server, which owns the plugin and its session state.

```bash
opencode run "@free explain this stack trace"
opencode run "/free on"
opencode run -c "now refactor the helper"
```

- `@free` works because the prompt hook sees the text before admission.
- A literal `/free ...` prompt is handled by the same hook, so the command works from `run` even though `run` has no slash-command parser.
- On V1 (1.x), use the command flag instead: `opencode run --command free on`. To keep `/free` state across V1 `run` calls, attach every call to one server (`opencode serve --port 4096`, then `opencode run --attach http://127.0.0.1:4096 --session <id> ...`); each standalone V1 `run` is a new process with fresh state.
- `-c` / `--continue` reuses the session on the same background server, so `/free on` persists across `run` calls. `--standalone` starts a private server per invocation, so session mode does not persist between separate runs.
- **Git Bash rewrites a leading `/free`.** MSYS2 turns the argv element `/free` into an absolute path (`C:/Program Files/Git/free`) before opencode sees it. The plugin recognizes the rewritten form, so `opencode run "/free ..."` still works from Git Bash. For an untouched argument, set `MSYS_NO_PATHCONV=1`.
- To pin a model for one CLI turn: `opencode run "@free opencode/beam-free summarize this"`.

---

## Design rules

- **One runtime export.** The file exports exactly one default object: `{ id, setup, server }`. V1's legacy loader iterates every runtime export, so a named helper or constant fails with *"Plugin export is not a function"*. Type-only exports are erased and safe. V2 reads `id` + `setup`; V1 reads `id` + `server`.
- **One install scope.** OpenCode loads every copy it finds. Two copies double-execute with unsynchronized state.
- **Failures degrade, never crash.** Network errors, malformed JSON, and unknown model IDs fall back to safe defaults and show a notice. The chat session survives.
- **Hooks have deadlines.** Session resolution and network calls time out, and notices are posted in the background, so a slow host never holds up your prompt.
- **One module, many instances.** OpenCode loads the plugin once per project directory on a shared module. Each instance's hooks run in their own host context, so one project's instance never acts on another project's sessions.
- **The catalog probe cannot recurse.** The `opencode models` CLI spawn reloads this plugin in the child process, which would spawn another probe forever. The child refuses to spawn again (`OPENCODE_FMR_NO_SPAWN`), so discovery degrades to the pinned fallback instead of fork-bombing.

---

## Test

Run the smoke suite:

```bash
bun test/smoke.test.ts
```

Or with Node: `npx -y tsx test/smoke.test.ts`

The suite runs offline against pinned fixtures (160 tests). It covers the V1 hook surface, V2 prompt/idle/retry/tool hooks with a fake host, concurrent-prompt race handling, headless (no-TUI) notice fallback, tag parsing, 429 failover, project policy switching, subagent inheritance (live parent mode and pin, V2 `subagent` tool stamping over oh-my-opencode-slim presets), preference order, and the native `/free` command.

---

## License

GPL-3.0-only
