import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { IConfigService, ISessionIndex, ISessionManager, type Scope } from '@kiki/agent-core-v2';
import { AgentTranscriptDraft, TranscriptFactReducer, TranscriptWireAdapter, applyContentSegment, TRANSCRIPT_COVERAGE_VERSION, type ContentSegment, type TranscriptResponse, type TranscriptTurn } from '@kiki/transcript';
import Fastify from 'fastify';
import { registerSessionViewHttp, SessionViewHttpConnection } from '../src/transport/klient/sessionViewHttp';
import type { SessionEventBroadcaster } from '../src/transport/ws/v1/sessionEventBroadcaster';
import { sessionHistoryBudgetRecords } from './fixtures/sessionHistoryBudget';
import { describe, expect, it, vi } from 'vitest';

import { HistoryNavigationDb } from '../src/services/history/historyNavigationDb';
import { HistoryLocatorStore } from '../src/services/history/historyLocatorStore';
import { CanonicalEntityPreparingError, HistoryCanonicalReader } from '../src/services/history/historyCanonicalReader';
import { TranscriptService } from '../src/services/transcript/transcriptService';
import { boundedEntity } from '../src/transport/klient/boundedContent';
import { readSessionViewTranscriptContent, readSessionViewTranscriptPage } from '../src/transport/klient/sessionViewReads';

vi.mock('node:fs/promises', { spy: true });

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const event = (value: Record<string, unknown>) => ({ type: 'context.append_loop_event', event: value, time: 2000 });
function turnRecords(turnId: number, output: unknown, callId = `call-${turnId}`): Record<string, unknown>[] {
  const step = `step-${turnId}`;
  return [
    { type: 'turn.prompt', turnId, promptId: `prompt-${turnId}`, input: [{ type: 'text', text: `question ${turnId}` }], origin: { kind: 'user' }, time: 1000 },
    event({ type: 'step.begin', turnId, step: 1, uuid: step }),
    event({ type: 'content.part', turnId, stepUuid: step, uuid: `think-${turnId}`, part: { type: 'think', think: '完整思考' } }),
    event({ type: 'tool.call', turnId, stepUuid: step, toolCallId: callId, name: 'Example', args: { target: turnId }, display: { type: 'diff', before: 'before', after: 'after' } }),
    event({ type: 'tool.progress', toolCallId: callId, update: { kind: 'custom', text: 'progress', customKind: 'phase', customData: { phase: 2 } } }),
    event({ type: 'tool.result', toolCallId: callId, result: { output, isError: true, errorCode: 'example_error' } }),
    event({ type: 'step.end', turnId, step: 1, uuid: step }),
    { type: 'turn.ended', turnId, reason: 'completed', time: 3000 },
  ];
}

async function fixture(records: readonly Record<string, unknown>[], detailCacheBudget?: () => number) {
  const base = resolve('../../.tmp/canonical-detail-fixtures');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'read-'));
  const agentDir = join(dir, 'sessions', 'ws', 's', 'agents', 'main');
  await mkdir(agentDir, { recursive: true });
  const wirePath = join(agentDir, 'wire.jsonl');
  await writeFile(wirePath, records.map(line).join(''));
  const core = { accessor: { get: (token: unknown) => token === ISessionIndex
    ? { get: async (id: string) => id === 's' ? { workspaceId: 'ws' } : undefined }
    : token === ISessionManager ? { get: () => undefined, list: () => [] }
      : token === IConfigService && detailCacheBudget !== undefined ? { get: () => ({ maxDetailCacheBytes: detailCacheBudget() }) } : undefined } } as unknown as Scope;
  const service = new TranscriptService({ homeDir: dir, core });
  const dbPath = join(dir, 'navigation.sqlite');
  const db = HistoryNavigationDb.lazy(dbPath);
  const nav = new HistoryLocatorStore(db, service);
  service.setHistoryLocatorReader(() => nav);
  return { dir, db, dbPath, nav, service, wirePath, close: async () => {
    service.dispose(); await db.close(); await rm(dir, { recursive: true, force: true });
  } };
}

function canonical(records: readonly Record<string, unknown>[]): TranscriptTurn | undefined {
  const draft = new AgentTranscriptDraft('main');
  const reducer = new TranscriptFactReducer(draft);
  const adapter = new TranscriptWireAdapter('main', { turn: (id) => draft.getTurn(id), tool: (id) => draft.getToolCall(id) });
  for (const record of records) reducer.apply(adapter.add(record as { type: string }));
  reducer.apply(adapter.finish());
  return draft.getTurn('t100');
}

