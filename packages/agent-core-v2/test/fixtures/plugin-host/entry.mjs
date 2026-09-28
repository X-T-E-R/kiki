import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function installPrerequisite({ consent, destination }) {
  if (consent !== true) throw new Error('Consent required');
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, 'pinned fixture binary', { flag: 'wx' });
  return destination;
}

export function handlePanelRequest(action, args, context) {
  if (action !== 'echo') throw new Error('Unsupported panel action');
  return { args, settings: context.settings };
}

export function register(api) {
  api.registerTool({
    schemaVersion: 1,
    name: 'fixture_echo',
    description: 'Echo a value',
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
    accesses: [{ kind: 'all' }],
  }, async (args, ctx) => {
    ctx.progress({ kind: 'progress', percent: 50, text: 'Halfway' });
    if (args.crash) process.exit(7);
    if (args.cacheDir) return { output: process.env.KIKI_CACHE_DIR ?? '' };
    if (args.context) return { output: JSON.stringify({ workspaceRoot: ctx.workspaceRoot, approvedPaths: ctx.approvedPaths, imageIn: ctx.imageIn, settings: ctx.settings }) };
    if (args.image) return { output: [{ type: 'text', text: 'preview' }, { type: 'image_url', imageUrl: { url: 'data:image/png;base64,aGVsbG8=' } }] };
    if (args.invalidImage) return { output: [{ type: 'image_url', imageUrl: { url: 'https://example.com/image.png' } }] };
    if (args.wait) await new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, 30_000);
      ctx.signal.addEventListener('abort', () => { clearTimeout(timeout); reject(new Error('cancelled')); }, { once: true });
    });
    return { output: String(args.value ?? 'ok') };
  });
}
