import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { scenarios } from '../scripts/visual-proof.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the proof registry owns every GUI fixture scenario', () => {
  assert.equal(scenarios.length, 74);
  assert.ok(scenarios.some((entry) => entry.name === 'subagent-invocations'));
  assert.equal(new Set(scenarios.map((entry) => entry.name)).size, scenarios.length);
  for (const entry of scenarios) {
    assert.equal(typeof entry.run, 'function', `${entry.name} has no run`);
    assert.ok(
      existsSync(join(ROOT, 'fixtures', `${entry.fixture}.scenario.mjs`)),
      `missing fixture for ${entry.name}: ${entry.fixture}`,
    );
  }
});

test('registry names follow the fixture-module convention', () => {
  for (const entry of scenarios) {
    assert.match(entry.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `odd scenario name: ${entry.name}`);
  }
});