describe('source-backed canonical detail', () => {
  it('prepares a large history once and replays only the target, then reuses warm and reopened reads', async () => {
    const history = Array.from({ length: 100 }, (_, id) => turnRecords(id, 'unrelated'.repeat(12000))).flat();
    const media = [{ type: 'text', text: '完整输出' }, { type: 'image', image: { url: 'blobref:main:example' } }];
    const target = turnRecords(100, media);
    const records = [...history, ...target];
    const f = await fixture(records);
    try {
      expect(Buffer.byteLength(records.map(line).join(''))).toBeGreaterThan(8 << 20);
      expect(await f.service.lookupToolCall('s', 'main', 'call-100')).toEqual({ status: 'preparing' });
      const first = await f.service.lookupToolCall('s', 'main', 'call-100');
      expect(first.status).toBe('found');
      if (first.status !== 'found') throw new Error('missing target');
      expect(first.frame).toMatchObject({ state: 'error', output: media, errorCode: 'example_error',
        display: { type: 'diff', before: 'before', after: 'after' },
        progress: { kind: 'custom', text: 'progress', customData: { phase: 2 } } });
      const source = { kind: 'turn' as const, id: 't100' };
      const complete = await f.service.readCanonicalEntity('s', 'main', source);
      expect(complete).toEqual(canonical(records));
      expect(complete).toMatchObject({ steps: [{ frames: [{ kind: 'thinking', text: '完整思考' }, { kind: 'tool' }] }] });
      const cold = f.nav.canonicalReadReport();
      expect(cold.replays).toBe(1);
      expect(cold.replayRecords).toBe(target.length);
      expect(cold.replayBytes).toBe(Buffer.byteLength(target.map(line).join('')));
      expect(cold.projectionRecords).toBe(records.length);
      expect(cold.cacheBytes).toBeLessThanOrEqual(4 << 20);
      await f.service.lookupToolCall('s', 'main', 'call-100');
      await f.service.readCanonicalEntity('s', 'main', { kind: 'frame', id: first.frame.frameId, turnId: first.turnId, stepId: first.stepId });
      expect(f.nav.canonicalReadReport()).toMatchObject({ replays: 1, replayRecords: target.length, projectionRecords: records.length });
      const warm = f.nav.canonicalReadReport();
      await f.db.close();
      const reopenedDb = HistoryNavigationDb.lazy(f.dbPath);
      try {
        const reopened = new HistoryLocatorStore(reopenedDb, f.service);
        f.service.setHistoryLocatorReader(() => reopened);
        expect(await f.service.lookupToolCall('s', 'main', 'call-100')).toEqual(first);
        expect(reopened.canonicalReadReport()).toMatchObject({ replays: 1, replayRecords: target.length, projectionBytes: 0, projectionRecords: 0 });
        console.log('canonical-detail-measurement', JSON.stringify({ wireBytes: Buffer.byteLength(records.map(line).join('')),
          records: records.length, cold, warm, reopen: reopened.canonicalReadReport() }));
      } finally { await reopenedDb.close(); }
      expect(f.service.memoryReport().coldReads.completed).toBe(0);
    } finally { await f.close(); }
  });

  it('shares concurrent target replay and caches a small frame when its enclosing turn exceeds admission', async () => {
    const records = turnRecords(100, 'small target');
    records.splice(3, 0, event({ type: 'content.part', turnId: 100, stepUuid: 'step-100', uuid: 'large-unopened-text',
      part: { type: 'text', text: 'x'.repeat(3 << 20) } }));
    const f = await fixture(records);
    try {
      const [first, second] = await Promise.all([
        f.service.lookupToolCall('s', 'main', 'call-100'), f.service.lookupToolCall('s', 'main', 'call-100'),
      ]);
      expect(first).toEqual(second);
      expect(first.status).toBe('found');
      const before = f.nav.canonicalReadReport();
      expect(before).toMatchObject({ replays: 1, replayRecords: records.length, cacheEntries: 1 });
      expect(before.cacheBytes).toBeLessThan(10000);
      await f.service.lookupToolCall('s', 'main', 'call-100');
      await f.service.readCanonicalEntity('s', 'main', { kind: 'frame', id: 'step-100.call-100', turnId: 't100', stepId: 'step-100' });
      expect(f.nav.canonicalReadReport()).toMatchObject({ replays: 1, replayBytes: before.replayBytes });
    } finally { await f.close(); }
  });

  it('reuses one oversized target across full range-copy requests and continuous reading beyond the idle TTL', async () => {
    const output = 'big output line '.repeat(210000) + '\nBIG-TAIL-NEEDLE';
    const records = turnRecords(100, output);
    records[5] = event({ type: 'tool.result', toolCallId: 'call-100', result: { output, isError: false } });
    const f = await fixture(records);
    const start = Date.now();
    let now = start;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const hit = await f.service.lookupToolCall('s', 'main', 'call-100');
      if (hit.status !== 'found') throw new Error('missing oversized target');
      const source = { kind: 'frame' as const, id: hit.frame.frameId, turnId: hit.turnId, stepId: hit.stepId };
      const ref = boundedEntity(hit.frame, source).contentRefs?.find((value) => value.path.length === 1 && value.path[0] === 'output');
      if (ref === undefined) throw new Error('missing output continuation');
      const scan = vi.spyOn(f.nav, 'scan');
      const before = f.nav.canonicalReadReport();
      const copied: string[] = [];
      let offset = 0;
      let requests = 0;
      while (offset < output.length) {
        now += 200;
        const segment = await readSessionViewTranscriptContent(f.service, 's', { agentId: 'main', ref: { ...ref, offset }, range: true });
        if (typeof segment?.value !== 'string') throw new Error('missing output range');
        copied.push(segment.value);
        offset += segment.value.length;
        requests += 1;
      }
      expect(copied.join('')).toBe(output);
      expect(requests).toBeGreaterThan(800);
      const after = f.nav.canonicalReadReport();
      expect(after).toMatchObject({ replays: 1, replayBytes: before.replayBytes, replayRecords: records.length,
        oversizedCacheEntries: 1 });
      expect(after.cacheBytes).toBeLessThanOrEqual(after.cacheBudgetBytes);
      expect(scan).not.toHaveBeenCalled();
      scan.mockRestore();
      const cancel = new AbortController(); cancel.abort();
      await expect(f.service.readCanonicalEntity('s', 'main', source, cancel.signal)).rejects.toMatchObject({ name: 'AbortError' });
      expect(await f.service.readCanonicalEntity('s', 'main', source)).toBe(hit.frame);
      now += 30_001;
      expect(f.nav.canonicalReadReport()).toMatchObject({ cacheBytes: 0, oversizedCacheEntries: 0 });
      expect(await f.service.lookupToolCall('s', 'main', 'call-100')).toEqual(hit);
      expect(f.nav.canonicalReadReport().replays).toBe(2);
      console.log('canonical-big-range-measurement', JSON.stringify({ characters: output.length, requests,
        simulatedActiveMs: now - start - 30_001, before, after }));
    } finally { clock.mockRestore(); await f.close(); }
  }, 120_000);

  it('keeps at most one oversized entity, does not retain an unrelated large turn, and invalidates on rewrite', async () => {
    const output = 'x'.repeat(3 << 20);
    const records = [...turnRecords(100, output), ...turnRecords(101, output)];
    const f = await fixture(records);
    try {
      expect((await f.service.lookupToolCall('s', 'main', 'call-100')).status).toBe('found');
      expect((await f.service.lookupToolCall('s', 'main', 'call-101')).status).toBe('found');
      expect(f.nav.canonicalReadReport()).toMatchObject({ cacheEntries: 1, oversizedCacheEntries: 1 });
      const replacement = `z${output.slice(1)}`;
      await writeFile(f.wirePath, [...turnRecords(100, output), ...turnRecords(101, replacement)].map(line).join(''));
      const changed = await f.service.lookupToolCall('s', 'main', 'call-101');
      expect(changed).toMatchObject({ status: 'found', frame: { output: replacement } });
      expect(f.nav.canonicalReadReport()).toMatchObject({ cacheEntries: 1, oversizedCacheEntries: 1, replays: 3 });
      f.nav.invalidateCanonical();
      expect(f.nav.canonicalReadReport()).toMatchObject({ cacheBytes: 0, oversizedCacheEntries: 0 });
    } finally { await f.close(); }
  });

  it('does not confuse preparing, fixed-watermark absence, missing sources, corrupt sources or partial tails', async () => {
    const records = [...Array.from({ length: 90 }, (_, id) => turnRecords(id, 'x'.repeat(110000))).flat(), ...turnRecords(100, 'error output')];
    const f = await fixture(records);
    try {
      await expect(f.service.readCanonicalEntity('s', 'main', { kind: 'turn', id: 't100' })).rejects.toBeInstanceOf(CanonicalEntityPreparingError);
      expect(await f.service.lookupToolCall('s', 'main', 'absent')).toEqual({ status: 'not_found' });
      await expect(f.service.lookupToolCall('missing', 'main', 'absent')).rejects.toThrow('source_missing');
      await expect(f.service.lookupToolCall('s', 'missing-agent', 'absent')).rejects.toThrow('source_missing');
      await appendFile(f.wirePath, '{invalid}\n');
      await expect(f.service.lookupToolCall('s', 'main', 'absent')).rejects.toThrow('corrupted line');
      await writeFile(f.wirePath, turnRecords(100, 'error output').map(line).join('') + '{"type":');
      await expect(f.service.lookupToolCall('s', 'main', 'absent')).rejects.toThrow('source_incomplete:partial_tail');
      await writeFile(f.wirePath, turnRecords(100, 'error output').map(line).join(''));
      expect(await f.service.lookupToolCall('s', 'main', 'call-100')).toMatchObject({ status: 'found', frame: { state: 'error', error: 'error output' } });
    } finally { await f.close(); }
  });

  it('reads segmented refs from a cold page while canonical navigation prepares in the background', async () => {
    const records = [...Array.from({ length: 32 }, (_, id) => turnRecords(id, 'x'.repeat(350000))).flat(),
      ...turnRecords(100, 'target '.repeat(100000))];
    expect(Buffer.byteLength(records.map(line).join(''))).toBeGreaterThan(8 << 20);
    const f = await fixture(records);
    const controller = new AbortController();
    const coldRead = vi.spyOn(f.service, 'readColdSnapshot');
    try {
      const page = await readSessionViewTranscriptPage(f.service, 's', { agentId: 'main', pageSize: 1, signal: controller.signal });
      const turn = page?.items.find((item) => item.kind === 'turn' && item.turnId === 't100');
      if (turn?.kind !== 'turn') throw new Error('missing cold page turn');
      const ref = turn.steps.flatMap((step) => step.frames).flatMap((frame) => frame.contentRefs ?? [])
        .find((value) => value.source.kind === 'frame' && value.path[0] === 'output');
      if (ref === undefined) throw new Error('missing cold page content ref');
      const before = coldRead.mock.calls.length;
      const first = await readSessionViewTranscriptContent(f.service, 's', { agentId: 'main', ref, signal: controller.signal });
      expect(first).toBeDefined();
      expect(first?.ref).toEqual(ref);
      expect(coldRead.mock.calls.length).toBe(before + 1);
      const next = first?.next;
      expect(next).toBeDefined();
      expect(await readSessionViewTranscriptContent(f.service, 's', { agentId: 'main', ref: next!, signal: controller.signal })).toBeDefined();
      expect(coldRead.mock.calls.length).toBe(before + 1);
      await vi.waitFor(() => expect(f.nav.canonicalReadReport().projectionRecords).toBe(records.length), { timeout: 30_000 });
    } finally { coldRead.mockRestore(); controller.abort(); await f.close(); }
  }, 60_000);

  it('keeps a cold detail prefix valid during a live append without caching it as the newer source', async () => {
    const f = await fixture(turnRecords(100, 'saved response'));
    const read = f.service.readColdSnapshot.bind(f.service);
    const cold = vi.spyOn(f.service, 'readColdSnapshot').mockImplementationOnce(async (...args) => {
      const snapshot = await read(...args);
      await appendFile(f.wirePath, turnRecords(101, 'live appended response').map(line).join(''));
      return snapshot;
    });
    let scans = 0;
    const reader = new HistoryCanonicalReader(f.db, f.service, async () => {
      if (++scans % 2 === 0) throw new Error('background unavailable');
      return { complete: false, nextByteOffset: 1, ordinal: 1, bytesRead: 1, recordsRead: 1, incarnation: 'test', incompleteReason: 'byte_budget' };
    });
    try {
      const source = { kind: 'turn' as const, id: 't100' };
      expect(await reader.readEntity('s', 'main', source, new AbortController().signal)).toMatchObject({ status: 'found' });
      expect(cold).toHaveBeenCalledTimes(1);
      expect(await reader.readEntity('s', 'main', source, new AbortController().signal)).toMatchObject({ status: 'found' });
      expect(cold).toHaveBeenCalledTimes(2);
    } finally { reader.invalidate(); cold.mockRestore(); await f.close(); }
  });

  it.each(['failure', 'cancel'] as const)('settles background preparation %s without certifying its incomplete projection', async mode => {
    const f = await fixture(turnRecords(100, 'target response'));
    let scans = 0;
    const reader = new HistoryCanonicalReader(f.db, f.service, async (_session, _agent, signal) => {
      scans += 1;
      if (scans === 1) return { complete: false, nextByteOffset: 1, ordinal: 1, bytesRead: 1, recordsRead: 1, incarnation: 'test', incompleteReason: 'byte_budget' };
      if (mode === 'failure') throw new Error('source read failed');
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    try {
      expect(await reader.readEntity('s', 'main', { kind: 'turn', id: 't100' }, new AbortController().signal)).toMatchObject({ status: 'found' });
      if (mode === 'cancel') reader.invalidate();
      await vi.waitFor(() => expect(reader.report()).toMatchObject({ preparationsActive: 0, preparationsCompleted: 0, preparationsFailed: mode === 'failure' ? 1 : 0, preparationsCancelled: mode === 'cancel' ? 1 : 0 }));
      expect(reader.report().projectionRecords).toBe(1);
      expect(scans).toBe(2);
    } finally { reader.invalidate(); await f.close(); }
  });

  it.each([9, 31])('advances a supported %i MiB record and locates the following small call without replaying the large turn', async (mib) => {
    const large = 'x'.repeat(mib << 20);
    const target = turnRecords(101, 'small independent output');
    const f = await fixture([...turnRecords(100, large), ...target]);
    try {
      let result = await f.service.lookupToolCall('s', 'main', 'call-101');
      let requests = 1;
      while (result.status === 'preparing' && requests < 5) {
        result = await f.service.lookupToolCall('s', 'main', 'call-101');
        requests += 1;
      }
      expect(result).toMatchObject({ status: 'found', turnId: 't101', frame: { output: 'small independent output' } });
      expect(requests).toBe(3);
      const small = f.nav.canonicalReadReport();
      expect(small).toMatchObject({ replays: 1, replayRecords: target.length, replayBytes: Buffer.byteLength(target.map(line).join('')) });
      const big = await f.service.lookupToolCall('s', 'main', 'call-100');
      expect(big.status).toBe('found');
      if (big.status !== 'found') throw new Error('large record unavailable');
      expect(big.frame.output).toBe(large);
      const after = f.nav.canonicalReadReport();
      expect(after.replayRecords - small.replayRecords).toBe(8);
      expect(after.replayBytes - small.replayBytes).toBeGreaterThan(mib << 20);
      await f.service.lookupToolCall('s', 'main', 'call-101');
      expect(f.nav.canonicalReadReport().replays).toBe(after.replays);
      expect(after.cacheBytes - after.oversizedCacheBytes).toBeLessThan(10_000);
      expect(after.cacheBytes).toBeLessThanOrEqual(after.cacheBudgetBytes);
      expect(after.oversizedCacheEntries).toBe(1);
      console.log('canonical-large-record-measurement', JSON.stringify({ mib, requests, small, after }));
    } finally { await f.close(); }
  });

  it('reads an indivisible record beyond the old line fence and preserves later small targets', async () => {
    const output = 'x'.repeat(33 << 20) + 'EXACT-TAIL';
    const f = await fixture([...turnRecords(100, output), ...turnRecords(101, 'small')]);
    try {
      for (let attempts = 0; ; attempts += 1) {
        expect(attempts).toBeLessThan(5);
        if ((await f.service.lookupToolCall('s', 'main', 'call-101')).status === 'found') break;
      }
      expect(await f.service.lookupToolCall('s', 'main', 'call-100')).toMatchObject({ status: 'found', frame: { output } });
      expect(await f.service.lookupToolCall('s', 'main', 'call-101')).toMatchObject({ status: 'found', frame: { output: 'small' } });
    } finally { await f.close(); }
  }, 60_000);

  it('cancels between chunks of an oversized supported record and leaves its checkpoint reusable', async () => {
    const f = await fixture([...turnRecords(100, 'x'.repeat(9 << 20)), ...turnRecords(101, 'small')]);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const controller = new AbortController();
    let streamingHandles = 0;
    let retryBytes = 0;
    try {
      expect(await f.service.lookupToolCall('s', 'main', 'call-101')).toEqual({ status: 'preparing' });
      const db = await f.db.ready();
      const checkpoint = db.readManifest('ws\0s\0main');
      const gate = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        if (args[0] !== f.wirePath) return handle;
        const read = handle.read.bind(handle);
        const stat = handle.stat.bind(handle);
        let streamingHandle = 0;
        Object.assign(handle, {
          stat: async () => { streamingHandle = ++streamingHandles; return stat(); },
          read: async (buffer: Buffer, offset: number, length: number, position: number) => {
            const result = await read(buffer, offset, length, position);
            if (streamingHandle === 2) {
              retryBytes += result.bytesRead;
              if (retryBytes >= (128 << 10)) controller.abort(new DOMException('Closed while reading a large record', 'AbortError'));
            }
            return result;
          },
        });
        return handle;
      });
      await expect(f.service.lookupToolCall('s', 'main', 'call-101', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
      gate.mockRestore();
      expect(retryBytes).toBe(128 << 10);
      const next = await f.service.lookupToolCall('s', 'main', 'call-101');
      expect(next).toEqual({ status: 'preparing' });
      expect(db.readManifest('ws\0s\0main')?.generation).toBe(checkpoint?.generation);
      expect(await f.service.lookupToolCall('s', 'main', 'call-101')).toMatchObject({ status: 'found', frame: { output: 'small' } });
      expect(f.nav.canonicalReadReport()).toMatchObject({ replays: 1, replayRecords: 8 });
    } finally { vi.mocked(fs.open).mockRestore(); await f.close(); }
  });

  it('isolates identical call IDs by caller and invalidates cache after rewrite, append and visibility reset', async () => {
    const f = await fixture(turnRecords(100, 'main original', 'same-call'));
    try {
      const otherPath = join(f.dir, 'sessions', 'ws', 's', 'agents', 'child', 'wire.jsonl');
      await mkdir(resolve(otherPath, '..'), { recursive: true });
      await writeFile(otherPath, turnRecords(100, 'child original', 'same-call').map(line).join(''));
      expect(await f.service.lookupToolCall('s', 'main', 'same-call')).toMatchObject({ status: 'found', frame: { output: 'main original' } });
      expect(await f.service.lookupToolCall('s', 'child', 'same-call')).toMatchObject({ status: 'found', frame: { output: 'child original' } });
      const generation = (await f.db.ready()).readManifest('ws\0s\0main')!.generation;
      await writeFile(f.wirePath, turnRecords(100, 'main replaced', 'same-call').map(line).join(''));
      expect(await f.service.lookupToolCall('s', 'main', 'same-call')).toMatchObject({ status: 'found', frame: { output: 'main replaced' } });
      expect((await f.db.ready()).readManifest('ws\0s\0main')!.generation).not.toBe(generation);
      await appendFile(f.wirePath, line(event({ type: 'tool.result', toolCallId: 'same-call', result: { output: 'late result', isError: false } })));
      expect(await f.service.lookupToolCall('s', 'main', 'same-call')).toMatchObject({ status: 'found', frame: { state: 'done', output: 'late result', error: undefined } });
      await appendFile(f.wirePath, line({ type: 'context.undo', count: 1 }));
      expect(await f.service.lookupToolCall('s', 'main', 'same-call')).toEqual({ status: 'not_found' });
      expect(await f.service.readCanonicalEntity('s', 'main', { kind: 'turn', id: 't100' })).toBeUndefined();
      await appendFile(f.wirePath, turnRecords(100, 'reused', 'same-call').map(line).join(''));
      expect(await f.service.lookupToolCall('s', 'main', 'same-call')).toMatchObject({ status: 'found', frame: { output: 'reused' } });
      expect(await f.service.lookupToolCall('s', 'child', 'same-call')).toMatchObject({ status: 'found', frame: { output: 'child original' } });
    } finally { await f.close(); }
  });

  it('retains legacy record identities and late results without replaying intervening turns', async () => {
    const records = [
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      { type: 'context.append_message', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }], toolCalls: [{ id: 'old-call', name: 'Example', arguments: '{"x":1}' }] } },
      ...turnRecords(100, 'unrelated'),
      { type: 'context.append_message', message: { role: 'tool', toolCallId: 'old-call', content: [{ type: 'text', text: 'late old result' }] } },
      { type: 'subagent.spawned', parentToolCallId: 'old-call', subagentId: 'nested-child', runInBackground: false },
    ];
    const f = await fixture(records);
    try {
      expect(await f.service.lookupToolCall('s', 'main', 'old-call')).toMatchObject({ status: 'found', turnId: 't0', stepId: 'legacy:v1:r1:step',
        frame: { frameId: 'legacy:v1:r1:step.old-call', input: { x: 1 }, output: 'late old result',
          agentRefs: [{ agentId: 'nested-child', role: 'child' }] } });
      expect(f.nav.canonicalReadReport()).toMatchObject({ replayRecords: 4, replays: 1 });
    } finally { await f.close(); }
  });

  it('distinguishes recorded orphan calls from absence and clears that uncertainty on visibility clear', async () => {
    const f = await fixture([
      { type: 'turn.prompt', turnId: 100, input: [{ type: 'text', text: 'legacy partial' }], origin: { kind: 'user' } },
      event({ type: 'tool.result', toolCallId: 'orphan-call', result: { output: 'known source, missing input' } }),
    ]);
    try {
      await expect(f.service.lookupToolCall('s', 'main', 'orphan-call')).rejects.toThrow('locator_incomplete');
      expect(await f.service.lookupToolCall('s', 'main', 'absent')).toEqual({ status: 'not_found' });
      await appendFile(f.wirePath, line({ type: 'context.clear' }));
      expect(await f.service.lookupToolCall('s', 'main', 'orphan-call')).toEqual({ status: 'not_found' });
    } finally { await f.close(); }
  });

  it('cancels a shared preparation reader without cancelling another reader', async () => {
    const f = await fixture(turnRecords(100, 'original'));
    try {
      const db = await f.db.ready();
      const original = db.addCanonicalSource.bind(db);
      const controller = new AbortController();
      const gate = vi.spyOn(db, 'addCanonicalSource').mockImplementation((...args) => {
        original(...args);
        controller.abort(new DOMException('One reader left', 'AbortError'));
      });
      const first = f.service.lookupToolCall('s', 'main', 'call-100', controller.signal);
      const second = f.service.lookupToolCall('s', 'main', 'call-100');
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      expect(await second).toMatchObject({ status: 'found', frame: { output: 'original' } });
      gate.mockRestore();
      expect(f.nav.canonicalReadReport().replays).toBe(1);
    } finally { await f.close(); }
  });

  it('aborts replay and old-scope admission then successfully reopens the changed source', async () => {
    const f = await fixture(turnRecords(100, 'before'));
    try {
      await f.nav.scan('s', 'main');
      const db = await f.db.ready();
      const controller = new AbortController();
      const original = db.canonicalSources.bind(db);
      const gate = vi.spyOn(db, 'canonicalSources').mockImplementation((...args) => {
        const page = original(...args);
        controller.abort(new DOMException('Closed detail', 'AbortError'));
        return page;
      });
      await expect(f.service.lookupToolCall('s', 'main', 'call-100', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
      gate.mockRestore();
      expect(f.nav.canonicalReadReport().cacheBytes).toBe(0);
      await writeFile(f.wirePath, turnRecords(100, 'after').map(line).join(''));
      expect(await f.service.lookupToolCall('s', 'main', 'call-100')).toMatchObject({ status: 'found', frame: { output: 'after' } });
      const invalidateGate = vi.spyOn(db, 'canonicalSources').mockImplementation((...args) => {
        const page = original(...args); f.nav.invalidateCanonical(); return page;
      });
      f.nav.invalidateCanonical();
      await expect(f.service.lookupToolCall('s', 'main', 'call-100')).rejects.toMatchObject({ name: 'AbortError' });
      invalidateGate.mockRestore();
      expect(f.nav.canonicalReadReport().cacheBytes).toBe(0);
    } finally { await f.close(); }
  });

  it('verifies exact target digests, reports unreadable files as errors, and bounds cache retention', async () => {
    const f = await fixture(Array.from({ length: 40 }, (_, id) => turnRecords(id, 'x'.repeat(90000))).flat());
    try {
      for (let id = 0; id < 40; id += 1) expect((await f.service.lookupToolCall('s', 'main', `call-${id}`)).status).toBe('found');
      const report = f.nav.canonicalReadReport();
      expect(report.cacheBytes).toBeLessThanOrEqual(4 << 20);
      expect(report.cacheEntries).toBeLessThanOrEqual(32);
      expect(report.cacheEntries).toBeLessThan(40);
      f.nav.invalidateCanonical();
      const file = await readFile(f.wirePath, 'utf8');
      const sources = (await f.db.ready()).canonicalSources('ws\0s\0main', 't20', -1, 128);
      const output = sources.find((span) => file.slice(span.start, span.end).includes('tool.result'))!;
      const db = await f.db.ready();
      db.db.prepare("UPDATE state SET value=json_set(value,'$.digest',?) WHERE scope=? AND bucket='canonicalRecords' AND key=?")
        .run('0'.repeat(64), 'ws\0s\0main', String(output.ordinal));
      await expect(f.service.lookupToolCall('s', 'main', 'call-20')).rejects.toThrow('history_source_changed');
      const spy = vi.spyOn(fs, 'open').mockRejectedValueOnce(Object.assign(new Error('unreadable synthetic file'), { code: 'EACCES' }));
      await expect(f.service.lookupToolCall('s', 'main', 'absent')).rejects.toThrow('unreadable synthetic file');
      spy.mockRestore();
    } finally { await f.close(); }
  });
});


