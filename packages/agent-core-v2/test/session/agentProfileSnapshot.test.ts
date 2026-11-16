import { describe, expect, it, vi } from 'vitest';
import { permissionModeKey } from '#/agent/permissionMode/permissionModeOps';
import { planKey } from '#/features/plan/planOps';
import { PersistedStatusReader } from '#/app/sessionLegacy/persistedStatus';
import { contextMemoryKey } from '#/agent/contextMemory/contextOps';
import { createWireContextProjection } from '#/agent/contextMemory/wireContextProjection';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { WireRecord } from '#/wire/record';
import { createHash } from 'node:crypto';
import { profileKey, profileActiveToolsKey } from '#/agent/profile/profileOps';
import { tokenCountingKey } from '#/agent/tokenCounting/tokenCountingOps';
import { turnKey } from '#/agent/loop/turnOps';
import { panelAccountingKey } from '#/agent/usage/panelAccounting';
import { readPersistedAgentRuntimeFacts } from '#/session/agentRuntimeFacts';
import { encodeReplayCheckpointGraph } from '#/state/replayCheckpointCodec';
import { REPLAY_ABI_VERSION } from '#/state/eventDispatcherService';
import {
  PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET,
  readPersistedAgentProfileSnapshot,
} from '#/session/agentProfileSnapshot';

