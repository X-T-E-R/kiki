#!/usr/bin/env node
/**
 * Refresh the vendored LiteLLM MIT-licensed model pricing snapshot.
 * Source: https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const urls = [
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json',
];
const output = resolve(
  import.meta.dirname,
  '..',
  'vendor',
  'litellm',
  'model_prices_and_context_window.json',
);

function validate(text) {
  const catalog = JSON.parse(text);
  const keys = Object.keys(catalog);
  if (keys.length < 1_000) throw new Error(`catalog has only ${keys.length} keys`);
  for (const model of ['gpt-5', 'claude-sonnet-4-5']) {
    const entry = catalog[model];
    if (typeof entry?.input_cost_per_token !== 'number') {
      throw new TypeError(`${model} is missing input_cost_per_token`);
    }
  }
}

let lastError;
for (const url of urls) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    validate(text);
    await mkdir(dirname(output), { recursive: true });
    const temp = `${output}.${process.pid}.tmp`;
    try {
      await writeFile(temp, text, 'utf8');
      await rename(temp, output);
    } finally {
      await rm(temp, { force: true });
    }
    process.stdout.write(`updated ${output} from ${url}\n`);
    process.exit(0);
  } catch (error) {
    lastError = error;
  }
}
throw lastError;
