# Interface overview

The desktop app and the browser UI are the same interface, and a session in either is built from three areas: the conversation view, the input box, and the right rail. This page is a tour of those three. For sessions, boards and drafts see [Workspace and session management](/en/guides/sessions); for the terminal version of the same concepts see [Interaction and input](/en/guides/interaction).

## Conversation view

This is the session timeline: assistant messages, tool calls, approvals, questions, and background-task notices.

Messages from another agent or conversation state their source above the body. Copying or quoting one uses the body without repeating that source label; editing keeps the original source prefix. A source label you type yourself stays literal.

Anything that has been resolved — a question you answered, an approval you granted, a marker — collapses into a compact one-line entry that stays where it happened. Several in a row fold into an **Activity history** row you can expand. Expanding or collapsing a conversation row keeps your reading position; scrolling takes over again. Failed and cancelled entries always stay visible on their own. Repeating markers such as goal updates show the latest one with a count ("Goal updated ×12") when nothing else separates them.

A subagent dispatch card expands children created during that particular run. Children from other runs, or whose creation time cannot be placed, stay under **Other subagents**, with their count and running or failed status. Open the group to see the same child cards. Resuming an older child does not make it newly created, and later status changes do not override your choice to open or close the group.

File references can be previewed, opened, or revealed in their folder. Reopening a session, or loading an agent's saved history, shows each model change as a divider naming the old and new model; a thinking-effort change on its own does not add one.

Long tool output and other large fields arrive in stages. **Continue loading** pulls in the rest of a truncated field, and the row tells you how much is loaded so far. If that fails on a field that has an original behind it — a tool's input or output, a background task's own output — the same row offers **Download original**, which writes the complete content to your machine and reports its own saving, saved, and retry states. Retrying stays available, and not every field can be downloaded.

## Input box

The input box accepts free-form text. `Enter` sends; `Shift-Enter` / `Ctrl-J` insert a newline. When it is empty, `↑` / `↓` browse what you have typed before in this working directory. You can paste images and video from the clipboard, as long as the current model accepts them — [Interaction and input](/en/guides/interaction) covers the details.

The **+** menu in the input box adds SSH hosts to the session. A joined host belongs to the session rather than to each message, so **Session SSH** stays above the input box for as long as one is joined: it lists them, removes one on **X**, and reopens the host list from its own row. Adding a host makes it available to the session; it does not connect to it. In a brand-new session the control reads **SSH to join**, and the hosts you pick are joined before the first message goes out.

