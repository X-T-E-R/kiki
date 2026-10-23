import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolve } from 'node:path';

import {
  MEDIA_TEST_FILE,
  assertPartitionCollections,
  parseShard,
  partitionCollectedFiles,
  vitestArguments,
} from './ci-test-partition.mjs';

const root = resolve('C:/fixture/repository');
const entry = (file, projectName) => ({ file: resolve(root, file), projectName });

await test('partitions future GUI and ordinary tests from the collected project identity', () => {
  const futureGui = entry('apps/kiki-gui/src/future/newSurface.e2e.tsx', 'gui');
  const futureOrdinary = entry('packages/future/test/newCapability.integration.ts', 'future');
  const media = entry(MEDIA_TEST_FILE, 'kap-server');

  assert.deepEqual(partitionCollectedFiles([futureGui, futureOrdinary, media], root), {
    ordinary: [futureOrdinary],
    gui: [futureGui],
    media: [media],
  });
});

await test('requires the three lanes and all ordinary shards to equal the original root collection', () => {
  const gui = entry('apps/kiki-gui/src/App.test.tsx', 'gui');
  const media = entry(MEDIA_TEST_FILE, 'kap-server');
  const first = entry('packages/example/test/first.test.ts', 'example');
  const second = entry('packages/example/test/second.e2e.ts', 'example');

  assert.deepEqual(assertPartitionCollections({
    full: [gui, media, first, second],
    ordinary: [first, second],
    gui: [gui],
    media: [media],
    shards: [[first], [second]],
  }, root), {
    full: 4,
    ordinary: 2,
    gui: 1,
    media: 1,
    shards: [1, 1],
  });
});

await test('rejects omissions, lane overlap, and shard overlap', () => {
  const gui = entry('apps/kiki-gui/src/App.test.tsx', 'gui');
  const ordinary = entry('packages/example/test/example.test.ts', 'example');

  assert.throws(() => assertPartitionCollections({
    full: [gui, ordinary],
    ordinary: [ordinary],
    gui: [],
    media: [],
    shards: [[ordinary]],
  }, root), /gui collection differs/);

  assert.throws(() => assertPartitionCollections({
    full: [gui, ordinary],
    ordinary: [ordinary],
    gui: [gui, ordinary],
    media: [],
    shards: [[ordinary]],
  }, root), /gui collection differs/);

  assert.throws(() => assertPartitionCollections({
    full: [gui, ordinary],
    ordinary: [ordinary],
    gui: [gui],
    media: [],
    shards: [[ordinary], [ordinary]],
  }, root), /ordinary shard 2 overlaps/);
});

await test('unknown runner lanes recover to full', () => {
  assert.deepEqual(vitestArguments('unexpected'), ['run']);
});

await test('builds selectors without omitting integration, e2e, or TSX files', () => {
  assert.deepEqual(vitestArguments('ordinary'), ['run', '--project=!gui']);
  assert.deepEqual(vitestArguments('gui'), ['run', '--project=gui']);
  assert.deepEqual(vitestArguments('media'), ['run', '--project=kap-server', MEDIA_TEST_FILE]);
  assert.deepEqual(vitestArguments('full'), ['run']);
  assert.deepEqual(vitestArguments('full', '5/5'), ['run', '--shard=5/5']);
  assert.deepEqual(parseShard('3/5'), { index: 3, count: 5 });
  assert.throws(() => parseShard('bad'), /invalid shard/);
  assert.throws(() => parseShard('6/5'), /invalid shard/);
});

await test('keeps expensive environments out of ordinary shards and preserves complete fallback', () => {
  const workflow = readFileSync(resolve(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8');
  const ordinary = workflow.match(/\n  test:\n([\s\S]*?)\n  test-gui:/)?.[1];
  const gui = workflow.match(/\n  test-gui:\n([\s\S]*?)\n  test-media-preview:/)?.[1];
  const media = workflow.match(/\n  test-media-preview:\n([\s\S]*?)\n  test-full:/)?.[1];
  const full = workflow.match(/\n  test-full:\n([\s\S]*?)\n  test-node-packages:/)?.[1];

  assert.ok(ordinary);
  assert.doesNotMatch(ordinary, /ffmpeg|playwright|Build GUI assets/);
  assert.match(ordinary, /Build host auth binding/);
  assert.match(ordinary, /Rebuild host PTY dependency/);
  assert.match(gui ?? '', /mcr\.microsoft\.com\/playwright:v1\.60\.0-noble@sha256:83192064/);
  assert.match(gui ?? '', /run gui/);
  assert.match(media ?? '', /s\|http:\/\/azure\.archive\.ubuntu\.com\/ubuntu\|http:\/\/archive\.ubuntu\.com\/ubuntu\|g/);
  assert.match(media ?? '', /cat \/etc\/apt\/apt-mirrors\.txt/);
  assert.match(media ?? '', /--no-install-recommends ffmpeg/);
  assert.match(media ?? '', /run media/);
  assert.match(full ?? '', /--no-install-recommends ffmpeg/);
  assert.match(full ?? '', /Build GUI assets/);
  assert.match(full ?? '', /run full --shard=/);

  for (const job of ['test-node-packages', 'test-pi-tui', 'test-vscode-legacy', 'docs-governance', 'lint', 'typecheck']) {
    assert.match(workflow, new RegExp(`\\n  ${job}:`));
  }
});