it('opens a cold HTTP view and reads first, middle and last canonical history exactly past old header budgets', async () => {
  const records = sessionHistoryBudgetRecords();
  const f = await fixture(records);
  const app = Fastify();
  const core = { accessor: { get: () => ({ get: () => undefined }) } } as unknown as Scope;
  const broadcaster = { getCursor: async () => ({ seq: 0, epoch: 'cold:s' }), unsubscribe: () => undefined } as unknown as SessionEventBroadcaster;
  const frames: unknown[] = [];
  const errors: unknown[] = [];
  const connection = new SessionViewHttpConnection(broadcaster, (frame) => frames.push(frame), (_id, error) => errors.push(error), { core, service: f.service });
  registerSessionViewHttp(app, core, { sessionViewTranscriptService: f.service });
  try {
    const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    connection.receive({ type: 'view_attach', id: 'view', sessionId: 's', data: { generation: 1, transcript_coverage_version: TRANSCRIPT_COVERAGE_VERSION, input: { sessionCursor: { seq: 0 }, transcriptGrades: { main: 'delta' } } } });
    await vi.waitFor(() => expect(frames.some((frame) => (frame as { data?: { type?: string } }).data?.type === 'ready')).toBe(true));
    expect(errors).toEqual([]);
    const draft = new AgentTranscriptDraft('main');
    const reducer = new TranscriptFactReducer(draft);
    const adapter = new TranscriptWireAdapter('main', { turn: (id) => draft.getTurn(id), tool: (id) => draft.getToolCall(id) });
    for (const record of records) reducer.apply(adapter.add(record as { type: string }));
    reducer.apply(adapter.finish());
    const expected = draft.snapshot();
    const all: TranscriptResponse['items'][number][] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const reply = await fetch(`${endpoint}/api/klient/session-view/s/transcript?agent_id=main&transcript_coverage_version=${TRANSCRIPT_COVERAGE_VERSION}&page_size=7${cursor === undefined ? '' : `&before_item=${encodeURIComponent(cursor)}`}`);
      expect(reply.status).toBe(200);
      const envelope = await reply.json() as { code: number; data: TranscriptResponse };
      expect(envelope.code).toBe(0);
      expect(envelope.data.items.length).toBeGreaterThan(0);
      all.unshift(...envelope.data.items);
      expect(++pages).toBeLessThan(100);
      if (envelope.data.next_cursor === undefined) break;
      expect(envelope.data.next_cursor).not.toBe(cursor);
      cursor = envelope.data.next_cursor;
    }
    expect(all.map((item) => item.kind === 'turn' ? item.turnId : item.kind)).toEqual(expected!.items.map((item) => item.kind === 'turn' ? item.turnId : item.kind));
    for (const ordinal of [0, 22, 44]) {
      const preview = all.find((item) => item.kind === 'turn' && item.ordinal === ordinal);
      if (preview?.kind !== 'turn') throw new Error('Missing turn');
      let turn = preview;
      const hydrate = async <T extends import('@kiki/transcript').ContentWindow>(value: T): Promise<T> => {
        let current = value;
        let count = 0;
        while (current.contentRefs?.length) {
          const ref = current.contentRefs[0]!;
          const reply = await fetch(`${endpoint}/api/klient/session-view/s/transcript/content`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'main', ref }) });
          expect(reply.status).toBe(200);
          const envelope = await reply.json() as { code: number; data: ContentSegment };
          if (envelope.code === 40923) { expect(++count).toBeLessThan(1000); continue; }
          expect(envelope.code).toBe(0);
          expect(envelope.data.next === undefined || envelope.data.next.offset > ref.offset).toBe(true);
          current = applyContentSegment(current, envelope.data);
          expect(++count).toBeLessThan(1000);
        }
        return current;
      };
      turn = await hydrate(turn);
      for (const step of turn.steps) for (let index = 0; index < step.frames.length; index += 1) step.frames[index] = await hydrate(step.frames[index]!);
      const canonical = expected!.items.find((item) => item.kind === 'turn' && item.ordinal === ordinal);
      expect(JSON.parse(JSON.stringify(turn, (key, value) => key === 'contentRefs' ? undefined : value))).toEqual(JSON.parse(JSON.stringify(canonical)));
    }
    console.log('session-open-budget-http', JSON.stringify({ turns: all.length, pages, wireBytes: Buffer.byteLength(records.map(line).join('')), canonical: f.nav.canonicalReadReport() }));
  } finally { connection.dispose(); await app.close(); await f.close(); }
}, 60_000);

