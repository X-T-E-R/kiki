import { describe, expect, it } from 'vitest';
import {
  PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET,
  readPersistedAgentProfileSnapshot,
} from '#/session/agentProfileSnapshot';

describe('readPersistedAgentProfileSnapshot', () => {
  it('returns metadata for an oversized wire and does not start a scan', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    let streamReads = 0;
    const host = {
      storage: {
        size: async () => PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET + 1,
        mtime: async () => 3,
        readStream: async function* () {
          streamReads += 1;
          await gate;
          yield Buffer.from('{"type":"config.update","modelAlias":"from-wire","time":2}\n');
        },
      },
      appendLog: {
        flush: async () => undefined,
        read: async function* () {
          reads += 1;
          await gate;
          yield { type: 'config.update', modelAlias: 'from-wire', time: 2 };
        },
      },
    };
    const budget = { inlineByteBudget: PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET };
    const first = await readPersistedAgentProfileSnapshot(
      host as never, 'workspace', 'session', 'main', { model: 'meta-model' }, undefined, budget,
    );
    expect(first).toMatchObject({
      source: 'metadata', modelAlias: 'meta-model', wireCoverage: 'unscanned', activeToolsKnown: false,
    });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(reads).toBe(0);
    expect(streamReads).toBe(0);
    const scanning = readPersistedAgentProfileSnapshot(
      host as never, 'workspace', 'session', 'main', { model: 'meta-model' },
    );
    for (let attempt = 0; attempt < 20 && streamReads === 0; attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    }
    expect(streamReads).toBe(1);
    expect(reads).toBe(0);
    const during = await readPersistedAgentProfileSnapshot(
      host as never, 'workspace', 'session', 'main', { model: 'meta-model' }, undefined, budget,
    );
    expect(during).toMatchObject({ source: 'metadata', wireCoverage: 'unscanned', activeToolsKnown: false });
    expect(streamReads).toBe(1);
    release();
    const scanned = await scanning;
    expect(scanned).toMatchObject({ source: 'wire', modelAlias: 'from-wire', activeToolsKnown: false });
    expect(scanned).not.toHaveProperty('wireCoverage');
    const cached = await readPersistedAgentProfileSnapshot(
      host as never, 'workspace', 'session', 'main', { model: 'meta-model' }, undefined, budget,
    );
    expect(cached).toMatchObject({ source: 'wire', modelAlias: 'from-wire', activeToolsKnown: false });
    expect(cached).not.toHaveProperty('wireCoverage');
    expect(reads).toBe(0);
    expect(streamReads).toBe(1);
  });

  it('folds profile lines from the wire stream and does not parse unrelated records', async () => {
    const noise = `this is not json ${'x'.repeat(64)}\n`;
    const request = `{"type":"llm.request","pad":"${'y'.repeat(1_100_000)}\n`;
    const update = '{"type":"config.update","modelAlias":"from-wire","time":2}\n';
    let appendReads = 0;
    const host = {
      storage: {
        size: async () => Buffer.byteLength(noise + request + update),
        mtime: async () => 4,
        readStream: async function* () {
          yield Buffer.from(noise);
          yield Buffer.from(request);
          yield Buffer.from(update);
        },
      },
      appendLog: {
        flush: async () => undefined,
        read: async function* () { appendReads += 1; },
      },
    };
    const snapshot = await readPersistedAgentProfileSnapshot(host as never, 'workspace', 'session', 'main', { model: 'meta-model' });
    expect(appendReads).toBe(0);
    expect(snapshot).toMatchObject({ source: 'wire', modelAlias: 'from-wire', activeToolsKnown: false });
    expect(snapshot?.promptRequest).toBeUndefined();
  });
});
