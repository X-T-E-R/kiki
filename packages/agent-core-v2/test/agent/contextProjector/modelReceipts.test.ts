import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { project } from '#/agent/contextProjector/projection';
import { renderModelReceipt } from '#/agent/contextProjector/modelReceipt';
import { localTime } from '#/agent/contextProjector/receiptFormat';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { IConfigService } from '#/app/config/config';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
import { IAgentMemorySnapshot } from '#/app/memory/memorySnapshot';
import { IMemoryStore } from '#/app/memory/memoryStore';
import { IThreadCommunicationService } from '#/app/threadCommunication/threadCommunication';
import { SEND_PEER_THREAD_MESSAGE } from '#/app/threadCommunication/peerThreadCapability';
import { IRoomService } from '#/app/room/room';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { IHistoryArchive, IHistoryReadTool, IHistorySearchTool, HistoryReadTool, HistorySearchTool } from '#/agent/tools/history/historyTools';
import { IHistoryDirectory, IHistoryListTool, HistoryListTool, HistoryListInputSchema, encodeHistoryDirectoryCursor } from '#/agent/tools/history/historyListTool';
import { IListThreadsTool, ListThreadsTool, IReadThreadTool, ReadThreadTool, IWaitThreadsTool, WaitThreadsTool, ISendMessageToThreadTool, SendMessageToThreadTool, IRoomReadTool, RoomReadTool } from '#/agent/tools/thread-communication/threadCommunicationTools';
import { IAgentListTool } from '#/agent/tools/agent-list/agent-list';
import { AgentListTool } from '#/agent/tools/agent-list/agentListTool';
import { ITaskListTool } from '#/agent/tools/task/task-list/task-list';
import { TaskListTool } from '#/agent/tools/task/task-list/taskListTool';
import { ITaskOutputTool } from '#/agent/tools/task/task-output/task-output';
import { TaskOutputTool } from '#/agent/tools/task/task-output/taskOutputTool';
import { IMemoryReadTool, MemoryReadTool, IMemorySearchTool, MemorySearchTool } from '#/agent/tools/memory/memoryTools';
import { ITodoListTool } from '#/agent/tools/todo-list/todo-list';
import { TodoListTool } from '#/agent/tools/todo-list/todoListTool';
import type { AgentTool, ExecutableToolResult } from '#/tool/toolContract';

const time = Date.parse('2026-10-30T01:02:03Z');
const ref = { hostId: 'local', workspaceId: 'example', sessionId: 'thread-b' };
const toolRef = { host_id: 'local', workspace_id: 'example', session_id: 'thread-b' };
const historyRef = `h1_${Buffer.from(JSON.stringify({ workspace: 'example', session: 'session-a', agent: 'main', kind: 'frame' })).toString('base64url')}`;
const contentRef = { source: { kind: 'turn' as const, id: '7' }, revision: 'example-span', path: ['output'], kind: 'text' as const, offset: 20, total: 40 };
const task = { taskId: 'task-a', kind: 'process' as const, description: 'Run focused tests', status: 'completed' as const, startedAt: time - 1000, endedAt: time,
  detached: true, command: 'pnpm test', pid: 123, exitCode: 0, ownerAgentId: 'main', ownerTurnId: 2, terminalNotificationSuppressed: false,
  receiptVerification: 'verified' as const, receipt: { schemaVersion: 1 as const, path: 'C:/example/output.txt', mediaType: 'text/plain; charset=utf-8' as const, bytes: 1000,
    sha256: 'a'.repeat(64), contentState: 'final' as const, committedAt: '2026-10-30T01:02:03Z' } };
const entry = { id: 'm_example', type: 'feedback' as const, title: 'Focused verification', body: 'Run the changed behavior and retain its source evidence.', revision: 'rev-2', status: 'active' as const,
  pinned: false, created: '2026-10-29T01:02:03Z', updated: '2026-10-30T01:02:03Z', source: { writer: 'agent' as const, session: 'session-a', turn: 1 },
  reason: 'Verified preference', basis: { kind: 'human' as const, note: 'Direct user request', refs: ['t1.1'] }, validity: { check: 'Recheck for the current task.' } };

interface Sample { name: string; variant: string; before: string; after: string }
const samples: Sample[] = [];
let ix: TestInstantiationService;

