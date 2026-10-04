import { readFile, writeFile } from 'node:fs/promises';
import { definition } from '../lib/definitions.mjs';
const file = new URL('../kimi.plugin.json', import.meta.url);
const manifest = JSON.parse(await readFile(file, 'utf8'));
manifest['x-kiki'].tools = [definition];
await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