it('rejects real corrupted cold history and recovers after the source is repaired', async () => {
  const records = turnRecords(100, 'recoverable');
  const f = await fixture(records);
  try {
    await appendFile(f.wirePath, 'not-json\n');
    await expect(f.service.readColdSnapshot('s', 'main')).rejects.toThrow('corrupted line');
    await writeFile(f.wirePath, records.map(line).join(''));
    expect(await f.service.readColdSnapshot('s', 'main')).toMatchObject({ items: [{ turnId: 't100', steps: [{ frames: [{ kind: 'thinking' }, { kind: 'tool', output: 'recoverable' }] }] }] });
  } finally { await f.close(); }
});


it('continues canonical target replay past the old 64 MiB total budget and retains the exact final fact', async () => {
  const records = turnRecords(100, 'initial');
  const large = 'x'.repeat(22 << 20);
  records.splice(6, 0, ...[0, 1, 2].map((index) => event({ type: 'tool.result', toolCallId: 'call-100', result: { output: `${index}:${large}`, isError: false } })), event({ type: 'tool.result', toolCallId: 'call-100', result: { output: 'EXACT FINAL 汉😀', isError: false } }));
  const f = await fixture(records);
  try {
    let lookup = await f.service.lookupToolCall('s', 'main', 'call-100');
    for (let attempts = 0; lookup.status === 'preparing'; attempts += 1) {
      expect(attempts).toBeLessThan(20);
      lookup = await f.service.lookupToolCall('s', 'main', 'call-100');
    }
    expect(lookup).toMatchObject({ status: 'found', frame: { output: 'EXACT FINAL 汉😀', state: 'done' } });
    expect(f.nav.canonicalReadReport().replayBytes).toBeGreaterThan(64 << 20);
    expect(f.nav.canonicalReadReport()).toMatchObject({ replays: 1, replayRecords: records.length });
  } finally { await f.close(); }
}, 60_000);


