---
"@kiki/agent-core-v2": patch
"@kiki/cli": patch
---

`kimi -p` fills unset `bash_task_timeout_s`, `max_steps_per_turn`, and `subagent.timeout_ms` with finite values (10 minutes, 200 steps, and the 2-hour interactive default) instead of 0, so a headless run no longer turns an unlimited loop into an unbounded one (W4B-04). The print cron wait also respects the wall-clock ceiling deadline: a recurring cron task can no longer keep the process alive past `PRINT_WAIT_CEILING_S_DEFAULT` without a warning.
