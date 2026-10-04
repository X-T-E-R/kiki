# Kiki Documents

Convert a local PDF, Office, HTML or text file into Markdown that Kiki can read and search. The plugin wraps the official `@nb-corp/nb-extract` 0.1.1 API; it does not replace Kiki's `Read` tool or create a document index.

## Install and use

Install this directory through Kiki's plugin installer, then enable `kiki-documents`. In the TUI:

```sh
/plugins install --trust ./plugins/official/kiki-documents
/plugins enable kiki-documents
```

The package includes the standard extractor's JavaScript production unit, Python bridge and licenses. No runtime npm install or local skill path is needed. Kiki's Node.js host must be 24.15 or later.

PDF and Office conversion needs a separately prepared Python 3.10+ environment with MarkItDown's matching format dependencies. Set its absolute interpreter path in the existing plugin settings (`pythonPath`); see [one-time setup](skills/documents/references/setup.md). The plugin does not install system software or pip packages. HTML, Markdown and plain text work without Python.

Ask Kiki to extract or summarize a local file, or load the `documents` skill:

> Extract `reports/summary.pdf` into a new `materials/summary` folder, read the result and summarize its main findings.

The tool `documents_extract` takes `file` and a new `outputDir`. It creates `document.md`, `extraction.json` and any real engine-provided assets; its response includes source, engine, warnings and a bounded preview. Follow `markdownPath` with `Read`/`Grep` for the actual text. Source files and existing outputs are never overwritten. Workspace paths work directly; external paths require Kiki's normal approval.

## Formats and engines

| Input | Default processing | What to expect |
| --- | --- | --- |
| `.md`, `.markdown`, `.txt` | Direct, local | Text preserved |
| `.html`, `.htm` | Defuddle, local | Readable article Markdown; linked images are not downloaded |
| `.pdf`, `.docx`, `.xlsx`, `.xls`, `.pptx` | MarkItDown, local | Matching Python format extras required; Markdown only, no exported images |
| Scanned PDF; JPEG/PNG | Explicit MinerU | Upload authorization and account required; actual assets from its result archive |

Auto never uploads or performs OCR. Empty extraction fails; partly scanned files may yield text from only their text-bearing pages, so inspect coverage. Legacy `.doc`/`.ppt`, arbitrary binary files, URLs, directories and web search are not plugin inputs. Complex layout fidelity depends on the standard engine; this is extraction, not Office editing.

MinerU requires both `engine=mineru` and `allowUpload=true`, plus credentials in settings or the standard environment. This sends the file to a cloud service with its own terms and charges; local cancellation does not cancel a remote task. There is no silent fallback. Optional `nbExtractPath` selects a separate official package root of the pinned version; leaving it empty always uses the plugin's own bundled API.

Input is bounded to 50 MiB with a 600-second deadline. The preview is capped at 16,000 characters and marked when shortened; the saved Markdown is not preview-truncated. A byte-limit failure is not reported as a complete conversion. Inspect partial outputs before retrying into a fresh directory.

## Rebuild and test

The checked-in `vendor/` unit is built from the pinned npm package and lockfile; no engine logic is maintained here. From this plugin directory:

```sh
npm --prefix runtime ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
node scripts/build-vendor.mjs
node scripts/sync-manifest.mjs
node --test test/documents.test.mjs
```

`runtime/node_modules` is development-only and is not needed in installed packages. `build-vendor.mjs` bundles the public ESM API, retains the original Python bridge and generates [third-party notices](THIRD_PARTY_NOTICES.md). The standard nb-extract, Defuddle and most JavaScript dependencies are MIT; LinkeDOM is ISC and other dependencies retain their listed licenses. Python/MarkItDown is separately installed; MinerU is a service, not bundled software.