describe('readPersistedAgentProfileSnapshot', () => {
  it('does not interpret a branch title as its profile when the journal has no binding', async () => {
    const host = {
      storage: { size: async () => 0, mtime: async () => 1, pathFor: () => undefined, read: async () => undefined },
      appendLog: { flush: async () => {} },
    };
    const snapshot = await readPersistedAgentProfileSnapshot(host as never, 'workspace', 'session', 'branch', {
      type: 'main', displayName: 'BTW', labels: { branch: 'true' },
    });
    expect(snapshot?.profileName).toBeUndefined();
  });
  it('extracts the frozen bound endpoint from a persisted profile binding', async () => {
    const endpoint = {
      provider_type: 'openai', base_url: 'https://api.example.test/v1', model: 'chat',
      capabilities: ['thinking', 'tool_use'], support_efforts: ['low', 'high'],
      max_context_size: 8192, max_completion_tokens: 512, request_params: { temperature: 0.2 },
      credential: { kind: 'ephemeral', secretRef: 'secret-ref' },
    };
    const bytes = Buffer.from(JSON.stringify({ type: 'profile.bind', endpoint, thinkingEffort: 'high', systemPrompt: '', disallowedTools: [], time: 1 }) + '\n');
    const host = {
      storage: { size: async () => bytes.length, mtime: async () => 1, pathFor: () => undefined, read: async () => undefined,
        readStream: async function* () { yield bytes; } },
      appendLog: { flush: async () => undefined },
    };
    const snapshot = await readPersistedAgentProfileSnapshot(host as never, 'workspace', 'session', 'main', undefined);
    expect(snapshot).toMatchObject({ source: 'wire', endpoint });
  });

  it('returns metadata for an oversized wire and does not start a scan', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    let streamReads = 0;
    const host = {
      storage: {
        size: async () => PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET + 1,
        mtime: async () => 3,
        pathFor: () => undefined,
        read: async () => undefined,
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

  it('keeps the latest persisted MCP inventory per server beside the profile', async () => {
    const records = [
      { type: 'config.update', modelAlias: 'from-wire', time: 1 },
      { type: 'mcp.tools_discovered', serverName: 'example', hash: 'first', tools: [{ name: 'old', description: 'Old', inputSchema: {} }], enabledNames: ['old'], time: 2 },
      { type: 'mcp.tools_discovered', serverName: 'example', hash: 'latest', tools: [{ name: 'lookup', description: 'Lookup', inputSchema: {} }], enabledNames: ['lookup'], time: 3 },
    ];
    const bytes = Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const host = {
      storage: { size: async () => bytes.length, mtime: async () => 1, pathFor: () => undefined, read: async () => undefined,
        readStream: async function* () { yield bytes; } },
      appendLog: { flush: async () => undefined },
    };
    const snapshot = await readPersistedAgentProfileSnapshot(host as never, 'workspace', 'session', 'main', undefined);
    expect(snapshot?.mcpTools).toEqual([{ serverName: 'example', tools: records[2]!.tools, enabledNames: ['lookup'], collisions: undefined }]);
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
        pathFor: () => undefined,
        read: async () => undefined,
        readStream: async function* () {
          yield Buffer.from(noise);
          yield Buffer.from(request);
          yield Buffer.from(update);
        },
      },
      appendLog: {
        flush: async () => undefined,
        read: () => { appendReads += 1; return (async function* () { yield* []; })(); },
      },
    };
    const snapshot = await readPersistedAgentProfileSnapshot(host as never, 'workspace', 'session', 'main', { model: 'meta-model' });
    expect(appendReads).toBe(0);
    expect(snapshot).toMatchObject({ source: 'wire', modelAlias: 'from-wire', activeToolsKnown: false });
    expect(snapshot?.promptRequest).toBeUndefined();
  });
});

function checkpointFixture(extraTail: readonly WireRecord[] = [], context: readonly ContextMessage[] = []) {
  const prefix = Buffer.alloc((8 << 20) + 100, 32);
  prefix[prefix.length - 1] = 10;
  const tail = Buffer.from([
    { type: 'tools.set_active_tools', names: ['Read', 'Grep'], time: 2 },
    { type: 'token_counting.rebased', length: 4, tokens: 1234, measured: true, time: 2 },
    { type: 'turn.prompt', input: [], origin: { kind: 'user' }, turnId: 7, time: 2 },
    { type: 'usage.record', model: 'example-model', usage: { inputOther: 100, output: 20, inputCacheRead: 50, inputCacheCreation: 10 }, usageKnown: true, time: 2 },
    { type: 'full_compaction.complete', time: 2 },
    ...extraTail,
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  const bytes = Buffer.concat([prefix, tail]);
  const states = [
    { name: profileKey.name, value: { ...profileKey.initial(), profileName: 'research', modelAlias: 'example-model',
      canSpawnSubagents: true, allowedSubagents: ['explore'], toolAllowPolicies: [['Read', 'Grep']],
      boundProfile: { name: 'research', tools: ['Read'], mcpOverrides: { example: false } } } },
    { name: profileActiveToolsKey.name, value: ['Read'] },
    { name: tokenCountingKey.name, value: tokenCountingKey.initial() },
    { name: turnKey.name, value: turnKey.initial() },
    { name: panelAccountingKey.name, value: panelAccountingKey.initial() },
    { name: permissionModeKey.name, value: 'yolo' },
    { name: planKey.name, value: { active: true, id: 'plan-1' } },
    { name: contextMemoryKey.name, value: context },
  ];
  const checkpoint = { format: 1, replayAbi: REPLAY_ABI_VERSION,
    wire: { size: prefix.length, mtimeMs: 1, storeGeneration: 'fixture-generation',
      headHash: createHash('sha256').update(prefix.subarray(0, 65536)).digest('hex').slice(0, 32),
      boundarySha256: createHash('sha256').update(prefix.subarray(-4096)).digest('hex') },
    graph: encodeReplayCheckpointGraph({ states }),
  };
  const reads: Array<{ start: number; end: number }> = [];
  const host = {
    docs: { get: async () => checkpoint },
    storage: { size: async () => bytes.length, mtime: async () => 2, pathFor: () => undefined,
      read: async (_scope: string, key: string) => key.endsWith('.generation') ? Buffer.from('fixture-generation') : undefined,
      readStream: async function* (_scope: string, _key: string, range?: { start: number; end: number }) {
        if (range === undefined) throw new Error('Unbounded wire read');
        reads.push(range);
        yield bytes.subarray(range.start, range.end + 1);
      } },
    appendLog: { flush: async () => {} },
  };
  return { host, reads, checkpoint, prefix };
}

it('recovers a large cold profile and runtime facts from a verified checkpoint and bounded tail', async () => {
  const { host, reads, prefix } = checkpointFixture();
  const snapshot = await readPersistedAgentProfileSnapshot(host as never, 'workspace', 'session', 'main', undefined,
    undefined, { inlineByteBudget: PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET });
  expect(snapshot).toMatchObject({ source: 'wire', profileName: 'research', activeToolNames: ['Read', 'Grep'],
    activeToolsKnown: true, canSpawnSubagents: true, allowedSubagents: ['explore'],
    boundProfile: { name: 'research', mcpOverrides: { example: false } } });
  const facts = await readPersistedAgentRuntimeFacts(host as never, 'workspace', 'session', 'main');
  expect(facts).toMatchObject({ contextTokens: 1234, turnCount: 8, complete: true,
    panelAccounting: { records: 1, knownRecords: 1, successfulCompactions: 1,
      knownByModel: { 'example-model': { inputOther: 100, output: 20, inputCacheRead: 50, inputCacheCreation: 10 } } } });
  expect(reads.some(range => range.start === prefix.length)).toBe(true);
  expect(reads.reduce((sum, range) => sum + range.end - range.start + 1, 0)).toBeLessThan(160_000);
});

it('reads cold status from verified runtime facts without starting the full projection worker', async () => {
  const { host, reads } = checkpointFixture();
  const request = vi.fn(async () => { throw new Error('Unexpected full wire scan'); });
  const reader = new PersistedStatusReader({ request } as never, host.appendLog as never, host.storage as never, host.docs as never);
  expect(await reader.read('workspace', 'session')).toMatchObject({
    permissionMode: 'yolo', permissionConfigured: true, planActive: true,
    contextTokens: { 'measured+estimated': 1234 },
  });
  expect(request).not.toHaveBeenCalled();
  expect(reads.reduce((sum, range) => sum + range.end - range.start + 1, 0)).toBeLessThan(160_000);
});

it('preserves canonical token strategies across a large checkpoint and an unmeasured context tail', async () => {
  const context: ContextMessage[] = Array.from({ length: 4 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: 'Saved context '.repeat(40) }], toolCalls: [],
  }));
  const tail: WireRecord = { type: 'context.append_message', message: { role: 'assistant', content: [{ type: 'text', text: 'Unmeasured output '.repeat(300) }], toolCalls: [] }, time: 3 };
  const { host } = checkpointFixture([tail], context);
  const projection = createWireContextProjection();
  for (const message of context) projection.add({ type: 'context.append_message', message });
  projection.add({ type: 'token_counting.rebased', length: 4, tokens: 1234, measured: true });
  projection.add(tail);
  const request = vi.fn(async () => { throw new Error('Unexpected full wire scan'); });
  const reader = new PersistedStatusReader({ request } as never, host.appendLog as never, host.storage as never, host.docs as never);
  expect((await reader.read('workspace', 'session')).contextTokens).toEqual(projection.result().contextTokens);
  expect(request).not.toHaveBeenCalled();
});

