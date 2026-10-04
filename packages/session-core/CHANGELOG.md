# @kiki/session-core

## 0.1.0

### Minor Changes

- [`9f93819`](https://github.com/X-T-E-R/kiki/commit/9f93819347696d3b7ed718a8cff7d3be28c1ccaf) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Bring external-engine main sessions in line with native ones: engine and negotiated capabilities next to the session title, a read-only engine model in the composer instead of an "unavailable" error, fork and image entry points hidden only when the engine reports them unsupported, plan reviews rendered as plans with revise and reject-and-exit, an "Allow Kiki subagents" switch for external main profiles, and install plus Google sign-in for the Antigravity ACP CLI.

### Patch Changes

- [`dd5cd6b`](https://github.com/X-T-E-R/kiki/commit/dd5cd6b510febafbf4e90d2e5561eb96546b0cca) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Open built-in skills as read-only SKILL.md preview tabs using their embedded content instead of treating `builtin://` URIs as host files. File-backed skills still open from their real paths.

- [`44a9cc7`](https://github.com/X-T-E-R/kiki/commit/44a9cc7fc3b62c823828499db0fe5bdc9f222192) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Redo the first-run onboarding wizard: three focused steps where every Next saves the current step, Test connection probes the unsaved form values through kap-server's `POST /providers:probe` (falling back to a browser-direct fetch on older servers), and auto becomes the default permission mode for new GUI installs.

- [`50f0425`](https://github.com/X-T-E-R/kiki/commit/50f0425d17fbe99b6a9feeea42f84883928b7844) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Restore image and video previews for previously read local files in the conversation timeline.

- [`e341a61`](https://github.com/X-T-E-R/kiki/commit/e341a61db26f03a789dc76c98973b5e162b307e1) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Session durability batch: the agent loop awaits the wire flush before a turn exits so the streamed step's `content.part` / `step.end` records land in `wire.jsonl` instead of dying with the process (W1B-01). `AppendLogStore` retries a failed durable append once so queued turns persist after a disk-full or lock conflict instead of living only in memory until the next append (W1B-02). The session event journal fsyncs every flush, requeues lines after a failed write, and `getBufferedSince` returns the new `resync_required(journal_gap)` reason when the durable tail has a seq hole, so clients resync from the snapshot instead of silently skipping events (W1B-06). `resyncRequired` gains the `journal_gap` reason in the protocol catalog and client types.

- [`06633f4`](https://github.com/X-T-E-R/kiki/commit/06633f4e1a0dbcc849d96777f7830405636a2e7f) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Add a Media sources view under Capabilities → Plugins: one searchable list of every installed image, video and speech provider with its live status, a settings form per source that can use either the package's own key or a connection you already have, per-modality defaults, and the current session's recent media jobs with their files. A job whose submission could not be confirmed is reported as still possibly charging, and a stopped job says that only the local wait ended.

- [`cea9855`](https://github.com/X-T-E-R/kiki/commit/cea98554aaf8e590ae0a92901e688f26ee2b8161) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Correct the auto and yolo permission hints and treat an empty default model as unset.

- [`57bf267`](https://github.com/X-T-E-R/kiki/commit/57bf267bcbd28aaad2e26445255a75261dfec5bc) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Batch composer draft saves and reduce GUI rendering work in long sessions.

- [`4d89b93`](https://github.com/X-T-E-R/kiki/commit/4d89b93b78e883c8c3a56f17b61d6b42ee208f95) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - List rooms as thread-style rows in the sidebar conversation list: the standalone rooms group is gone, room rows carry a `#` mark and interleave with threads by recency (or file under their workspace), the row context menu adds members, budget, and pause ahead of the shared pin/rename/archive/delete entries, and the copied room link deep-opens the room page.

- [`d90a026`](https://github.com/X-T-E-R/kiki/commit/d90a0260bd95f99ded551d714415b9b15eb0d840) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Refine settings and capability copy across zh and en locales to eliminate internal jargon and meta-narratives.

- [`8d0a94a`](https://github.com/X-T-E-R/kiki/commit/8d0a94a926e9d8bba01b9f400871642ca1383940) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Keep the legacy "transcript"/"会话记录" search terms pointing at the fold-steps switch after its card merged into Composer.

- [`b889b10`](https://github.com/X-T-E-R/kiki/commit/b889b102b37c7027dd3c644d5afb764f4d7d3ac6) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Move the eleven long settings lists onto the shared list pattern: spaces, notification channels, permission rules, connections, request identities, search providers, model pricing, skills, installed plugins, MCP servers, and the agent team table all get the same toolbar (search with a live count, filter chips, sort, density), foldable groups with remembered folds, and consistent empty states. The skills catalog reads as one scannable list instead of a two-column grid with per-group "show all" toggles, and the agent team table's source groups fold while model and effort still edit in place.

- [`b1efab1`](https://github.com/X-T-E-R/kiki/commit/b1efab174ad703bbb31f6e845609e46faccc3389) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Default composer sends with Ctrl/Cmd+Enter and route every external URL through the system browser.

- [`06633f4`](https://github.com/X-T-E-R/kiki/commit/06633f4e1a0dbcc849d96777f7830405636a2e7f) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Keep the SSH hosts you add to a conversation in one place above the input instead of repeating them on every message. The Session SSH control stays visible for as long as the host is joined, so you can see, add and remove hosts at any time, and each message you send now carries only what you typed and attached. Hosts chosen on a new session are joined to it before your first message is sent, and messages sent before this change still read as you typed them.

- [`a1e3edb`](https://github.com/X-T-E-R/kiki/commit/a1e3edb4914345e04246773db1ab1e8e5d097595) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - A message injected by another agent now names the sender's role profile and model next to the sender label in the timeline, and hovering the label shows the sender agent id, profile, model and task.

- [`a36ca0d`](https://github.com/X-T-E-R/kiki/commit/a36ca0dc3acf2f22729f817ec20bd7650f3f055b) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Fold-steps toggle now applies instantly, folded step groups refresh when a member's state changes, and expanded groups keep the original step order.

- [`dafce3c`](https://github.com/X-T-E-R/kiki/commit/dafce3c71959d93b3c71bf9a84346d044adc0e19) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Move the fold-steps switch into the Composer settings card so the General section fits one 1280×800 screen again.

- Updated dependencies [[`dd5cd6b`](https://github.com/X-T-E-R/kiki/commit/dd5cd6b510febafbf4e90d2e5561eb96546b0cca), [`05e33fe`](https://github.com/X-T-E-R/kiki/commit/05e33fe90c5b330ae2925236d7355fb4b613bd8a), [`e341a61`](https://github.com/X-T-E-R/kiki/commit/e341a61db26f03a789dc76c98973b5e162b307e1)]:
  - @kiki/klient@0.1.3
  - @kiki/protocol@0.5.1
