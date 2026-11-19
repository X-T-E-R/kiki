import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentTranscript, applyContentSegment, type AgentTranscriptSnapshot } from '@kiki/transcript';
import { ISessionIndex, ISessionManager, type Scope } from '@kiki/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';

import { TranscriptService } from '../src/services/transcript/transcriptService';
import { ContentChangedError, boundedEntity } from '../src/transport/klient/boundedContent';
import { boundedTranscriptSnapshot } from '../src/transport/klient/boundedTranscript';
import {
  readColdSessionViewBaseline,
  readSessionViewTranscriptContent,
  readSessionViewTranscriptDetails,
  readSessionViewTranscriptDetail,
} from '../src/transport/klient/sessionViewReads';

describe('session transcript detail reads', () => {
  it('returns canonical live task, attachment, and prompt bodies by explicit reference', async () => {
    const transcript = new AgentTranscript('main');
    transcript.apply([
      {
        op: 'task.upsert',
        task: {
          taskId: 'task-1', kind: 'subagent', state: 'completed', detached: false,
          outputTail: 'complete task output',
        },
      },
      {
        op: 'attachment.upsert',
        attachment: {
          attachmentId: 'attachment-1', mediaType: 'image/png',
          source: { kind: 'url', url: `data:image/png;base64,${'A'.repeat(8_192)}` },
        },
      },
      {
        op: 'prompt.upsert',
        prompt: {
          promptId: 'prompt-1', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z',
          content: { text: 'complete prompt content' },
        },
      },
    ]);
    const store = {
      ensureAgent: () => transcript,
    };
    const service = {
      forSessionLive: () => store,
      whenReady: async () => undefined,
      ensureAgentHistory: async () => transcript,
      reconcileQuestionSnapshot: (_sessionId: string, snapshot: ReturnType<AgentTranscript['snapshot']>) => snapshot,
    } as unknown as TranscriptService;

    await expect(readSessionViewTranscriptDetail(service, 's1', {
      agentId: 'main', kind: 'task', id: 'task-1',
    })).resolves.toEqual({
      session_id: 's1', agent_id: 'main', kind: 'task',
      task: expect.objectContaining({ taskId: 'task-1', outputTail: 'complete task output' }),
      read: { source: 'live', readiness: 'ready' },
    });
    await expect(readSessionViewTranscriptDetail(service, 's1', {
      agentId: 'main', kind: 'attachment', id: 'attachment-1',
    })).resolves.toEqual({
      session_id: 's1', agent_id: 'main', kind: 'attachment',
      attachment: expect.objectContaining({ attachmentId: 'attachment-1', source: { kind: 'session_media', fileId: expect.stringMatching(/^inline:main:/) } }),
      read: { source: 'live', readiness: 'ready' },
    });
    expect(transcript.getAttachment('attachment-1')?.source).toEqual({ kind: 'url', url: `data:image/png;base64,${'A'.repeat(8_192)}` });
    await expect(readSessionViewTranscriptDetail(service, 's1', {
      agentId: 'main', kind: 'prompt', id: 'prompt-1',
    })).resolves.toEqual({
      session_id: 's1', agent_id: 'main', kind: 'prompt',
      prompt: expect.objectContaining({ promptId: 'prompt-1', content: { text: 'complete prompt content' } }),
      read: { source: 'live', readiness: 'ready' },
    });
    await expect(readSessionViewTranscriptDetail(service, 's1', {
      agentId: 'main', kind: 'task', id: 'missing',
    })).resolves.toBeUndefined();
  });

  it('paginates canonical global entities with an opaque keyset cursor', async () => {
    const transcript = new AgentTranscript('main');
    transcript.apply([
      ...['task-1', 'task-2', 'task-3'].map((taskId) => ({
        op: 'task.upsert' as const,
        task: {
          taskId, kind: 'subagent' as const, state: 'completed' as const,
          detached: false, outputTail: taskId,
        },
      })),
    ]);
    const store = { ensureAgent: () => transcript };
    const service = {
      forSessionLive: () => store,
      whenReady: async () => undefined,
      ensureAgentHistory: async () => transcript,
      reconcileQuestionSnapshot: (_sessionId: string, snapshot: ReturnType<AgentTranscript['snapshot']>) => snapshot,
    } as unknown as TranscriptService;

    const first = await readSessionViewTranscriptDetails(service, 's1', {
      agentId: 'main', kind: 'task', limit: 1,
    });
    expect(first).toMatchObject({
      kind: 'task', items: [{ taskId: 'task-1' }], has_more: true,
      next_cursor: expect.any(String),
    });
    const second = await readSessionViewTranscriptDetails(service, 's1', {
      agentId: 'main', kind: 'task', limit: 1, cursor: first?.kind === 'task' ? first.next_cursor : undefined,
    });
    expect(second).toMatchObject({
      kind: 'task', items: [{ taskId: 'task-2' }], has_more: true,
      next_cursor: expect.any(String),
    });
  });

  it('keeps normal concise subagent receipts complete in boundedTranscriptSnapshot and preserves generous previews for oversized receipts', () => {
    const conciseSummary = '子智能体执行完成：\n- 定位了 3 处关键性能热点并全部修复。\n- 全部回归测试已通过。\n'.repeat(25);
    const hugeSummary = '详细审计报告段落：'.repeat(1200);
    const makeTask = (taskId: string, agentId: string, resultSummary: string) => ({
      taskId,
      kind: 'subagent' as const,
      state: 'completed' as const,
      detached: true,
      agentId,
      name: `worker_${agentId}`,
      subagentName: 'implementer',
      model: 'axon-message/gemini-4-neon',
      thinkingEffort: 'high',
      executorId: 'native',
      parentToolCallId: `call_${taskId}`,
      description: 'Inspect and repair subagent detail stall',
      startedAt: '2026-11-20T00:00:00.000Z',
      endedAt: '2026-11-20T00:00:12.000Z',
      outputTail: '',
      resultSummary,
    });
    const snapshot: AgentTranscriptSnapshot = {
      items: [
        { kind: 'taskref', refId: 'ref-concise', taskId: 'agent-11111111', at: '2026-11-20T00:00:00.000Z' },
        { kind: 'taskref', refId: 'ref-huge', taskId: 'agent-22222222', at: '2026-11-20T00:00:01.000Z' },
      ],
      tasks: [
        makeTask('agent-11111111', 'sub-1', conciseSummary),
        makeTask('agent-22222222', 'sub-2', hugeSummary),
      ],
      attachments: [],
      prompts: [],
      interactions: [],
      todos: [],
      meta: {},
    };
    const bounded = boundedTranscriptSnapshot(snapshot, 'main');
    const concise = bounded.tasks.find((entry) => entry.taskId === 'agent-11111111');
    const huge = bounded.tasks.find((entry) => entry.taskId === 'agent-22222222');
    expect(concise?.resultSummary).toBe(conciseSummary);
    expect(concise?.contentRefs).toBeUndefined();
    expect(huge?.resultSummary?.length).toBeGreaterThan(500);
    expect(huge?.contentRefs?.some((ref) => ref.path[0] === 'resultSummary')).toBe(true);
  });

  it('serves task continuations, task details, and tail tool lookups in <50ms without full-wire scans on >10MiB live tailFirst and cold sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'subagent-instant-detail-'));
    const sessionId = 's-large-wire';
    const sessionDir = join(home, 'sessions', 'ws', sessionId);
    const agentDir = join(sessionDir, 'agents', 'main');
    const wirePath = join(agentDir, 'wire.jsonl');
    const oldTaskId = 'agent-1111aaaa';
    const tailTaskId = 'agent-2222bbbb';
    const oldSummary = '历史子智能体完整总结：'.repeat(600);
    const tailSummary = '尾部子智能体完整总结：'.repeat(700);
    const padding = 'p'.repeat(64 * 1024);
    const oldTurnTime = Date.UTC(2026, 10, 20, 0, 0, 1);
    const tailTurnTime = Date.UTC(2026, 10, 20, 0, 10, 0);
    const records: unknown[] = [
      { type: 'metadata', protocol_version: '2', created_at: oldTurnTime - 1000 },
      { type: 'turn.prompt', turnId: 0, promptId: 'p0', input: [{ type: 'text', text: 'early dispatch' }], origin: { kind: 'user' }, time: oldTurnTime },
      { type: 'subagent.spawned', subagentId: 'sub-old', subagentName: 'researcher', parentToolCallId: 'call-old-sub', runInBackground: true, taskId: oldTaskId, description: 'Old task', time: oldTurnTime + 10 },
      { type: 'subagent.completed', subagentId: 'sub-old', taskId: oldTaskId, resultSummary: oldSummary, time: oldTurnTime + 50 },
      ...Array.from({ length: 180 }, (_, index) => ({ type: 'fixture.padding', index, payload: padding })),
      { type: 'turn.prompt', turnId: 1, promptId: 'p1', input: [{ type: 'text', text: 'latest dispatch' }], origin: { kind: 'user' }, time: tailTurnTime },
      { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'step-tail-1', turnId: 1, step: 1 }, time: tailTurnTime + 1 },
      { type: 'context.append_loop_event', event: { type: 'tool.call', uuid: 'tc-tail-1', stepUuid: 'step-tail-1', turnId: 1, toolCallId: 'call-tail-sub', name: 'AgentRun', args: { profile: 'implementer', description: 'Tail task', prompt: 'Do work' } }, time: tailTurnTime + 2 },
      { type: 'context.append_loop_event', event: { type: 'tool.result', stepUuid: 'step-tail-1', turnId: 1, toolCallId: 'call-tail-sub', result: { output: `task_id: ${tailTaskId}\nagent_id: sub-tail\nactual_profile: implementer`, isError: false } }, time: tailTurnTime + 3 },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-tail-1', turnId: 1, step: 1, finishReason: 'stop' }, time: tailTurnTime + 3 },
      { type: 'subagent.spawned', subagentId: 'sub-tail', subagentName: 'implementer', parentToolCallId: 'call-tail-sub', runInBackground: true, taskId: tailTaskId, description: 'Tail task', time: tailTurnTime + 4 },
      { type: 'subagent.completed', subagentId: 'sub-tail', taskId: tailTaskId, resultSummary: tailSummary, time: tailTurnTime + 20 },
      { type: 'prompt.enqueued', promptId: 'tail-prompt', message: { role: 'user', content: [{ type: 'text', text: 'tail queued prompt body' }], origin: { kind: 'user' } }, time: tailTurnTime + 25 },
      { type: 'turn.ended', turnId: 1, reason: 'completed', time: tailTurnTime + 30 },
    ];
    await mkdir(dirname(wirePath), { recursive: true });
    const wireText = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    expect(Buffer.byteLength(wireText, 'utf8')).toBeGreaterThan(10 << 20);
    await writeFile(wirePath, wireText, 'utf8');

    const writePersistedTask = async (taskId: string, subagentId: string, description: string, parentToolCallId: string, summary: string, startedAt: number, endedAt: number) => {
      const outputDir = join(agentDir, 'tasks', taskId);
      await mkdir(outputDir, { recursive: true });
      const buf = Buffer.from(summary, 'utf8');
      await writeFile(join(outputDir, 'output.log'), buf);
      await writeFile(join(agentDir, 'tasks', `${taskId}.json`), JSON.stringify({
        taskId,
        kind: 'agent',
        status: 'completed',
        detached: true,
        description,
        startedAt,
        endedAt,
        ownerAgentId: 'main',
        agentId: subagentId,
        profile: 'implementer',
        parentToolCallId,
        receipt: {
          schemaVersion: 1,
          path: `tasks/${taskId}/output.log`,
          mediaType: 'text/plain; charset=utf-8',
          bytes: buf.byteLength,
          sha256: createHash('sha256').update(buf).digest('hex'),
          contentState: 'final',
          committedAt: new Date(endedAt).toISOString(),
        },
        receiptVerification: 'verified',
      }), 'utf8');
    };
    await writePersistedTask(oldTaskId, 'sub-old', 'Old task', 'call-old-sub', oldSummary, oldTurnTime + 10, oldTurnTime + 50);
    await writePersistedTask(tailTaskId, 'sub-tail', 'Tail task', 'call-tail-sub', tailSummary, tailTurnTime + 4, tailTurnTime + 20);

    const core = {
      accessor: {
        get: (token: unknown) => {
          if (token === ISessionIndex) return { get: async () => ({ workspaceId: 'ws' }) };
          if (token === ISessionManager) return { get: () => undefined, list: () => [] };
          return undefined;
        },
      },
    } as unknown as Scope;

    const coldService = new TranscriptService({ homeDir: home, core });
    try {
      const baseline = await readColdSessionViewBaseline(coldService, sessionId, 'main', 'delta', new AbortController().signal);
      expect(baseline).toBeDefined();
      expect(baseline!.snapshot.hasMoreOlder).toBe(true);
      const tailTaskPreview = baseline!.snapshot.tasks.find((entry) => entry.taskId === tailTaskId);
      expect(tailTaskPreview).toBeDefined();
      expect(tailTaskPreview!.contentRefs?.some((ref) => ref.path[0] === 'resultSummary')).toBe(true);

      const fullColdSpy = vi.spyOn(coldService, 'readColdSnapshot');
      const fullLiveSpy = vi.spyOn(coldService, 'readFullAgentSnapshot');
      const navSpy = vi.fn(() => { throw new Error('unexpected HistoryNavigation scan'); });
      coldService.setHistoryLocatorReader(navSpy);

      const tColdContentStart = performance.now();
      let reassembledTail = tailTaskPreview!;
      while (reassembledTail.contentRefs?.length) {
        const seg = await readSessionViewTranscriptContent(coldService, sessionId, { agentId: 'main', ref: reassembledTail.contentRefs[0]! });
        expect(seg).toBeDefined();
        reassembledTail = applyContentSegment(reassembledTail, seg!);
      }
      const coldTailContentMs = performance.now() - tColdContentStart;
      expect(reassembledTail.resultSummary).toBe(tailSummary);
      expect(coldTailContentMs).toBeLessThan(50);

      const oldTaskPreview = boundedEntity(
        { taskId: oldTaskId, kind: 'subagent' as const, state: 'completed' as const, detached: true, outputTail: '', resultSummary: oldSummary },
        { kind: 'task', id: oldTaskId },
        1024,
      );
      const tColdOldContentStart = performance.now();
      let reassembledOld = oldTaskPreview;
      while (reassembledOld.contentRefs?.length) {
        const seg = await readSessionViewTranscriptContent(coldService, sessionId, { agentId: 'main', ref: reassembledOld.contentRefs[0]! });
        expect(seg).toBeDefined();
        reassembledOld = applyContentSegment(reassembledOld, seg!);
      }
      const coldOldContentMs = performance.now() - tColdOldContentStart;
      expect(reassembledOld.resultSummary).toBe(oldSummary);
      expect(coldOldContentMs).toBeLessThan(50);

      const tColdDetailStart = performance.now();
      const oldDetail = await readSessionViewTranscriptDetail(coldService, sessionId, { agentId: 'main', kind: 'task', id: oldTaskId });
      const coldOldDetailMs = performance.now() - tColdDetailStart;
      expect(oldDetail?.kind).toBe('task');
      expect(coldOldDetailMs).toBeLessThan(50);

      const tColdToolStart = performance.now();
      const coldTool = await coldService.lookupToolCall(sessionId, 'main', 'call-tail-sub');
      const coldToolMs = performance.now() - tColdToolStart;
      expect(coldTool).toMatchObject({ status: 'found', turnId: 't1', frame: { toolCallId: 'call-tail-sub', name: 'AgentRun' } });
      expect(coldToolMs).toBeLessThan(50);

      const tColdPromptStart = performance.now();
      const tailPromptDetail = await readSessionViewTranscriptDetail(coldService, sessionId, { agentId: 'main', kind: 'prompt', id: 'tail-prompt' });
      const coldPromptMs = performance.now() - tColdPromptStart;
      expect(tailPromptDetail?.kind).toBe('prompt');
      expect(coldPromptMs).toBeLessThan(50);

      expect(fullColdSpy).not.toHaveBeenCalled();
      expect(fullLiveSpy).not.toHaveBeenCalled();
      expect(navSpy).not.toHaveBeenCalled();

      const liveTranscript = new AgentTranscript('main');
      liveTranscript.apply([{
        op: 'reset',
        agentId: 'main',
        snapshot: {
          items: [
            {
              kind: 'turn',
              turnId: 't1',
              ordinal: 1,
              state: 'completed',
              origin: { kind: 'user' },
              prompt: 'latest dispatch',
              steps: [{
                kind: 'step',
                stepId: 's1',
                turnId: 't1',
                ordinal: 1,
                state: 'completed',
                frames: [{
                  kind: 'tool',
                  frameId: 'f-call-tail-sub',
                  toolCallId: 'call-tail-sub',
                  name: 'AgentRun',
                  state: 'done',
                  input: { profile: 'implementer', description: 'Tail task', prompt: 'Do work' },
                  output: `task_id: ${tailTaskId}\nagent_id: sub-tail\nactual_profile: implementer`,
                }],
              }],
            },
          ],
          tasks: [{
            taskId: tailTaskId,
            kind: 'subagent',
            state: 'completed',
            detached: true,
            agentId: 'sub-tail',
            description: 'Tail task',
            parentToolCallId: 'call-tail-sub',
            outputTail: '',
            resultSummary: tailSummary,
          }],
          attachments: [],
          prompts: [{ promptId: 'tail-prompt', status: 'queued', createdAt: new Date(tailTurnTime + 25).toISOString(), content: 'tail queued prompt body' }],
          interactions: [],
          todos: [],
          meta: {},
          hasMoreOlder: true,
        },
      }]);
      const liveService = Object.create(coldService) as TranscriptService;
      const liveStore = {
        getAgent: (id: string) => id === 'main' ? liveTranscript : undefined,
        ensureAgent: () => liveTranscript,
        agents: () => [{ agentId: 'main', type: 'main' as const }],
      };
      const forSessionLiveSpy = vi.fn(() => liveStore);
      const ensureAgentHistorySpy = vi.fn(async () => liveTranscript);
      const verifyCoverageSpy = vi.fn(async () => false);
      Object.assign(liveService, {
        forSessionLive: forSessionLiveSpy,
        ensureAgentHistory: ensureAgentHistorySpy,
        verifyTranscriptLiveCoverage: verifyCoverageSpy,
        readFullAgentSnapshot: fullLiveSpy,
        readColdSnapshot: fullColdSpy,
        live: new Map([[sessionId, { store: liveStore }]]),
      });

      const tLiveContentStart = performance.now();
      let liveReassembled = boundedEntity(liveTranscript.getTask(tailTaskId)!, { kind: 'task', id: tailTaskId }, 1024);
      while (liveReassembled.contentRefs?.length) {
        const seg = await readSessionViewTranscriptContent(liveService, sessionId, { agentId: 'main', ref: liveReassembled.contentRefs[0]! });
        expect(seg).toBeDefined();
        liveReassembled = applyContentSegment(liveReassembled, seg!);
      }
      expect(liveReassembled.resultSummary).toBe(tailSummary);
      expect(performance.now() - tLiveContentStart).toBeLessThan(50);

      const tLiveDetailStart = performance.now();
      const liveTailDetail = await readSessionViewTranscriptDetail(liveService, sessionId, { agentId: 'main', kind: 'task', id: tailTaskId });
      const liveOldDetail = await readSessionViewTranscriptDetail(liveService, sessionId, { agentId: 'main', kind: 'task', id: oldTaskId });
      expect(liveTailDetail?.kind).toBe('task');
      expect(liveOldDetail?.kind).toBe('task');
      expect(performance.now() - tLiveDetailStart).toBeLessThan(50);

      const tLiveToolStart = performance.now();
      const liveTool = await liveService.lookupToolCall(sessionId, 'main', 'call-tail-sub');
      expect(liveTool).toMatchObject({ status: 'found', turnId: 't1', frame: { toolCallId: 'call-tail-sub' } });
      expect(performance.now() - tLiveToolStart).toBeLessThan(50);

      expect(verifyCoverageSpy).not.toHaveBeenCalled();
      expect(fullLiveSpy).not.toHaveBeenCalled();
      expect(fullColdSpy).not.toHaveBeenCalled();
      expect(navSpy).not.toHaveBeenCalled();
      expect(forSessionLiveSpy).toHaveBeenCalledWith(sessionId, { tailFirst: true });
      expect(ensureAgentHistorySpy).toHaveBeenCalledWith(sessionId, 'main', expect.objectContaining({ tailFirst: true }));
    } finally {
      coldService.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    }
  });

  it('rejects stale ContentRef without full-wire scans, hydrates foreground tasks by taskId in state.json, and slices >4KiB CJK receipts cleanly', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiki-cjk-stale-'));
    const sessionId = 's-cjk-stale';
    const sessionDir = join(home, 'sessions', 'ws', sessionId);
    const agentDir = join(sessionDir, 'agents', 'main');
    const wirePath = join(agentDir, 'wire.jsonl');
    const cjkTaskId = 'agent-cjk00001';
    const fgTaskId = 'fg-agent-task-99';
    const cjkUnit = '汉字中文测试摘要报告内容。';
    const cjkReceipt = Array.from({ length: 220 }, (_, i) => `第${i + 1}段：${cjkUnit}`).join('\n');
    expect(Buffer.byteLength(cjkReceipt, 'utf8')).toBeGreaterThan(8 * 1024);
    const fgSummary = 'Foreground subagent summary stored only in session metadata.';

    const now = Date.parse('2026-06-01T00:00:00.000Z');
    const records: unknown[] = [
      { type: 'metadata', protocol_version: '2', created_at: now - 1000 },
      { type: 'turn.prompt', turnId: 0, promptId: 'p0', input: [{ type: 'text', text: 'start' }], origin: { kind: 'user' }, time: now },
      { type: 'prompt.enqueued', promptId: 'p-stale', message: { role: 'user', content: [{ type: 'text', text: 'queued prompt '.repeat(80) }], origin: { kind: 'user' } }, time: now + 5 },
      { type: 'turn.ended', turnId: 0, reason: 'completed', time: now + 10 },
    ];
    await mkdir(dirname(wirePath), { recursive: true });
    await writeFile(wirePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');

    const cjkDir = join(agentDir, 'tasks', cjkTaskId);
    await mkdir(cjkDir, { recursive: true });
    const cjkBuf = Buffer.from(cjkReceipt, 'utf8');
    await writeFile(join(cjkDir, 'output.log'), cjkBuf);
    await writeFile(join(agentDir, 'tasks', `${cjkTaskId}.json`), JSON.stringify({
      taskId: cjkTaskId,
      kind: 'agent',
      status: 'completed',
      detached: true,
      description: 'CJK receipt task',
      startedAt: now + 1,
      endedAt: now + 9,
      ownerAgentId: 'main',
      agentId: 'sub-cjk',
      profile: 'researcher',
      receipt: {
        schemaVersion: 1,
        path: `tasks/${cjkTaskId}/output.log`,
        mediaType: 'text/plain; charset=utf-8',
        bytes: cjkBuf.byteLength,
        sha256: createHash('sha256').update(cjkBuf).digest('hex'),
        contentState: 'final',
        committedAt: new Date(now + 9).toISOString(),
      },
      receiptVerification: 'verified',
    }), 'utf8');

    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({
      id: sessionId,
      createdAt: now - 1000,
      updatedAt: now + 10,
      archived: false,
      agents: {
        main: { type: 'main' },
        'sub-fg-child': {
          type: 'sub',
          parentAgentId: 'main',
          taskId: fgTaskId,
          status: 'completed',
          displayName: 'explore',
          userLabel: 'fg_child',
          completedAt: now + 8,
          resultSummary: fgSummary,
        },
      },
    }), 'utf8');

    const core = {
      accessor: {
        get: (token: unknown) => {
          if (token === ISessionIndex) return { get: async () => ({ workspaceId: 'ws' }) };
          if (token === ISessionManager) return { get: () => undefined, list: () => [] };
          return undefined;
        },
      },
    } as unknown as Scope;

    const service = new TranscriptService({ homeDir: home, core });
    try {
      const baseline = await readColdSessionViewBaseline(service, sessionId, 'main', 'delta', new AbortController().signal);
      expect(baseline).toBeDefined();

      const fullColdSpy = vi.spyOn(service, 'readColdSnapshot');
      const fullLiveSpy = vi.spyOn(service, 'readFullAgentSnapshot');

      const cjkTask = await service.readPersistedTask(sessionId, 'main', cjkTaskId);
      expect(cjkTask).toBeDefined();
      expect(cjkTask!.resultSummary).toBe(cjkReceipt);
      expect(cjkTask!.resultSummary).not.toContain('\uFFFD');
      expect(cjkTask!.outputTail).not.toContain('\uFFFD');
      expect(cjkTask!.outputTail.length).toBeGreaterThan(0);

      let preview = boundedEntity(cjkTask!, { kind: 'task', id: cjkTaskId }, 1024);
      const summaryRef = preview.contentRefs?.find((ref) => ref.path[0] === 'resultSummary');
      expect(summaryRef).toBeDefined();
      while (preview.contentRefs?.length) {
        const seg = await readSessionViewTranscriptContent(service, sessionId, { agentId: 'main', ref: preview.contentRefs[0]! });
        expect(seg).toBeDefined();
        preview = applyContentSegment(preview, seg!);
      }
      expect(preview.resultSummary).toBe(cjkReceipt);
      expect(preview.resultSummary).not.toContain('\uFFFD');
      expect(preview.outputTail).toBe(cjkTask!.outputTail);
      expect(preview.outputTail).not.toContain('\uFFFD');

      await expect(
        readSessionViewTranscriptContent(service, sessionId, {
          agentId: 'main',
          ref: { ...summaryRef!, revision: 'stale-drifted-revision' },
        }),
      ).rejects.toBeInstanceOf(ContentChangedError);

      const promptPreview = baseline!.snapshot.prompts.find((p) => p.promptId === 'p-stale');
      const promptRef = promptPreview?.contentRefs?.[0];
      if (promptRef !== undefined) {
        await expect(
          readSessionViewTranscriptContent(service, sessionId, {
            agentId: 'main',
            ref: { ...promptRef, revision: 'stale-drifted-prompt' },
          }),
        ).rejects.toBeInstanceOf(ContentChangedError);
      }

      const fgTask = await service.readPersistedTask(sessionId, 'main', fgTaskId);
      expect(fgTask).toMatchObject({
        taskId: fgTaskId,
        agentId: 'sub-fg-child',
        state: 'completed',
        resultSummary: fgSummary,
      });
      const fgDetail = await readSessionViewTranscriptDetail(service, sessionId, { agentId: 'main', kind: 'task', id: fgTaskId });
      expect(fgDetail).toMatchObject({ kind: 'task', task: { taskId: fgTaskId, agentId: 'sub-fg-child', resultSummary: fgSummary } });

      expect(fullColdSpy).not.toHaveBeenCalled();
      expect(fullLiveSpy).not.toHaveBeenCalled();
    } finally {
      service.dispose();
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    }
  });
});
