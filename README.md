# opencode-free-model-router

An [opencode](https://opencode.ai) plugin that routes chat turns to the free-tier models served by both the **opencode** (Zen) and **opencode-go** providers, and falls back down the list when a free model is rate limited.

Free tiers are useful but temporary, IP-locked and rate limited, and some free models may use your prompts for training. This plugin makes using them opt-in per message, per session and per project.

## Features

- **Dual provider** - discovers free models from both `opencode` and `opencode-go` (hourly cache; a pinned list is used when discovery fails).
- **`@free` tag** - put `@free` (optionally followed by a free model id) in a message to route that message. The tag is stripped before the model sees it.
- **`/free` command** - `/free on|off|auto|<provider/model-id>` switches routing for the current session. `/free` with no argument prints the usage line and the ordered candidate chain it would use.
- **Your own model preferences** - a `prefer` key, settable globally and per project, per role or as a single fallback, decides which free model you get. See [Choosing which free model you get](#choosing-which-free-model-you-get).
- **Delegation** - while `/free on`, `call_omo_agent` / `delegate_task` calls (oh-my-opencode) are stamped with a free model. Core `task` subagents that pin a model keep it; unpinned ones inherit the rerouted session.
- **429 failover** - when a tool result shows `429`, `FreeUsageLimitError`, a rate-limit or quota error while a free model is active, that model is marked failed for the session and the **next candidate in your own preference order** is used. When every candidate has failed, the original paid model is restored once and a notice is produced. Failed ids are kept only for the session that hit them.
- **Per-project policy** - `<project>/.opencode/free-model-router.json` controls what the project allows (see below).

## Install

Pick one route. Install in **one** scope only: opencode loads every copy it finds, and two copies keep separate session state.

### Standalone install

`free-model-router.ts` is self-contained (one default export; `lib.ts` is inlined), so the plugin loader sees exactly one plugin and no helper modules:

```text
free-model-router.ts     ->  ~/.config/opencode/plugins/free-model-router.ts
command/free.md          ->  ~/.config/opencode/command/free.md
```

There is no build step and nothing else to copy.

### npm route

`package.json` declares the package `opencode-free-model-router` with `@opencode-ai/plugin` as a peer dependency. Add the package name to the `plugin` array of your opencode config after publishing it to your registry, and copy `command/free.md` as above.

## Usage

```text
@free explain this stack trace
@free space-bunny-free explain this stack trace
@free opencode-go/longcat-2.5-preview-free explain this stack trace

/free on                               route every message in this session
/free off                              back to your paid model (default)
/free auto                             reserved: sets the mode but does not route by itself
/free opencode/deepseek-v4-flash-free  turn on and record a preferred free model
/free                                  show the usage line and the candidate chain
```

A model id may be written bare (`space-bunny-free`) or provider-qualified (`opencode-go/space-bunny-free`). Prefer the qualified form when the same id exists in both providers.

## Choosing which free model you get

Left alone, the router picks a built-in default per role (for example `deepseek-v4-flash-free` for code/plan/subagent roles, `muse-spark-1.3-contributor-free` for research/writing, `mimo-v2.6-flash-free` otherwise). Those defaults are one opinion about which free tier is worth using, and they are not right for everyone - your entitlement to a given model is personal.

The `prefer` key replaces that opinion with yours. It is read from two files that take the same shape:

| scope | file | sets |
| --- | --- | --- |
| global | `~/.config/opencode/free-model-router.json` | your standing preference for every project |
| project | `<project>/.opencode/free-model-router.json` | the preference for this project only |

Set `OPENCODE_FREE_ROUTER_GLOBAL_CONFIG` to a path to move the global file somewhere else.

### The three shapes

One key, three forms. The simplest form is the common case:

```json
{ "prefer": "opencode/space-bunny-free" }
```

An ordered list, so a 429 on the first entry lands on the second:

```json
{ "prefer": ["opencode/space-bunny-free", "opencode/mimo-v2.6-flash-free"] }
```

A per-role map, where each role holds a string or a list. `default` (or `*`) is the catch-all for roles you did not name:

```json
{ "prefer": { "default": "opencode/space-bunny-free", "research": "opencode-go/longcat-2.5-preview-free", "code": ["opencode/deepseek-v4-flash-free", "opencode/mimo-v2.6-flash-free"] } }
```

Roles are the opencode agent roles: `general`, `code`, `plan`, `orchestration`, `subagent`, `research`, `writing`, `title`, `compact`, `summarize`. An unrecognised role falls back to `general`, and is named in a one-time warning toast.

### How the two files combine

For any given role the router resolves, in order:

1. the session pin (`/free <id>` or `@free <id>`) - see below;
2. the `prefer` entry naming that role, from the project file if it has one, otherwise from the global file;
3. the `prefer` `default` entry, project before global;
4. the built-in default for that role.

A named role always beats `default`, whichever file either came from. So a project that sets a blanket `"prefer": "..."` overrides only your catch-all and leaves a `"research"` entry in your global file intact.

`mode` is deliberately **not** read from the global file - only a project may switch routing off.

### The pin

`/free <provider/model-id>` records a pin for the session, and `@free <id>` sets one for that message. A pin is **prepended** to the chain rather than replacing it, so if your pinned model is rate limited you fall through to your own preferences rather than to a built-in default. Pins are session state; a new session starts from your configured preferences.

### What you actually get

The router builds one ordered list and uses it for both the first pick and every failover:

1. the session pin, if any;
2. your `prefer` entry for the role, or the built-in default;
3. the rest of the free catalog, so an unconfigured or exhausted list still finds another free model;
4. `zdr-only` projects keep only the ZDR-safe entries, and if nothing survives the filter the ZDR-safe order is used instead;
5. your paid model, restored once with a notice, when every candidate has failed.

Duplicate entries are removed, and an id that is not currently in the free catalog is skipped with a one-time toast naming it - so a typo costs you that entry, never the whole preference list. An unparsable or wrongly-typed `prefer` is ignored with a warning; routing keeps working on the built-in defaults.

### Seeing the chain

`/free` with no argument prints the usage line followed by the chain it would use, each entry labelled with where it came from:

```text
free: mode unchanged (off). Usage: /free on | /free off | /free auto | /free <provider/model-id>.
Candidates in order: 1. opencode/space-bunny-free (pin); 2. opencode/mimo-v2.6-flash-free (configured); 3. opencode/jev-1.13-free (built-in); +7 more.
```

Long chains are capped at six entries so the reply stays readable.

## Per-project policy

Create `.opencode/free-model-router.json` in the project:

```json
{ "mode": "zdr-only" }
```

| mode | effect |
| --- | --- |
| `all` | any free model (default when the file is absent; a one-time training-risk toast is shown) |
| `zdr-only` | only zero-data-retention models (`space-bunny-free`, `longcat-2.5-preview-free`) |
| `off` | no routing in this project: `@free` is stripped but ignored, `/free` and delegation are no-ops, a toast explains why |

An invalid file falls back to `all` with a warning toast. Both this file and the global file are re-read when their modification times change, so an edit takes effect on your next message without a restart.

## Catalog (verified 2026-09-29)

| provider | model id | ZDR-safe |
| --- | --- | --- |
| opencode | `jev-1.13-free` | no |
| opencode | `deepseek-v4-flash-free` | no |
| opencode | `muse-spark-1.3-contributor-free` | no |
| opencode | `muse-spark-1.2-contributor-free` | no |
| opencode | `mimo-v2.6-flash-free` | no |
| opencode | `space-bunny-free` | yes |
| opencode | `longcat-2.5-preview-free` | yes |
| opencode | `mimo-v2.5-free` | no |
| opencode | `ling-3.0-flash-fin-free` | no |
| opencode | `nemotron-3-ultra-free` | no |
| opencode | `nemotron-3.5-lightning-free` | no |
| opencode | `big-pickle` | no |
| opencode-go | `space-bunny-free` | yes |
| opencode-go | `longcat-2.5-preview-free` | yes |

The live list is fetched at runtime and can differ; the table above is also the fallback list.

## Privacy

| class | models | meaning |
| --- | --- | --- |
| ZDR-safe | `space-bunny-free`, `longcat-2.5-preview-free` | zero data retention per the provider |
| all other free models | everything else above | treat prompts as potentially retained or used for training |

Use `zdr-only` for any project with code or data you would not want retained. In a `zdr-only` project the mode wins over your preference: a `"prefer"` entry naming a model that is not ZDR-safe is dropped from the chain, and if that empties the chain the built-in ZDR-safe models are used instead with a one-time toast saying so. The router never sets a reasoning effort; do not configure `max` effort on the `muse-spark` free models (they have no max reasoning level).

## Limits

- `/free` cannot suppress the model turn: opencode always follows a command with one short assistant reply.
- OMO delegation: the model stamp is forward-compatible; today delegated agents mainly inherit the rerouted parent session.
- Free tiers are temporary, IP-locked and return 429 when exhausted; there is no quota API.
- No scheduled switching: routing changes only through the tag, the command or a config file.
- Session mode and session pins live in memory only and reset when opencode restarts.

## Development

```text
bun test/smoke.test.ts      # or: npx -y tsx test/smoke.test.ts
```

The smoke suite drives only the plugin's hook surface: it imports `free-model-router.ts` and never reaches into internals. It runs offline against the pinned catalog.

## License

GPL-3.0-only.