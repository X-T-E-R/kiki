import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const scope = 'memory/global';
const defaultSizes = [5000, 10000, 50000];
const defaultModes = ['native', 'legacy'];
const defaultIncrement = 10;
const bodyLength = 1500;
const body = 'Benchmark memory entry body. Preserve this exact text while changing only the source session and revision so the open path sees repeated same-text evidence. '.repeat(20).slice(0, bodyLength);
const packageRoot = resolve(import.meta.dirname, '..');
const fixtureOldModule = join(packageRoot, 'test', 'fixtures', 'memoryDatabaseSchema3.ts');
const defaultOldModule = fixtureOldModule;
const currentModulePath = join(packageRoot, 'src', 'persistence', 'backends', 'sqliteMemory', 'database.ts');
const identityModulePath = join(packageRoot, 'src', 'app', 'memory', 'memorySourceIdentity.ts');

function usage() {
  return [
    'Usage: node --experimental-transform-types packages/agent-core-v2/scripts/bench-memory-open.mjs [options]',
    '',
    '--sizes=5000,10000,50000  Fixture sizes (default: 5000,10000,50000)',
    '--modes=native,legacy      Seed modes (default: native,legacy)',
    '--mode=native              Alias for one seed mode',
    '--increment=10             Objects receiving two old-writer revisions',
    '--old=PATH                 Frozen Schema3 MemoryDatabase module',
    '--out=PATH                 Also write the JSON result to PATH',
    '--help',
  ].join('\n');
}