it('continues HTTP content through a legal own key larger than the default request body budget', async () => {
  const original = { output: { ['k'.repeat(1100 * 1024)]: 'exact '.repeat(1000) } };
  const service = { readCanonicalEntity: async () => original } as unknown as TranscriptService;
  const app = Fastify();
  registerSessionViewHttp(app, {} as Scope, { sessionViewTranscriptService: service });
  let current = boundedEntity(original, { kind: 'frame', id: 'f', turnId: 't', stepId: 's' });
  try {
    let requests = 0;
    while (current.contentRefs?.length) {
      const reply = await app.inject({ method: 'POST', url: '/api/klient/session-view/s/transcript/content', payload: { agentId: 'main', ref: current.contentRefs[0]! } });
      expect(reply.statusCode).toBe(200);
      const envelope = reply.json<{ code: number; data: ContentSegment }>();
      expect(envelope.code).toBe(0);
      current = applyContentSegment(current, envelope.data);
      expect(++requests).toBeLessThan(10);
    }
    expect(current.output).toEqual(original.output);
  } finally { await app.close(); }
});


it('applies configurable detail retention at the next read without turning zero into an access limit', async () => {
  const output = 'x'.repeat(3 << 20) + 'EXACT-END';
  let budget = 0;
  const f = await fixture(turnRecords(100, output), () => budget);
  try {
    const first = await f.service.lookupToolCall('s', 'main', 'call-100');
    expect(first).toMatchObject({ status: 'found', frame: { output } });
    expect(f.nav.canonicalReadReport()).toMatchObject({ oversizedCacheEntries: 0, cacheBudgetBytes: 4 << 20, replays: 1 });
    budget = 16 << 20;
    expect(await f.service.lookupToolCall('s', 'main', 'call-100')).toEqual(first);
    expect(f.nav.canonicalReadReport()).toMatchObject({ oversizedCacheEntries: 1, replays: 2 });
    expect(f.nav.canonicalReadReport().oversizedCacheBytes).toBeLessThanOrEqual(budget);
    await f.service.lookupToolCall('s', 'main', 'call-100');
    expect(f.nav.canonicalReadReport().replays).toBe(2);
    budget = 0;
    expect(await f.service.lookupToolCall('s', 'main', 'call-100')).toEqual(first);
    expect(f.nav.canonicalReadReport()).toMatchObject({ oversizedCacheEntries: 0, replays: 3 });
    expect(await f.service.readCanonicalEntity('s', 'main', { kind: 'turn', id: 't100' })).toMatchObject({ steps: [{ frames: [{ kind: 'thinking' }, { kind: 'tool', output }] }] });
    expect(f.nav.canonicalReadReport().oversizedCacheEntries).toBe(0);
  } finally { await f.close(); }
});
