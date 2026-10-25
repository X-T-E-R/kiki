Cancel a scheduled cron job by id.

Use this tool to remove a cron task previously scheduled with
`Cron({action:"create",cron:...,prompt:...})`. The `id` is the ULID value returned by `Cron({action:"create",cron:...,prompt:...})`, or
shown in the `id:` column of `Cron({action:"list"})` — quote it verbatim, no
prefix.

Behaviour by task kind:

- **Recurring task** (`recurring: true`): stops all future fires
  immediately. The scheduler picks up the deletion on its next tick.
- **One-shot task** (`recurring: false`): cancels the pending fire if
  it has not happened yet. One-shots that have already fired
  auto-delete themselves, so calling `Cron({action:"delete",id:...})` on a fired one-shot
  returns "no cron job with id ...".

Not-found is reported as an error (not a silent no-op) so you can
correct yourself — typically by calling `Cron({action:"list"})` to see which ids
are actually live, rather than re-trying with the same stale id.

Refresh pattern (use when you want a stale recurring schedule to continue):

Stale recurring tasks auto-delete after their final fire. Recreate one with
`Cron({action:"create",cron:...,prompt:...})` using the same `cron` and `prompt`; `Cron({action:"list"})`'s `prompt` field
helps recover the original text after a context compaction.

`Cron({action:"delete",id:...})` is for live tasks: recurring tasks not yet stale and pending
one-shots.

Guidelines:

- Users have no direct `/cron` command or self-service UI to delete
  tasks themselves; they must ask the model to cancel a reminder.
  When deleting on behalf of a user, confirm the action and report
  the result plainly.
- Cron deletion is irreversible — there is no undo. If you delete the
  wrong task, you must re-create it with `Cron({action:"create",cron:...,prompt:...})`.
- If the model is unsure which id is current (e.g. after a context
  compaction), call `Cron({action:"list"})` first rather than guessing.
