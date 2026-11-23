import { appendFile, mkdir, mkdtemp, open, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { ISessionIndex, ISessionManager, type Scope } from '@kiki/agent-core-v2';
import { streamWireRecords } from '@kiki/transcript-live';
import { describe, expect, it } from 'vitest';

import {
  captureWirePrefixWitness,
  verifyWirePrefixWitness,
  verifyWitnessAppendSafe,
} from '../../src/services/transcript/prefixWitness';
import { TranscriptService } from '../../src/services/transcript/transcriptService';
import { readSessionViewTranscriptPage } from '../../src/transport/klient/sessionViewReads';

function coldCore(sessionId = 's1'): Scope {
  return {
    accessor: {
      get: (token: unknown) => {
        if (token === ISessionIndex) {
          return {
            get: async (id: string) => id === sessionId ? { id, workspaceId: 'ws', updatedAt: 1 } : undefined,
          };
        }
        if (token === ISessionManager) return { get: () => undefined };
        return undefined;
      },
    },
  } as unknown as Scope;
}

function promptLine(turnId: number, text: string): string {
  return `${JSON.stringify({
    type: 'turn.prompt',
    turnId,
    promptId: `p${turnId}`,
    input: [{ type: 'text', text }],
    origin: { kind: 'user' },
    time: 1000 + turnId,
  })}\n`;
}

function endedLine(turnId: number): string {
  return `${JSON.stringify({
    type: 'turn.ended',
    turnId,
    reason: 'completed',
    time: 2000 + turnId,
  })}\n`;
}

function paddingLine(bytes: number): string {
  return `${JSON.stringify({ type: 'fixture.padding', padding: 'x'.repeat(bytes) })}\n`;
}

describe('TranscriptService append-tolerant prefix witness and cooperative yielding', () => {
  it('resumes anchor continuation across live appends mid-scan and between slices while invalidating on prefix rewrite', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-append-resume-'));
    const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
    await mkdir(dirname(wirePath), { recursive: true });
    const initialBody =
      promptLine(0, 'original opening zero') +
      endedLine(0) +
      paddingLine(256 << 10).repeat(52) +
      promptLine(1, 'target opening one') +
      endedLine(1) +
      paddingLine(256 << 10).repeat(8) +
      promptLine(2, 'tail turn two') +
      endedLine(2);
    await writeFile(wirePath, initialBody, 'utf8');

    const starts: number[] = [];
    let appendedMidSlice = false;
    const service = new TranscriptService({
      homeDir: home,
      core: coldCore('s1'),
      wireRecordReader: async (path, options) => {
        starts.push(options.startByteOffset ?? 0);
        const result = await streamWireRecords(path, options);
        if (!appendedMidSlice) {
          appendedMidSlice = true;
          await appendFile(wirePath, promptLine(3, 'mid-scan live append') + endedLine(3), 'utf8');
        }
        return result;
      },
    });

    try {
      const first = await service.readAnchoredColdSnapshot('s1', 'main', 't1');
      expect(first).toBeDefined();
      expect(service.anchorReadState(first!)).toBe('pending');
      expect(starts).toEqual([0]);

      await appendFile(wirePath, promptLine(4, 'between-slice live append') + endedLine(4), 'utf8');

      let resolved = first;
      for (let attempt = 0; resolved !== undefined && service.anchorReadState(resolved) === 'pending' && attempt < 6; attempt += 1) {
        await appendFile(wirePath, promptLine(10 + attempt, `live append ${attempt}`) + endedLine(10 + attempt), 'utf8');
        resolved = await service.readAnchoredColdSnapshot('s1', 'main', 't1');
      }

      expect(resolved).toBeDefined();
      expect(service.anchorReadState(resolved!)).not.toBe('pending');
      expect(resolved!.items.some((item) => item.kind === 'turn' && item.turnId === 't1')).toBe(true);
      expect(starts.length).toBeGreaterThanOrEqual(2);
      expect(starts[1]).toBeGreaterThan(0);
      expect(starts.slice(1).every((offset) => offset > 0)).toBe(true);

      const readsBeforeCacheHit = starts.length;
      await appendFile(wirePath, promptLine(20, 'post-resolve live append') + endedLine(20), 'utf8');
      const cachedHit = await service.readAnchoredColdSnapshot('s1', 'main', 't1');
      expect(cachedHit?.items.some((item) => item.kind === 'turn' && item.turnId === 't1')).toBe(true);
      expect(starts.length).toBe(readsBeforeCacheHit);

      const rewrittenBody =
        promptLine(0, 'rewritten opening zero with altered prefix bytes') +
        endedLine(0) +
        paddingLine(256 << 10).repeat(52) +
        promptLine(1, 'rewritten target opening one') +
        endedLine(1) +
        paddingLine(256 << 10).repeat(8) +
        promptLine(2, 'tail turn two') +
        endedLine(2);
      await writeFile(wirePath, rewrittenBody, 'utf8');

      const readsBeforeRewrite = starts.length;
      let afterRewrite = await service.readAnchoredColdSnapshot('s1', 'main', 't1');
      for (let attempt = 0; afterRewrite !== undefined && service.anchorReadState(afterRewrite) === 'pending' && attempt < 6; attempt += 1) {
        afterRewrite = await service.readAnchoredColdSnapshot('s1', 'main', 't1');
      }
      expect(starts[readsBeforeRewrite]).toBe(0);
      expect(afterRewrite?.items.find((item) => item.kind === 'turn' && item.turnId === 't1')).toMatchObject({
        prompt: 'rewritten target opening one',
      });
    } finally {
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 60_000);

  it('preserves cold window backward extension and span lookups across live tail appends', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-append-window-'));
    const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
    await mkdir(dirname(wirePath), { recursive: true });
    const lines: string[] = [];
    for (let turnId = 0; turnId < 30; turnId += 1) {
      lines.push(promptLine(turnId, `turn-${turnId} ${'q'.repeat(350_000)}`));
      lines.push(endedLine(turnId));
    }
    await writeFile(wirePath, lines.join(''), 'utf8');

    const service = new TranscriptService({ homeDir: home, core: coldCore('s1') });
    try {
      const initial = await service.readColdPageSnapshot('s1', 'main', (value) => value, undefined, false, undefined, false, true, true);
      expect(initial).toBeDefined();
      const firstBoundary = await service.coldWindowBoundary('s1', 'main');
      expect(firstBoundary).toBeDefined();
      expect(firstBoundary!.start).toBeGreaterThan(0);

      await appendFile(wirePath, promptLine(30, 'live turn 30') + endedLine(30), 'utf8');

      const extended = await service.readColdPageSnapshot('s1', 'main', (value) => value, undefined, true, 1 << 20, true, true, true);
      expect(extended).toBeDefined();
      const secondBoundary = await service.coldWindowBoundary('s1', 'main');
      expect(secondBoundary).toBeDefined();
      expect(secondBoundary!.start).toBeLessThan(firstBoundary!.start);
      expect(secondBoundary!.end).toBe(firstBoundary!.end);

      await appendFile(wirePath, promptLine(31, 'live turn 31') + endedLine(31), 'utf8');

      const extendedAgain = await service.readColdPageSnapshot('s1', 'main', (value) => value, undefined, true, 1 << 20, true, true, true);
      expect(extendedAgain).toBeDefined();
      const thirdBoundary = await service.coldWindowBoundary('s1', 'main');
      expect(thirdBoundary).toBeDefined();
      expect(thirdBoundary!.start).toBeLessThan(secondBoundary!.start);
    } finally {
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 60_000);

  it('locates a recent turn behind a large prefix via backward tail proximity under continuous live appends', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-tail-proximity-'));
    const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
    await mkdir(dirname(wirePath), { recursive: true });
    const chunks: string[] = [
      promptLine(0, 'ancient opening'),
      endedLine(0),
      paddingLine(256 << 10).repeat(56),
    ];
    for (let turnId = 800; turnId <= 824; turnId += 1) {
      chunks.push(promptLine(turnId, `recent turn ${turnId} ${'r'.repeat(120_000)}`));
      chunks.push(endedLine(turnId));
    }
    await writeFile(wirePath, chunks.join(''), 'utf8');

    const service = new TranscriptService({ homeDir: home, core: coldCore('s1') });
    let nextLiveTurn = 825;
    let completedAppends = 0;
    let appendInFlight = Promise.resolve();
    const tickGaps: number[] = [];
    let lastTick = performance.now();
    const tickTimer = setInterval(() => {
      const now = performance.now();
      tickGaps.push(now - lastTick);
      lastTick = now;
    }, 10);
    const appendTimer = setInterval(() => {
      const turnId = nextLiveTurn++;
      appendInFlight = appendInFlight.then(async () => {
        await appendFile(wirePath, promptLine(turnId, `live append ${turnId}`) + endedLine(turnId), 'utf8');
        completedAppends += 1;
      });
    }, 15);
    try {
      await service.readColdPageSnapshot('s1', 'main', (value) => value, undefined, false, undefined, true, true, true);
      await appendInFlight;
      const beforeBytes = service.memoryReport().coldReads.bytes;
      const startedAt = performance.now();
      const page = await readSessionViewTranscriptPage(service, 's1', {
        agentId: 'main',
        beforeTurn: 't805',
        pageSize: 1,
      });
      const elapsedMs = performance.now() - startedAt;
      const bytesDelta = service.memoryReport().coldReads.bytes - beforeBytes;

      expect(completedAppends).toBeGreaterThan(0);
      expect(page?.read?.readiness).not.toBe('preparing');
      expect(page?.items.find((item) => item.kind === 'turn')).toMatchObject({ turnId: 't804' });
      expect(bytesDelta).toBeLessThan(8 << 20);
      expect(elapsedMs).toBeLessThan(1_000);
      expect(tickGaps.length).toBeGreaterThan(0);
      expect(Math.max(...tickGaps)).toBeLessThan(200);
    } finally {
      clearInterval(appendTimer);
      clearInterval(tickTimer);
      await appendInFlight;
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 60_000);

  it('yields cooperatively on the 4 ms budget so concurrent timers stay responsive during multi-megabyte scans', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-yield-loop-'));
    const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
    await mkdir(dirname(wirePath), { recursive: true });
    const records: string[] = [promptLine(0, 'start')];
    for (let index = 0; index < 4_500; index += 1) {
      records.push(`${JSON.stringify({
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          turnId: '0',
          stepUuid: 'step-0',
          uuid: `frame-${index}`,
          part: { type: 'text', text: `chunk-${index}-${'a'.repeat(1_800)}` },
        },
      })}\n`);
    }
    records.push(endedLine(0));
    records.push(promptLine(1, 'anchor turn'));
    records.push(endedLine(1));
    await writeFile(wirePath, records.join(''), 'utf8');

    const service = new TranscriptService({ homeDir: home, core: coldCore('s1') });
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    const tickGaps: number[] = [];
    let lastTick = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      tickGaps.push(now - lastTick);
      lastTick = now;
    }, 5);
    histogram.enable();
    try {
      let snapshot = await service.readAnchoredColdSnapshot('s1', 'main', 't1');
      for (let attempt = 0; snapshot !== undefined && service.anchorReadState(snapshot) === 'pending' && attempt < 6; attempt += 1) {
        snapshot = await service.readAnchoredColdSnapshot('s1', 'main', 't1');
      }
      expect(snapshot?.items.some((item) => item.kind === 'turn' && item.turnId === 't1')).toBe(true);
      expect(tickGaps.length).toBeGreaterThan(0);
      const maxGapMs = Math.max(...tickGaps);
      const p99Ms = histogram.percentile(99) / 1e6;
      expect(p99Ms).toBeLessThan(100);
      expect(maxGapMs).toBeLessThan(200);
    } finally {
      clearInterval(timer);
      histogram.disable();
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 60_000);

  it('rejects same-size in-place rewrites with changed mtime and truncations in prefix witness verification', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-witness-strict-'));
    const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
    await mkdir(dirname(wirePath), { recursive: true });
    const initial = `${'a'.repeat(32_767)}\n`;
    await writeFile(wirePath, initial, 'utf8');

    try {
      const before = await stat(wirePath);
      const witness = await captureWirePrefixWitness(wirePath, before);
      expect(witness).toBeDefined();
      expect(witness!.observedSize).toBe(32_768);
      expect(await verifyWirePrefixWitness(wirePath, witness!, before)).toBe(true);

      const handle = await open(wirePath, 'r+');
      try {
        await handle.write(Buffer.from('ZZZZ'), 0, 4, 8_192);
      } finally {
        await handle.close();
      }
      const bumpedTime = new Date(Date.now() + 5_000);
      await utimes(wirePath, bumpedTime, bumpedTime);
      const afterRewrite = await stat(wirePath);
      expect(afterRewrite.size).toBe(before.size);
      expect(await verifyWirePrefixWitness(wirePath, witness!, afterRewrite)).toBe(false);

      await truncate(wirePath, 24_576);
      const afterTruncate = await stat(wirePath);
      expect(afterTruncate.size).toBe(24_576);
      expect(await verifyWirePrefixWitness(wirePath, witness!, afterTruncate)).toBe(false);

      const ratchetPath = join(home, 'sessions', 'ws', 's1', 'agents', 'ratchet', 'wire.jsonl');
      await mkdir(dirname(ratchetPath), { recursive: true });
      await writeFile(ratchetPath, `${'b'.repeat(26_999)}\n`, 'utf8');
      const ratchetBefore = await stat(ratchetPath);
      const ratchetWitness = await captureWirePrefixWitness(ratchetPath, ratchetBefore);
      expect(ratchetWitness).toBeDefined();

      const appendedLine = '{"type":"fixture.note","padding":"123456789012"}\n';
      expect(Buffer.byteLength(appendedLine)).toBe(49);
      await appendFile(ratchetPath, appendedLine, 'utf8');
      const afterAppend = await stat(ratchetPath);
      const step1 = await verifyWitnessAppendSafe(ratchetPath, ratchetWitness!, afterAppend, ratchetWitness!.completeTailOffset, 1 << 20);
      expect(step1.valid).toBe(true);
      expect(step1.witness?.observedSize).toBe(afterAppend.size);
      expect(step1.visibilityCheckedTo).toBe(afterAppend.size);

      const clearReplacement = '{"type":"context.clear","padding":"12345678901"}\n';
      expect(Buffer.byteLength(clearReplacement)).toBe(49);
      const ratchetHandle = await open(ratchetPath, 'r+');
      try {
        await ratchetHandle.write(Buffer.from(clearReplacement), 0, 49, ratchetBefore.size);
      } finally {
        await ratchetHandle.close();
      }
      const ratchetBumped = new Date(Date.now() + 10_000);
      await utimes(ratchetPath, ratchetBumped, ratchetBumped);
      const afterPostAppendRewrite = await stat(ratchetPath);
      expect(afterPostAppendRewrite.size).toBe(afterAppend.size);
      const step2 = await verifyWitnessAppendSafe(ratchetPath, step1.witness!, afterPostAppendRewrite, step1.visibilityCheckedTo, 1 << 20);
      expect(step2.valid).toBe(false);

      await truncate(ratchetPath, afterAppend.size - 1);
      const afterPostAppendTruncate = await stat(ratchetPath);
      const step3 = await verifyWitnessAppendSafe(ratchetPath, step1.witness!, afterPostAppendTruncate, step1.visibilityCheckedTo, 1 << 20);
      expect(step3.valid).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('invalidates warm cold windows, anchor windows, and direct spans when context.clear appends including across a split EOF', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-clear-invalidate-'));
    const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
    await mkdir(dirname(wirePath), { recursive: true });
    const body =
      promptLine(0, 'pre-clear turn zero') +
      endedLine(0) +
      paddingLine(256 << 10).repeat(36) +
      promptLine(1, 'pre-clear turn one') +
      endedLine(1) +
      promptLine(2, 'pre-clear turn two') +
      endedLine(2);
    await writeFile(wirePath, body, 'utf8');

    const service = new TranscriptService({ homeDir: home, core: coldCore('s1') });
    try {
      const initial = await service.readColdPageSnapshot('s1', 'main', (value) => value, undefined, false, undefined, false, true, true);
      expect(initial?.items.some((item) => item.kind === 'turn' && item.turnId === 't1')).toBe(true);
      let anchorBefore = await service.readAnchoredColdSnapshot('s1', 'main', 't2');
      for (let attempt = 0; anchorBefore !== undefined && service.anchorReadState(anchorBefore) === 'pending' && attempt < 4; attempt += 1) {
        anchorBefore = await service.readAnchoredColdSnapshot('s1', 'main', 't2');
      }
      expect(anchorBefore?.items.some((item) => item.kind === 'turn' && item.turnId === 't1')).toBe(true);

      await appendFile(wirePath, `${JSON.stringify({ type: 'context.clear', time: 9_000 })}\n` + promptLine(3, 'post-clear turn three') + endedLine(3), 'utf8');

      const afterClear = await service.readColdPageSnapshot('s1', 'main', (value) => value, undefined, false, undefined, true, true, true);
      expect(afterClear?.items.some((item) => item.kind === 'turn' && item.turnId === 't1')).toBe(false);
      expect(afterClear?.items.some((item) => item.kind === 'turn' && item.turnId === 't3')).toBe(true);
      const staleDirect = await service.readColdWindowTurn('s1', 'main', 't1');
      expect(staleDirect).toBeUndefined();

      let anchorAfterClear = await service.readAnchoredColdSnapshot('s1', 'main', 't2');
      for (let attempt = 0; anchorAfterClear !== undefined && service.anchorReadState(anchorAfterClear) === 'pending' && attempt < 4; attempt += 1) {
        anchorAfterClear = await service.readAnchoredColdSnapshot('s1', 'main', 't2');
      }
      expect(anchorAfterClear).toBeUndefined();
      expect(await service.readColdWindowTurn('s1', 'main', 't1')).toBeUndefined();

      const splitPath = join(home, 'sessions', 'ws', 's1', 'agents', 'split', 'wire.jsonl');
      await mkdir(dirname(splitPath), { recursive: true });
      await writeFile(splitPath, `${promptLine(0, 'before split')}${endedLine(0)}{"type":"context.cl`, 'utf8');
      const splitBefore = await stat(splitPath);
      const splitWitness = await captureWirePrefixWitness(splitPath, splitBefore);
      expect(splitWitness).toBeDefined();
      expect(splitWitness!.completeTailOffset).toBeLessThan(splitBefore.size);

      await appendFile(splitPath, 'ear","time":9001}\n', 'utf8');
      const splitAfter = await stat(splitPath);
      const checked = await verifyWitnessAppendSafe(splitPath, splitWitness!, splitAfter, splitWitness!.completeTailOffset, 1 << 20);
      expect(checked.valid).toBe(false);
    } finally {
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 60_000);

  it('reserves forward budget and avoids starvation when backward tail proximity misses past dense records', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-proximity-miss-'));
    const wirePath = join(home, 'sessions', 'ws', 's1', 'agents', 'main', 'wire.jsonl');
    await mkdir(dirname(wirePath), { recursive: true });
    const parts: string[] = [
      promptLine(0, 'turn zero'),
      endedLine(0),
      paddingLine(256 << 10).repeat(32),
      promptLine(100, 'target turn 100'),
    ];
    for (let i = 0; i < 20_000; i += 1) {
      parts.push(`{"type":"context.append_loop_event","event":{"type":"step.end","turnId":100,"step":${i}}}\n`);
    }
    parts.push(endedLine(100));
    for (let turnId = 101; turnId <= 122; turnId += 1) {
      parts.push(promptLine(turnId, `tail turn ${turnId} ${'t'.repeat(45_000)}`));
      parts.push(endedLine(turnId));
    }
    await writeFile(wirePath, parts.join(''), 'utf8');

    const service = new TranscriptService({ homeDir: home, core: coldCore('s1') });
    try {
      await service.readColdPageSnapshot('s1', 'main', (value) => value, undefined, false, undefined, true, true, true);
      let snapshot = await service.readAnchoredColdSnapshot('s1', 'main', 't100');
      let slices = 1;
      while (snapshot !== undefined && service.anchorReadState(snapshot) === 'pending' && slices < 8) {
        snapshot = await service.readAnchoredColdSnapshot('s1', 'main', 't100');
        slices += 1;
      }
      expect(snapshot).toBeDefined();
      expect(service.anchorReadState(snapshot!)).not.toBe('pending');
      expect(snapshot!.items.some((item) => item.kind === 'turn' && item.turnId === 't100')).toBe(true);
      expect(slices).toBeLessThanOrEqual(4);
    } finally {
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 60_000);
});
