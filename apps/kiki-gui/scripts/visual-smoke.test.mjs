import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { SCENARIOS } from './visual-smoke.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Keep the smoke registry honest without duplicating its entry count here.
// visual-smoke.mjs guards its executable path, so importing the registry does
// not build the app or launch Chromium.
test('every smoke registry entry has a fixture scenario', () => {
  assert.ok(SCENARIOS.length > 0);
  assert.equal(new Set(SCENARIOS.map((entry) => entry.name)).size, SCENARIOS.length);
  for (const entry of SCENARIOS) {
    assert.equal(typeof entry.run, 'function', `${entry.name} has no run`);
    const fixture = entry.fixture ?? entry.name;
    assert.ok(
      existsSync(join(ROOT, 'fixtures', `${fixture}.scenario.mjs`)),
      `missing fixture for smoke scenario ${entry.name}: ${fixture}`,
    );
  }
});
