import { resolve } from 'node:path';
import { stageWebBundle } from '../../kiki-gui/scripts/web-bundle-integrity.mjs';

const appRoot = resolve(import.meta.dirname, '..');
const source = resolve(appRoot, '..', 'kiki-gui', 'dist');
const target = resolve(appRoot, 'dist', 'web');

const verified = await stageWebBundle({
  sourceDistDir: source,
  targetWebDir: target,
  minFileCount: 100,
});

console.log(
  `[copy-web-assets] copied and verified ${verified.fileCount} files (${verified.referencedAssets.length} entry assets) -> ${target}`,
);
