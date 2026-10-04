import { readFile, writeFile } from 'node:fs/promises';
import { z } from '../../../../packages/plugin-sdk/node_modules/zod/index.js';
import { mediaGenerateInputSchema, mediaActionSchema } from '../../../../packages/plugin-sdk/dist/media.js';

const file = new URL('../kimi.plugin.json', import.meta.url);
const manifest = JSON.parse(await readFile(file, 'utf8'));
manifest['x-kiki'].tools = [
  { schemaVersion: 1, name: 'generate', description: 'Generate an image/edit, video, or speech file through one installed provider. Return original file_id artifacts, or a background Task that notifies on completion. Reuse request_id for the same request; unknown submission must not be automatically resubmitted. Discover models/voices with media rather than guessing. Resume only polls/downloads, never buys a new generation.', parameters: z.toJSONSchema(mediaGenerateInputSchema, { io: 'input' }), accesses: [{ kind: 'all' }], display: { type: 'media_generation' }, disclosure: 'inline', mediaInputs: true },
  { schemaVersion: 1, name: 'media', description: 'Discover installed media provider capabilities/models or voices on demand; inspect, stop or resume one media job. Cancel reports local reception separately from confirmed remote cancellation and does not promise a refund. Resume never submits a new generation.', parameters: z.toJSONSchema(mediaActionSchema), accesses: [{ kind: 'all' }], display: { type: 'media_generation' }, disclosure: 'deferred' },
];
const expected = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (await readFile(file, 'utf8') !== expected) throw new Error('Media tool manifest is stale; run sync-manifest.mjs');
} else await writeFile(file, expected);
