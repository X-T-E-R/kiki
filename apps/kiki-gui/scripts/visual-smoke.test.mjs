import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, '..');
const source = readFileSync(join(SCRIPTS, 'visual-smoke.mjs'), 'utf8');
const names = [...source.matchAll(/^    name: '([^']+)',$/gm)].map((match) => match[1]);

// Keep the smoke registry honest without importing the runner (which would
// build the app and launch Chromium as a module side effect).
test('every smoke registry entry has a fixture scenario', () => {
  assert.equal(names.length, 11);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) {
    const fixture = name === 'hero-shell-zh' ? 'hero-shell' : name;
    assert.ok(
      existsSync(join(ROOT, 'fixtures', `${fixture}.scenario.mjs`)),
      `missing fixture for smoke scenario ${name}: ${fixture}`,
    );
  }
});
