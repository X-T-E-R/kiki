---
title: The preview layer
description: The resource model for files, attachments and pages opened in the GUI's preview panel, the action list and read states derived from it, the phased plan, and what of it is built.
outline: [2, 3]
---

# The preview layer

This record covers how the GUI in `apps/kiki-gui` opens and shows files, SendMessage attachments, session media, web pages, agents and skills in its side preview panel, and what a person may do with each. It replaces "what can I do here" being decided by the entry point with one model decided by the thing itself. The interface rules it applies (state in words, actions next to their object, the phone changes form but not words) are in [GUI interface rules](./2026-11-ui-rules.md); the words "this computer" and "the computer running Kiki" follow [Spaces, computers, devices and pairing](./2026-11-spaces-and-pairing.md).

## The problem

The preview panel has no notion of "the thing being previewed", only of the entry point it came from. Tabs come in five kinds that do not know about each other (`file`, `attachment`, `web`, `panel` for agents, `skill`; `apps/kiki-gui/src/state/previewWorkspace.ts`), and each entry point brings its own menu, its own type detection and its own answer to "is this on another computer". The same file opened from a link and from a SendMessage receipt gives two tabs, two renderers, two sets of actions and possibly two different contents.

| Entry point | Opens | Bytes come from |
| --- | --- | --- |
| A file link in a reply, a SendMessage body or a previewed Markdown file | A file tab (with line or heading) | The host-path read `GET /api/fs:content` |
| A path in a tool row, diff card, plugin tool card, capability page or agent panel (`FilePathLink`); the right rail and inspector file rows | A file tab | The same |
| A file chip with a path | Non-images: a file tab; images and video: the lightbox or a dialog | The same |
| A file chip or generated media with only a session file id | A centred modal dialog, a third preview surface | Session media `GET /api/sessions/{id}/media/{fileId}` |
| Message, tool-result and Markdown images | The image lightbox | Session media or the host-path read, falling back to the original |
| A file attached to a SendMessage receipt | An attachment tab | Session media; PDF, Office and CSV through the session document preview; HTML through the HTML preview |
| A receipt's image, video or audio | Lightbox; dialog for video; audio plays in place | Session media |
| A web address card or "open preview" on a link | A web tab | The browser loads it |
| A subagent; a built-in skill | An agent tab; a skill tab | The session runtime; `GET /api/skills/{name}:content` |

What people meet:

