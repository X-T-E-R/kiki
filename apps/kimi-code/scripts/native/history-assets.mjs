import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { buildRuntimeAssetKey } from './manifest.mjs';

export const HISTORY_ENTRY_KEY = 'history-import/entry.mjs';
export async function collectHistoryImportAssets({ appRoot, target }) {
  const root = resolve(appRoot, '../../packages/agent-core-v2/src/app/pluginImport/builtin');
  const runtimeFiles = []; const assets = {};
  async function walk(directory, prefix = '') {
    for (const item of (await readdir(directory, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + item.name; const file = join(directory, item.name);
      if (item.isDirectory()) await walk(file, relative + '/');
      else {
        const bytes = await readFile(file); const key = `history-import/${relative}`;
        const assetKey = buildRuntimeAssetKey(target, key);
        runtimeFiles.push({ key, assetKey, relativePath: `runtime/history-import/${relative}`, sha256: createHash('sha256').update(bytes).digest('hex'), mode: 0o644 });
        assets[assetKey] = file;
      }
    }
  }
  await walk(root);
  if (!runtimeFiles.some((file) => file.key === HISTORY_ENTRY_KEY)) throw new Error('Built-in history entry is missing');
  return { runtimeFiles, assets };
}
export async function copyHistoryImportAssets({ appRoot, outDir }) {
  await mkdir(outDir, { recursive: true });
  await cp(resolve(appRoot, '../../packages/agent-core-v2/src/app/pluginImport/builtin'), resolve(outDir, 'builtin'), { recursive: true });
}
