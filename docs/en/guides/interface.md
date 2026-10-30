# Interface overview

The desktop app and the browser UI are the same interface, and a session in either is built from three areas: the conversation view, the input box, and the right rail. This page is a tour of those three. For sessions, boards and drafts see [Workspace and session management](/en/guides/sessions); for the terminal version of the same concepts see [Interaction and input](/en/guides/interaction).

## Conversation view

This is the session timeline: assistant messages, tool calls, approvals, questions, and background-task notices.

If a turn ends without a reply, its footer says whether background work is still running, no work is executing, or the activity is unknown. If **Send again** is available, it restores the original message text to the input box without sending it.

Messages from another agent or conversation show the source title above the body, falling back to its task name or short ID when no title is available. Hover over the label to see its full identity; select it to open the source agent or a conversation available in the current connection. Copying or quoting uses the body without repeating the label; editing keeps the original source prefix. A source label you type yourself stays literal. Context injected after a user message stays after that message when you reopen or continue loading the conversation.

Anything that has been resolved — a question you answered, an approval you granted, a marker — collapses into a compact one-line entry that stays where it happened. A question keeps that position while awaiting your answer and as the conversation continues; expand its entry to read the saved question and answer. Several in a row fold into an **Activity history** row you can expand. Expanding or collapsing a conversation row keeps your reading position; scrolling takes over again. Failed and cancelled entries always stay visible on their own. Repeating markers such as goal updates show the latest one with a count ("Goal updated ×12") when nothing else separates them.

A subagent dispatch card expands children created during that particular run. Children from other runs, or whose creation time cannot be placed, stay under **Other subagents**, with their count and running or failed status. Open the group to see the same child cards. Resuming an older child does not make it newly created, and later status changes do not override your choice to open or close the group.

File references can be previewed, opened, or revealed in their folder. Reopening a session, or loading an agent's saved history, shows each model change as a divider naming the old and new model; a thinking-effort change on its own does not add one.

Click an image to open one viewer. Use the previous/next controls or `←` / `→` to browse images from that agent's loaded conversation. Long images fit the width and scroll vertically; click the image or use the size control to switch to actual size, where you can drag to pan.

Choose **Annotate image** below the image to enter **Annotation mode**. The bottom toolbar offers arrows, rectangles, freehand marks, selection and undo; **Done** keeps the marks in the viewer, while **Cancel** discards the current edits. Right-click, or press `Shift-F10`, to copy or save the image; annotations can be saved separately as a PNG without changing the original. Link and path actions appear only when the source has them, and local open/reveal actions are available only for local files on a host that supports them. If an image fails to load, retry it or continue to another image.

Long tool output and other large fields arrive in stages. **Continue loading** pulls in the rest of a truncated field, and the row tells you how much is loaded so far. If that fails on a field that has an original behind it — a tool's input or output, a background task's own output — the same row offers **Download original**, which writes the complete content to your machine and reports its own saving, saved, and retry states. Retrying stays available, and not every field can be downloaded.

## Input box

The input box accepts free-form text. `Enter` sends; `Shift-Enter` / `Ctrl-J` insert a newline. You can paste images and video from the clipboard, as long as the current model accepts them — [Interaction and input](/en/guides/interaction) covers the details.

In an existing conversation, changing **Approvals**, switching between **Normal** and **Plan**, or changing the Plan gate saves immediately, without sending a message. With native execution, the next tool approval uses the new permission mode, Plan mode's restrictions apply to subsequent tool calls in the running turn, and the gate controls the next plan submission. A request already waiting for approval still needs your decision. If saving fails, the control returns to the session's reported setting and shows the error.

Changing a native model or thinking effort also needs no message: the current request finishes, and the new binding applies before the next model request. The pending indicator names the change; open the queue to cancel it before preparation starts. A failed switch keeps the current binding and shows the error. **Default** clears the manual effort and restores the persona's pinned effort, then the selected model's profile default, then the model default. A profile or engine change remains attached to your next message.

`↑` and `↓` move the caret inside the draft, including on a wrapped line. They browse earlier prompts only from the start of the text (`↑`) or the end (`↓`): this conversation keeps its own list, and the new-session page keeps one for that workspace. A text selection, `Shift`, an IME composition, or an open `/` or `@` menu keeps the key. `Esc`, or `↓` past the newest entry, restores the draft from before that browse.

Select a passage in the conversation and choose **Quote** to add it above the input box. You can add several passages and remove each one separately. Sending includes those passages; references added while a send is awaiting confirmation stay in the draft. Type `@` to find workspace files, then choose **Load more** or scroll to the end of the matches to load another page.

