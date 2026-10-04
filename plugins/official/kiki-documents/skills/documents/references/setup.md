# One-time document setup

The plugin ships @nb-corp/nb-extract 0.1.1 and its JavaScript production dependencies. A normal directory/ZIP installation needs no runtime npm install and no local skill checkout. Kiki supplies the Node.js host (24.15+). Leave `nbExtractPath` empty unless you intentionally select a separate standard package of the same version.

## Local PDF and Office

Install Python 3.10+ separately on the machine running Kiki. In a directory you control, create a virtual environment and install only the formats you need:

```sh
python -m venv .venv-documents
```

Windows:

```sh
.venv-documents/Scripts/python.exe -m pip install "markitdown[pdf,docx,xlsx,xls,pptx]"
```

macOS/Linux:

```sh
.venv-documents/bin/python -m pip install "markitdown[pdf,docx,xlsx,xls,pptx]"
```

For PDF only, use `markitdown[pdf]`. In **Capabilities → Plugins → Kiki Documents → Settings**, set `pythonPath` to the absolute path of that environment's Python executable. Kiki does not silently install Python or pip packages. These are optional dependencies for PDF/Office, not requirements for HTML/Markdown/text. MarkItDown is MIT; its format dependencies retain their own licenses.

Auto conversion is local. MarkItDown returns text Markdown without exporting images; scans without a text layer can return `EMPTY_CONTENT` and need OCR. A nonempty result from a partly scanned document may still miss image-only pages: inspect coverage instead of claiming every page was read.

## Explicit cloud OCR

For an authorized cloud request, prepare a MinerU account and set the secret `mineruToken` in plugin settings (or the standard package's `MINERU_TOKEN` environment variable). `mineruBaseUrl` optionally selects a compatible hosted API; it is not the separate self-hosted MinerU protocol. Then call the extraction tool with `engine=mineru` and `allowUpload=true` only after the user has explicitly authorized sending that file.

MinerU uploads the local file. Its service terms, limits and charges apply. The standard package saves the useful resources returned by its archive, not promised images for every input. Local cancellation stops waiting but does not cancel the remote task. A missing token or rejected service request is a failure; there is no fallback upload.

## Result and recovery

Each successful extraction creates a new output directory with `document.md`, `extraction.json` (source, engine, warnings and artifact paths), and any engine-provided assets. Existing directories are rejected. The response preview is capped at 16,000 characters and marks `previewTruncated`; the saved Markdown is not preview-truncated. Input is capped at 50 MiB; extraction times out after 600 seconds. Byte-limit failures do not return a truncated artifact as complete.

For `LOCAL_DEPENDENCY_MISSING`, prepare/select the correct interpreter. For `DEPENDENCY_MISSING` or `VERSION_MISMATCH`, reinstall the complete plugin or set `nbExtractPath` to the pinned standard package root. For `EMPTY_CONTENT`, explain that no readable text was extracted. Before retrying a failed save, inspect any partial directory and choose a fresh one.
