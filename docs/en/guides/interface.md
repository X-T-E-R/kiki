# Interface overview

The desktop app and the browser UI are the same interface, and a session in either is built from three areas: the conversation view, the input box, and the right rail. This page is a tour of those three. For sessions, boards and drafts see [Workspace and session management](/en/guides/sessions); for the terminal version of the same concepts see [Interaction and input](/en/guides/interaction).

## Conversation view

This is the session timeline: assistant messages, tool calls, approvals, questions, and background-task notices.

Anything that has been resolved — a question you answered, an approval you granted, a marker — collapses into a compact one-line entry that stays where it happened. Several in a row fold into an **Activity history** row you can expand. Failed and cancelled entries always stay visible on their own. Repeating markers such as goal updates show the latest one with a count ("Goal updated ×12") when nothing else separates them.

A subagent dispatch card expands children created during that particular run. Children from other runs, or whose creation time cannot be placed, stay under **Other subagents**, with their count and running or failed status. Open the group to see the same child cards. Resuming an older child does not make it newly created, and later status changes do not override your choice to open or close the group.

File references can be previewed, opened, or revealed in their folder. Reopening a session, or loading an agent's saved history, shows each model change as a divider naming the old and new model; a thinking-effort change on its own does not add one.

Long tool output and other large fields arrive in stages. **Continue loading** pulls in the rest of a truncated field, and the row tells you how much is loaded so far. If that fails on a field that has an original behind it — a tool's input or output, a background task's own output — the same row offers **Download original**, which writes the complete content to your machine and reports its own saving, saved, and retry states. Retrying stays available, and not every field can be downloaded.

## Input box

The input box accepts free-form text. `Enter` sends; `Shift-Enter` / `Ctrl-J` insert a newline. When it is empty, `↑` / `↓` browse what you have typed before in this working directory. You can paste images and video from the clipboard, as long as the current model accepts them — [Interaction and input](/en/guides/interaction) covers the details.

The **+** menu in the input box adds SSH hosts to the session. A joined host belongs to the session rather than to each message, so **Session SSH** stays above the input box for as long as one is joined: it lists them, removes one on **X**, and reopens the host list from its own row. Adding a host makes it available to the session; it does not connect to it. In a brand-new session the control reads **SSH to join**, and the hosts you pick are joined before the first message goes out.

While the agent is busy, a message you submit joins the queue above the input box instead of interrupting. Each queued message carries its own timing — **when idle**, **after subagents**, or **after tasks** — and you can change it, edit the text, reorder, or send it right away from its row in the queue.

Scheduled prompts in the same queue have a **Scheduled job** label and a text preview. Select the preview to expand the full prompt text. Their text is read-only in the queue; messages you submit remain editable. A scheduled task set to **Queue** on the scheduled tasks page keeps the same reorder and send-now controls. One set to **Insert when idle** or **Insert immediately** is held outside the ordinary send order, so it is not counted among messages waiting to send; its row shows the selected timing and keeps the text readable and removable, without reorder or send-now controls.

To pick the timing for a message you submit, hover the send button or focus it and press `↓`. Besides the default, you can send the message into the current turn so the agent reads it at its next safe step (the same as `Ctrl-Enter`), start it after the running subagents finish, or start it after all background tasks finish. When the main agent is blocked waiting on a foreground `AgentRun`, **Send now** moves that wait to the background without stopping the child, which still reports back when it completes; plain queueing does not. The timing you choose applies to that one message. The menu only appears while the agent is busy.

Stop the main agent before it has replied or called a tool and the interrupted prompt goes back into the session draft with its attachments, next to any edits you had not sent. A prompt the agent already answered or was steered by is not restored, and recovered attachments need the full prompt in the loaded transcript and stay in memory until you restart the app.

After a restart, queued messages come back held until you decide. **Send now** on one message sends only that one; **Resume queue** releases the rest. **Later** just hides the explanation — the resume button remains, and anything you submit meanwhile keeps queuing until you resume.

In a subagent's input box the stop button is disabled while the stop request is in flight. If it fails, the notice says why and the button comes back so you can retry. Stopping one run leaves the subagent's other queued messages alone.

## Approvals

An approval appears in the timeline before a protected operation runs, with the option to allow it once or for the session. Auto mode (the default) runs routine tool calls without asking and still asks for sensitive files and external links. Manual mode asks before shell commands and writes outside the workspace, while `Write` / `Edit` inside a trusted directory run without a per-file prompt. YOLO mode skips the sensitive-file prompt unless a deny rule covers it. Pressing `Esc` stops a tool call before it executes.

## Right rail

The rail describes one agent at a time — whichever you last clicked into or focused. The main agent and every subagent get the same page, and the rail follows you into a subagent's transcript. It shows what that agent is doing now, the items waiting on you as rows you can decide from, the activity feed, and a folded capabilities block. **Dispatch capabilities** opens the panel showing how the agent hands work to subagents, and from there you can inspect a subagent's profile (its configuration file), route and executor, plus where its default model and thinking effort (how much reasoning the model invests) come from — see [Agents and subagents](../customization/agents.md#rebuilding-a-session-context).

On desktop-width screens the rail is open by default. **Standard / Cockpit** in its header widens it over the preview space while the conversation and composer stay in the main column; **Standard** or **Exit cockpit** puts the previous preview content, tabs, draft and width back.

The file pane offers read-only document previews for workspace files and session attachments. PDF renders locally, including Chinese text and embedded fonts, without an extra renderer installation. DOCX, XLSX and PPTX use the Office plugin's OfficeCLI renderer. Use the page controls for Word and presentations, or select a worksheet for Excel.

If Office is missing, review and approve its installation plan in the preview. This installs only the Office plugin and its renderer, not the Work bundle. If you previously disabled Office, **Enable Office preview** makes that change explicit; an enabled plugin missing only OfficeCLI offers its renderer installation. Text and CSV previews identify themselves as source text and offer continuation when only part is loaded. Previews never write back to the document.

Older `.doc`, `.xls`, `.ppt` and OpenDocument `.odt`, `.ods`, `.odp` files do not yet have an integrated page renderer. Use **Download original** or open the original locally rather than treating extracted text as its page layout. A preview failure offers retry without changing the source file.

## Sessions and workspaces

The session list groups sessions by workspace; pick one to resume, or start a new draft there. If a saved model, profile (the agent's configuration file) or effort is no longer available, the entry stays visible with a diagnostic instead of quietly switching you to a different model. [Workspace and session management](/en/guides/sessions) covers the rest.

## Next steps

- [Workspace and session management](/en/guides/sessions) — sessions, the task board, usage statistics
- [Memory](/en/guides/memory) — the three memory scopes and the `/memory` page
- [Settings pages](./settings.md) — a tour of the desktop settings categories
- [Interaction and input](/en/guides/interaction) — the TUI counterpart of these concepts
