---
name: kiki-office
description: Use Kiki Office tools when the user asks to create, inspect, edit, or preview local .docx, .xlsx, or .pptx documents.
---

Use the Office tools when the user wants a local `.docx`, `.xlsx`, or `.pptx` created or edited. The host must first install and enable the Office plugin and arrange the pinned OfficeCLI executable with the user's consent. Missing engines are reported as errors; tools never download executables.

Start with `office_create` for a new file. For an existing file, use `office_view` for a bounded overview, then `office_get` or `office_query` for a precise semantic path. `office_add` inserts elements, `office_set` changes properties or replaces matching text, and `office_remove` deletes an addressed element. For several related edits, `office_batch` applies them atomically. Paths such as `/body/p[1]`, `/Sheet1/A1`, and `/slide[1]` are one-based. Prefer IDs returned by `office_get` where available. Document paths are workspace-relative unless the user has explicitly approved an absolute path.

For Word, add paragraphs under `/body` using `type: "paragraph"` and `props.text`; use `props.style: "Heading1"` for a heading. For Excel, set `/Sheet1/A1` with `props.value`. For PowerPoint, add a `slide` under `/`, then add a `shape` under `/slide[1]` with `text`, `x`, and `y`. Refer to OfficeCLI element help when changing uncommon properties; do not invent property names.

Read results are capped at 200 rows, 200 cells, and 16 KiB. A `> Truncated:` marker means the full content was not inspected; narrow the range or selector. An error has `code`, `message`, and `suggestion`; act on the suggestion, not by repeating the same call unchanged. For a visual check, use `office_preview` and inspect the returned PNG if the model accepts images; otherwise use its outline fallback. Finish by reading the relevant content, checking the changed element's formatting, and inspecting any visible rendering issues before delivery. Choose one appropriate format/workflow at a time rather than stacking unrelated document instructions.
