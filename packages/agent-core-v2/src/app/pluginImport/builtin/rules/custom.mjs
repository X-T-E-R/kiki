import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const definition = { schemaVersion: 1, id: 'custom', label: 'Custom JSON / script', formatVersion: 'custom-records-v1' };
async function script(context) {
  const configured = context.settings.customScript;
  const file = typeof configured === 'string' && configured.trim() ? configured.trim() : fileURLToPath(new URL('../examples/custom-json.mjs', import.meta.url));
  if (!path.isAbsolute(file)) throw new Error('customScript must be an absolute path to a trusted JavaScript ES module');
  const bytes = await readFile(file, { signal: context.signal });
  const signature = createHash('sha256').update(bytes).update(JSON.stringify(context.settings)).digest('hex');
  const url = pathToFileURL(file); url.searchParams.set('revision', signature);
  const module = await import(url.href);
  for (const action of ['discover', 'probe', 'parse']) if (typeof module[action] !== 'function') throw new Error(`Custom script must export ${action}(input, context)`);
  return { module, signature };
}
function revision(signature, sourceRevision) {
  return createHash('sha256').update(JSON.stringify([signature, sourceRevision])).digest('hex');
}
export const adapter = {
  async discover(args, context) { return (await script(context)).module.discover(args, context); },
  async probe(args, context) {
    const { module, signature } = await script(context); const value = await module.probe(args, context);
    return { ...value, formatVersion: definition.formatVersion, revision: revision(signature, value.revision) };
  },
  async parse(args, context) {
    const { module, signature } = await script(context); const current = await module.probe(args, context);
    if (revision(signature, current.revision) !== args.revision) throw new Error('Custom source or script changed; preview again');
    return module.parse({ ...args, revision: current.revision }, context);
  },
};
