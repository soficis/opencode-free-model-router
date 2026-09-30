# opencode-free-model-router

An [opencode](https://opencode.ai) plugin that routes chat turns to the free-tier models served by both the **opencode** (Zen) and **opencode-go** providers, and falls back down the list when a free model is rate limited.

Free tiers are useful but temporary, IP-locked and rate limited, and some free models may use your prompts for training. This plugin makes using them opt-in per message, per session and per project.

## Features

- **Dual provider** - discovers free models from both `opencode` and `opencode-go` (hourly cache; a pinned list is used when discovery fails).
- **`@free` tag** - put `@free` (optionally followed by a free model id) in a message to route that message. The tag is stripped before the model sees it.
- **`/free` command** - `/free on|off|auto|<provider/model-id>` switches routing for the current session. `/free` with no argument shows a catalog summary toast.
- **Delegation** - while `/free on`, `call_omo_agent` / `delegate_task` calls (oh-my-opencode) are stamped with a free model. Core `task` subagents that pin a model keep it; unpinned ones inherit the rerouted session.
- **429 failover** - when a tool result shows `429`, `FreeUsageLimitError`, a rate-limit or quota error while a free model is active, that model is marked failed for the session and the next free candidate is used. When every candidate has failed, the original paid model is restored once and a notice is produced. Failed ids are kept only for the session that hit them.
- **Per-project policy** - `<project>/.opencode/free-model-router.json` controls what the project allows (see below).

## Install

Pick one route. Install in **one** scope only: opencode loads every copy it finds, and two copies keep separate session state.

### Copy the files

```text
free-model-router.ts  ->  ~/.config/opencode/plugins/free-model-router.ts
lib.ts                ->  ~/.config/opencode/plugins/lib.ts
command/free.md       ->  ~/.config/opencode/command/free.md
```

(Use `<project>/.opencode/plugins` and `<project>/.opencode/command` instead for a project-only install.)

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
/free                                  show the free-catalog summary
```

Without a tag or a preferred id, the model is chosen from the session's agent role (for example `deepseek-v4-flash-free` for code/plan/subagent roles, `muse-spark-1.3-contributor-free` for research/writing, `mimo-v2.6-flash-free` otherwise) when that model is currently free.

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

An invalid file falls back to `all` with a warning toast. The file is re-read when its modification time changes.

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

Use `zdr-only` for any project with code or data you would not want retained. The router never sets a reasoning effort; do not configure `max` effort on the `muse-spark` free models (they have no max reasoning level).

## Limits

- `/free` cannot suppress the model turn: opencode always follows a command with one short assistant reply.
- OMO delegation: the model stamp is forward-compatible; today delegated agents mainly inherit the rerouted parent session.
- Free tiers are temporary, IP-locked and return 429 when exhausted; there is no quota API.
- No scheduled switching: routing changes only through the tag, the command or the project file.
- Session mode lives in memory only and resets when opencode restarts.

## Development

```text
bun test/smoke.test.ts      # or: npx -y tsx test/smoke.test.ts
```

The smoke suite imports only `lib.ts`.

## License

GPL-3.0-only.
