import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const definition = { schemaVersion: 1, id: 'example-export', label: 'Example export', formatVersion: 'example-v1' };
async function load(home, externalId) {
  const sourceHome = await realpath(home);
  const bytes = await readFile(path.join(sourceHome, externalId));
  return { sourceHome, revision: createHash('sha256').update(bytes).digest('hex'), bytes, records: JSON.parse(bytes.toString()) };
}
export function register(api) {
  api.registerSessionSource(definition, {
    async discover() { return { entries: [{ externalId: 'history.json', title: 'Example' }], cursor: null }; },
    async probe(input) {
      const source = await load(input.home, input.externalId);
      return { revision: source.revision, title: 'Example', formatVersion: definition.formatVersion, sourceHome: source.sourceHome,
        status: 'preserved', losses: [], totalBytes: source.bytes.length };
    },
    async parse(input, context) {
      const source = await load(input.home, input.externalId);
      if (source.revision !== input.revision) throw new Error('Source changed');
      const index = Number(input.cursor ?? 0);
      let delay = 0;
      try { delay = Number(await readFile(path.join(input.home, 'delay'), 'utf8')); } catch {}
      if (index > 0 && delay > 0) await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, delay);
        context.signal.addEventListener('abort', () => { clearTimeout(timeout); reject(new Error('cancelled')); }, { once: true });
      });
      context.signal.throwIfAborted();
      return { records: source.records.slice(index, index + 1), cursor: index + 1 < source.records.length ? String(index + 1) : null,
        losses: [], bytesRead: index + 1 === source.records.length ? source.bytes.length : 0 };
    },
  });
}
