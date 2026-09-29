---
name: kiki-as-subagent
description: Delegate long-running work to Kiki from Claude Code, Codex desktop/TUI, or Grok Build using the Kiki MCP seat; track, notify, resume, and recover external children.
---

# Use Kiki as an external subagent

Use this skill when you are the **host agent** and want Kiki to own a bounded task. The tools are `kiki_*` from the existing `kiki mcp` server, not the host's own AgentRun/spawn_agent. A seat belongs to one workspace; reuse that workspace to reconnect. The Kiki daemon owns the dispatch after the host process exits. You must keep the dispatch ID (and `task_name` for named children) in the host's task notes.

## Set up a workspace seat

Install a working `kiki` executable on PATH and start a Kiki session/provider with an admitted named profile. Run `kiki seat install --client claude --workspace <absolute-workspace>` for Claude Code; it creates the workspace `.mcp.json`. For Codex, `kiki seat install --client codex --workspace <absolute-workspace>` **prints** TOML for manual insertion into the user's `config.toml`. For Grok, its `.mcp.json` discovery can use a workspace `.mcp.json` or configure `[mcp_servers.kiki]` in its user/project TOML. `kiki seat install --client generic` prints JSON for hosts that need it. Inspect any existing config before merging; installing a seat is separate from installing this skill.

Grant the host permission to call Kiki's MCP tools (or to start the Grok attach process); keep Kiki's **internal** permission ceiling at its default `manual`. The host's automatic tool allowance applies only to invoking Kiki; it does not approve a child tool. If `kiki_interactions` reports an approval or question, surface the decision to the user when appropriate, then submit it with `kiki_respond`. Do not silently approve a dangerous child action.

## Dispatch without blocking

1. Call `kiki_profiles` to choose an admitted profile/model. Use `kiki_dispatch` with `target: "named"`, a stable lowercase `task_name`, `profile_name`, a bounded `message` (task, workspace, expected artifact, completion evidence), and a unique `dispatch_key` for retry safety. It returns a `dispatchId` immediately; continue independent host work. Use `target: "main"` only with a dedicated seat.
2. Record `dispatchId`, `task_name`, workspace, and (for Codex) the host's thread ID. Call `kiki_list` for owned children and `kiki_status` for active-tool status. `kiki_send` sends a message to a named child; reuse the same `idempotency_key` only for the **same** message. To start a new turn on a completed named child use `kiki_dispatch` with the same `task_name`; `kiki_continue` continues from a terminal dispatch ID. Neither repeats an active dispatch.
3. For updates call `kiki_events({dispatch_id, cursor, detail:"lifecycle"})`. Events have an increasing `seq`; save the last `seq` after consuming an entire page, and repeat while `nextCursor` is present. `agent_notify` is the child's mid-run message (`message`, `messageId`). A terminal `completed|failed|cancelled|interrupted` event means inspect `kiki_status`, then `kiki_result` (page with `cursor`), or `kiki_transcript` for context. The `turn` detail stream has a **different** cursor. If `truncated_before_seq` has passed the saved cursor (last 5,000 lifecycle events retained), reconcile with `kiki_status` and the current result before restarting.
4. `kiki_wait({dispatch_id, timeout_s})` can return `timed_out` without stopping the child (maximum 600 seconds per call), or `interaction_pending` with an approval/question. Never turn a wait timeout into a duplicate dispatch. Use `kiki_cancel` only when abandoning the child; a cancel is not a continuation.

Tell the child to use **AgentNotify** sparingly for facts that change your plan before completion. It is delivered to the Kiki parent mailbox as usual and mirrored to the dispatch's `agent_notify` lifecycle event; completion is a separate terminal event. Check events even after a host-side wake, and use the event cursor for idempotency. For interactive approvals, `kiki_interactions` + `kiki_respond` is the Kiki-side protocol.

## Host wakeups

### Claude Code

In `.claude/settings.json` or user settings allow `mcp__kiki__*` (`permissions.allow`). Keep the `.mcp.json` Kiki server `timeout` at an hours-scale wall-clock value (milliseconds), and leave MCP automatic backgrounding on. `kiki_dispatch` is already short. When your host needs completion, call `kiki_wait` and let Claude Code 2.1.212+ background a long MCP call after its automatic-background threshold (default two minutes). An eventual `<task-notification>` wakes an idle interactive host; use the dispatch ID to read the result. A `timed_out` wait is a boundary: call it again if still interested. Noninteractive `-p` has different background behavior.

For **mid-run** wakeups, add a workspace `.claude/settings.json` hook (merge with existing settings, substitute the real workspace path):

```json
{"permissions":{"allow":["mcp__kiki__*"]},"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"kiki host-claude-rewake --workspace /absolute/workspace","async":true,"asyncRewake":true,"timeout":36000000}]}]}}
```

