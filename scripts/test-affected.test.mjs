import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { PROMOTE_TEST_COMMANDS, runPromoteTests } from './run-promote-tests.mjs';
import {
  collectBaseChanges,
  fullCommands,
  parseArguments,
  parseNameStatus,
  runCommands,
  selectAffected,
} from './test-affected.mjs';

const packages = [
  { dir: 'packages/base', name: '@fixture/base', dependencies: [], scripts: { typecheck: 'tsc' }, vitestProject: 'base' },
  { dir: 'packages/consumer', name: '@fixture/consumer', dependencies: ['@fixture/base'], scripts: { typecheck: 'tsc' }, vitestProject: 'consumer' },
  { dir: 'packages/leaf', name: '@fixture/leaf', dependencies: [], scripts: {} },
];

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repositoryFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'test-affected-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'fixture@example.test']);
  git(root, ['config', 'user.name', 'Fixture']);
  await mkdir(join(root, 'packages/base/src'), { recursive: true });
  await writeFile(join(root, 'packages/base/package.json'), JSON.stringify({ name: '@fixture/base' }));
  await writeFile(join(root, 'packages/base/src/old.ts'), 'export const old = true;\n');
  await writeFile(join(root, 'package.json'), '{}\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return { root, base: git(root, ['rev-parse', 'HEAD']) };
}

test('parses argument modes without allowing an ambiguous base and path set', () => {
  assert.deepEqual(parseArguments(['focused', '--base', 'HEAD~1', '--plan']), {
    mode: 'focused', base: 'HEAD~1', paths: [], planOnly: true, receipt: undefined,
  });
  assert.deepEqual(parseArguments(['focused', '--paths', 'a.ts', 'b.ts', '--receipt', 'out.json']).paths, ['a.ts', 'b.ts']);
  assert.deepEqual(parseArguments(['focused', '--', '--paths', 'a.ts']).paths, ['a.ts']);
  assert.equal(parseArguments(['full', '--', '--plan']).planOnly, true);
  assert.throws(() => parseArguments(['focused', '--base', 'HEAD', '--path', 'a.ts']), /mutually exclusive/);
  assert.throws(() => parseArguments(['full', '--path', 'a.ts']), /does not accept/);
});

test('parses rename and delete records without losing either rename path', () => {
  assert.deepEqual(parseNameStatus('R100\0packages/base/src/old.ts\0packages/base/src/new.ts\0D\0packages/base/src/gone.ts\0'), [
    { status: 'R100', oldPath: 'packages/base/src/old.ts', path: 'packages/base/src/new.ts' },
    { status: 'D', path: 'packages/base/src/gone.ts' },
  ]);
});

test('selects changed packages, reverse consumers, related Vitest, and bounded typechecks', () => {
  const selected = selectAffected({ changes: [{ status: 'M', path: 'packages/base/src/value.ts' }], packages });
  assert.equal(selected.mode, 'focused');
  assert.deepEqual(selected.packages, ['@fixture/base']);
  assert.deepEqual(selected.consumers, ['@fixture/consumer']);
  assert.deepEqual(selected.commands[0].args, [
    'exec', 'vitest', 'related', '--run', '--maxWorkers=2', '--passWithNoTests=false',
    '--project=base', '--project=consumer', 'packages/base/src/value.ts',
  ]);
  assert.deepEqual(selected.commands[1].args, [
    '--filter', '@fixture/base', '--filter', '@fixture/consumer', 'run', 'typecheck',
  ]);
});

test('keeps mapped rename focused and falls back for delete or unmappable changes', () => {
  const renamed = selectAffected({
    changes: [{ status: 'R100', oldPath: 'packages/base/src/old.ts', path: 'packages/base/src/new.ts' }],
    packages,
  });
  assert.equal(renamed.mode, 'focused');
  assert.deepEqual(renamed.commands[0].args.slice(-2), ['packages/base/src/old.ts', 'packages/base/src/new.ts']);

  const deleted = selectAffected({ changes: [{ status: 'D', path: 'packages/base/src/gone.ts' }], packages });
  assert.equal(deleted.mode, 'full');
  assert.match(deleted.reasons[0], /no remaining import target/);

  const unknownRename = selectAffected({
    changes: [{ status: 'R100', oldPath: 'legacy/old.ts', path: 'packages/base/src/new.ts' }],
    packages,
  });
  assert.equal(unknownRename.mode, 'full');
  assert.match(unknownRename.reasons[0], /not mapped|cannot be mapped/);

  const unknownDelete = selectAffected({ changes: [{ status: 'D', path: 'legacy/gone.ts' }], packages });
  assert.equal(unknownDelete.mode, 'full');
});

test('global, shared, setup, script, and unknown changes select full', () => {
  for (const path of [
    'pnpm-lock.yaml',
    'vendor/archive.tgz',
    '.github/workflows/ci.yml',
    'build/raw-text-plugin.mjs',
    'packages/protocol/src/index.ts',
    'packages/base/vitest.config.ts',
    'packages/base/test/setup.ts',
    'scripts/example.mjs',
    'unknown/place.txt',
  ]) {
    const selected = selectAffected({ changes: [{ status: 'M', path }], packages });
    assert.equal(selected.mode, 'full', path);
    assert.ok(selected.commands.length > 0, path);
  }
});

