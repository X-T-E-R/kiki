import { cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '..');
const source = resolve(appRoot, '..', 'kiki-gui', 'dist');
const target = resolve(appRoot, 'dist', 'web');

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });

console.log(`[copy-web-assets] copied ${source} to ${target}`);
