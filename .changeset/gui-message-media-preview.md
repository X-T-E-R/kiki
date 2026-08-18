---
"@kiki/gui": minor
---

Render message media inline and make file references openable in the kiki GUI.

- Image/video/file content parts are kept as structured media refs on user/assistant/steer transcript blocks instead of being flattened into `[image]` / `[file: …]` placeholders; images render as thumbnails with a fullscreen lightbox (zoom, download, Esc/backdrop close), and file parts render as name+size chips.
- Tool results that carry engine media parts (e.g. ReadMediaFile output) render their images in the tool card instead of serialized JSON.
- Markdown links, tool card summaries, and edit-tool path headers recognize local file paths (absolute, file://, or workspace-relative anchored at the session cwd) and open a slide-over preview pane: code/text in a mono read-only view with a large-file truncation notice, rendered markdown, images with lightbox escalation, and a download fallback for unsupported types.
