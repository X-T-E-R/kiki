# Interface overview

The Kiki desktop app and the browser GUI (the same interface used in a browser) share the same interface. A session is built around three areas: the conversation view, the input box, and the right rail. This page orients you in the interface; see [Workspace and session management](/en/guides/sessions) for boards, drafts, and recovery, and [Interaction and input](/en/guides/interaction) for the TUI counterpart.

## Conversation view

The conversation view shows the session timeline: assistant messages, tool calls, approvals, questions, and background-task notices. Resolved questions, approvals, markers, and completion notices stay inline at their original position as compact one-line entries; consecutive entries fold into an expandable "Activity history" row, while failed or cancelled entries always remain individually visible. File references can be previewed, opened, or shown in their containing folder.

## Input box

The input box accepts free-form text. `Enter` sends; `Shift-Enter` / `Ctrl-J` insert a newline. When it is empty, `↑` / `↓` browse the input history for the current working directory. Images and videos can be pasted from the clipboard, subject to the current model's multimodal capabilities — see [Interaction and input](/en/guides/interaction) for the full behavior, which the GUI input box shares.

After a restart, restored queued messages wait for confirmation. Choose **Send now** on one message to send just that message, or **Resume queue** to release the queue. **Later** only collapses the explanation: the resume button stays visible while messages are held, and newly submitted messages may continue to queue until you resume.

In a subagent's input box, the stop button is disabled while its stop request is pending. If the request fails, an error notice explains why and the button becomes available to retry. Stopping one run does not clear unrelated messages waiting in that subagent's queue.

## Approvals

Shell commands appear as approval requests in the timeline; each request names the operation before it runs, and you approve once or for the session. Read-only operations run automatically by default. File writes follow the workspace trust model: in a trusted working directory, `Write` / `Edit` inside that directory run without per-file approval, while writes outside the workspace and sensitive-file access are blocked or require approval. Tool calls interrupted by `Esc` stop before execution.

## Right rail

The main agent's right rail holds the workspace selector, the requirements board entry (the fixed button at the bottom — see [the task board](/en/guides/sessions#requirements-board)), and the session panel showing the current agent's tool directory. Open **Dispatch capabilities** (the panel showing how the agent dispatches subagents) there to inspect a subagent's profile (configuration file), route, and executor, plus where the default model and thinking effort (how much reasoning the model invests) come from; see [Agents and subagents](../customization/agents.md#rebuilding-a-session-context).

## Sessions and workspaces

The session list groups sessions by workspace; pick one to resume or start a new draft. Saved model, profile (the agent's configuration file), and effort choices that are no longer available stay visible with a diagnostic so you can select a valid value — the GUI does not silently substitute another model. Details are covered in [Workspace and session management](/en/guides/sessions).

## Next steps

- [Workspace and session management](/en/guides/sessions) — sessions, the task board, usage statistics
- [Settings pages](./settings.md) — a tour of the desktop settings categories
- [Interaction and input](/en/guides/interaction) — the TUI counterpart of these concepts
