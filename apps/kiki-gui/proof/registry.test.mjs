import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { scenarios } from '../scripts/visual-proof.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

void test('the proof registry owns every GUI fixture scenario', () => {
  // The count itself is not the claim: it goes stale the moment a scenario is
  // added, and a wrong number here says nothing about whether the registry is
  // sound. What has to hold is that the registry is populated and that every
  // entry is actually runnable against a fixture that exists.
  assert.ok(scenarios.length > 0, 'the proof registry is empty');
  assert.equal(scenarios.find((entry) => entry.name === 'cockpit')?.fixture, 'rail-scale');
  assert.ok(scenarios.some((entry) => entry.name === 'subagent-invocations'));
  assert.ok(scenarios.some((entry) => entry.name === 'send-timing'));
  assert.equal(new Set(scenarios.map((entry) => entry.name)).size, scenarios.length);
  for (const entry of scenarios) {
    assert.equal(typeof entry.run, 'function', `${entry.name} has no run`);
    assert.ok(
      existsSync(join(ROOT, 'fixtures', `${entry.fixture}.scenario.mjs`)),
      `missing fixture for ${entry.name}: ${entry.fixture}`,
    );
  }
});

void test('registry names follow the fixture-module convention', () => {
  for (const entry of scenarios) {
    assert.match(entry.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `odd scenario name: ${entry.name}`);
  }
});
