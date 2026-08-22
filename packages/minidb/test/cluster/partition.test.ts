import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { scanFrameRefsFile, TYPE_BATCH } from '../../src/codec.js';
import { ClusterDb, shardDirName } from '../../src/cluster/index.js';
import { tmpDir, rmrf } from '../e2e/helpers/tmp.js';

test('partition mailbox operations stay on one shard and one atomic WAL batch', async () => {
  const dir = await tmpDir('minidb-cluster-partition-');
  const partition = 'mailbox-a';
  const messageKey = `${partition}/message`;
  const receiptKey = `${partition}/receipt`;
  const foreignKey = 'mailbox-b/receipt';
  let db: ClusterDb<{ value: number }> | undefined;

  try {
    db = await ClusterDb.open({
      dir,
      shardCount: 8,
      valueCodec: 'json',
      fsyncPolicy: 'always',
      autoCompact: false,
      indexGenerations: false,
    });
    const partitionShard = db.shardOf(partition);
    assert.notEqual(db.shardOf(messageKey), partitionShard);

    await assert.rejects(
      db.partitionBatch(partition, [
        { op: 'set', key: messageKey, value: { value: 1 } },
        { op: 'set', key: foreignKey, value: { value: 2 } },
      ]),
      /does not belong to partition "mailbox-a"/,
    );
    assert.equal(await db.partitionGet(partition, messageKey), undefined);

    await db.partitionBatch(partition, [
      { op: 'set', key: messageKey, value: { value: 1 } },
      { op: 'set', key: receiptKey, value: { value: 2 } },
    ]);
    assert.deepEqual(await db.partitionGet(partition, messageKey), { value: 1 });
    assert.deepEqual(
      (await db.partitionPrefix(partition, `${partition}/`)).map(({ key, value }) => [key, value]),
      [
        [messageKey, { value: 1 }],
        [receiptKey, { value: 2 }],
      ],
    );
    assert.equal(await db.get(messageKey), undefined);

    await db.close();
    db = undefined;

    const walPath = path.join(dir, shardDirName(partitionShard, 8), 'db.wal');
    const wal = await fs.stat(walPath);
    assert.ok(wal.size > 0);
    const scanned = scanFrameRefsFile(walPath, { onCorrupt: 'strict' });
    assert.deepEqual(scanned.corruptRanges, []);
    assert.equal(scanned.frames.length, 1);
    assert.equal(scanned.frames[0]?.type, TYPE_BATCH);
  } finally {
    await db?.close();
    await rmrf(dir);
  }
});