async function run(tool: AgentTool, input: Record<string, unknown>, variant: string): Promise<Sample> {
  const execution = await tool.resolveExecution(input);
  const result: ExecutableToolResult = 'execute' in execution ? await execution.execute({ turnId: 3, step: 1, toolCallId: 'sample-call', signal: new AbortController().signal }) : execution;
  const before = result.output as string;
  const history: ContextMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'Read the saved state.' }], toolCalls: [] },
    { role: 'assistant', content: [], toolCalls: [{ type: 'function', id: 'sample-call', name: tool.name, arguments: JSON.stringify(input) }] },
    { role: 'tool', content: [{ type: 'text', text: before }], toolCalls: [], toolCallId: 'sample-call', isError: result.isError },
  ];
  const original = JSON.stringify(history);
  const projected = project(history);
  const after = projected.at(-1)!.content.map((part) => part.type === 'text' ? part.text : '').join('\n');
  expect(JSON.stringify(history)).toBe(original);
  expect(renderModelReceipt(tool.name, before, JSON.stringify({ ...input, raw: true }))).toBe(before);
  const sample = { name: tool.name, variant, before, after };
  samples.push(sample);
  return sample;
}

beforeEach(() => {
  vi.stubEnv('TZ', 'Asia/Singapore');
  ix = new TestInstantiationService();
  ix.stub(ISessionContext, { workspaceId: 'example', sessionId: 'session-a' });
  ix.stub(IAgentScopeContext, { agentId: 'main' });
  ix.stub(IWorkspaceService, { get: async () => undefined });
  ix.stub(ISessionIndex, { get: async (id) => ({ id, workspaceId: 'example', createdAt: time, updatedAt: time, archived: false }) });
  ix.stub(IConfigService, { get: <T>() => ({ enabled: true, approval: 'auto', workspaces: {} }) as T });
  ix.stub(ICapabilitySnapshotService, { toolAvailable: () => true });
  ix.stub(IAgentMemorySnapshot, { getPersona: () => undefined });
  ix.stub(IMemoryStore, { get: async (scope, id) => scope.kind === 'global' && id === entry.id ? entry : undefined, query: async () => ({ mode: 'search' as const, items: [{ ...entry, scope: { kind: 'global' as const }, score: 2 }], next_cursor: null, coverage: { complete: true, exhausted: true, scopes: [{ kind: 'global' as const }, { kind: 'workspace' as const, workspaceId: 'example' }], statuses: ['active' as const], warnings: [] } }) });
  ix.stub(IAgentContextMemoryService, { get: () => [] });
  ix.stub(ISessionMetadata, { read: async () => ({ id: 'session-a', createdAt: time, updatedAt: time, archived: false, agents: {} }) });
  ix.stub(IAgentLifecycleService, { get: () => undefined });
  ix.stub(IAgentTaskService, { list: () => [task], getTask: () => task, getTaskSnapshot: async () => task,
    getOutputSnapshot: async () => ({ outputPath: 'C:/example/output.txt', outputSizeBytes: 1000, previewBytes: 21, truncated: true, fullOutputAvailable: true, preview: '12 focused tests pass.' }),
    getOutputPage: async () => ({ outputPath: 'C:/example/output.txt', offset: 0, nextOffset: 20, totalBytes: 1000, hasMore: true, text: 'First page of output.' }) });
  ix.stub(IThreadCommunicationService, { hostId: 'local', isWorkspaceEnabled: async () => true,
    listThreads: async () => ({ threads: [{ ref, title: 'Verification', createdAt: time - 1000, updatedAt: time, state: 'idle' as const }], nextCursor: 'list-next' }),
    readThread: async () => ({ thread: ref, turns: [{ turnId: 7, startedAt: time - 1000, endedAt: time, reason: 'completed' as const, origin: 'user' as const,
      input: 'Check the change.', output: 'The focused tests pass.', contentRefs: [contentRef] }], nextCursor: 'read-next' }),
    waitThreads: async () => ({ timedOut: false, threads: [{ thread: ref, cursor: 'wait-next', activities: [{ ref, seq: 21, kind: 'terminal' as const, at: time, reason: 'completed', turnId: 7 }] }] }),
  });
  Object.assign(ix.get(IThreadCommunicationService), { [SEND_PEER_THREAD_MESSAGE]: async () => ({ messageId: 'message-a', targetSeq: 22, acceptedAt: time, deduplicated: false, delivery: 'pending' }) });
  ix.stub(IRoomService, { get: async () => ({ version: 1, id: 'room-a', name: 'Review room', host: 'session-a', paused: false,
    mode: 'mention', budget: { botMessagesPerUserMessage: 2 }, workspace: 'example', createdAt: '2026-10-30T01:02:03Z',
    generation: 0, budgetUsed: 0, userMessageCount: 0, cursors: {},
    members: [{ kind: 'thread', sessionId: 'session-a', muted: false, joinedAt: '2026-10-30T01:02:03Z', queueWhenBusy: false }] }),
    log: async () => ({ entries: [{ id: 'message-a', at: '2026-10-30T01:02:03Z', kind: 'message' as const, from: 'session-a', text: 'Tests are ready to inspect.', mentions: [] }], nextCursor: 'message-a' }) });
  ix.stub(ISessionTodoService, { getNotes: () => ({ notes: { goal: 'Finish the change' }, meta: { rev: 2, hash: 'fixture', writtenTurn: 1,
    writtenStep: 't1.1', coveredMessageId: 'notes-call', windowEpoch: 0 } }), getTodos: () => [{ title: 'Run focused tests', status: 'done' }], setTodos: () => {}, setNotes: () => {} });
  ix.stub(IHistoryDirectory, { list: async (request) => ({ status: 'partial' as const, target: { workspaceId: 'example', sessionId: 'session-a', agentId: 'main' }, source: 'transcript' as const,
    coverage: { complete: false, domain: 'directory' as const, gaps: ['navigation_building'], scanned: { bytes: 1024, records: 12 } },
    turns: [{ turn: 7, ref: historyRef, startedAt: '2026-10-30T01:02:03Z', promptExcerpt: 'Check the change.', answerExcerpt: 'Focused tests pass.', stepCount: 2, toolCount: 3 }],
    nextCursor: encodeHistoryDirectoryCursor({ v: 1, request: { ...request, order: 'newest', limit: 10 }, afterTurn: 7 }) }) });
  ix.stub(IHistoryArchive, { search: async () => ({ items: [{ sessionId: 'session-a', agentId: 'main', role: 'assistant' as const, turn: 7, stepId: 't7.2', ref: historyRef,
    time, snippet: 'The focused tests pass.', matched: ['tests'] }], hasMore: true, pageToken: 'search-next', indexState: { state: 'ready' }, source: 'index' as const,
    warning: 'page_local_relevance', coverage: { complete: false, domain: 'indexed_text' as const, gaps: ['tool_tail_not_indexed'] } }),
    readRef: async () => ({ status: 'ok' as const, turn: 7, stepId: 't7.2', ref: historyRef, role: 'assistant' as const, text: 'The focused tests pass. '.repeat(100) }),
    readTurn: async () => 'Original turn text.' });
  ix.set(IHistoryListTool, new SyncDescriptor(HistoryListTool)); ix.set(IHistoryReadTool, new SyncDescriptor(HistoryReadTool)); ix.set(IHistorySearchTool, new SyncDescriptor(HistorySearchTool));
  ix.set(IListThreadsTool, new SyncDescriptor(ListThreadsTool)); ix.set(IReadThreadTool, new SyncDescriptor(ReadThreadTool));
  ix.set(IWaitThreadsTool, new SyncDescriptor(WaitThreadsTool)); ix.set(ISendMessageToThreadTool, new SyncDescriptor(SendMessageToThreadTool)); ix.set(IRoomReadTool, new SyncDescriptor(RoomReadTool));
  ix.set(IAgentListTool, new SyncDescriptor(AgentListTool)); ix.set(ITaskListTool, new SyncDescriptor(TaskListTool)); ix.set(ITaskOutputTool, new SyncDescriptor(TaskOutputTool));
  ix.set(IMemorySearchTool, new SyncDescriptor(MemorySearchTool)); ix.set(IMemoryReadTool, new SyncDescriptor(MemoryReadTool)); ix.set(ITodoListTool, new SyncDescriptor(TodoListTool));
});
afterEach(async () => { await ix.dispose(); vi.unstubAllEnvs(); });

