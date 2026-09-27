# @moonshot-ai/agent-core-v2

## 0.4.1

### Patch Changes

- [`dd5cd6b`](https://github.com/X-T-E-R/kiki/commit/dd5cd6b510febafbf4e90d2e5561eb96546b0cca) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Open built-in skills as read-only SKILL.md preview tabs using their embedded content instead of treating `builtin://` URIs as host files. File-backed skills still open from their real paths.

- [`05e33fe`](https://github.com/X-T-E-R/kiki/commit/05e33fe90c5b330ae2925236d7355fb4b613bd8a) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Replace the remaining "Kimi Code" product strings with Kiki across the TUI banner, dialogs, CLI help and doctor output, web/server API titles, plugin descriptions, and the Nix package (which now installs `kiki`), keeping Kimi only for the provider platform and upstream credits.

- [`dc9cdbf`](https://github.com/X-T-E-R/kiki/commit/dc9cdbf9779d88ef74a8537fea23becae871b5f5) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Harden launch-surface paths: quote `cmd /c start` targets so `&` cannot split the command, refuse executable-looking hosts with trailing dots/spaces and additional single-document extensions in `open_host_path`, allowlist external-open schemes in the VS Code host bridge, keep non-loopback deep-link servers out of persisted Web UI connections, tighten the CORS origin loopback check against `127.*`-prefixed domains, and strip trailing root dots from FetchURL hosts before the donor metadata allowlist.

- [`b80dd87`](https://github.com/X-T-E-R/kiki/commit/b80dd8779092b5bc7131a0747a0d9aa7ff908616) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - `kimi -p` fills unset `bash_task_timeout_s`, `max_steps_per_turn`, and `subagent.timeout_ms` with finite values (10 minutes, 200 steps, and the 2-hour interactive default) instead of 0, so a headless run no longer turns an unlimited loop into an unbounded one (W4B-04). The print cron wait also respects the wall-clock ceiling deadline: a recurring cron task can no longer keep the process alive past `PRINT_WAIT_CEILING_S_DEFAULT` without a warning.

- [`e341a61`](https://github.com/X-T-E-R/kiki/commit/e341a61db26f03a789dc76c98973b5e162b307e1) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Session durability batch: the agent loop awaits the wire flush before a turn exits so the streamed step's `content.part` / `step.end` records land in `wire.jsonl` instead of dying with the process (W1B-01). `AppendLogStore` retries a failed durable append once so queued turns persist after a disk-full or lock conflict instead of living only in memory until the next append (W1B-02). The session event journal fsyncs every flush, requeues lines after a failed write, and `getBufferedSince` returns the new `resync_required(journal_gap)` reason when the durable tail has a seq hole, so clients resync from the snapshot instead of silently skipping events (W1B-06). `resyncRequired` gains the `journal_gap` reason in the protocol catalog and client types.

- [`5b06589`](https://github.com/X-T-E-R/kiki/commit/5b065892ee55fbfef048983a46bebc549135de2b) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Preserve the owner-only mode across config rewrites, close the Windows unlink window in atomic writes, and recover orphaned temp documents at startup.

  - `atomicWrite` (node-sdk and agent-core-v2) re-applies the requested mode after replacing an existing target, so a rewrite of `config.toml` / `credentials.toml` created with a drifted (looser) mode no longer widens it.
  - Windows atomic writes rename over the target first and fall back to unlink+rename only on `EPERM`, so a crash between unlink and rename no longer opens on every write.
  - `FileStorageService.read` promotes a surviving `*.tmp.<pid>.<hex>` sibling when the target is missing, so a config or session document killed mid-replace is recovered on next load instead of being lost.

- [`cfcc6bb`](https://github.com/X-T-E-R/kiki/commit/cfcc6bb995157fe722af341cc4562f11ff806df3) Thanks [@X-T-E-R](https://github.com/X-T-E-R)! - Prevent recursive file watchers from retrying indefinitely on persistent filesystem errors.

- Updated dependencies [[`dd5cd6b`](https://github.com/X-T-E-R/kiki/commit/dd5cd6b510febafbf4e90d2e5561eb96546b0cca), [`05e33fe`](https://github.com/X-T-E-R/kiki/commit/05e33fe90c5b330ae2925236d7355fb4b613bd8a), [`901f1c8`](https://github.com/X-T-E-R/kiki/commit/901f1c8c607d7640635c92c98eedead1848f1e25), [`e341a61`](https://github.com/X-T-E-R/kiki/commit/e341a61db26f03a789dc76c98973b5e162b307e1), [`ed55547`](https://github.com/X-T-E-R/kiki/commit/ed55547da4d8af6e85aa5ce9da2f7c0c28a9bad7)]:
  - @kiki/protocol@0.5.1
  - @kiki/oauth@0.4.1
  - @kiki/acp-client@0.0.2

## 0.4.0

### Minor Changes

- [#2351](https://github.com/MoonshotAI/kimi-code/pull/2351) [`6be2697`](https://github.com/MoonshotAI/kimi-code/commit/6be26978b123bacf1c5ebce52bbeb6f7b7ff0629) Thanks [@7Sageer](https://github.com/7Sageer)! - Add the Session-scoped `ISessionTitleService` for managed AI session titles: composes the excerpt sent to the platform chat_title tool from the main agent's conversation (the first user prompts, the strict `first_turn` pair, or the head+tail `digest` for multi-turn sessions; assistant segments keep only final text), persists the result with a `titleKind` (`replaceable` / `generated` / `custom`) that never overwrites a user-renamed title unless explicitly forced, and rebroadcasts `session.meta.updated`. Gated by the new experimental `auto_session_title` flag and a managed OAuth login.

### Patch Changes

- [#2911](https://github.com/MoonshotAI/kimi-code/pull/2911) [`249d8fa`](https://github.com/MoonshotAI/kimi-code/commit/249d8faa3447427665185a900926d048213d2ac7) Thanks [@7Sageer](https://github.com/7Sageer)! - Normalize provider tool call ids at the LLM ingestion boundary (`ToolCallIdNormalizer` in `llmRequester`): self-hosted endpoints may renumber ids per response, and a repeated id corrupted every downstream keying — dropped tool results in context rebuild, `duplicate_tool_call_dropped` in the strict projector, merged transcript frames, misrouted approvals. The first occurrence passes through unchanged; later ones are rewritten to a readable `<id>__<n>` suffix, kept consistent between streamed deltas and the finalized message, logged for provenance, and rolled back when the attempt fails so projection retries re-stream under the same ids. Interaction ids are additionally minted engine-side (`approval_<uuid>` / `question_<uuid>` / `user_tool_<uuid>`) instead of deriving from the provider toolCallId.

- Updated dependencies [[`6be2697`](https://github.com/MoonshotAI/kimi-code/commit/6be26978b123bacf1c5ebce52bbeb6f7b7ff0629), [`4a93f70`](https://github.com/MoonshotAI/kimi-code/commit/4a93f70aa2cf5f70a88b4f8eeb2e409aab2c8f59)]:
  - @moonshot-ai/kimi-code-oauth@0.4.0

## 0.3.2

### Patch Changes

- [#2815](https://github.com/MoonshotAI/kimi-code/pull/2815) [`43c68f5`](https://github.com/MoonshotAI/kimi-code/commit/43c68f58f578c88d9f503afb72f12d343c2aa5c7) Thanks [@liruifengv](https://github.com/liruifengv)! - Keep session updatedAt stable across metadata management writes: rename and archive/restore no longer bump it, fork inherits the source session's recency, and agent registration is non-touching; add SessionMeta.archivedAt (set on archive, cleared on restore) and surface it as archived_at through the session index and the v1/v2 session routes.

## 0.3.1

### Patch Changes

- [#2562](https://github.com/MoonshotAI/kimi-code/pull/2562) [`071b6a5`](https://github.com/MoonshotAI/kimi-code/commit/071b6a50d9c2ce9c4b45dc4d58dac1101b8c4f52) Thanks [@sailist](https://github.com/sailist)! - Serve v1 message history from the server layer and drop the engine-side legacy message adapter; the /api/v1 message contract is unchanged.

## 0.3.0

### Minor Changes

- [#2382](https://github.com/MoonshotAI/kimi-code/pull/2382) [`40172c7`](https://github.com/MoonshotAI/kimi-code/commit/40172c7ca96ca981b043b793588dd32e898979fa) Thanks [@liruifengv](https://github.com/liruifengv)! - Replace the bootstrap `clientVersion` with a required `clientIdentity` host identity object: the OAuth device-flow endpoints now send the full `X-Msh-*` device headers on every host, telemetry reads the client version from the same source, and the session export manifest gains an optional desktop version field.

### Patch Changes

- Updated dependencies [[`40172c7`](https://github.com/MoonshotAI/kimi-code/commit/40172c7ca96ca981b043b793588dd32e898979fa)]:
  - @moonshot-ai/kimi-code-oauth@0.3.0

## 0.2.0

### Minor Changes

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Let custom agent files restrict which sub-agent types they may delegate to (v2 engine only).

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Support custom agents defined as Markdown files with frontmatter, usable as the main agent or a sub-agent (v2 engine only).

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Add global tool gating to constrain which tools agents may use, with a per-session override (v2 engine only).

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Support overriding the default main-agent system prompt with a user-level file for every session (v2 engine only).

### Patch Changes

- [#2030](https://github.com/MoonshotAI/kimi-code/pull/2030) [`ec88d35`](https://github.com/MoonshotAI/kimi-code/commit/ec88d352e8f4dc5e8ffd1212f016138458f69893) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix catalog-imported Claude models being wrongly locked into always-on thinking, and stop offering a misleading thinking Off option for models that cannot truly disable reasoning (such as Gemini 3). Also normalizes configured thinking effort values and unifies context-usage reporting.

- [#1993](https://github.com/MoonshotAI/kimi-code/pull/1993) [`37eda4e`](https://github.com/MoonshotAI/kimi-code/commit/37eda4e59aebc8ecafa91be3f43f971ed63963a3) Thanks [@RealKai42](https://github.com/RealKai42)! - Add environment variable overrides for agent loop and background task limits. Set KIMI_LOOP_MAX_STEPS_PER_TURN, KIMI_LOOP_MAX_RETRIES_PER_STEP, or KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS to take priority over the [loop_control] and [background] config.

- [#1993](https://github.com/MoonshotAI/kimi-code/pull/1993) [`37eda4e`](https://github.com/MoonshotAI/kimi-code/commit/37eda4e59aebc8ecafa91be3f43f971ed63963a3) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix config environment overrides (such as KIMI_IMAGE_MAX_EDGE_PX or KIMI_SUBAGENT_TIMEOUT_MS) being persisted into config.toml by config API writes while the env var is set, and keeping the old value after the env var is changed to an invalid value or removed.

- [#1968](https://github.com/MoonshotAI/kimi-code/pull/1968) [`71bcfba`](https://github.com/MoonshotAI/kimi-code/commit/71bcfba54a6836f4b6d4e26babde67576b293a64) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix sessions getting stuck on every turn with a provider "message must not be empty" error after a content-filtered response.

- [#2015](https://github.com/MoonshotAI/kimi-code/pull/2015) [`b5efba7`](https://github.com/MoonshotAI/kimi-code/commit/b5efba7abcaf4041f81ec520097a61e6546e8c50) Thanks [@RealKai42](https://github.com/RealKai42)! - Fix thinking levels being offered for models that do not support them (e.g. phantom levels on Kimi K3): levels now come from each model's declared capabilities. Models that cannot disable reasoning (e.g. gpt-5) no longer offer an Off option, and turning thinking Off on models that support it (e.g. xai grok) now truly disables reasoning.

- [#1735](https://github.com/MoonshotAI/kimi-code/pull/1735) [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6) Thanks [@7Sageer](https://github.com/7Sageer)! - Warn when a tool allow/deny list entry can never match any tool, for example a misspelled name (v2 engine only).

- Updated dependencies [[`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6), [`ce0e3ce`](https://github.com/MoonshotAI/kimi-code/commit/ce0e3ceb04223bdaad8e8931bad46eff561055b6), [`a3699dd`](https://github.com/MoonshotAI/kimi-code/commit/a3699dd6aa7b41efd3129a117007d195282379fd)]:
  - @moonshot-ai/protocol@0.5.0

## 0.1.2

### Patch Changes

- [#1888](https://github.com/MoonshotAI/kimi-code/pull/1888) [`5ae60fa`](https://github.com/MoonshotAI/kimi-code/commit/5ae60fa6736b63b80bd764ef01d6c0334eb80595) Thanks [@sailist](https://github.com/sailist)! - Add a unified, agent-granular transcript rendering data layer and serve it from the v2 server: clients can fetch turn-paginated transcripts via `GET /sessions/{id}/transcript` and subscribe to per-agent transcript updates over the v1 WebSocket with per-connection granularity control (off / turn / block / delta). All transcript wire types are owned by the transcript package itself. `turn.started` now carries the turn's prompt text so live transcripts render the user input as soon as the turn opens.

## 0.1.1

### Patch Changes

- Updated dependencies [[`44f3341`](https://github.com/MoonshotAI/kimi-code/commit/44f334191989183d21920f6867c405581347c748), [`44f3341`](https://github.com/MoonshotAI/kimi-code/commit/44f334191989183d21920f6867c405581347c748), [`44f3341`](https://github.com/MoonshotAI/kimi-code/commit/44f334191989183d21920f6867c405581347c748), [`44f3341`](https://github.com/MoonshotAI/kimi-code/commit/44f334191989183d21920f6867c405581347c748)]:
  - @moonshot-ai/minidb@0.2.0

## 0.1.0

### Minor Changes

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Track the agent's live phase (idle, running, streaming, tool call, retrying, awaiting approval, interrupted, ended) as a single model field driven by the existing turn events, and carry it on the status update channel for downstream consumers.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Persist v2 wire records natively in the v1 record vocabulary and remove the persist-time rewrite layer: ops now write v1-shaped records directly (todo updates persist as `tools.update_store`, `turn.prompt` carries only `input`/`origin`, `usage.record` drops request context, `plan_mode.enter` carries only the plan id), live-only state (runtime phase, task/cron registries, context size, skill activations, runtime permission rules) is declared `persist: false` instead of being stripped at write time, and the swarm-mode exit reminder removal replays from the `swarm_mode.exit` record itself. This fixes resumed sessions losing the todo list, drifting turn counters after retries, and removed reminders reappearing after resume.

### Patch Changes

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Fix the v2 AskUserQuestion flow: answers now come back keyed by question text with option labels as values, aborting a turn or stopping a background question dismisses the pending question instead of leaking it, and duplicate question texts or option labels are rejected before the question is shown. The pending-question wire shape no longer carries a synthetic expires_at field.

- [#1638](https://github.com/MoonshotAI/kimi-code/pull/1638) [`7c889f3`](https://github.com/MoonshotAI/kimi-code/commit/7c889f3a960482cc9382203bda55d972b6fb6acd) Thanks [@RealKai42](https://github.com/RealKai42)! - In auto permission mode, plan exits are now marked as auto-approved (not user-reviewed) in both the tool result and the transcript, so the agent no longer treats automatic plan approval as a user signal to start executing.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Fix the production build by resolving internal module imports directly instead of through directory re-exports.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Reorganize the agent execution environment into separate filesystem, process and tool domains.

- [#1629](https://github.com/MoonshotAI/kimi-code/pull/1629) [`0527ca2`](https://github.com/MoonshotAI/kimi-code/commit/0527ca2267f8cf355d0c158953f3dbfc0c9692ac) Thanks [@sailist](https://github.com/sailist)! - Fix session fork losing everything except the conversation log: forked sessions now carry over media attachments, plan files, background task output, and cron tasks, and a failed fork no longer leaves a broken half-copy behind.

- [#1663](https://github.com/MoonshotAI/kimi-code/pull/1663) [`1294a0e`](https://github.com/MoonshotAI/kimi-code/commit/1294a0e1ad739151573163505f9c58afb2d543e4) Thanks [@7Sageer](https://github.com/7Sageer)! - Fix OAuth login hanging after browser authorization when the provider configuration changes during sign-in.

- [#1632](https://github.com/MoonshotAI/kimi-code/pull/1632) [`a4aae87`](https://github.com/MoonshotAI/kimi-code/commit/a4aae87cd9a240d3567601ed1a9aefaab540b075) Thanks [@sailist](https://github.com/sailist)! - Fix providers without a configured base_url being rejected: anthropic/openai and other protocol providers now fall back to their official default endpoints again, as before.

- [#1629](https://github.com/MoonshotAI/kimi-code/pull/1629) [`0527ca2`](https://github.com/MoonshotAI/kimi-code/commit/0527ca2267f8cf355d0c158953f3dbfc0c9692ac) Thanks [@sailist](https://github.com/sailist)! - Fix the v2 engine never activating tool-call deduplication: identical tool calls issued in the same step no longer execute multiple times, and repeated identical calls across steps receive escalating reminders again.

- [#1636](https://github.com/MoonshotAI/kimi-code/pull/1636) [`8027fe2`](https://github.com/MoonshotAI/kimi-code/commit/8027fe291b03fbfce6dc60aa06f8699ad0976ec5) Thanks [@sailist](https://github.com/sailist)! - Fix caller-supplied MCP servers being silently dropped when creating a session through the v2 engine (experimental).

- [#1636](https://github.com/MoonshotAI/kimi-code/pull/1636) [`8027fe2`](https://github.com/MoonshotAI/kimi-code/commit/8027fe291b03fbfce6dc60aa06f8699ad0976ec5) Thanks [@sailist](https://github.com/sailist)! - Make file tools able to reach skill directories outside the working directory in the v2 engine (experimental), and honor --skillsDir in v2 print mode and the server's skillDirs option.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Reroute the blob store backend from the host filesystem to the pluggable storage layer, so server-only deployments no longer require a local filesystem implementation.

- [#1637](https://github.com/MoonshotAI/kimi-code/pull/1637) [`0e0a6e9`](https://github.com/MoonshotAI/kimi-code/commit/0e0a6e9a5170c28c5e6809c1b2cf6d6f8904de73) Thanks [@sailist](https://github.com/sailist)! - Support caller-supplied MCP server configs on session create in the v2 engine (experimental), merged over the file config and under plugin servers.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Route FetchURL through the managed Kimi fetch service when the Kimi provider is logged in, with automatic fallback to local fetching on failure, and forward the host identity headers with the request.

- [#1634](https://github.com/MoonshotAI/kimi-code/pull/1634) [`96b8328`](https://github.com/MoonshotAI/kimi-code/commit/96b83281b2da3ee479b59e8a8da990708d1d6a30) Thanks [@sailist](https://github.com/sailist)! - Fix v2 managed OAuth login ignoring `KIMI_CODE_BASE_URL` / `KIMI_CODE_OAUTH_HOST`: the login environment is now resolved env-aware (v1 parity), so the credential slot a token is written to always matches the slot the runtime reads — no more "login succeeds but every call 401s" against non-default environments. The provisioned provider entry records the login environment and credential slot explicitly, and logout deletes from the runtime (env-aware) slot.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Hide image-compression captions from user-visible history: captions that prompt ingestion places inside a user message are rerouted through hidden system reminders (and stripped from session titles), while the model still receives the full note. ReadMediaFile is now registered in production whenever the bound model supports image or video input, re-registering on model switches.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Align v2 media reads with v1: the ReadMediaFile summary moves to the tool result's note side channel so raw `<system>` markup never renders in UIs, image dimensions are reported in the decoded EXIF-rotated space so portrait photos get correct coordinate guidance, the downscale cap rises from 2000px to 3000px with a gentler byte-budget fallback, and image compression and crop telemetry is reported for media reads.

- [#1633](https://github.com/MoonshotAI/kimi-code/pull/1633) [`5d1f904`](https://github.com/MoonshotAI/kimi-code/commit/5d1f9049cab84c0f40524a2382b085dfa976c866) Thanks [@sailist](https://github.com/sailist)! - Fix the v2 messages API serving broken history after resume: restored `blobref:` media URLs are rehydrated to inline `data:` URIs from the agent's blob store (matching live emissions), tool results carrying media (e.g. ReadMediaFile) pass their content parts through instead of being flattened to empty text, and `created_at` uses the wire record time instead of a synthesized session-start offset.

- [#1677](https://github.com/MoonshotAI/kimi-code/pull/1677) [`003e583`](https://github.com/MoonshotAI/kimi-code/commit/003e583d865d40ae7dbeb0f1e6b3974a63781950) Thanks [@sailist](https://github.com/sailist)! - Fix the v2 model catalog response omitting support_efforts and default_effort, restoring thinking-effort selection for clients connected to the v2 backend.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Fix the managed OAuth device-code login getting aborted when an unrelated provider refresh fires during the login flow.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Harden plugin management: degrade sessions gracefully when plugin state fails to load, clean up temp dirs and roll back the managed copy on failed installs, restore managed endpoint env for stdio plugin MCP servers, and make update checks concurrent with per-repo failure isolation.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Forward the host identity headers (User-Agent and device identity) with WebSearch requests, matching v1.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Align v2 engine telemetry with the v1 wire format: rename `tool_call_dedupe_detected` to `tool_call_dedup_detected`, carry mode/protocol tags on turn events, emit `turn_ended` unconditionally with interrupt reasons, add alias/protocol/input token fields to `api_error`, tag `tool_call` with `dup_type`, rename compaction usage fields to `input_tokens`/`output_tokens`, and add `context_projection_repaired`, `session_started`, and `session_load_failed` events.

- [#1602](https://github.com/MoonshotAI/kimi-code/pull/1602) [`09c1c32`](https://github.com/MoonshotAI/kimi-code/commit/09c1c3296059255a5074fa5d4dbb22fef14cdef9) Thanks [@kermanx](https://github.com/kermanx)! - Align the v2 engine with v1 on several parity gaps: the auto permission mode reminder is re-announced after compaction instead of being lost, goal reminders and the background-task reminder now match v1's exact text, and the goal tools are main-agent-only again.

- [#1441](https://github.com/MoonshotAI/kimi-code/pull/1441) [`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6) Thanks [@sailist](https://github.com/sailist)! - Report `video_upload` telemetry for ReadMediaFile video uploads — outcome, byte size, mime type, duration, and model/protocol tags; a failing telemetry sink never affects the upload.

- Updated dependencies [[`ceb158d`](https://github.com/MoonshotAI/kimi-code/commit/ceb158dc54586f254819edbc83c27e21dca1ecf6), [`0303b82`](https://github.com/MoonshotAI/kimi-code/commit/0303b82c3e691836163ecf906febfb6324c81d74)]:
  - @moonshot-ai/protocol@0.4.0
