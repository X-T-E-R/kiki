import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { MailboxRow, MailboxWrite } from '#/persistence/backends/sqliteMailbox/protocol';
import type { ThreadRef } from './threadCommunication';
import { threadMessageIdempotencyKey as idempotencyKey } from './threadMessageIdentity';
import type { AcceptedThreadMessage, ThreadMessageProducer } from './threadMailboxStore';

type Document = Record<string, unknown>;

export class LegacyMailboxImportError extends Error {
  constructor(readonly key: string, message: string) { super(message); }
}

export interface LegacyMailboxImportReader {
  get(key: string): Promise<Document | undefined>;
  find(partition: string, field: 'messageId' | 'legacyIdentity', value: string): Promise<MailboxRow | undefined>;
  sourceGet(key: string): MailboxRow | undefined;
}

export async function convertLegacyMailboxRows(rows: readonly MailboxRow[], reader: LegacyMailboxImportReader): Promise<readonly MailboxWrite<Document>[]> {
  const staged = new Map<string, Document>();
  const writes: MailboxWrite<Document>[] = [];
  const get = async (key: string): Promise<Document | undefined> => staged.get(key) ?? reader.get(key);
  const put = (key: string, value: Document, expireAt = 0): void => { staged.set(key, value); writes.push({ op: 'set', key, value, expireAt }); };
  const metaFor = async (target: ThreadRef): Promise<Document> => {
    const current = await get(`${partitionFor(target)}/meta`);
    if (current !== undefined) return current;
    const sourceMeta = reader.sourceGet(`activity/${hash({ hostId: target.hostId, workspaceId: target.workspaceId, sessionId: target.sessionId })}/meta`)?.value;
    const epoch = sourceMeta?.['kind'] === 'activity_meta' && isDeepStrictEqual(sourceMeta['target'], target) && typeof sourceMeta['epoch'] === 'string'
      ? sourceMeta['epoch'] : '';
    return { kind: 'target_meta', target, nextMessageSeq: 1, nextDeliverableSeq: 1, pendingCount: 0,
      activityEpoch: epoch, nextActivitySeq: 1, minActivitySeq: 1 };
  };
  for (const row of rows) {
    const value = row.value;
    const fail = (): never => { throw new LegacyMailboxImportError(row.key, `Invalid legacy mailbox record at ${row.key} (${String(value['kind'])})`); };
    switch (value['kind']) {
      case 'delivery': {
        if (!row.key.startsWith('delivery/')) fail();
        const message = legacyMessage(value['message']);
        const state = value['state'];
        if (message === undefined || !['pending', 'delivering', 'delivered', 'undeliverable'].includes(String(state)) || !nonnegative(value['attempt']) || typeof value['idempotencyStorageKey'] !== 'string') fail();
        const accepted = message!;
        const partition = partitionFor(accepted.target);
        const known = [...staged.entries()].find(([key, doc]) => key.startsWith(`${partition}/message/`) && doc['kind'] === 'message' && (doc['message'] as AcceptedThreadMessage).messageId === accepted.messageId)?.[1]
          ?? (await reader.find(partition, 'messageId', accepted.messageId))?.value;
        if (known !== undefined) {
          const existing = known['message'] as AcceptedThreadMessage;
          if (!isDeepStrictEqual({ ...existing, targetSeq: accepted.targetSeq }, accepted)) throw new LegacyMailboxImportError(row.key, `Conflicting legacy message identity at ${row.key}`);
          break;
        }
        const meta = await metaFor(accepted.target);
        const seq = Math.max(accepted.targetSeq, Number(meta['nextMessageSeq']));
        if (!Number.isSafeInteger(seq) || seq < 1) fail();
        const normalized = { ...accepted, targetSeq: seq };
        const idem = idempotencyKey(partition, accepted);
        const originalIdem = reader.sourceGet(String(value['idempotencyStorageKey']));
        const payloadHash = typeof originalIdem?.value['payloadHash'] === 'string' ? originalIdem.value['payloadHash'] : hash({ content: accepted.content });
        const key = messageKey(partition, seq);
        put(key, { kind: 'message', message: normalized, idempotencyStorageKey: idem, payloadHash, state,
          fence: Number(value['attempt']) + (state === 'delivering' ? 1 : 0),
          legacyAttempt: { attempt: value['attempt'], activeAttemptId: value['activeAttemptId'], sourceKey: row.key } }, row.expireAt);
        const priorIdem = await get(idem);
        if (priorIdem !== undefined && (priorIdem['payloadHash'] !== payloadHash || priorIdem['messageKey'] !== key)) throw new LegacyMailboxImportError(row.key, `Conflicting legacy idempotency key at ${row.key}`);
        put(idem, { kind: 'idempotency', producer: accepted.producer, target: accepted.target, idempotencyKey: accepted.idempotencyKey, payloadHash, messageKey: key, messageId: accepted.messageId }, originalIdem?.expireAt ?? row.expireAt);
        const pending = state === 'pending' || state === 'delivering';
        const nextMessageSeq = Math.max(Number(meta['nextMessageSeq']), seq + 1);
        put(`${partition}/meta`, { ...meta, nextMessageSeq,
          pendingCount: Number(meta['pendingCount']) + Number(pending), nextDeliverableSeq: Number(meta['pendingCount']) === 0
            ? pending ? seq : nextMessageSeq : pending ? Math.min(Number(meta['nextDeliverableSeq']), seq) : meta['nextDeliverableSeq'] });
        for (const op of mailboxPeerIndexWrites(partition, normalized)) if (op.op === 'set') put(op.key, op.value);
        break;
      }
      case 'idempotency': {
        if (!row.key.startsWith('idem/') || typeof value['messageId'] !== 'string' || typeof value['payloadHash'] !== 'string' || typeof value['idempotencyKey'] !== 'string') fail();
        const target = threadRef(value['target']);
        const producer = legacyProducer(value);
        if (target === undefined || producer === undefined) fail();
        const partition = partitionFor(target!);
        const input = { producer: producer!, target: target!, idempotencyKey: String(value['idempotencyKey']) };
        const key = idempotencyKey(partition, input);
        const prior = await get(key);
        if (prior === undefined) {
          const found = await reader.find(partition, 'messageId', String(value['messageId']));
          put(key, { kind: 'idempotency', ...input, payloadHash: value['payloadHash'], messageId: value['messageId'], messageKey: found?.key ?? `${partition}/legacy-message/${String(value['messageId'])}` }, row.expireAt);
        }
        break;
      }
      case 'activity_meta': {
        const target = threadRef(value['target']);
        if (target === undefined || typeof value['epoch'] !== 'string' || !positive(value['nextSeq']) || !positive(value['minSeq']) || !row.key.startsWith('activity/')) fail();
        const partition = partitionFor(target!);
        const existing = await get(`${partition}/meta`);
        const meta = existing ?? await metaFor(target!);
        if (supersededActivityEpoch(meta, value['epoch'])) break;
        put(`${partition}/meta`, { ...meta, activityEpoch: meta['activityEpoch'] === '' ? value['epoch'] : meta['activityEpoch'],
          nextActivitySeq: Math.max(Number(meta['nextActivitySeq']), Number(value['nextSeq'])),
          minActivitySeq: Number(meta['nextActivitySeq']) === 1 ? value['minSeq'] : Math.min(Number(meta['minActivitySeq']), Number(value['minSeq'])) });
        break;
      }
      case 'activity_event': {
        const target = threadRef(value['target']);
        const activity = record(value['activity']);
        if (target === undefined || activity === undefined || !positive(activity['seq']) || typeof activity['epoch'] !== 'string' || !nonnegative(activity['at']) || typeof activity['reason'] !== 'string' || !['terminal', 'attention', 'lifecycle', 'message_undeliverable'].includes(String(activity['kind']))) fail();
        const partition = partitionFor(target!);
        const identity = hash({ target, activity });
        if ([...staged.values()].some((doc) => doc['legacyIdentity'] === identity) || await reader.find(partition, 'legacyIdentity', identity) !== undefined) break;
        const meta = await metaFor(target!);
        if (supersededActivityEpoch(meta, activity!['epoch'])) break;
        const seq = Number(activity!['seq']);
        if (await get(activityKey(partition, seq)) !== undefined) throw new LegacyMailboxImportError(row.key, `Conflicting legacy activity sequence at ${row.key}; both sources were preserved`);
        put(activityKey(partition, seq), { kind: 'activity', target, activity, legacyIdentity: identity }, row.expireAt);
        put(`${partition}/meta`, { ...meta, activityEpoch: meta['activityEpoch'] === '' ? activity!['epoch'] : meta['activityEpoch'],
          nextActivitySeq: Math.max(Number(meta['nextActivitySeq']), seq + 1), minActivitySeq: Number(meta['nextActivitySeq']) === 1 ? seq : Math.min(Number(meta['minActivitySeq']), seq) });
        break;
      }
      case 'workspace_override': {
        if (typeof value['workspaceId'] !== 'string' || typeof value['enabled'] !== 'boolean' || !nonnegative(value['updatedAt'])) fail();
        const key = `w/${hash({ workspaceId: value['workspaceId'] })}/override`;
        const prior = await get(key);
        if (prior === undefined || Number(prior['updatedAt']) <= Number(value['updatedAt'])) put(key, value, row.expireAt);
        break;
      }
      case 'mailbox_meta':
        if (threadRef(value['target']) === undefined || typeof value['epoch'] !== 'string' || !positive(value['nextSeq']) || !positive(value['minSeq']) || !nonnegative(value['pendingCount']) || !row.key.startsWith('mailbox/')) fail();
        break;
      case 'message_event':
        if (threadRef(value['target']) === undefined || !positive(value['seq']) || !nonnegative(value['at']) || typeof value['messageId'] !== 'string' || !['accepted', 'delivery_attempt', 'delivered', 'undeliverable'].includes(String(value['event'])) || !row.key.startsWith('mailbox/')) fail();
        break;
      default: fail();
    }
  }
  return writes;
}

