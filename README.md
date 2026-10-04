# opencode-free-model-router

Your OpenCode bill can drop to zero for the boring work.

This [OpenCode](https://opencode.ai) plugin sends chat turns to free-tier models from the **opencode** (Zen) and **opencode-go** providers. When a free model hits a 429 rate limit, the plugin tries the next one. When the free quota runs out, your paid model takes over.

Free models are cheap but come with strings. They can vanish. They can throttle you. Some train on your prompts. So free routing is opt-in. You choose per message, per session, or per project.

---

## Install

Paste this into any OpenCode chat:

> *"Install the OpenCode free model router plugin from `https://github.com/soficis/opencode-free-model-router`"*

Or install it by hand. Pick **one scope**: global (`~/.config/opencode`) or project (`<project>/.opencode`). OpenCode loads every copy it finds. Two copies run with unsynchronized session state.

| File | Destination |
| --- | --- |
| `free-model-router.ts` | `<config-dir>/plugins/free-model-router.ts` |
| `command/free.md` | `<config-dir>/command/free.md` |

`<config-dir>` is `~/.config/opencode` on Linux and macOS. On Windows it is `%USERPROFILE%\.config\opencode`.

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

Restart OpenCode. Run `/free`. It prints the routing status and the candidate chain.

---

## Use it

### Route one message (`@free`)

Add `@free` to a message. Optionally name a model.

```text
@free explain this stack trace
@free space-bunny-free refactor this helper function
@free opencode-go/longcat-2.5-preview-free write a test suite
```

Write model IDs bare (`space-bunny-free`) or with a provider (`opencode/space-bunny-free`, `opencode-go/space-bunny-free`).

### Route a whole session (`/free`)

| Command | Effect |
| --- | --- |
| `/free on` | Sends every later message in this session to free models |
| `/free off` | Returns to your paid model (the default) |
| `/free auto` | Sends only allowlisted agent roles to free models (default: `explore`) |
| `/free <provider/model-id>` | Turns free routing on and pins that model first |
| `/free` | Shows the mode, a usage summary, and the candidate chain |

### See the candidate chain

Run `/free` with no arguments:

```text
free: mode unchanged (off). Usage: /free on | /free off | /free auto | /free <provider/model-id>.
Candidates in order: 1. opencode/space-bunny-free (pin); 2. opencode/mimo-v2.6-flash-free (configured); 3. opencode/jev-1.13-free (built-in); +7 more.
```

---

## Pick your free model (`prefer`)

Without config, the router picks a built-in model for each agent role. `muse-spark-1.3-contributor-free` handles coding and planning. `mimo-v2.6-flash-free` handles general tasks.

You can override that. Add a `prefer` key to either config file:

| Scope | Path | Purpose |
| --- | --- | --- |
| **Global** | `~/.config/opencode/free-model-router.json` | Default for all your projects |
| **Project** | `<project>/.opencode/free-model-router.json` | Overrides global |

Set `OPENCODE_FREE_ROUTER_GLOBAL_CONFIG` to move the global file.

```json
{
  "prefer": {
    "default": ["opencode/space-bunny-free", "opencode/mimo-v2.6-flash-free"],
    "build": "opencode/muse-spark-1.3-contributor-free"
  }
}
```

Keys are agent roles: `build`, `plan`, `general`, `explore`, or your own. Values are a model string or an ordered fallback list. Use `"default"` (or `*`) as the catch-all. On a 429, the router moves to the next model in the list.

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

### Choose roles for `/free auto` (`auto.roles`)

In `/free auto` mode, only listed roles go to free models. Your main coding turns (`build`, `plan`, `general`) stay on your paid model.

```json
{
  "auto": {
    "roles": ["explore"]
  }
}
```

- **Schema:** `{"auto": {"roles": ["agent-name", ...]}}`. A bare array like `{"auto": [...]}` is invalid and triggers a warning.
- **Replace, not extend:** Your list replaces the built-in default (`["explore"]`). Set `"roles": []` to turn auto routing off.
- **Cascade:** Project config beats global config. With neither set, `["explore"]` applies.
- **Unroutable roles:** `title`, `compaction`, and `summary` cannot be routed. OpenCode calls the LLM directly for them and skips the `chat.message` hook. Listing them produces a warning.
- **Privacy:** The `explore` agent reads your workspace files and sends their contents to a free-tier model. If that worries you, set `"mode": "zdr-only"`.

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
| `"all"` | Allows any free model. This is the default. A one-time toast warns about prompt training. |
| `"zdr-only"` | Allows only verified Zero Data Retention models (`space-bunny-free`, `longcat-2.5-preview-free`). Drops other models from preference chains and shows a toast. |
| `"off"` | Disables free routing. `@free` tags are stripped and ignored. `/free` toggles are blocked. Every request stays on paid models. |

> **Privacy note:** `mode` is project-scoped only. A global config cannot force or disable a mode for a project.

---

## Catalog and ZDR reference

Verified models, as of October 2026:

| Provider | Model ID | ZDR-safe | Retention & Training Policy |
| --- | --- | :---: | --- |
| `opencode` | `space-bunny-free` | **Yes** | Zero-retention policy; no prompt training |
| `opencode` | `longcat-2.5-preview-free` | **Yes** | Zero-retention policy; no prompt training |
| `opencode-go` | `space-bunny-free` | **Yes** | Zero-retention policy; no prompt training |
| `opencode-go` | `longcat-2.5-preview-free` | **Yes** | Zero-retention policy; no prompt training |
| `opencode` | `fledge-alpha-free` | No | Free preview; collected data may be used to improve model |
| `opencode` | `ling-3.1-flash-free` | No | Free tier; collected data may be used to improve model |
| `opencode` | `ling-3.0-flash-fin-free` | No | Free tier; collected data may be used to improve model |
| `opencode` | `mimo-v2.6-flash-free` | No | Free tier; collected data may be used to improve model |
| `opencode` | `mimo-v2.5-free` | No | Free tier; collected data may be used to improve model |
| `opencode` | `nemotron-3-ultra-free` | No | NVIDIA trial endpoint; logged for security & service improvement |
| `opencode` | `nemotron-3.5-lightning-free` | No | NVIDIA trial endpoint; logged for security & service improvement |
| `opencode` | `muse-spark-1.3-contributor-free` | No | Contributor tier; prompts/completions train future Meta models |
| `opencode` | `muse-spark-1.2-contributor-free` | No | Contributor tier; prompts/completions train future Meta models |
| `opencode` | `big-pickle` | No | Stealth free model; collected data may be used to improve model |
| `opencode` | `jev-1.13-free` | No | Structured decision model; data retained per TypeSafe AI policy |

---

## Design rules

- **One default export.** OpenCode scans every `.ts` file in the plugin directory. A non-function export fails with *"Plugin export is not a function"*. `free-model-router.ts` exports exactly one default function.
- **One install scope.** OpenCode loads every copy it finds. Two copies double-execute with unsynchronized state.
- **Failures degrade, never crash.** Network errors, malformed JSON, and unknown model IDs fall back to safe defaults and show a toast. The chat session survives.
- **Hooks have deadlines.** Session resolution and network calls time out. The TUI never hangs.

---

## Test

Run the smoke suite:

```bash
bun test/smoke.test.ts
```

Or with Node: `npx -y tsx test/smoke.test.ts`

The suite runs offline against pinned fixtures. It covers hook surfaces, tag parsing, 429 failover, project policy switching, subagent inheritance, and preference order.

---

## License

GPL-3.0-only
