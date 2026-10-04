# Interface overview

The Kiki desktop app and the browser GUI (the same interface used in a browser) share the same interface. A session is built around three areas: the conversation view, the input box, and the right rail. This page orients you in the interface; see [Workspace and session management](/en/guides/sessions) for boards, drafts, and recovery, and [Interaction and input](/en/guides/interaction) for the TUI counterpart.

## Conversation view

The conversation view shows the session timeline: assistant messages, tool calls, approvals, questions, and background-task notices. Resolved questions, approvals, markers, and completion notices stay inline at their original position as compact one-line entries; consecutive entries fold into an expandable "Activity history" row, while failed or cancelled entries always remain individually visible. Consecutive identical marker dividers, such as goal updates, show only the latest entry with a repeat count (for example, "Goal updated ×12") when no message or tool call separates them. File references can be previewed, opened, or shown in their containing folder. Reopening a session or loading an agent's saved history shows model changes as dividers naming the previous and new model; changing only thinking effort does not add a divider.

Long tool output and other large fields load in stages. Choose **Continue loading** to pull in the rest of a field that was cut short, with the row reporting how much is loaded. When that loading fails on a field that has an original to fetch — a tool's input or output, or a background task's own output, for example — the same place offers **Download original**, which saves the field's complete original content to your machine and reports its own saving, saved, and retry states. Retrying stays available, and not every field can be downloaded.

## Input box

The input box accepts free-form text. `Enter` sends; `Shift-Enter` / `Ctrl-J` insert a newline. When it is empty, `↑` / `↓` browse the input history for the current working directory. Images and videos can be pasted from the clipboard, subject to the current model's multimodal capabilities — see [Interaction and input](/en/guides/interaction) for the full behavior, which the GUI input box shares.

Use the input box's **+** menu to add SSH hosts to the session. A host joined to a session is a resource of that session, not something each message carries, so the **Session SSH** control above the input box stays in place for as long as the host is joined: it lists the joined hosts, takes a host away on **X**, and opens the same host list from its own row to add or remove more. Adding a host makes it available to the session; it does not connect to it. In a new session (`/new`) the control reads **SSH to join**, and the selected hosts are joined to the created session before its first message is sent.

While the agent is busy, new messages join a queue above the input box by default instead of interrupting. Each queued message has its own send timing: **when idle** (as soon as the agent finishes its turn), **after subagents** (once the running subagents finish), or **after tasks** (once all background tasks finish). Change a message's timing, edit, reorder, or send it now from its row in the queue.

While the agent is busy, hover over the send button, or focus it and press `↓`, to open the send-timing menu. Alongside the default send action, you can choose to send the message into the current turn for reading at the next safe step boundary (the same behavior as `Ctrl-Enter`), start it after subagents finish, or start it after all background tasks finish. If the main agent is waiting for a foreground `AgentRun`, Send now releases that wait into background without stopping the child; the child still reports completion automatically. Ordinary queueing does not release the wait. The choice applies only to this message and does not change the default timing. The menu does not appear while the agent is idle.

Stopping the main agent before it has replied or called a tool restores the interrupted prompt and its attachments to the session draft, alongside any unsent edits. Already answered or steered prompts are not restored. Attachment recovery requires the complete prompt content to be available in the loaded transcript; recovered attachments stay in memory for the current app run.

After a restart, restored queued messages wait for confirmation. Choose **Send now** on one message to send just that message, or **Resume queue** to release the queue. **Later** only collapses the explanation: the resume button stays visible while messages are held, and newly submitted messages may continue to queue until you resume.

In a subagent's input box, the stop button is disabled while its stop request is pending. If the request fails, an error notice explains why and the button becomes available to retry. Stopping one run does not clear unrelated messages waiting in that subagent's queue.

## Approvals

Approvals appear in the timeline before a protected operation runs, with options to approve once or for the session. In the default Auto mode, routine tool calls run without asking; sensitive-file and external-link access still request approval. Manual mode asks before shell commands and workspace-external writes, while trusted-workspace `Write` / `Edit` calls run without per-file approval. YOLO mode skips sensitive-file prompts unless explicitly denied. Tool calls interrupted by `Esc` stop before execution.

## Right rail

The right panel describes one agent at a time: whichever you last clicked into or focused. The main agent and every subagent get the same page, and the same rail follows you into a subagent's transcript. It shows the agent's head over what it is doing now, the items waiting on you as rows you can decide from, the activity feed, and a folded capabilities block. From **Dispatch capabilities** (the panel showing how the agent dispatches subagents) you can inspect a subagent's profile (configuration file), route, and executor, plus where the default model and thinking effort (how much reasoning the model invests) come from; see [Agents and subagents](../customization/agents.md#rebuilding-a-session-context).

On desktop-width screens the panel is open by default, and **Standard / Cockpit** in its header temporarily widens it over the preview space while the conversation and composer stay in the main column. **Standard** or **Exit cockpit** restores the previous preview content, tabs, draft, and width.

## Sessions and workspaces

The session list groups sessions by workspace; pick one to resume or start a new draft. Saved model, profile (the agent's configuration file), and effort choices that are no longer available stay visible with a diagnostic so you can select a valid value — the GUI does not silently substitute another model. Details are covered in [Workspace and session management](/en/guides/sessions).

## Next steps

- [Workspace and session management](/en/guides/sessions) — sessions, the task board, usage statistics
- [Memory](/en/guides/memory) — the three memory scopes and the `/memory` page
- [Settings pages](./settings.md) — a tour of the desktop settings categories
- [Interaction and input](/en/guides/interaction) — the TUI counterpart of these concepts