export function mailboxPeerIndexWrites(partition: string, message: AcceptedThreadMessage): readonly MailboxWrite<Document>[] {
  if (message.producer.kind === 'external_client') return [];
  const groups = new Set(['all', `session:${message.target.sessionId}`, `workspace:${message.target.workspaceId}`]);
  if (message.producer.kind === 'peer_thread') { groups.add(`session:${message.producer.source.sessionId}`); groups.add(`workspace:${message.producer.source.workspaceId}`); }
  const peerOrder = `${message.acceptedAt.toString().padStart(16, '0')}/${message.messageId}`;
  return [...groups].map((peerGroup) => ({ op: 'set', key: `${partition}/peer/${hash([peerGroup, message.messageId])}`,
    value: { kind: 'peer_index', peerGroup, peerOrder, partition, messageKey: messageKey(partition, message.targetSeq) } }));
}

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('base64url'); }
function partitionFor(target: ThreadRef): string { return `t/${hash({ hostId: target.hostId, workspaceId: target.workspaceId, sessionId: target.sessionId })}`; }
function messageKey(partition: string, seq: number): string { return `${partition}/message/${seq.toString().padStart(16, '0')}`; }
function activityKey(partition: string, seq: number): string { return `${partition}/activity/${seq.toString().padStart(16, '0')}`; }
function record(value: unknown): Document | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Document : undefined; }
function supersededActivityEpoch(meta: Document, epoch: unknown): boolean {
  const current = meta['activityEpoch'];
  return typeof current === 'string' && current !== '' && current !== epoch;
}
function nonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function positive(value: unknown): value is number { return nonnegative(value) && value > 0; }
function threadRef(value: unknown): ThreadRef | undefined {
  const ref = record(value);
  return ref !== undefined && ['hostId', 'workspaceId', 'sessionId'].every((key) => typeof ref[key] === 'string') ? ref as unknown as ThreadRef : undefined;
}
function legacyProducer(value: Document): ThreadMessageProducer | undefined {
  const producer = record(value['producer']);
  if (producer?.['kind'] === 'external_client') return producer as unknown as ThreadMessageProducer;
  if (producer?.['kind'] === 'peer_thread' && threadRef(producer['source']) !== undefined) return producer as unknown as ThreadMessageProducer;
  if (producer?.['kind'] === 'room' && typeof producer['roomId'] === 'string') return producer as unknown as ThreadMessageProducer;
  const source = threadRef(value['source']);
  return source === undefined ? undefined : { kind: 'peer_thread', source };
}
function legacyMessage(value: unknown): AcceptedThreadMessage | undefined {
  const input = record(value);
  if (input === undefined) return undefined;
  const target = threadRef(input['target']);
  const producer = legacyProducer(input);
  if (target === undefined || producer === undefined || !['messageId', 'content', 'idempotencyKey'].every((key) => typeof input[key] === 'string') || !nonnegative(input['acceptedAt']) || !positive(input['targetSeq'])) return undefined;
  if (target.hostId === 'agent-collaboration-v2') {
    let envelope: Document | undefined;
    try { envelope = record(JSON.parse(String(input['content']))); } catch { return undefined; }
    if (envelope?.['v'] !== 1 || envelope['kind'] !== 'agent_collaboration_message' || !['sourceTaskName', 'targetTaskName', 'content'].every((key) => typeof envelope![key] === 'string')) return undefined;
  }
  return { messageId: String(input['messageId']), content: String(input['content']), idempotencyKey: String(input['idempotencyKey']),
    acceptedAt: input['acceptedAt'], targetSeq: input['targetSeq'], target, producer };
}