it('keeps all cold status token strategies equal to canonical projection after an unmeasured tail', async () => {
  const records = [
    { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'question '.repeat(200) }], toolCalls: [], origin: { kind: 'user' } }, time: 1 },
    { type: 'token_counting.measured', length: 1, tokens: 100, time: 2 },
    { type: 'context.append_message', message: { role: 'assistant', content: [{ type: 'text', text: 'answer '.repeat(200) }], toolCalls: [] }, time: 3 },
  ];
  const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const host = { storage: { size: async () => bytes.length, mtime: async () => 1, pathFor: () => undefined,
    read: async () => undefined, readStream: async function* () { yield bytes; } }, appendLog: { flush: async () => {} } };
  const projection = createWireContextProjection();
  for (const record of records) projection.add(record);
  const facts = await readPersistedAgentRuntimeFacts(host as never, 'workspace', 'session', 'main', undefined, undefined, { includeStatus: true });
  expect(facts.status?.contextTokens).toEqual(projection.result().contextTokens);
  expect(facts.status?.contextTokens['measured+estimated']).toBeGreaterThan(100);
});

it('rejects an invalid large checkpoint without scanning its wire and uses mirrored context', async () => {
  const { host, checkpoint, reads } = checkpointFixture();
  checkpoint.wire.boundarySha256 = '0'.repeat(64);
  const facts = await readPersistedAgentRuntimeFacts(host as never, 'workspace', 'session', 'main', { contextTokens: 99 } as never);
  expect(facts).toEqual({ contextTokens: 99, complete: false });
  expect(reads.every(range => range.end - range.start < 65536)).toBe(true);
});

it('uses the context mirror when a small valid wire has no token-counting facts', async () => {
  const bytes = Buffer.from('{"type":"config.update","modelAlias":"example-model","time":1}\n');
  const host = { storage: { size: async () => bytes.length, mtime: async () => 1, pathFor: () => undefined,
    read: async () => undefined, readStream: async function* () { yield bytes; } }, appendLog: { flush: async () => {} } };
  expect(await readPersistedAgentRuntimeFacts(host as never, 'workspace', 'session', 'main', { contextTokens: 321 } as never))
    .toMatchObject({ contextTokens: 321, complete: true });
});

it.each([false, true])('keeps mirrored context through a direct model switch, with explicit zero counting=%s', async counted => {
  const records = [{ type: 'agent.model_switch', operationId: 'switch', input: { operationId: 'switch', model: 'next', mode: 'direct' },
    agentId: 'main', fromModel: 'old', toModel: 'next', mode: 'direct', thinking: 'off',
    config: { modelAlias: 'next', thinkingEffort: 'off' }, contextRevision: 0, oldEpoch: 0, newEpoch: 0,
    summaryGenerated: false, previousMessageCount: 0, time: 1 },
    ...(counted ? [{ type: 'token_counting.rebased', length: 0, tokens: 0, measured: true, time: 2 }] : [])];
  const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const host = { storage: { size: async () => bytes.length, mtime: async () => 1, pathFor: () => undefined,
    read: async () => undefined, readStream: async function* () { yield bytes; } }, appendLog: { flush: async () => {} } };
  expect(await readPersistedAgentRuntimeFacts(host as never, 'workspace', 'session', 'main', { contextTokens: 321 } as never))
    .toMatchObject({ contextTokens: counted ? 0 : 321, complete: true });
});