test('empty selection is explicitly incomplete instead of a pass', () => {
  const selected = selectAffected({ changes: [], packages });
  assert.equal(selected.mode, 'none');
  assert.deepEqual(selected.commands, []);
  assert.match(selected.reasons[0], /no pass claim/);
});

test('base collection includes untracked files and rejects a missing base', async t => {
  const { root, base } = await repositoryFixture(t);
  await writeFile(join(root, 'packages/base/src/untracked.ts'), 'export {};\n');
  const collected = collectBaseChanges(root, base);
  assert.equal(collected.ok, true);
  assert.deepEqual(collected.changes, [{ status: '?', path: 'packages/base/src/untracked.ts' }]);

  const missing = collectBaseChanges(root, 'missing-base');
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /cannot be resolved/);
});

test('base collection preserves mapped rename and delete facts from Git', async t => {
  const { root, base } = await repositoryFixture(t);
  git(root, ['mv', 'packages/base/src/old.ts', 'packages/base/src/new.ts']);
  await writeFile(join(root, 'packages/base/src/delete.ts'), 'export {};\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'rename and add']);
  const second = git(root, ['rev-parse', 'HEAD']);
  await rm(join(root, 'packages/base/src/delete.ts'));

  const renamed = collectBaseChanges(root, base);
  assert.equal(renamed.ok, true);
  assert.ok(renamed.changes.some(change => change.status.startsWith('R') && change.oldPath.endsWith('/old.ts') && change.path.endsWith('/new.ts')));
  assert.ok(renamed.changes.some(change => change.status.startsWith('D') && change.path.endsWith('/delete.ts')));

  const deleted = collectBaseChanges(root, second);
  assert.equal(deleted.ok, true);
  assert.ok(deleted.changes.some(change => change.status.startsWith('D')));
});

function fakeChild(exitCode) {
  const child = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => {
    child.stdout.end('fixture output\n');
    child.stderr.end();
    child.emit('close', exitCode);
  });
  return child;
}

test('launches parameter arrays, propagates failure, and marks later commands skipped', async t => {
  const root = await mkdtemp(join(tmpdir(), 'test-affected-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launches = [];
  let nextExit = 7;
  const results = await runCommands([
    { label: 'fails', args: ['exec', 'node', '--test', 'file with space.test.mjs'] },
    { label: 'must not run', args: ['run', 'lint'] },
  ], {
    root,
    env: { ...process.env, npm_execpath: '/fixture/pnpm.cjs', HOME: join(root, 'home') },
    logDirectory: join(root, 'logs'),
    spawnImpl(command, args, options) {
      launches.push({ command, args, options });
      const child = fakeChild(nextExit);
      nextExit = 0;
      return child;
    },
  });

  assert.equal(launches.length, 1);
  assert.equal(launches[0].command, process.execPath);
  assert.deepEqual(launches[0].args, ['/fixture/pnpm.cjs', 'exec', 'node', '--test', 'file with space.test.mjs']);
  assert.equal(launches[0].options.env.HOME, join(root, 'home'));
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].exitCode, 7);
  assert.equal(results[1].status, 'skipped');
});

test('full collection has one bounded root Vitest pool and serial lint, type, build, and smoke stages', () => {
  const commands = fullCommands();
  const rootVitest = commands.filter(entry => entry.args.includes('vitest') && entry.args.includes('run'));
  assert.equal(rootVitest.length, 1);
  assert.deepEqual(rootVitest[0].args, ['exec', 'vitest', 'run', '--maxWorkers=2']);
  const labels = commands.map(entry => entry.label);
  assert.ok(labels.indexOf('repository lint') < labels.indexOf('repository typecheck'));
  assert.ok(labels.indexOf('repository typecheck') < labels.indexOf('repository build'));
  assert.ok(labels.indexOf('repository build') < labels.indexOf('CLI bundle smoke'));
  assert.ok(commands.some(entry => entry.label === 'repository node:test contracts' && entry.args.includes('--test-concurrency=2')));
});

test('legacy promote entry keeps its no-argument command set and continues after failure', () => {
  const launches = [];
  const exits = [1, 0, 0];
  const code = runPromoteTests({
    env: { ...process.env, npm_execpath: '/fixture/pnpm.cjs' },
    spawn(command, args, options) {
      launches.push({ command, args, options });
      return { status: exits.shift() };
    },
  });
  assert.equal(code, 1);
  assert.equal(launches.length, PROMOTE_TEST_COMMANDS.length);
  assert.deepEqual(launches[0].args, ['/fixture/pnpm.cjs', 'exec', 'vitest', 'run', '--maxWorkers=2']);
  assert.ok(launches.every(launch => Array.isArray(launch.args)));
});