The same menu's **Session** group carries **MCP servers ▸**, which lists every MCP server this conversation can see: the engine's own state for each one (connected, still connecting, waiting for sign-in, or the error it reported), the file or plugin it came from, and **Reconnect** where this conversation can retry it. Reading the list sends nothing and leaves your draft alone. The switch beside a row adds that server to this conversation or removes it from this conversation alone — the configuration and your other conversations are untouched, and the choice survives closing the panel. A server a plugin switches off for itself, or one whose runtime name another source owns, is shown without a switch, because the engine would refuse the write. Servers are configured for the workspace on the [MCP page](../server/mcp.md#configuration). **Rebuild context**, in the same group, reloads the agent's prompt sources without starting a new conversation — see [Rebuilding a session context](../customization/agents.md#rebuilding-a-session-context).

While the agent is busy, a message you submit joins the queue above the input box instead of interrupting. Each queued message carries its own timing — **when idle**, **after subagents**, or **after tasks** — and you can change it, edit the text, reorder, or send it right away from its row in the queue.

Scheduled prompts in the same queue have a **Scheduled job** label and a text preview. Select the preview to expand the full prompt text. Their text is read-only in the queue; messages you submit remain editable. A scheduled task set to **Queue** on the scheduled tasks page keeps the same reorder and send-now controls.

Waiting prompts set to **Insert when idle** share one group at the front of the queue, with each job's text and **Remove** action inside it. A prompt set to **Insert immediately** shows its timing on its own row. Both modes stay outside the ordinary send order, so they are not counted among messages waiting to send and have no reorder or send-now controls. **Remove** cancels only that pending occurrence; a recurring job stays scheduled and can fire again at its next scheduled time.

To pick the timing for a message you submit, hover the send button or focus it and press `↓`. Besides the default, you can send the message into the current turn so the agent reads it at its next safe step (the same as `Ctrl-Enter`), start it after the running subagents finish, or start it after all background tasks finish. When the main agent is blocked waiting on a foreground `AgentRun`, **Send now** moves that wait to the background without stopping the child, which still reports back when it completes; plain queueing does not. The timing you choose applies to that one message. The menu only appears while the agent is busy.

Stop the main agent before it has replied or called a tool and the interrupted prompt goes back into the session draft with its attachments, next to any edits you had not sent. A prompt the agent already answered or was steered by is not restored, and recovered attachments need the full prompt in the loaded transcript and stay in memory until you restart the app.

After a restart, queued messages come back held until you decide. **Send now** on one message sends only that one; **Resume queue** releases the rest. **Later** just hides the explanation — the resume button remains, and anything you submit meanwhile keeps queuing until you resume.

In a subagent's input box the stop button is disabled while the stop request is in flight. If it fails, the notice says why and the button comes back so you can retry. Stopping one run leaves the subagent's other queued messages alone.

## Approvals

An approval appears in the timeline before a protected operation runs, with the option to allow it once or for the session. Auto mode (the default) runs routine tool calls without asking and still asks for sensitive files and external links. Manual mode asks before shell commands and writes outside the workspace, while `Write` / `Edit` inside a trusted directory run without a per-file prompt. YOLO mode skips the sensitive-file prompt unless a deny rule covers it. Pressing `Esc` stops a tool call before it executes.

## Right rail

The rail describes one agent at a time — whichever you last clicked into or focused. The main agent and every subagent get the same page, and the rail follows you into a subagent's transcript. It shows what that agent is doing now, the items waiting on you as rows you can decide from, the activity feed, and a folded capabilities block.

The agent tree labels external executors beside each agent's name. An **off** thinking effort is shown only when it was explicitly selected.

**Dispatch capabilities** opens the panel showing how the agent hands work to subagents, and from there you can inspect a subagent's profile (its configuration file), route and executor, plus where its default model and thinking effort (how much reasoning the model invests) come from — see [Agents and subagents](../customization/agents.md#rebuilding-a-session-context).

On desktop-width screens the rail is open by default. **Standard / Cockpit** in its header widens it over the preview space while the conversation and composer stay in the main column; **Standard** or **Exit cockpit** puts the previous preview content, tabs, draft and width back.

The file pane previews workspace files and session attachments. Images open at full resolution and can be enlarged from the conversation. Their labels use the real filename when available, or **Image** otherwise. MP3, WAV, OGG, M4A, FLAC, AAC and Opus files use the built-in audio player, with original-file download available if the browser cannot play the codec.

Markdown and HTML files offer **Rendered / Source** views in the preview pane. HTML previews preserve scripts, styling, embedded fonts, relative resources and local storage in an isolated document sandbox without access to Kiki credentials, the parent interface or desktop bridges. HTML rendering needs a local connection to the server and a resource root containing the document; when access is unavailable, use **Source** or download the file.

PDF renders locally, including Chinese text and embedded fonts, without an extra renderer installation. Page changes retain the open PDF instead of downloading it again. DOCX, XLSX and PPTX use the Office plugin's OfficeCLI renderer. Use the page controls for Word and presentations, or select a worksheet for Excel.

If Office is missing, review and approve its installation plan in the preview. This installs only the Office plugin and its renderer, not the Work bundle. If you previously disabled Office, **Enable Office preview** makes that change explicit; an enabled plugin missing only OfficeCLI offers its renderer installation. Text and CSV previews identify themselves as source text and offer continuation when only part is loaded. Rendered document previews do not write back to the file; the source editor keeps its existing save controls where desktop editing is available.

Older `.doc`, `.xls`, `.ppt` and OpenDocument `.odt`, `.ods`, `.odp` files do not yet have an integrated page renderer. Use **Download original** or open the original locally rather than treating extracted text as its page layout. A preview failure offers retry without changing the source file.

## Sessions and workspaces

The session list groups sessions by workspace; pick one to resume, or start a new draft there. If a saved model, profile (the agent's configuration file) or effort is no longer available, the entry stays visible with a diagnostic instead of quietly switching you to a different model. [Workspace and session management](/en/guides/sessions) covers the rest.

Above the list sits the sidebar's own navigation — task board, scheduled tasks, memory, personas, usage and capabilities. The destinations you use stay visible; the rest wait under **More tools**, which expands in place and remembers whether you left it open. **Settings → General → Sidebar tools** decides which destinations stay visible, and the same list is in the View options menu at the top of the list.

## Next steps

- [Workspace and session management](/en/guides/sessions) — sessions, the task board, usage statistics
- [Memory](/en/guides/memory) — the three memory scopes and the `/memory` page
- [Settings pages](./settings.md) — a tour of the desktop settings categories
- [Interaction and input](/en/guides/interaction) — the TUI counterpart of these concepts
