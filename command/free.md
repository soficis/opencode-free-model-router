---
description: Flip this session between free and paid model routing (on, off, auto, or provider/model-id)
---

Arguments received: $ARGUMENTS

Usage (sticky per session; the router replies with the mode that is now active):
- `/free on` - route this session's messages to free models
- `/free off` - restore the paid model (default)
- `/free auto` - reserved: sets mode auto, which does not route on its own yet
- `/free <provider/model-id>` - turn free routing on and record that id as this session's preferred free model id

Limits: this command cannot suppress the model turn. opencode always follows a command with one short assistant reply, so each invocation costs a small amount of tokens; the reply is only a status echo of the mode above, and the mode lives in memory for this session only.
