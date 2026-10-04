---
name: documents
description: Extract local PDF, Office, HTML and text files into Markdown with source metadata. Use when the user asks to read, summarize or convert a local document that Read cannot directly parse; not for document editing or web search.
---

# Documents

Use `plugin__kiki_documents__documents_extract` to turn one local file into a new directory containing `document.md`, `extraction.json` and any assets the selected engine actually exports. Keep the source unchanged. For editing Word/Excel/PowerPoint, use the Office workflow instead; for source discovery, use search tools.

Choose a fresh `outputDir` in the workspace. Pass the user's `file` and default to `engine=auto`: HTML uses Defuddle, Markdown/text is direct, and PDF/DOCX/XLSX/XLS/PPTX uses local MarkItDown. Local PDF/Office requires a prepared Python interpreter and matching format dependencies; if missing, read `references/setup.md` for the one-time setup and settings. Do not install system dependencies without authorization.

Inspect the returned `status`, `source`, `engine`, `warnings`, `markdownPath` and `assets`. A bounded preview is not the full document: when `previewTruncated` is true, continue with `Read` or `Grep` on `markdownPath`, using ranges/searches relevant to the user's question. Open the real saved Markdown before summarizing or claiming conversion succeeded. Report the source and artifact path, and retain warnings that affect coverage, images or layout. Only claim images were extracted when the asset list contains them.

Empty content or a scan without OCR is not a successful read. Explain the returned error and the recovery action; do not invent text or automatically switch to a cloud engine. MinerU is available only when the user explicitly authorizes uploading this file: then pass `engine=mineru` and `allowUpload=true`, with credentials prepared as described in `references/setup.md`. Cloud terms/charges apply and cancellation of local waiting does not cancel a remote task. Never set upload authorization on the user's behalf.

If an output directory already exists or a save was interrupted, inspect the existing output and use a fresh directory for a retry rather than deleting or overwriting it. Stop on missing dependencies, unsupported formats or cancellation with the concrete error; no cache, index, automatic context injection or alternate extraction engine is created by this skill.