- **SendMessage attachments have no file actions.** A sent file opens in a tab that looks like a file tab, but its menu offers only close, close others and close all, and its header only rendered/source and a download arrow: no copy path, no show in folder, no open with default app, no "@" to add it to the chat. PDF, Word, Excel, PowerPoint and CSV attachments do not even get a download. A Markdown attachment resolves relative images and links against the session's directory instead of the file's own, so its images show "无法读取该文件" ("Could not load this file"). The data for all of this already arrives: the receipt carries the real path and a `source_id`, and the GUI drops the path in three places (the receipt card computes a host path only for HTML, the attachment tab strips `path` before reading, and the tab menu and header only know `kind === 'file'`).
- **Two tabs for one file, and nothing says which is which.** A `notes.md` opened from the receipt and from a link gives two tabs named `notes.md`; one shows the content as sent, the other the file on disk now, and no word marks the copy. Different spellings of one path (relative, absolute, case, `..`, `:line`) already collapse into one tab; the live file and its sent copy do not, and should not, but must be told apart.
- **A tab does not know the file changed.** A text tab reads once when it mounts; reopening the same link only activates the tab; there is no reload. Only the desktop's save-time compare notices a change on disk.
- **Every failure reads the same.** Missing, permission denied, a folder, another computer, not readable from this device: all show the same "无法读取该文件" although the server answers with different codes, and the download arrow and "@" stay in the header, doing nothing or adding a missing file to the chat. A truncated video says the type is unsupported.
- **Paired devices and spaces on other computers cannot read files by path.** The host-path read, the document preview and the media playback grant are not in the paired-connection operation list (`packages/protocol/src/rest/connection-operations.ts`), so the phone app and a desktop window in another computer's space see "could not load" for every file link and tool-row path, while attachments in session media open fine.
- **Host actions follow the wrong check.** "Show in folder" and "Open with default app" are offered when the scope is not SSH, so a desktop window in a space on another computer acts on a path on this computer. Four different "is this remote" checks exist, in `PreviewWorkspace.tsx`, `Markdown.tsx`, `imageActions.ts` and `mediaParts.tsx` (all under `apps/kiki-gui/src/components/`).
- **The desktop preview is an autosaving editor.** Every text tab is writable in the desktop app and saves five seconds after the last keystroke, on blur and when the page is hidden (`apps/kiki-gui/src/state/hostFileEditor.ts`). The read is a lossy UTF-8 decode (`packages/klient/src/transports/http/rest.ts`) and files without an extension count as text (`packages/session-core/src/composer/media.ts`), so a GBK file or an ELF binary opens as garbled, writable text that one keystroke rewrites as UTF-8. In an SSH space the editor takes typing and then every save fails.
- **On a phone the content is there but out of reach.** Copy path is only in a long-press menu; file and attachment tabs are 28 px tall with an 11×11 px "@" and a 16×12 px close; after four or five tabs the active tab scrolls out of view; an image tab's header squeezes the file name to nothing; the lightbox has no visible download.
- **Three surfaces for attachments, each with its own rules.** The modal dialog shows Markdown as plain text, PDF in the browser's own viewer (which phone browsers often do not show) and HTML as source only, while the same files render properly in a side-panel tab.
- **Type routing has gaps.** `.ipynb` is "not supported" although it is JSON text; CSV is a code editor in a file tab and plain document-preview text in an attachment tab; legacy `.doc`, `.xls`, `.ppt` are labelled DOCX/XLSX/PPTX on the receipt card but cannot be rendered; an extension-less binary is shown as text; images are read whole with no limit.
- **A web tab that cannot load is a blank page**, with only a standing hint that some sites refuse embedding.
- Smaller things: the rightmost tab is half under the full-screen button; a receipt card's hover shows an internal file id such as `f_upload_0001` for attachments sent by id; the "unsupported" download is a vermilion primary; the agent tab's fallback label is a hard-coded English `Agent:`; the "在桌面应用中打开即可编辑。" strip stands on every text tab, including where editing is impossible; tool-row paths lose their line number.

## The model

What the preview shows is a piece of content plus where it came from. What can be done with it is decided by where its bytes are read from now and whether the original is on this device, never by which button opened it.

### Resources

