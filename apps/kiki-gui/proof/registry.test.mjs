import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { scenarios } from '../scripts/visual-proof.mjs';
import { buildCacheKey } from './runner.mjs';

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

void test('proof build cache follows workspace bundle inputs but ignores proof output', (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'kiki-proof-cache-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const root = join(workspace, 'apps/kiki-gui');
  mkdirSync(root, { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '--quiet');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'fixture');
  const write = (name, value) => {
    const file = join(workspace, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value);
  };
  let key = buildCacheKey(root);
  assert.equal(typeof key, 'string');
  assert.equal(buildCacheKey(root), key);
  const inputs = [
    'packages/session-core/src/i18n/zh.ts',
    'packages/session-core/src/i18n/en.ts',
    'packages/protocol/src/rest/example.ts',
    'packages/klient/src/core/example.ts',
    'packages/transcript/src/contract/example.ts',
    'packages/agent-profiles/src/example.ts',
    'packages/plugin-sdk/dist/media.js',
    'apps/kiki-gui/vite/example.ts',
    'apps/kiki-gui/package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
  ];
  for (const name of inputs) {
    write(name, 'first');
    const next = buildCacheKey(root);
    assert.notEqual(next, key, name);
    write(name, 'second edit while already dirty');
    const edited = buildCacheKey(root);
    assert.notEqual(edited, next, `${name}: same dirty status`);
    key = edited;
  }
  for (const name of ['apps/kiki-gui/.tmp/visual-proof/output.png', 'packages/session-core/notes.md']) {
    write(name, 'not a bundle input');
    assert.equal(buildCacheKey(root), key, name);
  }
  rmSync(join(workspace, inputs[0]));
  assert.notEqual(buildCacheKey(root), key, 'deleted workspace input');
});
