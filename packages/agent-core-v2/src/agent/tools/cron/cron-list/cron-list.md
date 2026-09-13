List all cron jobs currently scheduled in this session.

Use this tool to inspect pending recurring and one-shot jobs scheduled with
`CronCreate`.

Each record carries:

- `id` — the task id (a ULID). Pass this to `CronDelete` to remove the
  task, or quote it in user-facing messages when asking for
  confirmation.
- `cron` — the verbatim 5-field cron expression as scheduled.
- `humanSchedule` — plain-English rendering (e.g. `every 5 minutes`).
- `prompt` — the scheduled prompt text, JSON-encoded so embedded
  newlines stay on one line. Truncated to 200 UTF-8 bytes with
  `…(truncated)` if longer. Use this to recall what a task is for
  after a context compaction, and as the source for the
  `CronCreate` refresh ritual.
- `nextFireAt` — local ISO timestamp with an explicit numeric offset for the
  next fire after jitter, or `null` if none occurs within 5 years.
- `recurring` — `true` for cadenced jobs, `false` for one-shots.
- `ageDays` — `(now - createdAt) / day`, two decimal places. Useful
  when deciding whether a long-running cron is still relevant.
- `stale` — `true` when a recurring task is older than 7 days. The system
  auto-deletes it after this final fire; `stale: true` marks that delivery.
  Recreate it with `CronCreate` using the original `cron` and `prompt` to
  resume. One-shots are never stale.

Guidelines:

- This tool is read-only and never mutates state, so it is always
  safe to call (including in plan mode).
- Users cannot directly manage cron tasks themselves; if they want to
  cancel or modify a schedule, route the request through the model
  (i.e. call `CronDelete` or `CronCreate` on their behalf).
- The empty case returns `cron_jobs: 0\nNo cron jobs scheduled.`. Cron
  tasks survive a resume of the same session but do not bleed into new
  sessions.
- After a context compaction, or whenever you are unsure which cron
  jobs are live, call this tool to re-enumerate them rather than
  guessing ids from earlier in the conversation.
- Records are separated by a line containing just `---`, in the
  insertion order they were scheduled.