describe('model receipt projection', () => {
  it('renders real history tool receipts with body-first excerpts and one continuation', async () => {
    const list = await run(ix.get(IHistoryListTool), {}, 'partial-directory');
    expect(list.after).toContain('User: Check the change.');
    expect(list.after).toContain('Partial coverage: history navigation is still preparing');
    expect(list.after.match(/HistoryList \{/g)).toHaveLength(1);
    const search = await run(ix.get(IHistorySearchTool), { query: 'tests' }, 'partial-search');
    expect(search.after).toContain('Relevance is ranked within each page');
    expect(search.after).toContain('scope: session · mode: auto');
    expect(search.after).not.toContain('schema_version');
    const read = await run(ix.get(IHistoryReadTool), { ref: historyRef, max_chars: 1000 }, 'text-page');
    expect(read.after.indexOf('The focused tests pass.')).toBeLessThan(read.after.indexOf('Characters'));
    expect(read.after).toContain('1000 of 2400 (UTF-16)');
    await run(ix.get(IHistoryReadTool), { turn: 7 }, 'legacy-turn');
    Object.assign(ix.get(IHistoryDirectory), { list: async () => ({ status: 'partial', target: { workspaceId: 'example', sessionId: 'session-a', agentId: 'main' }, source: 'transcript', coverage: { complete: false, domain: 'directory', gaps: ['navigation_building'] }, turns: [], nextCursor: 'prepare-next' }) });
    const preparing = await run(ix.get(IHistoryListTool), {}, 'empty-preparation');
    expect(preparing.after).toContain('Partial coverage');
    const execution = await ix.get(IHistorySearchTool).resolveExecution({ query: 'tests' });
    if (!('execute' in execution)) throw new Error('Expected execution');
    const result = await execution.execute({ turnId: 1, toolCallId: 'search', signal: new AbortController().signal });
    const cursor = JSON.parse(result.output as string).next_cursor;
    expect(await ix.get(IHistorySearchTool).resolveExecution({ cursor, raw: true })).toHaveProperty('execute');
    expect(HistoryListInputSchema.safeParse({ cursor: 'next', raw: true }).success).toBe(true);
  });

  it('keeps historical target errors actionable', async () => {
    ix.stub(ISessionIndex, { get: async () => undefined });
    const result = await run(ix.get(IHistoryReadTool), { session_id: 'missing-session', turn: 7 }, 'missing-source');
    expect(result.after).toContain('HistoryList');
    expect(result.after).not.toContain('retryable');
  });

  it('renders local thread, wait, send and room receipts with usable calls', async () => {
    for (const [tool, input, variant] of [
      [ix.get(IListThreadsTool), {}, 'directory'], [ix.get(IReadThreadTool), { thread: toolRef }, 'turns'],
      [ix.get(IWaitThreadsTool), { threads: [{ thread: toolRef }] }, 'terminal'],
      [ix.get(ISendMessageToThreadTool), { thread: toolRef, content: 'Check tests.', idempotency_key: 'example-key' }, 'pending'],
      [ix.get(IRoomReadTool), { room: 'room-a' }, 'messages'],
    ] as const) {
      const sample = await run(tool, input, variant);
      expect(sample.after).not.toContain('targetSeq');
      expect(sample.after).not.toContain('"createdAt"');
      expect(sample.after.match(/"revision"/g)?.length ?? 0).toBe(tool.name === 'ThreadRead' ? 1 : 0);
    }
    Object.assign(ix.get(IThreadCommunicationService), { isWorkspaceEnabled: async () => true, readThread: async () => ({ thread: ref, turns: [], incomplete: 'history_preparing', nextCursor: 'prepare-next' }) });
    expect((await run(ix.get(IReadThreadTool), { thread: toolRef }, 'preparing')).after).toContain('History is preparing');
    Object.assign(ix.get(IThreadCommunicationService), { isWorkspaceEnabled: async () => true, readThread: async () => ({ thread: ref, turns: [], view: { segment: { ref: contentRef, value: 'Remaining original text.', next: { ...contentRef, offset: 30 }, contentRefs: [] } } }) });
    const segment = await run(ix.get(IReadThreadTool), { thread: toolRef, content_ref: contentRef }, 'segment');
    expect(segment.after).toContain('Remaining original text.');
    expect(segment.after.match(/"revision"/g)).toHaveLength(1);
    const bridgeId = '11111111-1111-4111-8111-111111111111';
    const bridged = { ...ref, bridgeId };
    Object.assign(ix.get(IThreadCommunicationService), { readThread: async () => ({ thread: bridged, turns: [], nextCursor: 'bridge-next',
      view: { transcript: { coverage: { complete: false, gaps: ['active_turn_or_step'] }, items: [{ kind: 'turn', ordinal: 9,
        state: 'completed', origin: { kind: 'external', payload: { source: 'peer' } }, prompt: 'Inspect the bridge.', endedAt: '2026-10-30T01:02:03Z', steps: [{ kind: 'step', frames: [
          { kind: 'text', role: 'assistant', text: 'Bridged result.', contentRefs: [contentRef] },
          { kind: 'tool', name: 'Read', state: 'done', input: { path: 'example.txt' }, output: 'Original file text.' },
        ] }] }] } } }) });
    const bridge = await run(ix.get(IReadThreadTool), { thread: { ...toolRef, bridge_id: bridgeId } }, 'bridge');
    expect(bridge.after).toContain('Bridged result.');
    expect(bridge.after).toContain('Original file text.');
    expect(bridge.after).toContain(`"bridge_id":"${bridgeId}"`);
    expect(bridge.after).toContain('the current turn or step is unfinished');
    expect(bridge.after).toContain('Prompt (external): Inspect the bridge.');
    expect(bridge.after).toContain('UTF-16 characters');
  });

  it('renders task logs, memory units and todo changes without losing recovery fields', async () => {
    await run(ix.get(IAgentListTool), {}, 'empty');
    await run(ix.get(ITaskListTool), { active_only: false }, 'completed');
    const output = await run(ix.get(ITaskOutputTool), { task_id: 'task-a' }, 'tail');
    expect(output.after).toContain('exit_code: 0');
    expect(output.after).not.toContain('sha256');
    expect(output.after).toContain('Read {"path":"C:/example/output.txt"}');
    await run(ix.get(ITaskOutputTool), { task_id: 'task-a', offset: 0 }, 'page');
    for (const tool of [ix.get(IMemoryReadTool), ix.get(IMemorySearchTool)]) {
      const sample = await run(tool, tool.name === 'MemoryRead' ? { id: 'm_example' } : { query: 'verification' }, 'complete');
      expect(sample.after).toContain(entry.body);
      expect(sample.after).toContain('"expected_revision":"rev-2"');
      expect(sample.after).toContain('Recheck for the current task.');
      expect(sample.after).not.toContain('"cursor":null');
    }
    Object.assign(ix.get(IMemoryStore), { query: async () => ({ mode: 'search', items: [], next_cursor: 'memory-next',
      coverage: { complete: false, exhausted: false, scopes: [{ kind: 'global' }], statuses: ['active'], warnings: ['1 memory record was skipped (unavailable).'] } }) });
    const partial = await run(ix.get(IMemorySearchTool), { query: 'verification' }, 'partial');
    expect(partial.after).toContain('1 memory record was skipped');
    expect(partial.after).toContain('MemorySearch {"cursor":"memory-next"}');
    await run(ix.get(IMemoryReadTool), { id: 'missing' }, 'missing');
    await run(ix.get(IMemorySearchTool), { cursor: 'next', raw: true }, 'raw-continuation');
    await run(ix.get(ITodoListTool), {}, 'read');
    await run(ix.get(ITodoListTool), { todos: [] }, 'update');
  });

  it('leaves unrelated, malformed, unknown and media output unchanged and uses explicit local offsets', () => {
    expect(renderModelReceipt('OtherTool', '{"agents":[]}')).toBe('{"agents":[]}');
    expect(renderModelReceipt('HistoryRead', '{broken')).toBe('{broken');
    expect(renderModelReceipt('HistoryRead', '{"future":1}')).toBe('{"future":1}');
    expect(localTime('2026-10-30T01:02:03Z')).toBe('2026-10-30 09:02:03 UTC+08:00');
    expect(localTime(0)).toContain('1970-01-01');
    const media: ContextMessage[] = [{ role: 'assistant', content: [], toolCalls: [{ type: 'function', id: 'media', name: 'HistoryRead', arguments: '{}' }] },
      { role: 'tool', toolCalls: [], toolCallId: 'media', content: [{ type: 'text', text: 'Original caption' }, { type: 'image_url', imageUrl: { url: 'https://example.test/image.png' } }] }];
    expect(project(media).at(-1)?.content).toEqual(media[1]!.content);
  });

  it('saves reproducible before/after captures when requested', async () => {
    if (!process.env['KIKI_CAPTURE_RECEIPTS']) return;
    const root = fileURLToPath(new URL('../../../../../.tmp/history-tool-output-20261030', import.meta.url));
    await mkdir(root, { recursive: true });
    for (const sample of samples) {
      await writeFile(resolve(root, `${sample.name}-${sample.variant}.before.txt`), sample.before);
      await writeFile(resolve(root, `${sample.name}-${sample.variant}.after.txt`), sample.after);
    }
    await writeFile(resolve(root, 'measurements.json'), JSON.stringify(samples.map(({ name, variant, before, after }) => ({ name, variant,
      before_chars: before.length, after_chars: after.length, saved_chars: before.length - after.length })), null, 2));
  });
});