After `kiki_dispatch` call `kiki host-claude-bind --workspace <absolute-workspace> --dispatch <dispatch-id>` so the already-running hook sees this child. The hook tracks a per-dispatch cursor in `<workspace>/.kiki/host-claude/`, exits **2** on stderr only on a new `agent_notify`, and otherwise keeps watching until its timeout then exits **0**. A hook that exits 2 unconditionally will wake itself repeatedly. Claude labels this delivery a hook blocking error; explain that label to the user. Do not put credentials or private results in hook command arguments. A finished `kiki_wait` supplies terminal wakeups independently of the hook. MCP channels remain experimental and are not required here.

### Codex desktop / TUI

Copy the printed seat snippet into `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), adding under `[mcp_servers.kiki]`:

```toml
tool_timeout_sec = 30
default_tools_approval_mode = "approve"
```

Use **short MCP calls**, never an hours-long `kiki_wait`: progress notifications from MCP do not wake Codex. The host must be an active, non-ephemeral desktop/TUI daemon thread; `codex exec` and ephemeral threads cannot receive `codex queue`. Add this to Kiki's own `~/.kiki/config.toml` (merge existing hooks):

```toml
[[hooks]]
event = "Notification"
matcher = "external_delegation\\.(agent_notify|completed|failed|cancelled|interrupted)"
command = "kiki host-codex-queue"
```

After dispatch, get the **host's** Codex thread ID and call `kiki host-codex-bind --workspace <absolute-workspace> --dispatch <dispatch-id> --thread <codex-thread-id> --codex <absolute-path-to-codex-executable>`. `--codex` may be omitted if `codex` is on PATH. This binding catches up events emitted before it was written. The hook receives `dispatch_id` and workspace via stdin, consumes `kiki_events` from a durable cursor in `<KIKI_HOME>/host-codex/<workspace-hash>/` (outside the workspace, so repository files cannot replace the executable binding), and calls `codex queue --thread … --message …` once for each new AgentNotify or terminal event. Queueing wakes an idle thread and queues during a busy turn. If the daemon is down, queue fails and cursor stays before the undelivered event; run `kiki host-codex-queue --workspace <absolute-workspace> --dispatch <dispatch-id>` after it returns. If Kiki uses a nondefault home, pass the same `--home <dir>` to both bind and hook command. Test your installed `codex queue --help`: older Codex versions may not expose it.

### Grok Build

Configure the same `kiki mcp` seat for short dispatch/list/send/status/events calls. Merge the following into the workspace `.mcp.json` (or copy the output of `kiki seat install --client generic --workspace <absolute-workspace>`):

```json
{"mcpServers":{"kiki":{"command":"kiki","args":["mcp","--workspace","/absolute/workspace"]}}}
```

For a first background-terminal smoke test use `kiki host-attach --prompt-file <file>` with Grok's `run_terminal_command(is_background: true)`. It immediately prints an `ATTACH` line and exits with `DONE` when the print session ends; the host then receives a `task-completed-…` wakeup. The attached print process is killed with Grok, and Grok limits a background attachment to ten hours.

For durable tasks prefer `kiki_dispatch` over MCP, then start `kiki host-attach --workspace <absolute-workspace> --dispatch <dispatch-id>` through Grok's `monitor`. It reads the seat's ordered events, prints one `NOTIFY` line per `agent_notify`, prints `DONE` at terminal state, and exits. An attach restart resumes with `--cursor <last-seq>`; the Kiki dispatch keeps running when Grok or its monitor exits. Grok rate-limits monitor stdout (burst capacity 10, about one line every two seconds) and may drop notifications during active goal mode; read `kiki_events` after reconnect. If a monitor is unavailable, background terminal completion still wakes the host, but mid-run notifications require an explicit event read.

## Long runs and recovery

The Kiki child timeout defaults to **two hours**, independent of host/MCP/attachment timeouts. For a longer task set `[subagent].timeout_ms` to a task-appropriate value in Kiki config; `0` disables it. This is an explicit operator choice, not an automatic change. Keep the daemon alive while work is active.

If the host exits, reconnect to the **same workspace** and call `kiki_list`/`kiki_events` from the saved cursor; `kiki_status` identifies a completed/failed/cancelled/interrupted dispatch. If kap-server itself restarted, active dispatches become `interrupted` and do not automatically rerun: inspect the partial transcript, then `kiki_continue` (or dispatch the existing named child) with a new message explaining the recovery point. If a host's stdio MCP dies, restart that host's connection and use the same seat. For repeated tool/network errors, distinguish authentication (`seat` revoked or provider auth), server health, host notification bridge, and the child's own tool approval; restore the original MCP/monitor/queue channel before trying a new child. Do not copy a delegation token into a prompt or log.
