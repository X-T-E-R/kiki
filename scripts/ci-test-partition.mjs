import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

import { BaseSequencer } from 'vitest/node';

export const GUI_PROJECT = 'gui';
export const MEDIA_TEST_FILE = 'packages/kap-server/test/mediaPreview.test.ts';
export const DEFAULT_SHARD_COUNT = 5;

const repositoryRoot = resolve(import.meta.dirname, '..');
const vitestCli = resolve(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

function normalizePath(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function normalizedFile(entry, root = repositoryRoot) {
  const file = resolve(entry.file);
  const path = normalizePath(relative(root, file));
  if (path.startsWith('../')) {
    throw new Error(`collected test is outside the repository: ${entry.file}`);
  }
  return path;
}

function fileSet(entries, root = repositoryRoot) {
  return new Set(entries.map((entry) => normalizedFile(entry, root)));
}

/** @param {Iterable<string>} values */
function sorted(values) {
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

function difference(left, right) {
  return new Set([...left].filter((value) => !right.has(value)));
}

function intersection(left, right) {
  return new Set([...left].filter((value) => right.has(value)));
}

function assertSameFiles(label, actual, expected) {
  const missing = difference(expected, actual);
  const extra = difference(actual, expected);
  if (missing.size > 0 || extra.size > 0) {
    throw new Error(`${label} collection differs: missing=${JSON.stringify(sorted(missing))} extra=${JSON.stringify(sorted(extra))}`);
  }
}

export function partitionCollectedFiles(entries, root = repositoryRoot) {
  const gui = [];
  const media = [];
  const ordinary = [];

  for (const entry of entries) {
    const file = normalizedFile(entry, root);
    if (entry.projectName === GUI_PROJECT) {
      gui.push(entry);
    } else if (file === MEDIA_TEST_FILE) {
      media.push(entry);
    } else {
      ordinary.push(entry);
    }
  }

  return { ordinary, gui, media };
}

export function resolveRequestedMode(value) {
  if (value === 'partitioned' || value === undefined || value === '') {
    return 'partitioned';
  }
  return 'full';
}

export function vitestArguments(lane, shard) {
  if (lane === 'ordinary') {
    return ['run', '--project=!gui'];
  }
  if (lane === 'gui') {
    return ['run', '--project=gui'];
  }
  if (lane === 'media') {
    return ['run', '--project=kap-server', MEDIA_TEST_FILE];
  }
  const args = ['run'];
  if (shard !== undefined) {
    if (!/^\d+\/\d+$/.test(shard)) {
      throw new Error(`invalid shard: ${shard}`);
    }
    args.push(`--shard=${shard}`);
  }
  return args;
}

export function assertPartitionCollections({ full, ordinary, gui, media, shards }, root = repositoryRoot) {
  const expected = partitionCollectedFiles(full, root);
  const fullFiles = fileSet(full, root);
  const ordinaryFiles = fileSet(ordinary, root);
  const guiFiles = fileSet(gui, root);
  const mediaFiles = fileSet(media, root);

  assertSameFiles('ordinary', ordinaryFiles, fileSet(expected.ordinary, root));
  assertSameFiles('gui', guiFiles, fileSet(expected.gui, root));
  assertSameFiles('media', mediaFiles, fileSet(expected.media, root));

  for (const pair of [
    { names: 'ordinary/gui', left: ordinaryFiles, right: guiFiles },
    { names: 'ordinary/media', left: ordinaryFiles, right: mediaFiles },
    { names: 'gui/media', left: guiFiles, right: mediaFiles },
  ]) {
    const overlap = intersection(pair.left, pair.right);
    if (overlap.size > 0) {
      throw new Error(`${pair.names} overlap: ${JSON.stringify(sorted(overlap))}`);
    }
  }

  const laneUnion = new Set([...ordinaryFiles, ...guiFiles, ...mediaFiles]);
  assertSameFiles('partition union', laneUnion, fullFiles);

  const shardUnion = new Set();
  for (const [index, shard] of shards.entries()) {
    const shardFiles = fileSet(shard, root);
    const overlap = intersection(shardUnion, shardFiles);
    if (overlap.size > 0) {
      throw new Error(`ordinary shard ${index + 1} overlaps an earlier shard: ${JSON.stringify(sorted(overlap))}`);
    }
    for (const file of shardFiles) shardUnion.add(file);
  }
  assertSameFiles('ordinary shard union', shardUnion, ordinaryFiles);

  return {
    full: fullFiles.size,
    ordinary: ordinaryFiles.size,
    gui: guiFiles.size,
    media: mediaFiles.size,
    shards: shards.map((entries) => fileSet(entries, root).size),
  };
}

function runVitest(args, options = {}) {
  const result = spawnSync(process.execPath, [vitestCli, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout ?? ''}${result.stderr ?? ''}` : '';
    throw new Error(`vitest ${args.join(' ')} failed with exit code ${result.status}${detail}`);
  }
}

function collect(args, outputPath) {
  runVitest(['list', '--filesOnly', `--json=${outputPath}`, ...args], { capture: true });
  return JSON.parse(readFileSync(outputPath, 'utf8'));
}

function withoutMedia(entries, root = repositoryRoot) {
  return entries.filter((entry) => normalizedFile(entry, root) !== MEDIA_TEST_FILE);
}

export function parseShard(shard) {
  const match = /^(\d+)\/(\d+)$/.exec(shard);
  if (match === null) throw new Error(`invalid shard: ${shard}`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (index < 1 || count < 1 || index > count) throw new Error(`invalid shard: ${shard}`);
  return { index, count };
}

async function shardEntries(entries, shard) {
  const config = { root: repositoryRoot, shard: parseShard(shard) };
  const sequencer = new BaseSequencer({ config });
  const specifications = entries.map((entry) => ({ moduleId: entry.file, entry }));
  return (await sequencer.shard(specifications)).map((specification) => specification.entry);
}

function collectOrdinary(outputPath) {
  return withoutMedia(collect(['--project=!gui'], outputPath));
}

async function runOrdinary(shard) {
  const directory = mkdtempSync(resolve(tmpdir(), 'kiki-ci-ordinary-'));
  try {
    const ordinary = collectOrdinary(resolve(directory, 'ordinary.json'));
    const entries = shard === undefined ? ordinary : await shardEntries(ordinary, shard);
    const files = sorted(fileSet(entries));
    if (files.length === 0) throw new Error('ordinary test selection is empty');
    runVitest(['run', '--project=!gui', ...files]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function verifyCollections(shardCount = DEFAULT_SHARD_COUNT) {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error(`invalid shard count: ${shardCount}`);
  }
  const directory = mkdtempSync(resolve(tmpdir(), 'kiki-ci-partition-'));
  try {
    const full = collect([], resolve(directory, 'full.json'));
    const ordinary = collectOrdinary(resolve(directory, 'ordinary.json'));
    const gui = collect(['--project=gui'], resolve(directory, 'gui.json'));
    const media = collect(['--project=kap-server', MEDIA_TEST_FILE], resolve(directory, 'media.json'));
    const shards = await Promise.all(Array.from(
      { length: shardCount },
      (_, index) => shardEntries(ordinary, `${index + 1}/${shardCount}`),
    ));
    const result = assertPartitionCollections({ full, ordinary, gui, media, shards });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function usage() {
  throw new Error('usage: node scripts/ci-test-partition.mjs run <ordinary|gui|media|full> [--shard=N/M] | verify [--shards=N]');
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [, , command, requestedLane, ...rest] = process.argv;
  if (command === 'run') {
    const lane = ['ordinary', 'gui', 'media', 'full'].includes(requestedLane) ? requestedLane : 'full';
    const shard = rest.find((value) => value.startsWith('--shard='))?.slice('--shard='.length);
    if (lane === 'ordinary') await runOrdinary(shard);
    else runVitest(vitestArguments(lane, shard));
  } else if (command === 'verify') {
    const shardCountValue = [requestedLane, ...rest].find((value) => value?.startsWith('--shards='))?.slice('--shards='.length);
    await verifyCollections(shardCountValue === undefined ? DEFAULT_SHARD_COUNT : Number(shardCountValue));
  } else {
    usage();
  }
}
