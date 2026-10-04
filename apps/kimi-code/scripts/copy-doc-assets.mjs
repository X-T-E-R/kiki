import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { copyKikiDocs } from './local-docs.mjs';

const appRoot = resolve(import.meta.dirname, '..');
const source = resolve(appRoot, '..', '..', 'docs');
const target = resolve(appRoot, 'dist', 'docs');

await rm(target, { recursive: true, force: true });
await copyKikiDocs({ sourceDir: source, targetDir: target });

console.log(`[copy-doc-assets] copied ${source} to ${target}`);