function argumentValue(argv, index, key) {
  const argument = argv[index];
  const prefix = `${key}=`;
  if (argument.startsWith(prefix)) return [argument.slice(prefix.length), index];
  if (argument === key) {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${key} requires a value`);
    return [value, index + 1];
  }
  return ['', index];
}

function positiveInteger(value, name) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseList(value, name) {
  const values = value.split(',').filter((item) => item.length > 0).map((item) => positiveInteger(item, name));
  if (values.length === 0) throw new Error(`${name} must not be empty`);
  return [...new Set(values)];
}

function parseModes(value) {
  const values = value.split(',').filter((item) => item.length > 0);
  if (values.length === 0 || values.some((item) => !defaultModes.includes(item))) throw new Error('--modes must contain only native and legacy');
  return [...new Set(values)];
}

function parseArguments(argv) {
  let sizes = [...defaultSizes];
  let modes = [...defaultModes];
  let increment = defaultIncrement;
  let oldModule = defaultOldModule;
  let out;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    let value;
    [value, index] = argumentValue(argv, index, '--sizes');
    if (value !== '') {
      sizes = parseList(value, '--sizes');
      continue;
    }
    [value, index] = argumentValue(argv, index, '--modes');
    if (value !== '') {
      modes = parseModes(value);
      continue;
    }
    [value, index] = argumentValue(argv, index, '--mode');
    if (value !== '') {
      modes = parseModes(value);
      continue;
    }
    [value, index] = argumentValue(argv, index, '--increment');
    if (value !== '') {
      increment = positiveInteger(value, '--increment');
      continue;
    }
    [value, index] = argumentValue(argv, index, '--old');
    if (value !== '') {
      oldModule = resolve(value);
      continue;
    }
    [value, index] = argumentValue(argv, index, '--out');
    if (value !== '') {
      out = resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  for (const size of sizes) if (increment > size) throw new Error(`--increment=${increment} exceeds fixture size ${size}`);
  return { sizes, modes, increment, oldModule: resolve(oldModule), out };
}

function fingerprint(request) {
  return createHash('sha256').update(request).digest('hex');
}

function entryFor(mode, index, revision, session = `seed-${mode}-${index}`) {
  const id = `m_bench_${mode}_${String(index).padStart(6, '0')}`;
  return {
    id,
    revision,
    type: 'feedback',
    title: `Memory open benchmark ${index}`,
    body,
    status: 'active',
    pinned: false,
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    source: { writer: 'agent', session, turn: 17 },
    reason: 'Memory open benchmark fixture',
  };
}

function sourceId(mode, phase, index) {
  return `source:bench:${mode}:${phase}:${index}`;
}

function sourceFor(mode, phase, index, entry) {
  return { id: sourceId(mode, phase, index), scope, objectId: entry.id, payload: JSON.stringify(entry), learnedAt: entry.created };
}

function sourceUnitIds(memoryObjectSourceUnitId, memorySourceUnitId, entry) {
  const objectSource = memoryObjectSourceUnitId(scope, entry.id, entry.body);
  const signature = memorySourceUnitId(scope, entry.source, entry.body);
  assert.ok(signature);
  return { objectSource, signature };
}

function seedFixture({ Previous, memoryObjectSourceUnitId, memorySourceUnitId, path, size, mode }) {
  const initial = new Previous(path);
  initial.close();
  const raw = new DatabaseSync(path);
  const revisions = raw.prepare('INSERT INTO revisions VALUES(?,?,?,?,?)');
  const commitViews = raw.prepare('INSERT INTO commit_views VALUES(?,?,?,?)');
  const heads = raw.prepare('INSERT INTO heads VALUES(?,?,?)');
  const sources = raw.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?)');
  const sourceLinks = raw.prepare('INSERT INTO source_links VALUES(?,?,?)');
  const sourceSignatures = raw.prepare('INSERT INTO source_signatures VALUES(?,?,?)');
  const operations = raw.prepare('INSERT INTO operations VALUES(?,?,?,?)');
  const operationObjects = raw.prepare('INSERT INTO operation_objects VALUES(?,?,?)');
  const legacy = raw.prepare('INSERT INTO legacy VALUES(?,?,?,?,?,?)');
  const generation = raw.prepare("UPDATE metadata SET value=? WHERE key='generation'");
  try {
    raw.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < size; index++) {
      const entry = entryFor(mode, index, `seed:${mode}:${index}`);
      const encoded = JSON.stringify(entry);
      const currentGeneration = index + 1;
      const source = sourceFor(mode, 'seed', index, entry);
      const { objectSource, signature } = sourceUnitIds(memoryObjectSourceUnitId, memorySourceUnitId, entry);
      revisions.run(scope, entry.id, entry.revision, currentGeneration, encoded);
      commitViews.run(scope, entry.id, currentGeneration, entry.revision);
      heads.run(scope, entry.id, entry.revision);
      sources.run(source.id, scope, entry.id, encoded, null, entry.created);
      sourceLinks.run(scope, source.id, entry.id);
      sourceLinks.run(scope, objectSource, entry.id);
      sourceSignatures.run(scope, signature, entry.id);
      if (mode === 'native') {
        const operationId = `bench-seed-${mode}-${index}`;
        const request = `bench-seed-request-${mode}-${index}`;
        operations.run(operationId, fingerprint(request), currentGeneration, JSON.stringify({ entry }));
        operationObjects.run(operationId, scope, entry.id);
      } else {
        legacy.run(scope, `entries/${entry.id}.md`, encoded, entry.id, entry.revision, null);
      }
    }
    generation.run(size);
    raw.exec('COMMIT');
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) {
    try { raw.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    raw.close();
  }
}

function databaseCounts(path) {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    const count = (table) => Number(raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.['n']);
    return {
      revisions: count('revisions'),
      commitViews: count('commit_views'),
      heads: count('heads'),
      sources: count('sources'),
      sourceLinks: count('source_links'),
      sourceSignatures: count('source_signatures'),
      operations: count('operations'),
      operationObjects: count('operation_objects'),
      legacy: count('legacy'),
      generation: Number(raw.prepare("SELECT value FROM metadata WHERE key='generation'").get()?.['value']),
      userVersion: Number(raw.prepare('PRAGMA user_version').get()?.['user_version']),
    };
  } finally {
    raw.close();
  }
}

function measureOpen(Module, path, verify) {
  const started = performance.now();
  const database = new Module(path);
  const milliseconds = performance.now() - started;
  let verification;
  try {
    verification = verify?.(database);
  } finally {
    database.close();
  }
  return {
    milliseconds: Number(milliseconds.toFixed(3)),
    fileBytes: statSync(path).size,
    verification,
  };
}

function nativeIncrement({ Previous, path, increment, mode }) {
  let generation = databaseCounts(path).generation;
  const old = new Previous(path);
  const targets = Array.from({ length: increment }, (_, index) => index);
  const revisions = {};
  const allEntries = [];
  try {
    for (const phase of ['increment-a', 'increment-b']) {
      const previousRevision = phase === 'increment-a' ? (index) => `seed:${mode}:${index}` : (index) => revisions[index].revision;
      const entries = targets.map((index) => entryFor(mode, index, `bench:${phase}:${index}`, `${mode}-${phase}-${index}`));
      const edits = entries.map((entry, position) => ({
        scope,
        id: entry.id,
        expectedRevision: previousRevision(targets[position]),
        revision: entry.revision,
        entry,
      }));
      const sources = entries.map((entry, index) => sourceFor(mode, phase, index, entry));
      const journal = entries.map((entry, index) => {
        const before = phase === 'increment-a' ? entryFor(mode, index, `seed:${mode}:${index}`) : revisions[index];
        return { scope, operationId: `bench-${mode}-${phase}`, action: 'update', id: entry.id, at: entry.updated, writer: entry.source.writer, before: JSON.stringify(before), beforeRevision: before.revision, afterRevision: entry.revision };
      });
      old.commit({
        operationId: `bench-${mode}-${phase}`,
        request: `bench-request-${mode}-${phase}`,
        expectedGeneration: generation++,
        edits,
        sources,
        journal,
        result: { entries },
      });
      allEntries.push(...entries);
      for (let index = 0; index < entries.length; index++) revisions[index] = entries[index];
    }
  } finally {
    old.close();
  }
  return { entries: allEntries, revisionsPerObject: 2 };
}

function legacyIncrement({ Previous, path, increment, mode }) {
  const old = new Previous(path);
  const targets = Array.from({ length: increment }, (_, index) => index);
  const allEntries = [];
  try {
    for (const phase of ['increment-a', 'increment-b']) {
      const records = targets.map((index) => {
        const entry = entryFor(mode, index, `bench:${phase}:${index}`, `${mode}-${phase}-${index}`);
        allEntries.push(entry);
        return { scope, key: `entries/${entry.id}.md`, payload: JSON.stringify(entry), entry };
      });
      old.importLegacy(records);
    }
  } finally {
    old.close();
  }
  return { entries: allEntries, provenanceEntries: [allEntries[0], allEntries[increment]], revisionsPerObject: 2 };
}

function verifyIncrement(database, incrementResult, mode) {
  for (const entry of incrementResult.entries) assert.deepEqual(database.revision(scope, entry.id, entry.revision), entry);
  if (mode !== 'legacy') return { readableRevisions: incrementResult.entries.length, provenanceChecked: false };
  const provenanceEntries = incrementResult.provenanceEntries;
  const expectedSessions = new Set(provenanceEntries.map((entry) => entry.source.session));
  const provenance = database.provenance(scope, provenanceEntries[0].id);
  const matchingSources = provenance.sources.filter((source) => {
    const entry = JSON.parse(source.payload);
    return expectedSessions.has(entry.source?.session);
  });
  assert.equal(matchingSources.length, 2);
  assert.deepEqual(new Set(matchingSources.map((source) => JSON.parse(source.payload).source.session)), expectedSessions);
  for (const source of matchingSources) {
    const entry = JSON.parse(source.payload);
    assert.equal(entry.id, provenanceEntries[0].id);
    assert.equal(entry.body, body);
  }
  return { readableRevisions: incrementResult.entries.length, provenanceChecked: true, provenanceSources: provenance.sources.length, matchingSources: matchingSources.length };
}

function runCase({ Current, Previous, memoryObjectSourceUnitId, memorySourceUnitId, scratchRoot, size, mode, increment }) {
  const caseRoot = mkdtempSync(join(scratchRoot, `${mode}-${size}-`));
  const path = join(caseRoot, 'memory.sqlite');
  seedFixture({ Previous, memoryObjectSourceUnitId, memorySourceUnitId, path, size, mode });
  const seed = { fileBytes: statSync(path).size, counts: databaseCounts(path) };
  assert.equal(seed.counts.revisions, size);
  assert.equal(seed.counts.commitViews, size);
  assert.equal(seed.counts.heads, size);
  assert.equal(seed.counts.sources, size);
  assert.equal(seed.counts.sourceLinks, size * 2);
  assert.equal(seed.counts.sourceSignatures, size);
  assert.equal(seed.counts.generation, size);
  if (mode === 'native') {
    assert.equal(seed.counts.operations, size);
    assert.equal(seed.counts.operationObjects, size);
    assert.equal(seed.counts.legacy, 0);
  } else {
    assert.equal(seed.counts.operations, 0);
    assert.equal(seed.counts.operationObjects, 0);
    assert.equal(seed.counts.legacy, size);
  }
  const oldOpen = measureOpen(Previous, path);
  const currentFirstUpgrade = measureOpen(Current, path);
  const afterFirst = databaseCounts(path);
  assert.equal(afterFirst.revisions, size);
  assert.equal(afterFirst.heads, size);
  assert.equal(afterFirst.sources, size);
  assert.equal(afterFirst.generation, size);
  const currentReopen = [1, 2, 3].map(() => measureOpen(Current, path));
  const incrementResult = mode === 'native'
    ? nativeIncrement({ Previous, path, increment, mode })
    : legacyIncrement({ Previous, path, increment, mode });
  const currentIncrementalOpen = measureOpen(Current, path, (database) => verifyIncrement(database, incrementResult, mode));
  const finalCounts = databaseCounts(path);
  assert.equal(finalCounts.heads, size);
  assert.equal(finalCounts.revisions, size + increment * 2);
  assert.equal(finalCounts.generation, size + 2);
  return {
    mode,
    entries: size,
    bodyChars: body.length,
    increment,
    databasePath: path,
    seed,
    oldOpen,
    currentFirstUpgrade,
    currentReopen,
    currentIncrementalOpen,
    final: { fileBytes: statSync(path).size, counts: finalCounts },
  };
}

const options = parseArguments(process.argv.slice(2));
const [{ MemoryDatabase: Current }, { MemoryDatabase: Previous }, { memoryObjectSourceUnitId, memorySourceUnitId }] = await Promise.all([
  import(pathToFileURL(currentModulePath).href),
  import(pathToFileURL(options.oldModule).href),
  import(pathToFileURL(identityModulePath).href),
]);
const scratchRoot = mkdtempSync(join(tmpdir(), 'kiki-memory-open-'));
const results = [];
for (const mode of options.modes) for (const size of options.sizes) {
  process.stderr.write(`Benchmark ${mode} ${size}: seeding and measuring\n`);
  const result = runCase({ Current, Previous, memoryObjectSourceUnitId, memorySourceUnitId, scratchRoot, size, mode, increment: options.increment });
  results.push(result);
  process.stderr.write(`Benchmark ${mode} ${size}: first ${result.currentFirstUpgrade.milliseconds} ms, reopen ${result.currentReopen.map((sample) => sample.milliseconds).join('/')} ms, incremental ${result.currentIncrementalOpen.milliseconds} ms\n`);
}
const output = {
  benchmark: 'memory-open',
  scope,
  modes: options.modes,
  sizes: options.sizes,
  increment: options.increment,
  bodyChars: body.length,
  currentModule: currentModulePath,
  oldModule: options.oldModule,
  scratchRoot,
  results,
};
const encoded = JSON.stringify(output, null, 2);
if (options.out !== undefined) {
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${encoded}\n`);
}
process.stdout.write(`${encoded}\n`);
