# opencode-free-model-router

An [OpenCode](https://opencode.ai) plugin that routes chat turns to free-tier models served by both **opencode** (Zen) and **opencode-go** providers, featuring automatic 429 rate-limit failover, subagent inheritance, Zero Data Retention (ZDR) privacy policies, and customizable preference cascades.

Free-tier models are cost-effective for everyday development tasks, but can be temporary, rate-limited, or subject to prompt training. This plugin makes free routing fully opt-in per message, per session, and per project—while maintaining seamless fallback to paid models when quotas are exhausted.

---

## Install

You can install this plugin directly by pasting this repository's GitHub URL into any OpenCode chat session:

> *"Install the OpenCode free model router plugin from `https://github.com/soficis/opencode-free-model-router`"*

Install in **one scope only** (global `~/.config/opencode` OR project `<project>/.opencode`). OpenCode loads every copy it finds, and two copies run with unsynchronized session state.

| File | Destination |
| --- | --- |
| `free-model-router.ts` | `<config-dir>/plugins/free-model-router.ts` |
| `command/free.md` | `<config-dir>/command/free.md` |

`<config-dir>` is `~/.config/opencode` (Linux/macOS) or `%USERPROFILE%\.config\opencode` (Windows).

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

Restart OpenCode, then run `/free` — it should display the current routing status and candidate chain.

---

## Usage Guide

### 1. Per-Message Routing (`@free`)

Add `@free` to any message. You can optionally name a specific free model:

```text
@free explain this stack trace
@free space-bunny-free refactor this helper function
@free opencode-go/longcat-2.5-preview-free write a test suite
```

Model IDs may be written bare (`space-bunny-free`) or provider-qualified (`opencode/space-bunny-free` or `opencode-go/space-bunny-free`).

### 2. Session Toggles (`/free`)

Use the `/free` slash command to manage routing across an entire session:

| Command | Description |
| --- | --- |
| `/free on` | Routes all subsequent messages in this session to free models |
| `/free off` | Restores your configured paid model (default) |
| `/free auto` | Routes only allowlisted agent roles (default: `explore`) to free models |
| `/free <provider/model-id>` | Activates free routing and pins that model as the top choice |
| `/free` | Displays current mode, usage summary, and the ordered candidate chain |

### 3. Inspecting the Candidate Chain

Running `/free` with no arguments prints the active candidate chain:

```text
free: mode unchanged (off). Usage: /free on | /free off | /free auto | /free <provider/model-id>.
Candidates in order: 1. opencode/space-bunny-free (pin); 2. opencode/mimo-v2.6-flash-free (configured); 3. opencode/jev-1.13-free (built-in); +7 more.
```

---

## Choosing Which Free Model You Get (`prefer`)

By default, the router assigns sensible built-in models based on the agent role (e.g. `muse-spark-1.3-contributor-free` for coding and planning, `mimo-v2.6-flash-free` for general tasks).

You can define your own preference order using the `prefer` key in either config file:

| Scope | Path | Purpose |
| --- | --- | --- |
| **Global** | `~/.config/opencode/free-model-router.json` | Default preference across all your projects |
| **Project** | `<project>/.opencode/free-model-router.json` | Project-specific preference (overrides global) |

*(Set `OPENCODE_FREE_ROUTER_GLOBAL_CONFIG` environment variable to override the global config path).*

### Example Configuration

```json
{
  "prefer": {
    "default": ["opencode/space-bunny-free", "opencode/mimo-v2.6-flash-free"],
    "build": "opencode/muse-spark-1.3-contributor-free"
  }
}
```

Map preferences to specific agent roles (`build`, `plan`, `general`, `explore`, custom agents). `prefer` also accepts a bare model string or an ordered fallback list; use `"default"` (or `*`) as the catch-all. When a model hits a 429 rate limit, failover moves to the next model in the list.

### Resolution Order

When selecting a model for a turn, the router walks this chain and takes the first match: session pin (`/free <model-id>`, `@free <model-id>`) → project role → global role → project `"default"` → global `"default"` → built-in role default → remaining free catalog → your paid model.

### Automatic Routing Roles (`auto.roles`)

When session mode is `/free auto`, only specific agent roles are routed to free models, leaving primary coding turns (`build`, `plan`, `general`) on your paid model.

You can customize which roles route automatically via the `auto.roles` setting in project or global config:

```json
{
  "auto": {
    "roles": ["explore"]
  }
}
```

- **Schema**: `{"auto": {"roles": ["agent-name", ...]}}`. Bare arrays like `{"auto": [...]}` are invalid and trigger a warning.
- **Replace, not extend**: Setting `auto.roles` completely replaces the built-in default (`["explore"]`). To disable automatic routing entirely, set `"roles": []`.
- **Global & project cascade**: A project-level `auto.roles` takes precedence over global config. If not specified in the project, the global list is used; if neither is set, the default `["explore"]` applies.
- **Unroutable roles**: `title`, `compaction`, and `summary` cannot be routed because OpenCode calls LLMs directly for those tasks, bypassing the `chat.message` hook. Specifying them produces a configuration warning.
- **Privacy notice**: The `explore` agent searches and reads workspace files, sending file contents to the selected free-tier model. If prompt privacy or data retention is a concern, configure `"mode": "zdr-only"` to restrict routing to verified zero-data-retention models.

---

## Per-Project Privacy Policy (`mode`)

Create `<project>/.opencode/free-model-router.json` to enforce project-level boundaries:

```json
{
  "mode": "zdr-only"
}
```

| Mode | Behavior |
| --- | --- |
| `"all"` | Allows any free model (default when absent; displays a one-time prompt training risk toast). |
| `"zdr-only"` | **Zero Data Retention only**. Restricts routing strictly to verified ZDR models (`space-bunny-free`, `longcat-2.5-preview-free`). Automatically drops non-ZDR models from preference chains with a toast notification. |
| `"off"` | **Disables free routing**. `@free` tags are stripped and ignored, `/free` toggles are blocked, and all requests stay on paid models. |

> **Privacy Note**: `mode` is strictly project-scoped. Global configs cannot disable or force modes on individual projects.

---

## Catalog & Zero Data Retention Reference

Verified catalog models (as of September 2026):

| Provider | Model ID | ZDR-Safe (Zero Data Retention) |
| --- | --- | :---: |
| `opencode` | `space-bunny-free` | **Yes** |
| `opencode` | `longcat-2.5-preview-free` | **Yes** |
| `opencode-go` | `space-bunny-free` | **Yes** |
| `opencode-go` | `longcat-2.5-preview-free` | **Yes** |
| `opencode` | `jev-1.13-free` | No |
| `opencode` | `mimo-v2.6-flash-free` | No |
| `opencode` | `mimo-v2.5-free` | No |
| `opencode` | `muse-spark-1.3-contributor-free` | No |
| `opencode` | `muse-spark-1.2-contributor-free` | No |
| `opencode` | `ling-3.0-flash-fin-free` | No |
| `opencode` | `nemotron-3-ultra-free` | No |
| `opencode` | `nemotron-3.5-lightning-free` | No |
| `opencode` | `big-pickle` | No |

---

## Technical Invariants & Architecture

- **Single Default Export**: OpenCode scans `.ts` files in the plugin directory. Exporting non-functions causes OpenCode to fail with *"Plugin export is not a function"*. `free-model-router.ts` maintains exactly one default function export.
- **Single-Scope Loading**: OpenCode loads every copy of a plugin file it finds. Installing in both global and project directories causes double-execution with unsynchronized session states.
- **Non-Fatal Degradation**: Network failures, malformed JSON, and unknown model IDs degrade gracefully to safe defaults and issue descriptive toasts; they never crash the chat session.
- **Bounded Hooks**: All session resolution and network calls are wrapped with deadlines to prevent hanging the OpenCode TUI.

---

## Development & Testing

Run the hermetic smoke test suite:

```bash
bun test/smoke.test.ts
```

*(Or via Node/tsx: `npx -y tsx test/smoke.test.ts`)*

The suite exercises hook surfaces, tag parsing, 429 failover walks, project policy switching, subagent inheritance, and preference hierarchies entirely offline against pinned fixtures.

---

## License

GPL-3.0-only