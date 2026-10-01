# opencode-free-model-router

An [OpenCode](https://opencode.ai) plugin that routes chat turns to free-tier models served by both **opencode** (Zen) and **opencode-go** providers, featuring automatic 429 rate-limit failover, subagent inheritance, Zero Data Retention (ZDR) privacy policies, and customizable preference cascades.

Free-tier models are cost-effective for everyday development tasks, but can be temporary, rate-limited, or subject to prompt training. This plugin makes free routing fully opt-in per message, per session, and per project—while maintaining seamless fallback to paid models when quotas are exhausted.

---

## Quick Install via OpenCode Chat (One-Prompt Setup)

You can install this plugin directly by pasting this repository's GitHub URL into any OpenCode chat session:

> *"Install the OpenCode free model router plugin from `https://github.com/<owner>/opencode-free-model-router`"*

### Instructions for OpenCode Agents / LLMs

When executing an installation request in an OpenCode session, follow these exact steps:

1. **Locate the OpenCode user configuration directory**:
   - **Linux / macOS**: `~/.config/opencode`
   - **Windows**: `~/.config/opencode` (or `%USERPROFILE%\.config\opencode`)

2. **Ensure destination directories exist**:
   - `<config-dir>/plugins/`
   - `<config-dir>/command/`

3. **Copy the two core files**:
   - Copy `free-model-router.ts` into `<config-dir>/plugins/free-model-router.ts`
   - Copy `command/free.md` into `<config-dir>/command/free.md`

4. **Verify Single-Scope Installation**:
   - Install in **one scope only** (global `~/.config/opencode` OR project `<project>/.opencode`). Do **not** install in both simultaneously, as OpenCode evaluates all copies and maintains independent session state.

5. **Verify Installation**:
   - Restart OpenCode or open a new session and enter `/free`. It should display the current routing status and candidate chain.

---

## Manual Installation

### Standalone File Copy (Recommended)

`free-model-router.ts` is completely self-contained with zero build steps and no external dependencies beyond OpenCode:

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

Restart OpenCode to activate the plugin.

---

## Features

- **Dual-Provider Discovery**: Automatically discovers free models from both `opencode` (Zen endpoint) and `opencode-go` CLI. Uses a 1-hour cache and falls back to a curated pinned catalog if offline.
- **Message-Level `@free` Tag**: Prefix any prompt with `@free` (e.g. `@free fix this bug`) to route that single turn to a free model. The tag is stripped before the model sees the prompt.
- **Session-Wide `/free` Command**: Toggle free routing for an entire session with `/free on` or revert with `/free off`. Run `/free` with no arguments to inspect the candidate fallback chain.
- **Automatic 429 Failover**: When a free model encounters an HTTP 429, `FreeUsageLimitError`, or rate-limit error during tool execution or delegation, the router immediately marks that model as failed and advances to the next candidate in your preference chain.
- **Clean Paid Fallback**: When all available free candidates have been exhausted, the router safely restores your configured paid model for subsequent turns and issues a one-time toast notification.
- **Subagent & Delegation Support**: Child sessions inherit the parent session's `/free on` mode. Injects free model routing into Oh-My-OpenCode delegations (`call_omo_agent`, `delegate_task`).
- **Zero Data Retention (ZDR) Enforcement**: Configure `"mode": "zdr-only"` to restrict routing strictly to confirmed zero-data-retention models (`space-bunny-free`, `longcat-2.5-preview-free`).
- **Flexible Preference Hierarchy**: Customize preferred models globally (`~/.config/opencode/free-model-router.json`) or per-project (`<project>/.opencode/free-model-router.json`). Supports single models, fallback lists, and per-agent role mappings.
- **Hot-Reloaded Configs**: Configuration files are re-read on file modification (mtime-checked), applying changes immediately on the next message without restarting OpenCode.

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
| `/free auto` | Reserved: sets auto mode |
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

### The Three Configuration Shapes

#### Shape 1: Single Preferred Model
```json
{
  "prefer": "opencode/space-bunny-free"
}
```

#### Shape 2: Ordered Fallback List
If the first model hits a 429 rate limit, failover moves directly to the second:
```json
{
  "prefer": [
    "opencode/space-bunny-free",
    "opencode/mimo-v2.6-flash-free",
    "opencode-go/longcat-2.5-preview-free"
  ]
}
```

#### Shape 3: Per-Agent Role Map
Map preferences to specific OpenCode agent roles (e.g. `build`, `plan`, `general`, `explore`, custom agents, or Oh-My-OpenCode agents). Use `"default"` (or `*`) as the catch-all:
```json
{
  "prefer": {
    "default": "opencode/space-bunny-free",
    "build": ["opencode/muse-spark-1.3-contributor-free", "opencode/mimo-v2.6-flash-free"],
    "plan": "opencode/muse-spark-1.3-contributor-free",
    "research": "opencode-go/longcat-2.5-preview-free"
  }
}
```

### Resolution Order

When selecting a model for a turn, the router evaluates the candidate list in this exact order:

1. **Session Pin**: Model set via `/free <model-id>` or `@free <model-id>`.
2. **Project Role Preference**: Matching role in `<project>/.opencode/free-model-router.json`.
3. **Global Role Preference**: Matching role in `~/.config/opencode/free-model-router.json`.
4. **Project Default Preference**: `"default"` in project config.
5. **Global Default Preference**: `"default"` in global config.
6. **Built-in Role Defaults**: Built-in default for that role.
7. **Remaining Free Catalog**: Unexhausted free models in the catalog.
8. **Paid Model Restoration**: Restores paid model once all free options fail.

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