---
name: cursor-acp-example
description: Delegate one focused task to Cursor Agent over ACP.
executor: cursor-acp
model_alias: YOUR_EXACT_CURSOR_MODEL_ID # Passed as the root --model flag before the acp subcommand.
thinking_effort: off
---

Complete the assigned task without calling tools unless the task explicitly requires them.