The **+** menu in the input box adds SSH hosts to the session. A joined host belongs to the session rather than to each message, so **Session SSH** stays above the input box for as long as one is joined: it lists them, removes one on **X**, and reopens the host list from its own row. Adding a host makes it available to the session; it does not connect to it. In a brand-new session the control reads **SSH to join**, and the hosts you pick are joined before the first message goes out.

The same menu's **Session** group carries **MCP servers ▸**, which lists every MCP server this conversation can see: the engine's own state for each one (connected, still connecting, waiting for sign-in, or the error it reported), the file or plugin it came from, and **Reconnect** where this conversation can retry it. Reading the list sends nothing and leaves your draft alone. The switch beside a row adds that server to this conversation or removes it from this conversation alone — the configuration and your other conversations are untouched, and the choice survives closing the panel. Before the first message, server choices stay in the draft and apply before that message starts. A server a plugin switches off for itself, or one whose runtime name another source owns, is shown without a switch, because the engine would refuse the write. Servers are configured for the workspace on the [MCP page](../server/mcp.md#configuration). **Rebuild context**, in the same group, reloads the agent's prompt sources without starting a new conversation — see [Rebuilding a session context](../customization/agents-and-subagents.md#rebuilding-a-session-context).

While the agent is busy, a message you submit joins the queue above the input box instead of interrupting. Each queued message carries its own timing — **when idle**, **after subagents**, or **after tasks** — and you can change it, edit the text, reorder, or send it right away from its row in the queue. Editing restores the message's selected passages and original image previews, including after a restart. **Cancel** returns to your previous draft and selections; if an original image is unavailable, the edit reports the problem and leaves the queued message intact.

Scheduled prompts in the same queue have a **Scheduled job** label and a text preview. Select the preview to expand the full prompt text. Their text is read-only in the queue; messages you submit remain editable. A scheduled task set to **Queue** on the scheduled tasks page keeps the same reorder and send-now controls.

Waiting prompts set to **Insert when idle** share one group at the front of the queue, with each job's text and **Remove** action inside it. A prompt set to **Insert immediately** shows its timing on its own row. Both modes stay outside the ordinary send order, so they are not counted among messages waiting to send and have no reorder or send-now controls. **Remove** cancels only that pending occurrence; a recurring job stays scheduled and can fire again at its next scheduled time.

To pick the timing for a message you submit, hover the send button or focus it and press `↓`. Besides the default, you can send the message into the current turn so the agent reads it at its next safe step (`Ctrl-Enter` with the default send shortcut), start it after the running subagents finish, or start it after all background tasks finish. The timing you choose applies to that one message. The menu only appears while the agent is busy.

Ordinary queued messages run one at a time in queue order, each in its own turn. The next message starts only after the preceding turn finishes. With the native executor, messages you explicitly send into the current turn at the same safe step can still share one model input. Steering and submit hooks run once for that batch; each original message keeps its own history entry and result.

A profile or engine change needs a separate turn even with **Send now**. Steered messages with different execution settings are not batched together. For external engines, the handshake determines whether sending into the current turn is available. AGY CLI delivers the message at its next model call in the same turn; if the turn ends first, Kiki keeps the message queued for the next turn. For any external engine, Kiki waits up to 60 seconds for a running tool call to finish before sending; otherwise the message stays queued. If delivery is unconfirmed, the queue pauses: check the timeline before deciding whether to resume it.

When the main agent is blocked waiting on a foreground `AgentRun`, **Send now** moves that wait to the background without stopping the child, which still reports back when it completes; plain queueing does not.

Stop the main agent before it has replied or called a tool and the interrupted prompt goes back into the session draft with its attachments, next to any edits you had not sent. A prompt the agent already answered or was steered by is not restored, and recovered attachments need the full prompt in the loaded transcript and stay in memory until you restart the app.

After a restart, queued messages come back held until you decide. **Send now** on one message sends only that one; **Resume queue** releases the rest. **Later** just hides the explanation — the resume button remains, and anything you submit meanwhile keeps queuing until you resume.

A native subagent's **Approvals** and **Plan** controls apply immediately to that agent alone; its permission ceiling still applies. External subagents show an explanation instead of these controls because their executor owns those modes.

In a subagent's input box the stop button is disabled while the stop request is in flight. If it fails, the notice says why and the button comes back so you can retry. Stopping one run leaves the subagent's other queued messages alone.

## Approvals

An approval appears in the timeline before a protected operation runs, with the option to allow it once or for the session. Auto mode (the default) runs routine tool calls without asking and still asks for sensitive files and external links. Manual mode asks before shell commands and writes outside the workspace, while `Write` / `Edit` inside a trusted directory run without a per-file prompt. YOLO mode skips the sensitive-file prompt unless a deny rule covers it. Pressing `Esc` stops a tool call before it executes.

## Right rail

The rail describes one agent at a time — whichever you last clicked into or focused. The main agent and every subagent get the same page, and the rail follows you into a subagent's transcript. It shows what that agent is doing now, items waiting on you, the activity feed, and two independently folded capability sections.

For the native executor, the context overview uses the selected agent's current effective model limit, including its bound profile and recipe constraints. Changing that model's configured limit refreshes the window, percentage and automatic-compaction point in open main and subagent views. An unavailable limit leaves the token count visible without a percentage; recorded usage for earlier turns stays unchanged.

The agent tree labels external executors beside each agent's name. An **off** thinking effort is shown only when it was explicitly selected.

**Capability inventory** has **Tools**, **Skills**, and **Subagents** tabs. The tools list includes plugin and MCP tools. Each subagent row names the profile and route, and whether that child can be launched now. Who this agent may start is set on the profile under **Child agents** — see [Dispatch capabilities](./settings.md#dispatch-capabilities).

**Capability controls** holds plugin usage, system-capability switches, and MCP server choices for this conversation. These controls stay separate from the inventory. Enabling **Browser** allows browser tools within the current tool policy; browser settings show the available connections and any connection failures. Ego Lite uses the native `browser__ego_run` tool rather than a separate list of typed page tools.

**IM conversation** lists the channels bound to this conversation, with a separate switch for each binding. Channels from one account, including Telegram topics, can belong to different conversations. An unrelated account's reconnecting state does not appear here. When an incoming channel is awaiting confirmation, **Bind here** explicitly links it to this conversation.

On desktop-width screens the rail is open by default. **Standard / Cockpit** in its header widens it over the preview space while the conversation and composer stay in the main column; **Standard** or **Exit cockpit** puts the previous preview content, tabs, draft and width back.

The file pane previews workspace files and session attachments. Images open at full resolution and can be enlarged from the conversation. Their labels use the real filename when available, or **Image** otherwise. MP3, WAV, OGG, M4A, FLAC, AAC and Opus files use the built-in audio player, with original-file download available if the browser cannot play the codec.

Markdown and HTML files offer **Rendered / Source** views in the preview pane. HTML previews preserve scripts, styling, embedded fonts, relative resources and local storage in an isolated document sandbox without access to Kiki credentials, the parent interface or desktop bridges. HTML rendering needs a local connection to the server and a resource root containing the document; when access is unavailable, use **Source** or download the file.

PDF renders locally, including Chinese text and embedded fonts, without an extra renderer installation. Page changes retain the open PDF instead of downloading it again. DOCX, XLSX and PPTX use the Office plugin's OfficeCLI renderer. Use the page controls for Word and presentations, or select a worksheet for Excel.

If Office is missing, review and approve its installation plan in the preview. This installs only the Office plugin and its renderer, not the Work bundle. If you previously disabled Office, **Enable Office preview** makes that change explicit; an enabled plugin missing only OfficeCLI offers its renderer installation. Text and CSV previews identify themselves as source text and offer continuation when only part is loaded. Rendered document previews do not write back to the file; the source editor keeps its existing save controls where desktop editing is available.

Older `.doc`, `.xls`, `.ppt` and OpenDocument `.odt`, `.ods`, `.odp` files do not yet have an integrated page renderer. Use **Download original** or open the original locally rather than treating extracted text as its page layout. A preview failure offers retry without changing the source file.

## Sessions and workspaces

The session list groups sessions by workspace; pick one to resume, or start a new draft there. When the list is grouped by workspace, a plus on a workspace title starts a draft in that workspace. [Starting and resuming sessions](/en/guides/sessions#starting-and-resuming-sessions) says which headings have the plus and what it leaves alone. If a saved model, profile (the agent's configuration file) or effort is no longer available, the entry stays visible with a diagnostic instead of quietly switching you to a different model. [Workspace and session management](/en/guides/sessions) covers the rest.

Above the list sits the sidebar's own navigation. Memory, personas and usage are visible by default; the task board, scheduled tasks, capabilities and **Discover Kiki** start under **More tools**, which expands in place and remembers whether you left it open. **Settings → General → Sidebar tools** decides which destinations stay visible, and the same list is in the View options menu at the top of the list. Your saved choices stay in place.

## Next steps

- [Workspace and session management](/en/guides/sessions) — sessions, the task board, usage statistics
- [Memory](/en/guides/memory) — the three memory scopes and the `/memory` page
- [Settings pages](./settings.md) — a tour of the desktop settings categories
- [Interaction and input](/en/guides/interaction) — the TUI counterpart of these concepts
