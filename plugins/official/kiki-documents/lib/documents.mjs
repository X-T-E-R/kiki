import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { admitPaths, DocumentsError } from './paths.mjs';
import { loadExtract } from './runtime.mjs';

const LOCAL_FORMATS = ['.pdf', '.docx', '.xlsx', '.xls', '.pptx', '.html', '.htm', '.txt', '.md', '.markdown'];
export async function extractDocument(args, context, load = loadExtract) {
  try {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((key) => !['file', 'outputDir', 'engine', 'allowUpload', 'previewChars'].includes(key))) {
      throw new DocumentsError('ARGUMENT_INVALID', 'Use the declared document extraction parameters.', 'Pass file and a new outputDir.');
    }
    const engine = args.engine ?? 'auto';
    if (!['auto', 'direct', 'defuddle', 'markitdown', 'mineru'].includes(engine)) throw new DocumentsError('ENGINE_UNSUPPORTED', 'Unsupported extraction engine.', 'Use auto for local processing, or explicitly select MinerU for cloud OCR.');
    if (args.allowUpload !== undefined && typeof args.allowUpload !== 'boolean') throw new DocumentsError('ARGUMENT_INVALID', 'allowUpload must be boolean.', 'Set it only when cloud upload is explicitly authorized.');
    if (engine === 'mineru' && args.allowUpload !== true) throw new DocumentsError('UPLOAD_NOT_AUTHORIZED', 'MinerU uploads the source file to a cloud service.', 'Ask the user to authorize upload of this file; use local auto otherwise.');
    const previewChars = args.previewChars ?? 4000;
    if (!Number.isInteger(previewChars) || previewChars < 0 || previewChars > 16000) throw new DocumentsError('ARGUMENT_INVALID', 'previewChars must be between 0 and 16000.', 'Use a bounded preview, then Read/Grep the saved document.');
    const { source, output } = await admitPaths(args.file, args.outputDir, context);
    const extension = path.extname(source).toLowerCase();
    const formats = engine === 'mineru' ? [...LOCAL_FORMATS, '.png', '.jpg', '.jpeg'] : LOCAL_FORMATS;
    if (!formats.includes(extension)) throw new DocumentsError('FORMAT_UNSUPPORTED', `Unsupported document extension: ${extension || '(none)'}`, 'Use PDF, DOCX, XLSX/XLS, PPTX, HTML, Markdown or plain text; JPEG/PNG require explicit cloud MinerU.');
    const settings = context.settings ?? {};
    const api = await load(settings.nbExtractPath);
    const result = await api.extract({ path: source }, {
      engine, python: settings.pythonPath || undefined,
      signal: context.signal, timeoutMs: 600_000, maxBytes: 50 * 1024 * 1024,
      mineru: engine === 'mineru' ? { token: settings.mineruToken || undefined, baseUrl: settings.mineruBaseUrl || undefined } : undefined,
    });
    if (!result.markdown?.trim()) throw new DocumentsError('EMPTY_CONTENT', 'No readable document content was extracted.', 'A scanned PDF needs an OCR-capable engine; do not treat an empty result as a read document.');
    if (result.assets.some((asset) => asset.path.toLowerCase() === 'extraction.json')) throw new DocumentsError('ASSET_CONFLICT', 'Engine returned an asset named extraction.json.', 'Choose another engine or report the conflicting engine output.');
    context.signal?.throwIfAborted();
    await api.saveResult(result, output);
    const warnings = [...result.warnings];
    if (result.engine === 'markitdown' && extension === '.pdf') warnings.push('Local MarkItDown does not perform OCR; image-only pages may be missing.');
    if (engine === 'mineru') warnings.push('Source uploaded to MinerU. Service terms and charges apply; stopping local waiting does not cancel the remote task.');
    const assets = result.assets.map((asset) => ({ path: path.join(output, asset.path), bytes: asset.data.byteLength }));
    const metadata = {
      source: result.source, engine: result.engine, warnings,
      markdownPath: path.join(output, 'document.md'), metadataPath: path.join(output, 'extraction.json'),
      markdownChars: result.markdown.length, assets,
    };
    try { await writeFile(metadata.metadataPath, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { throw new DocumentsError('METADATA_SAVE_FAILED', `Markdown exists at ${metadata.markdownPath}, but metadata could not be saved: ${error.message}`, 'Inspect this partial output and choose a new directory before retrying.'); }
    return { output: JSON.stringify({ status: 'succeeded', ...metadata, preview: result.markdown.slice(0, previewChars), previewTruncated: result.markdown.length > previewChars, artifactTruncated: false }) };
  } catch (error) {
    let code = error.code ?? 'EXTRACTION_FAILED';
    let suggestion = error.suggestion ?? 'Check the source, selected engine and dependency settings; retry into a new output directory.';
    if (context.signal?.aborted) { code = 'CANCELLED'; suggestion = 'Extraction was cancelled; inspect any output before retrying. Remote MinerU tasks are not cancelled.'; }
    else if (/returned empty document content/.test(error.message)) { code = 'EMPTY_CONTENT'; suggestion = 'No text was found. For scans, explicitly authorize an OCR-capable engine; local auto never uploads or performs OCR.'; }
    else if (/Python not found|Optional dependency missing|MissingDependencyException|No module named/.test(error.message)) { code = 'LOCAL_DEPENDENCY_MISSING'; suggestion = 'Prepare Python >=3.10 with MarkItDown format dependencies, then select its interpreter in the plugin pythonPath setting.'; }
    else if (/exceeds|byte limit/.test(error.message)) { code = 'SIZE_LIMIT'; suggestion = 'Use a smaller source. No truncated document is reported as complete.'; }
    return { output: JSON.stringify({ status: 'failed', code, message: error.message ?? String(error), suggestion }), isError: true };
  }
}
