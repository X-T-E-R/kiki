import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { definitions } from '../lib/definitions.mjs';

const root = path.dirname(import.meta.dirname);
const file = path.join(root, 'kimi.plugin.json');
const manifest = JSON.parse(await readFile(file, 'utf8'));
const value = JSON.stringify({ ...manifest, 'x-kiki': { ...manifest['x-kiki'], tools: definitions } }, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if ((await readFile(file, 'utf8')) !== value) throw new Error('Office manifest tools differ from lib/definitions.mjs');
} else {
  await writeFile(file, value);
}
