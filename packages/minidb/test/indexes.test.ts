// test/indexes.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';
import { UniqueViolationError } from '../src/index-manager.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-idx-'));
}

test('equality index findEq', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byCity', { field: 'city' });
    await db.set('u1', { name: 'Ann', city: 'Paris' });
    await db.set('u2', { name: 'Bob', city: 'Paris' });
    await db.set('u3', { name: 'Eve', city: 'London' });
    const res = db.findEq('byCity', 'Paris').map((r) => r.key).sort();
    assert.deepEqual(res, ['u1', 'u2']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('range index findRange with bounds + limit', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byAge', { field: 'age', type: 'range' });
    for (let i = 1; i <= 10; i++) await db.set(`p${i}`, { age: i * 10 });
    const ages = db.findRange('byAge', { min: 30, max: 70, count: 3 }).map((r) => r.field);
    assert.deepEqual(ages, [30, 40, 50]);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('unique index rejects duplicates', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byEmail', { field: 'email', unique: true });
    await db.set('a', { email: 'user@example.test' });
    await assert.rejects(() => db.set('b', { email: 'user@example.test' }), UniqueViolationError);
    // Re-setting the same key with the same value is allowed.
    await db.set('a', { email: 'user@example.test' });
    assert.equal(db.size, 1);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('index is updated on delete', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byCity', { field: 'city' });
    await db.set('u1', { city: 'Paris' });
    await db.del('u1');
    assert.deepEqual(db.findEq('byCity', 'Paris'), []);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('array field is indexed per element', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byTag', { field: 'tags' });
    await db.set('a', { tags: ['red', 'blue'] });
    await db.set('b', { tags: ['blue', 'green'] });
    assert.deepEqual(db.findEq('byTag', 'red').map((r) => r.key), ['a']);
    assert.deepEqual(db.findEq('byTag', 'blue').map((r) => r.key).sort(), ['a', 'b']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('index definitions + data rebuild across reopen', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byAge', { field: 'age', type: 'range' });
    for (let i = 1; i <= 5; i++) await db.set(`p${i}`, { age: i });
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'json' });
    assert.deepEqual(db.listIndexes().map((i) => i.name), ['byAge']);
    assert.deepEqual(db.findRange('byAge', { min: 2, max: 4 }).map((r) => r.key), [
      'p2',
      'p3',
      'p4',
    ]);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('unique equality index: batch swap, del+reuse, intra-batch/concurrent conflict, and createIndex on dups', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.set('d1', { dup: 'same' });
    await db.set('d2', { dup: 'same' });
    await assert.rejects(db.createIndex('byDup', { field: 'dup', unique: true }), /unique/i);
    assert.equal(db.listIndexes().length, 0);

    await db.createIndex('byMail', { field: 'email', unique: true });
    // Intra-batch violation leaves nothing committed.
    await assert.rejects(
      db.batch([{ op: 'set', key: 'x1', value: { email: 'dup@example.test' } }, { op: 'set', key: 'x2', value: { email: 'dup@example.test' } }]),
      /unique/i,
    );
    assert.equal(db.get('x1'), undefined);
    assert.equal(db.get('x2'), undefined);

    // Swap and del+reuse inside a batch succeed; touching existing owner rejects.
    await db.set('u1', { email: 'alice@example.test' });
    await db.set('u2', { email: 'bob@example.test' });
    await db.batch([
      { op: 'set', key: 'u1', value: { email: 'bob@example.test' } },
      { op: 'set', key: 'u2', value: { email: 'alice@example.test' } },
    ]);
    assert.equal(db.get('u1')?.email, 'bob@example.test');
    assert.equal(db.get('u2')?.email, 'alice@example.test');
    await db.batch([{ op: 'del', key: 'u1' }, { op: 'set', key: 'u3', value: { email: 'bob@example.test' } }]);
    assert.equal(db.get('u1'), undefined);
    assert.deepEqual(db.findEq('byMail', 'bob@example.test').map((r) => r.key), ['u3']);
    await assert.rejects(db.batch([{ op: 'set', key: 'u4', value: { email: 'bob@example.test' } }]), /unique/i);
    assert.equal(db.get('u4'), undefined);

    // Concurrent sets cannot both commit the same unique value.
    const settled = await Promise.allSettled([
      db.set('c1', { email: 'race@example.test' }),
      db.set('c2', { email: 'race@example.test' }),
    ]);
    assert.ok(settled.filter((r) => r.status === 'fulfilled').length <= 1);
    assert.ok(db.findEq('byMail', 'race@example.test').length <= 1);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('range index handles array fields (dedupes elements + cleans up on update) and eq canonicalizes object keys', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byScore', { field: 'scores', type: 'range' });
    await db.createIndex('byMeta', { field: 'meta' });

    await db.set('a', { scores: [10, 20, 30, 10] });
    await db.set('b', { scores: [25] });
    assert.equal(db.findRange('byScore', { min: 0, max: 100 }).length, 4);
    assert.deepEqual(db.findRange('byScore', { min: 10, max: 10 }).map((r) => r.key), ['a']);
    await db.set('a', { scores: [20, 20] });
    assert.deepEqual(db.findRange('byScore', { min: 10, max: 10 }).map((r) => r.key), []);
    assert.deepEqual(db.findRange('byScore', { min: 20, max: 20 }).map((r) => r.key), ['a']);

    await db.set('k1', { meta: { a: 1, b: 2 } });
    await db.set('k2', { meta: { nested: { x: 1, y: 2 } } });
    assert.deepEqual(db.findEq('byMeta', { b: 2, a: 1 }).map((r) => r.key), ['k1']);
    assert.deepEqual(db.findEq('byMeta', { nested: { y: 2, x: 1 } }).map((r) => r.key), ['k2']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('active expiration drops expired keys from secondary and full-text indexes', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', activeExpireIntervalMs: 20 });
    await db.createIndex('byCity', { field: 'city' });
    await db.createTextIndex('body');
    await db.set('u1', { city: 'Paris', bio: 'hello world' }, { ttl: 30 });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(db.get('u1'), undefined);
    assert.deepEqual(db.findEq('byCity', 'Paris'), []);
    assert.deepEqual(db.search('body', 'hello'), []);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('expired keys are excluded from findEq/findRange/search/compoundRange and reaped via scan()', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', activeExpireIntervalMs: 0 });
    await db.createIndex('byCity', { field: 'city' });
    await db.createIndex('byAge', { field: 'age', type: 'range' });
    await db.createTextIndex('body', { fields: ['bio'] });
    await db.createCompoundIndex('byWs', { groupBy: 'ws', orderBy: 'ts' });
    await db.set('g', { city: 'Paris', age: 30, bio: 'hello world', ws: 'W1' }, { ttl: 1, dt: { ts: 100 } });
    await new Promise((r) => setTimeout(r, 15));

    assert.deepEqual(db.findEq('byCity', 'Paris'), []);
    assert.deepEqual(db.findRange('byAge', { min: 0, max: 100 }), []);
    assert.deepEqual(db.search('body', 'hello'), []);
    assert.deepEqual(db.compoundRange('byWs', 'W1'), []);
    assert.deepEqual(db.dtRange('ts', { gte: 0, lte: 1000 }), []);

    // scan() must reap the expired key from raw derived structures too.
    assert.deepEqual(db.scan(), []);
    assert.deepEqual(db.dt.columns(), []);
    assert.deepEqual(db.indexes.findEq('byCity', 'Paris'), []);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