Tab kinds go from five to four: **resource** (today's file and attachment tabs merged), **web**, **agent** and **skill**. Agents and skills are not files and stay separate; the skill tab may reuse the resource Markdown renderer but gets no file actions. A resource knows four things:

| It knows | Values | Where it comes from |
| --- | --- | --- |
| Where its bytes are read from | `host-file`: an absolute path on the computer running Kiki; `session-copy`: session id + file id, with `sourceId` when known; `url`: http(s), `data:` or `blob:` | Every entry point already has one of these |
| Where the original is (optional) | An absolute path with a `trusted` flag | A host file is its own original. A session copy has a trusted original only when the SendMessage receipt carried `source_id`: then its `path` is the real path the engine itself read. Uploads, generated media and attachments sent by file id have none |
| Live or copy | Live: every read returns what is on disk now. Copy: the bytes stored when it was sent, which never change | Derived from the bytes source |
| Type | `text`, `markdown`, `html`, `image`, `video`, `audio`, `pdf`, `office`, `table`, `unsupported` | One classifier |

**Identity.** Opening the same thing twice activates one tab. A live host file is keyed by its normalized absolute path, as today. A session copy is keyed by session id + file id + `sourceId`. A live file and its copy have different keys and open as two tabs, because their contents can differ.

**One classifier**, `classifyResource({ name, mime, head })`, looks at the name, the declared media type and, when available, the first bytes, and replaces the five tables in use today (`packages/session-core/src/composer/media.ts`, the attachment checks in `apps/kiki-gui/src/components/PreviewWorkspace.tsx`, the dialog's check in `apps/kiki-gui/src/components/mediaPreview.tsx`, and the receipt card's two tables in `apps/kiki-gui/src/components/message/messageMedia.ts`). It agrees with them except for intended corrections: `.ipynb` is `text`; an extension-less file is `text` only when its first bytes decode losslessly as UTF-8, otherwise `unsupported`; legacy `.doc`, `.xls` and `.ppt` are `unsupported` (download or open the original instead); `.csv` and `.tsv` are `table`, which renders as text until a table renderer exists.

**The environment** answers three questions the resource does not carry: whether this device is the computer running Kiki, what the host can do (reveal, open, write a file, show a save dialog), and whether the layout is the phone form. The first is one function, `isKikiComputer(connection)`, which replaces the separate checks. It is true only for a local connection in the desktop shell or a loopback browser connection, and false for `ssh:` scopes, `direct:peer`, `connectionSource === 'remote'`, a `spaceKey` starting with `remote:`, paired app shells, web-entry browsers, and anything it does not recognise. It fails closed: offering "show" for someone else's path is the costly mistake.

### Actions

One pure function, `resourceActions(resource, environment, readState)`, returns the ordered list of actions that apply. The tab menu, the resource header, the phone's ⋯ sheet, the file-link menu in replies, `FilePathLink`, file chips, image menus and the lightbox all call it. An action that does not apply is absent: there are no disabled or no-op entries.

| Action | zh | en | Requires | Otherwise |
| --- | --- | --- | --- | --- |
| Show on this computer | 在这台电脑上显示 | Show on this computer | An original path; `isKikiComputer`; the host can reveal | Absent |
| Open | 以默认程序打开; for a copy 打开原文件 | Open with default app; for a copy Open original file | As above, and the host can open; for a copy it opens what is on disk now | Absent |
| Copy path | 复制路径 | Copy path | An original path (true on any device: a path is a fact) | Absent |
| Copy content | 复制内容 | Copy content | A text-like type, read in full | Absent |
| Download | 下载 | Download | Bytes readable from this device | Absent; the read state explains |
| Add to chat (@) | 加入对话 | Add to chat | A session; an original path; the file is readable | Absent |
| Open in browser | 在浏览器打开 | Open in browser | An http(s) bytes source | Absent |
| Find in file | 文件内查找 | Find in file | A text renderer | Absent |
| Edit | 编辑 | Edit | A live host file; `isKikiComputer`; the host can write; content decoded losslessly as UTF-8; not truncated; a known text type | Read-only. Where the desktop could normally edit but this file cannot, one short reason in the header: 「只读：不是 UTF-8 文本」 / "Read-only: not UTF-8 text" |
| Go to line or heading | — | — | A text or Markdown renderer | Today's "position not found" message |
| Reload | 重新读取 | Reload | A live source (host file or web page) | Absent for copies |
| Rendered / Source | 渲染 / 源码 | Rendered / Source | Markdown or HTML | Absent |
| Open current file | 打开现在的文件 | Open current file | A copy whose trusted original is readable | Absent |

Placement follows rule 3: actions on the resource sit in its own header, the most used one inline and the rest in a header "more" menu; the tab's context menu keeps tab management (close, close others, close all) plus the same "more" items, for desktop habit. "Show on this computer" appears only when the file really is on this computer; statuses about a file elsewhere say 「运行 Kiki 的电脑」 / "the computer running Kiki", never 「本机」.

A copy is marked as one: its tab carries 「副本」 / "Sent copy", its header says 「发送时的副本」 / "Copy as it was sent", and when the trusted original is readable the header offers 「打开现在的文件」, which opens or activates the live tab. A Markdown copy with a trusted origin resolves relative images and links against the original's directory.

### Read states

Each state is a word or one sentence in the content area, and the header collapses to what still applies.

| State | zh | en | Offers |
| --- | --- | --- | --- |
| Reading (only after 300 ms) | 正在读取… | Reading… | — |
| Missing | 这个文件不存在了。(path below) | This file no longer exists. | Reload; Close tab |
| No permission | 没有权限读取这个文件。 | You do not have permission to read this file. | Reload |
| A folder | 这是一个文件夹。 | This is a folder. | Show on this computer, when it applies |
| This device cannot read it | 这个文件在运行 Kiki 的电脑上，这台设备读不到它。 | This file is on the computer running Kiki, and this device cannot read it. | Copy path |
| Too large | 文件较大，只显示开头 512 KB。 | Large file: showing the first 512 KB. | Download; Markdown keeps "Load full file" |
| Unsupported | 这种文件还不能预览。 | This kind of file cannot be previewed yet. | Download; Open when it applies; an ink button, not vermilion |
| Cannot decode | 这个文件损坏了，或者不是它声明的类型。 | This file is damaged or is not the type it claims to be. | Download (a truncated video lands here) |
| Changed on disk | 磁盘上的文件已更改。 | The file on disk has changed. | Reload; with unsaved edits, the existing overwrite / reload / keep editing choice |
| A copy | 发送时的副本 (in the header) | Copy as it was sent | Open current file, when readable |

Server errors map by code: `FS_PATH_NOT_FOUND` (404) to missing, `FS_PERMISSION_DENIED` (403) to no permission, `FS_IS_DIRECTORY` (409) to a folder, and `local_owner_required` (403) or the client's "Operation is not available to a remote space" to "this device cannot read it". The client carries these codes through instead of folding them into one failure.

"Changed on disk" needs no new protocol. `GET /api/fs:content` already answers conditional requests with an ETag, so a live tab asks with `If-None-Match` at three moments only: when it comes to the front, when the window regains focus, and when a file-writing tool in the session finishes on a path that is open. A `304` changes nothing. A new ETag with no local edits shows the state with Reload rather than swapping content under the reader. Image tabs follow the same rule.

### Editing

Editing in the preview stays, but it is opt-in and safe. It exists only on the local desktop (the device is the computer running Kiki and the host can write), and only after the person presses 「编辑」 / "Edit" in the header; until then nothing is ever written. Autosave runs only after edit mode was entered for that tab. A file whose bytes do not decode losslessly as UTF-8, that was truncated for preview, or whose type is unknown is never editable; an extension-less file counts as unknown unless its name is a known text file name such as `Makefile` or `Dockerfile` and it decodes losslessly. SSH spaces, spaces on other computers, paired devices and web-entry browsers never show "Edit". The always-on 「在桌面应用中打开即可编辑。」 strip goes away. The save-time re-read and compare, the confirmation before closing a tab with unsaved changes, and keeping the draft when the panel collapses stay as they are.

### HTML and web pages

An HTML resource renders when its tab opens, as it does today, and keeps the Rendered / Source switch and Reload. A web tab gains a loading state until the frame's `load` event and a failure state when none arrives in time, 「没能打开这个网页，可以在浏览器里打开」 / "This page could not be opened here; open it in the browser", with the existing open-in-browser action.

### Phone form

Content and order match the desktop; only the form changes. On phones a title row replaces the tab strip: 「文件名 ▾ · 3」 / "file name ▾ · 3" (the active resource's name, a chevron, the tab count), and tapping it opens a bottom sheet listing the open tabs, each with its own 44 px close. The active file's name is always visible. The header keeps the name, the one most used action (download when the bytes are readable) and ⋯, which opens the rest of the action list in a bottom sheet in the desktop "more" order. Long-press menus stay but are no longer the only way in. Every touch target in the panel is at least 44 px, and tabs no longer carry "@" (it moves into ⋯). On touch, the lightbox shows a visible ⋯ with the image resource's actions, download and copy included. On desktop, a tab that becomes active scrolls into view, and overflowing tabs show that more exist instead of hiding under the full-screen button.

### What stays

Path normalization and merging, line and heading jumps, per-visit reading positions, keeping drafts when the panel collapses, confirmation before closing, and the save-time compare stay. The image lightbox stays the dedicated image viewer (paging, zoom, annotation); it receives a resource and takes its menu from the same function. Agent and skill tabs keep their behaviour. The centred attachment dialog is removed: images keep the lightbox, every other attachment opens as a resource tab.

## Decisions

- A live file and its sent copy are two tabs; the copy is labelled 「副本」 and offers 「打开现在的文件」.
- Attachments gain an origin first, in phase 1, so the original complaint (a sent attachment has no "show in folder", "copy path" or download) closes early; merging file and attachment tabs into one kind waits until phase 3.
- Editing is local-desktop only, behind an explicit "Edit", with autosave only after that, and never for files that do not decode losslessly or whose type is unknown.
- HTML keeps rendering on open.
- Paired devices and spaces on other computers read workspace files through the session-confined read route that already exists (`POST /api/sessions/{id}/fs:read`), not through the host-path read. Until that lands, the tab says truthfully that this device cannot read the file, a state distinct from missing, no permission and folder. Nothing changes for the local owner on the computer running Kiki, whose previews keep using the host-path read.
- The modal attachment dialog is removed in phase 3.
- Phones get a title and a tab-list sheet instead of the tab strip; the desktop keeps the strip.
- `.ipynb` is text for now.
- The `message-channels` fixture gets `source_id` on its attachments (64 lowercase hex characters) and keeps at least one without, so both cases stay covered; it is the only fixture change phase 1 needs.
- The receipt `path` that holds a file id for attachments sent by file id (`path = file.path ?? input.file_id` in `packages/agent-core-v2/src/agent/tools/message/sendMessageTool.ts`) is cleaned up as separate protocol work, not as a precondition.

The receipt card's hover shows the original path only when there is a trusted origin, and the display name otherwise. Legacy Office files get honest badges (DOC, XLS, PPT) so the card no longer promises a preview the tab cannot give.

## Phases

Each phase leaves the product usable. The risk that shapes the order is `apps/kiki-gui/src/components/PreviewWorkspace.tsx`: about 2,900 lines that every phase touches. Phase 1 therefore changes it minimally, and phase 2 starts by splitting it, as a change of its own, before any behaviour changes there.

| Phase | Content | Tracked by |
| --- | --- | --- |
| 0 | The pure model: resource type, identity key, classifier, `isKikiComputer`, `resourceActions`, in a new `apps/kiki-gui/src/state/previewResource.ts` with a truth-table test. No UI change. | "Add a pure preview resource model that derives file actions from origin" |
| 1 | Receipts carry their trusted origin for every kind (file, image, video, audio); attachment tabs keep it; tab menus and headers use the action list; document attachments get a download in every state; Markdown copies resolve against the original's directory; one remote check in the preview; actions collapse after a failed read. | "Carry the original path of SendMessage attachments that have a source_id"; "Give attachment preview tabs file actions from the shared action list" |
| 2 | Split the renderers into `apps/kiki-gui/src/components/preview/`; the edit gate and lossless reads with ETag and error codes from klient; read states, Reload and changed-on-disk; the web tab's loading and failure states; `.ipynb` as text; streaming download for file tabs. | "Split PreviewWorkspace.tsx into one file per preview renderer"; "Stop the desktop preview from autosaving files it cannot decode losslessly"; "Make file preview tabs say why a read failed and reload changed files" |
| 3 | One resource tab kind with old per-visit snapshots still readable (`apps/kiki-gui/src/lib/navViewState.ts`); one "open resource" entry point; the dialog removed; chips, path links, Markdown links, image and lightbox menus on the action list, with the old remote and type checks deleted; `FilePathLink` forwarding line numbers. | "Merge file and attachment preview tabs into one resource tab kind"; "Drive file chips, path links and image menus from the shared action list" |
| 4 | The phone form and the desktop scroll-into-view. | "Replace the preview tab strip with a title and tab list sheet on phones" |

Two more pieces of work depend on these. Reading workspace files from paired devices and spaces on other computers adds `fsRead: ['POST', '/sessions/{sessionId}/fs:read']` to `CONNECTION_OPERATIONS` (which admits it for paired tokens and the remote-space broker alike), a klient method, and a preview fallback that converts the absolute path to one relative to the session's working directory: text and Markdown within the 512 KB preview limit, media as base64 within the route's 10 MiB per-request cap, the returned ETag feeding "changed on disk". Files outside the session's directories or over the cap keep "this device cannot read it". That is "Let paired devices and remote spaces preview workspace files", after phase 2's read states. Loading the preview workbench, code editor and image viewer only on first use is "Load the preview workbench, code editor and image viewer on first use", after phase 3.

## What is built

Nothing of the model is built: `apps/kiki-gui/src/state/previewResource.ts` does not exist, the five tab kinds are unchanged, `apps/kiki-gui/src/components/PreviewWorkspace.tsx` is still one file of about 2,900 lines, and the attachment dialog is still in `apps/kiki-gui/src/components/mediaPreview.tsx`. The pieces the model rests on are in the tree:

- SendMessage receipts carry `source_id` when the engine recorded the source (`packages/agent-core-v2/src/agent/tools/message/sendMessageTool.ts`), and session-core parses it into `sourceId` (`packages/session-core/src/session/messageView.ts`).
- The server resolves a trusted host path for an attachment by checking session, agent, copy and `source_id` together (`resolveTrustedSessionAttachmentHostSource` in `packages/kap-server/src/routes/sessionMedia.ts`).
- `GET /api/fs:content` builds an ETag and answers `If-None-Match` (`packages/kap-server/src/routes/workspaceFs.ts`).
- The session-confined read route exists (`read` in the session filesystem dispatcher, `packages/kap-server/src/routes/fs.ts`), confined to the session's directories by `resolveWithin` (`packages/agent-core-v2/src/workspace/workspaceFs/fsService.ts`), with `length` capped at 10,485,760 bytes (`packages/protocol/src/rest/fs.ts`). It is not yet in `CONNECTION_OPERATIONS`.
- Spellings of one path already open one tab (`openFile` in `apps/kiki-gui/src/components/mediaPreview.tsx` resolves the path and matches existing tabs by identity), and the desktop editor's save-time compare and conflict choice work (`apps/kiki-gui/src/state/hostFileEditor.ts`).
- The bottom sheet the phone form uses (`apps/kiki-gui/src/components/overlays/ActionSheet.tsx`) and phone mode (`usePhoneMode` in `apps/kiki-gui/src/lib/layoutHooks.ts`).

## What is not built

Everything in [Phases](#phases), plus the paired-device fallback and first-use loading named after the table. The receipt `path` cleanup has no issue yet.

Two consequences are expected once the series lands and should not be mistaken for bugs: old receipts without `source_id` still have no file actions, which is the truthful answer; and removing the dialog changes how generated media and message file chips open.

## What was never verified

- Everything that exists only in the desktop shell ("show in folder", "open with default app", editing, autosave, the save-conflict bar, failing saves in SSH spaces, host actions offered in a space on another computer) was read in code, not run. The write-back of a garbled file was inferred; only the garbled-but-editable view of an ELF file was seen, in the browser build.
- Paired devices, spaces on other computers and web-entry browsers were not run. That the phone app uses a paired token was seen only in a type comment (`apps/kiki-gui/src/state/connectionConfig.ts`). The session-confined read route's limits were read from the code, not exercised against a paired device; confirm them before building the fallback.
- A real server's 403, 409, truncation and ETag responses were not seen; the fixture server answers only 404 and does not handle ranges, and it showed a large file whole.
- A tab's behaviour when the file changes on disk was not run (the fixture cannot change files at run time).
- The attachment dialog was never seen: in the `media-messages` fixture an assistant message's file part renders no chip at all, and whether that is a fixture projection gap or a product bug was not traced.
- Long-press menus on phones were triggered only with synthetic events, never on a real phone or iOS.
- Dark theme, video and audio attachment tabs, real Office rendering, and how a subagent working in another directory resolves relative paths were not looked at. Menus on tool-row paths were only read in code.

## Open questions

- Should CSV get a real table renderer, instead of the code editor in file tabs and document-preview text in attachment tabs? Until decided, `table` renders as text.
- Removing the attachment dialog changes how generated media and message file chips open; confirm it with whoever maintains the media area before the tab merge lands.
