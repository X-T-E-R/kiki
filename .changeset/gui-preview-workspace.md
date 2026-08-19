---
"@kiki/gui": minor
---

Upgrade the file preview slide-over into a resident multi-tab preview workspace in the kiki GUI.

- Clicking a file path in the transcript (markdown links, tool card paths, attachment chips) opens or activates a tab in a docked right-hand panel (ConversationShell `preview` slot between the conversation column and the rail) instead of a modal; the panel collapses, drags wider/narrower (persisted), and falls back to a fixed drawer below lg.
- Tab strip: one tab per file, activate-on-reopen, × close, right-click menu (close / close others / close all), drag reorder, dirty dot, truncated long names; dirty closes confirm before discarding, and dirty buffers also arm the app-level navigation guard and beforeunload.
- Viewers route by type: code/text in a CodeMirror 6 view with lazy language highlighting, markdown with rendered/source toggle, images escalating to the lightbox, and a download fallback for unknown binaries.
- Text files are editable in the desktop build: 5s debounce autosave, Ctrl/Cmd+S manual save, and window-blur/tab-hide save; every save re-reads the file first and parks on a conflict banner (overwrite / reload / keep editing) when the on-disk content diverged.
- kap-server has no host-file write endpoint, so saving writes through tauri-plugin-fs in the desktop app; the browser build marks tabs read-only with an explanatory hint. The fixture server gains a `POST /fs:write` mock so the save flow can be proofed once a server endpoint lands.
