import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfficeError } from './paths.mjs';
import { runProcess } from './binary.mjs';

export async function renderPreview(binary, file, { mode = 'screenshot', page = 1, signal, imageIn = false } = {}) {
  if (mode === 'screenshot' && !imageIn) mode = 'outline';
  if (mode === 'outline') {
    const result = await runProcess(binary, ['view', file, 'outline', '--max-lines', '100'], { signal });
    if (result.code !== 0) throw new OfficeError('RENDER_FAILED', result.stderr || 'Outline rendering failed.', 'Try office_view text or check the document.');
    return { text: `Image input is unavailable for this model; document outline:\n${result.stdout.slice(0, 16_384)}` };
  }
  if (!['screenshot', 'html'].includes(mode)) throw new OfficeError('ARGUMENT_INVALID', 'Unsupported preview mode.', 'Choose screenshot or html.');
  if (!Number.isInteger(page) || page < 1 || page > 100) throw new OfficeError('ARGUMENT_INVALID', 'Page must be an integer from 1 to 100.', 'Choose a valid page number.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kiki-office-preview-'));
  try {
    const output = path.join(directory, mode === 'html' ? 'preview.html' : 'preview.png');
    const result = await runProcess(binary, ['view', file, mode, '--page', String(page), '--out', output], { signal, timeoutMs: 60_000 });
    if (result.code !== 0) throw new OfficeError('RENDER_FAILED', result.stderr || 'Preview rendering failed.', 'Try office_view outline or check the document.');
    const bytes = await readFile(output);
    if (mode === 'html') return { html: bytes.toString('utf8').slice(0, 256 * 1024) };
    if (bytes.byteLength > 5 * 1024 * 1024 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw new OfficeError('RENDER_FAILED', 'Preview is not a PNG within 5 MiB.', 'Try a smaller page or use office_view outline.');
    }
    return { image: `data:image/png;base64,${bytes.toString('base64')}`, page };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
