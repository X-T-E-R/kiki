#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildRawSubstrateOpenApi } from '../packages/protocol/src/openapi.ts';

const outIndex = process.argv.indexOf('--out');
const doc = buildRawSubstrateOpenApi();
const json = `${JSON.stringify(doc, null, 2)}\n`;

if (outIndex !== -1 && process.argv[outIndex + 1]) {
  const outPath = resolve(process.argv[outIndex + 1]);
  writeFileSync(outPath, json, 'utf8');
  process.stdout.write(`Wrote OpenAPI 3.1 spec to ${outPath}\n`);
} else {
  process.stdout.write(json);
}
