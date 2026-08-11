/**
 * Thread mailbox persistence and sequencing scenarios.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MiniDb } from '@moonshot-ai/minidb';

import { MiniDbMailboxBackend } from '#/app/threadCommunication/miniDbThreadMailboxStore';
import type { ThreadRef } from '#/app/threadCommunication/threadCommunication';
import {
  ThreadActivityCursorExpiredError,
  ThreadMailboxBacklogError,
} from '#/app/threadCommunication/mailboxErrors';

const source: ThreadRef = { hostId: 'host-a', workspaceId: 'workspace-a', sessionId: 'source' };
const target: ThreadRef = { hostId: 'host-a', workspaceId: 'workspace-b', sessionId: 'target' };
const execFileAsync = promisify(execFile);
const writerFixture = fileURLToPath(
  new URL('./fixtures/mailbox-writer.mts', import.meta.url),
);

describe('MiniDbMailboxBackend', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'thread-mailbox-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('serializes concurrent writers and assigns one monotonic target sequence', async () => {
    const writers = Array.from({ length: 4 }, () => new MiniDbMailboxBackend(dir));
    const accepted = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        writers[index % writers.length]!.acceptMessage({
          producer: { kind: 'peer_thread', source },
          target,
          content: `message-${index}`,
          idempotencyKey: `key-${index}`,
        }),
      ),
    );

    expect(accepted.map((item) => item.message.targetSeq).toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    expect(new Set(accepted.map((item) => item.message.messageId)).size).toBe(24);
  }, 15_000);

  it('serializes independent process writers against the same target mailbox', async () => {
    const outputs = await Promise.all(
      Array.from({ length: 4 }, async (_, writer) => {
        const result = await execFileAsync(
          process.execPath,
          ['--import', 'tsx', writerFixture, dir, String(writer), '4'],
          { cwd: join(import.meta.dirname, '../../..') },
        );
        return JSON.parse(result.stdout) as number[];
      }),
    );

    expect(outputs.flat().toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
  }, 15_000);

  it('deduplicates the same scoped key and reports a conflicting payload', async () => {
    const store = new MiniDbMailboxBackend(dir);
    const first = await store.acceptMessage({
      producer: { kind: 'peer_thread', source },
      target,
      content: 'same',
      idempotencyKey: 'stable-key',
    });
    const same = await new MiniDbMailboxBackend(dir).acceptMessage({
      producer: { kind: 'peer_thread', source },
      target,
      content: 'same',
      idempotencyKey: 'stable-key',
    });
    const conflict = await new MiniDbMailboxBackend(dir).acceptMessage({
      producer: { kind: 'peer_thread', source },
      target,
      content: 'different',
      idempotencyKey: 'stable-key',
    });

    expect(same).toMatchObject({
      deduplicated: true,
      payloadConflict: false,
      message: { messageId: first.message.messageId, targetSeq: first.message.targetSeq },
    });
    expect(conflict).toMatchObject({ deduplicated: true, payloadConflict: true });
  });

  it('namespaces external and peer idempotency while preserving external retry semantics', async () => {
    const store = new MiniDbMailboxBackend(dir);
    const external = await store.acceptMessage({
      producer: { kind: 'external_client' },
      target,
      content: 'external',
      idempotencyKey: 'shared-key',
    });
    const peer = await store.acceptMessage({
      producer: { kind: 'peer_thread', source },
      target,
      content: 'peer',
      idempotencyKey: 'shared-key',
    });
    const externalRetry = await new MiniDbMailboxBackend(dir).acceptMessage({
      producer: { kind: 'external_client' },
      target,
      content: 'external',
      idempotencyKey: 'shared-key',
    });
    const externalConflict = await store.acceptMessage({
      producer: { kind: 'external_client' },
      target,
      content: 'changed',
      idempotencyKey: 'shared-key',
    });

    expect(peer.message.messageId).not.toBe(external.message.messageId);
    expect(externalRetry).toMatchObject({
      deduplicated: true,
      payloadConflict: false,
      message: { messageId: external.message.messageId },
    });
    expect(externalConflict).toMatchObject({
      deduplicated: true,
      payloadConflict: true,
      message: { messageId: external.message.messageId },
    });
  });

  it('reads uncommitted legacy source records only as peer provenance', async () => {
    const idempotencyKey = 'legacy-key';
    const messageId = 'legacy-message';
    const content = 'legacy peer';
    const legacyIdempotencyKey = `idem/${testHash({ source, target, key: idempotencyKey })}`;
    const db = await MiniDb.open<Record<string, unknown>>({
      dir,
      valueCodec: 'json',
      valueMode: 'memory',
      fsyncPolicy: 'always',
      recovery: 'strict',
      indexGenerations: false,
      activeExpireIntervalMs: 0,
    });
    await db.batch([
      {
        op: 'set',
        key: legacyIdempotencyKey,
        value: {
          kind: 'idempotency',
          source,
          target,
          idempotencyKey,
          payloadHash: testHash({ content }),
          messageId,
        },
      },
      {
        op: 'set',
        key: `delivery/${messageId}`,
        value: {
          kind: 'delivery',
          message: {
            messageId,
            source,
            target,
            content,
            idempotencyKey,
            acceptedAt: 1,
            targetSeq: 1,
          },
          state: 'pending',
          attempt: 0,
        },
      },
    ]);
    await db.close();

    const store = new MiniDbMailboxBackend(dir);
    const peerRetry = await store.acceptMessage({
      producer: { kind: 'peer_thread', source },
      target,
      content,
      idempotencyKey,
    });
    const external = await store.acceptMessage({
      producer: { kind: 'external_client' },
      target,
      content,
      idempotencyKey,
    });

    expect(peerRetry).toMatchObject({
      deduplicated: true,
      message: { messageId, producer: { kind: 'peer_thread', source } },
    });
    expect(external).toMatchObject({ deduplicated: false, message: { producer: { kind: 'external_client' } } });
  });

  it('recovers accepted messages after reopen and fences superseded delivery attempts', async () => {
    const firstStore = new MiniDbMailboxBackend(dir);
    const accepted = await firstStore.acceptMessage({
      producer: { kind: 'peer_thread', source },
      target,
      content: 'durable',
      idempotencyKey: 'reopen-key',
    });
    const firstAttempt = await firstStore.beginDelivery(accepted.message.messageId);
    const reopened = new MiniDbMailboxBackend(dir);
    const pending = await reopened.listPendingDeliveries();
    const secondAttempt = await reopened.beginDelivery(accepted.message.messageId);

    expect(pending).toEqual([accepted.message]);
    expect(firstAttempt).toBeDefined();
    expect(secondAttempt).toBeDefined();
    expect(
      await reopened.acknowledgeDelivery(accepted.message.messageId, firstAttempt!.attemptId),
    ).toBe(false);
    expect(
      await reopened.acknowledgeDelivery(accepted.message.messageId, secondAttempt!.attemptId),
    ).toBe(true);
    expect(await reopened.listPendingDeliveries()).toEqual([]);
  });

  it('persists activity epochs and workspace overrides', async () => {
    const store = new MiniDbMailboxBackend(dir);
    const baseline = await store.readActivity(target, Number.MAX_SAFE_INTEGER, 1);
    const activity = await store.appendActivity({
      target,
      kind: 'terminal',
      reason: 'completed',
      turnId: 3,
    });
    const page = await new MiniDbMailboxBackend(dir).readActivity(target, baseline.latestSeq, 8);

    expect(page.epoch).toBe(baseline.epoch);
    expect(page.activities).toEqual([activity]);
    expect(await store.getWorkspaceOverride(target.workspaceId)).toBeUndefined();
    await store.setWorkspaceOverride(target.workspaceId, false);
    expect(await new MiniDbMailboxBackend(dir).getWorkspaceOverride(target.workspaceId)).toBe(false);
    await store.clearWorkspaceOverride(target.workspaceId);
    expect(await store.getWorkspaceOverride(target.workspaceId)).toBeUndefined();
  });

  it('stores long thread and workspace identities under bounded collision-checked keys', async () => {
    const store = new MiniDbMailboxBackend(dir);
    const longSource: ThreadRef = {
      hostId: `host-${'h'.repeat(300)}`,
      workspaceId: `workspace-${'a'.repeat(300)}`,
      sessionId: `session-${'b'.repeat(300)}`,
    };
    const longTarget: ThreadRef = {
      hostId: `host-${'h'.repeat(300)}`,
      workspaceId: `workspace-${'c'.repeat(300)}`,
      sessionId: `session-${'d'.repeat(300)}`,
    };
    const accepted = await store.acceptMessage({
      producer: { kind: 'peer_thread', source: longSource },
      target: longTarget,
      content: 'long identity',
      idempotencyKey: 'long-key',
    });
    const baseline = await store.readActivity(longTarget, Number.MAX_SAFE_INTEGER, 1);
    const activity = await store.appendActivity({
      target: longTarget,
      kind: 'terminal',
      reason: 'completed',
    });
    const page = await new MiniDbMailboxBackend(dir).readActivity(longTarget, baseline.latestSeq, 8);

    expect(accepted.message).toMatchObject({ producer: { kind: 'peer_thread', source: longSource }, target: longTarget });
    expect(page.activities).toEqual([activity]);
    await store.setWorkspaceOverride(longTarget.workspaceId, false);
    expect(await new MiniDbMailboxBackend(dir).getWorkspaceOverride(longTarget.workspaceId)).toBe(false);
    await store.clearWorkspaceOverride(longTarget.workspaceId);
  });

  it('retains pending delivery and idempotency records when accepted events are pruned', async () => {
    const store = new MiniDbMailboxBackend(dir, {
      mailboxBacklogLimit: 2,
      pendingMessageLimit: 2,
    });
    const first = await store.acceptMessage({
      producer: { kind: 'peer_thread', source },
      target,
      content: 'first pending',
      idempotencyKey: 'first-pending',
    });
    await store.beginDelivery(first.message.messageId);
    const activeAttempt = await store.beginDelivery(first.message.messageId);
    const reopened = new MiniDbMailboxBackend(dir, {
      mailboxBacklogLimit: 2,
      pendingMessageLimit: 2,
    });

    expect(await reopened.listPendingDeliveries()).toEqual([first.message]);
    expect(await reopened.acceptMessage({
      producer: { kind: 'peer_thread', source },
      target,
      content: 'first pending',
      idempotencyKey: 'first-pending',
    })).toMatchObject({
      deduplicated: true,
      payloadConflict: false,
      message: { messageId: first.message.messageId, targetSeq: first.message.targetSeq },
    });

    await reopened.acceptMessage({
      producer: { kind: 'peer_thread', source },
      target,
      content: 'second pending',
      idempotencyKey: 'second-pending',
    });
    await expect(reopened.acceptMessage({
      producer: { kind: 'peer_thread', source },
      target,
      content: 'overflow',
      idempotencyKey: 'overflow',
    })).rejects.toBeInstanceOf(ThreadMailboxBacklogError);
    expect(await reopened.acknowledgeDelivery(first.message.messageId, activeAttempt!.attemptId)).toBe(true);
    await expect(reopened.acceptMessage({
      producer: { kind: 'peer_thread', source },
      target,
      content: 'accepted after terminal',
      idempotencyKey: 'after-terminal',
    })).resolves.toMatchObject({ deduplicated: false, delivery: 'pending' });
  });

  it('rejects activity cursors before retained history and accepts the exact boundary', async () => {
    const store = new MiniDbMailboxBackend(dir, { activityBacklogLimit: 3 });
    for (let index = 1; index <= 4; index++) {
      await store.appendActivity({
        target,
        kind: 'terminal',
        reason: `event-${index}`,
      });
    }

    await expect(store.readActivity(target, 0, 8)).rejects.toBeInstanceOf(
      ThreadActivityCursorExpiredError,
    );
    const boundary = await store.readActivity(target, 1, 8);
    expect(boundary.activities.map((activity) => activity.seq)).toEqual([2, 3, 4]);
    expect(await store.readActivity(target, boundary.latestSeq, 8)).toMatchObject({ activities: [] });
  });
});

function testHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}
