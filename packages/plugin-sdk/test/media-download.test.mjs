import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadMedia } from '@kiki/plugin-sdk/media-download';

let root;
beforeEach(async () => {
  const scratch = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.tmp');
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(path.join(scratch, 'media-download-'));
});
afterEach(async () => {
  mock.restoreAll();
  await rm(root, { recursive: true, force: true });
});
await test('streams a complete original through the published Node helper with signal and headers', async () => {
  const destination = path.join(root, 'original.mp4');
  const signal = new AbortController().signal;
  const fetch = mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('video')); controller.enqueue(new TextEncoder().encode('-bytes')); controller.close(); } }), { headers: { 'content-length': '11' } }));
  assert.deepEqual(await downloadMedia('https://fixture.invalid/original', destination, { signal, headers: { authorization: 'fixture-key' } }), { bytes: 11 });
  assert.deepEqual(fetch.mock.calls[0].arguments, ['https://fixture.invalid/original', { signal, headers: { authorization: 'fixture-key' } }]);
  assert.equal(await readFile(destination, 'utf8'), 'video-bytes');
  assert.deepEqual(await readdir(root), ['original.mp4']);
});
for (const failure of ['truncated', 'empty', 'stream-error']) {
  await test(`preserves an existing original and removes partial files after ${failure} delivery`, async () => {
    const destination = path.join(root, 'original.mp4');
    await writeFile(destination, 'keep-original');
    mock.method(globalThis, 'fetch', async () => failure === 'stream-error'
      ? new Response(new ReadableStream({ start(controller) { controller.error(new Error('fixture stream failed')); } }))
      : new Response(failure === 'empty' ? '' : 'short', { headers: { 'content-length': '100' } }));
    await assert.rejects(downloadMedia('https://fixture.invalid/original', destination, { signal: new AbortController().signal }));
    assert.equal(await readFile(destination, 'utf8'), 'keep-original');
    assert.deepEqual(await readdir(root), ['original.mp4']);
  });
}
