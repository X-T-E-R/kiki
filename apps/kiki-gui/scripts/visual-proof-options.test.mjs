import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { selectProofOutput, UPDATE_GOLDENS_FLAG } from './visual-proof-options.mjs';

const ROOT = join('workspace', 'apps', 'kiki-gui');
const SCENARIOS = ['basic-stream', 'reconnect'];

test('routine proof output is disposable and outside screenshots', () => {
  assert.deepEqual(selectProofOutput(ROOT, [], SCENARIOS), {
    mode: 'disposable',
    outputDir: join(ROOT, '.tmp', 'visual-proof', 'batch3'),
    only: null,
  });
});

test('golden output requires the explicit update flag', () => {
  assert.deepEqual(selectProofOutput(ROOT, [UPDATE_GOLDENS_FLAG], SCENARIOS), {
    mode: 'update-goldens',
    outputDir: join(ROOT, 'screenshots', 'batch3'),
    only: null,
  });
});

test('known scenario subset remains disposable', () => {
  assert.deepEqual(selectProofOutput(ROOT, ['--only=reconnect'], SCENARIOS), {
    mode: 'disposable',
    outputDir: join(ROOT, '.tmp', 'visual-proof', 'batch3'),
    only: ['reconnect'],
  });
});

test('golden updates reject every scenario subset before returning an output selection', () => {
  assert.throws(
    () => selectProofOutput(ROOT, [UPDATE_GOLDENS_FLAG, '--only=reconnect'], SCENARIOS),
    /--update-goldens cannot be combined with --only/,
  );
});

test('unknown scenarios are rejected before returning an output selection', () => {
  assert.throws(
    () => selectProofOutput(ROOT, ['--only=reconect'], SCENARIOS),
    /unknown scenario\(s\): reconect/,
  );
});

test('canonical proof subset remains a known scenario list', () => {
  const canonical = [
    'basic-stream',
    'queue',
    'reconnect',
    'reconnect-mid-turn',
    'resync-hold',
    'rewrite-flow',
    'subagents',
    'long-transcript',
    'subagent-approval',
    'attachments',
  ];
  for (const name of canonical) {
    assert.equal(typeof name, 'string');
    assert.notEqual(name.length, 0);
  }
  assert.deepEqual(
    selectProofOutput(ROOT, ['--only=basic-stream,rewrite-flow'], [...canonical, 'reconnect']).only,
    ['basic-stream', 'rewrite-flow'],
  );
});
