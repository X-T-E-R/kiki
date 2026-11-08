import { describe, expect, it } from 'vitest';

import {
  foldHistory,
  groupBlocks,
  groupHasError,
  groupHasRunning,
  groupSummary,
  isMemoryToolName,
  isReadStep,
  latestTurnId,
  readSubagentEndings,
  stepObject,
  type HistoryFold,
  type MediaRun,
  type SubagentEnding,
  type SubagentGroup,
  type ToolGroup,
} from './grouping';
import type { AssistantBlock, QuestionBlock, ShellBlock, SubagentBlock, SystemBlock, ThinkingBlock, ToolBlock, UserBlock } from './transcript';

let counter = 0;
function tool(
  name: string,
  status: ToolBlock['status'] = 'done',
  extra: Partial<ToolBlock> = {},
): ToolBlock {
  counter += 1;
  return {
    kind: 'tool',
    id: `tool-t${counter}`,
    toolCallId: `t${counter}`,
    name,
    argsText: '',
    args: undefined,
    display: undefined,
    description: undefined,
    status,
    output: undefined,
    isError: status === 'error' ? true : undefined,
    startedAt: 0,
    durationMs: 12,
    durationSource: 'frame',
    progressText: undefined,
    ...extra,
  };
}

const read = (path = 'C:/w/plan.ts', status: ToolBlock['status'] = 'done') =>
  tool('Read', status, { args: { file_path: path } });

function shell(): ShellBlock {
  counter += 1;
  return {
    kind: 'shell',
    id: `shell-t${counter}`,
    commandId: `c${counter}`,
    command: 'echo hi',
    output: '',
    done: true,
    isError: undefined,
    startedAt: 0,
  };
}

function thinking(): ThinkingBlock {
  counter += 1;
  return { kind: 'thinking', id: `think-t${counter}`, text: 'pondering', streaming: false, createdAt: undefined };
}

function text(kind: 'user' | 'assistant'): UserBlock | AssistantBlock {
  counter += 1;
  return kind === 'user'
    ? { kind, id: `u${counter}`, text: 'hi', createdAt: '2026-01-01T00:00:00.000Z' }
    : { kind, id: `a${counter}`, text: 'hello', streaming: false, createdAt: undefined };
}

describe('stepObject', () => {
  it('names the verb and the object from the display payload first', () => {
    expect(stepObject(tool('Read', 'done', {
      display: { kind: 'file_io', operation: 'read', path: 'C:/fixture/workshop/plan.ts' },
    }))).toEqual({ verb: 'read', target: 'plan.ts' });
    expect(stepObject(tool('Write', 'done', {
      display: { kind: 'file_io', operation: 'write', path: '/w/notes.md', content: 'x' },
    }))).toEqual({ verb: 'create', target: 'notes.md' });
    expect(stepObject(tool('Glob', 'done', {
      display: { kind: 'file_io', operation: 'glob', path: 'C:/w/src' },
    }))).toEqual({ verb: 'list', target: 'src' });
  });

  it('falls back to the tool name and args', () => {
    expect(stepObject(tool('Edit', 'done', { args: { file_path: '/w/a.ts' } }))).toEqual({ verb: 'edit', target: 'a.ts' });
    expect(stepObject(tool('Grep', 'done', { args: { pattern: 'TODO' } }))).toEqual({ verb: 'search', target: 'TODO' });
    expect(stepObject(tool('Glob', 'done', { args: { pattern: 'src/**/*.ts' } }))).toEqual({ verb: 'list', target: 'src/**/*.ts' });
    expect(stepObject(tool('WebFetch', 'done', { args: { url: 'https://example.com/spec' } }))).toEqual({ verb: 'fetch', target: 'example.com/spec' });
    expect(stepObject(tool('Bash', 'done', { args: { command: 'pnpm test' } }))).toEqual({ verb: 'run', target: 'pnpm test' });
    expect(stepObject(tool('Mystery'))).toEqual({ verb: 'other', target: undefined });
  });
});

describe('groupBlocks', () => {
  it('folds a run of three or more pure reads into one group', () => {
    const nodes = groupBlocks([read(), tool('Grep', 'done', { args: { pattern: 'x' } }), tool('Glob')]);
    expect(nodes).toHaveLength(1);
    const group = nodes[0] as ToolGroup;
    expect(group.kind).toBe('tool-group');
    expect(group.count).toBe(3);
  });

  it('leaves a run of two reads in place', () => {
    const a = read();
    const b = read('/w/b.ts');
    expect(groupBlocks([a, b])).toEqual([a, b]);
  });

  it('keeps read groups inside their owning turn without moving old work into the live group', () => {
    const old = [tool('MemoryRead', 'done', { turnId: 't1' }), tool('MemorySearch', 'done', { turnId: '1' })];
    const current = [read(), read(), read('/w/live', 'running')].map((block) => ({ ...block, turnId: 't2' }));
    const nodes = groupBlocks([...old, ...current]);
    expect(nodes.map((node) => node.kind)).toEqual(['tool', 'tool', 'tool-group']);
    expect(nodes.slice(0, 2)).toEqual(old);
    expect(nodes[2]).toMatchObject({ members: current, count: 3 });
    const folded = foldHistory(nodes, 't2');
    expect(folded.map((node) => node.kind)).toEqual(['history-fold', 'tool-group']);
    expect(folded[0]).toMatchObject({ turnId: 't1', members: old });
    expect(folded[1]).toBe(nodes[2]);
    expect(groupHasRunning(folded[1] as ToolGroup)).toBe(true);
  });

  it('normalizes a known turn for grouping and keeps unowned reads separate', () => {
    const known = [read(), read(), read()].map((block, index) => ({ ...block, turnId: index === 1 ? '3' : 't3' }));
    const unowned = read();
    const nodes = groupBlocks([...known, unowned]);
    expect(nodes.map((node) => node.kind)).toEqual(['tool-group', 'tool']);
    expect(nodes[0]).toMatchObject({ members: known, count: 3 });
    expect(nodes[1]).toBe(unowned);
  });

  it('never folds edits, writes, commands, shells or thinking — they break the run', () => {
    const r1 = read();
    const r2 = read('/w/b.ts');
    const edit = tool('Edit', 'done', { args: { file_path: '/w/a.ts' } });
    const r3 = read('/w/c.ts');
    expect(groupBlocks([r1, r2, edit, r3])).toEqual([r1, r2, edit, r3]);
    const blocks = [read(), shell(), read(), thinking(), read(), tool('Bash'), read()];
    expect(groupBlocks(blocks)).toEqual(blocks);
  });

  it('breaks runs at conversation blocks and preserves identity around groups', () => {
    const first = text('user') as UserBlock;
    const reads = [read('/w/a.ts'), read('/w/b.ts'), read('/w/c.ts')];
    const answer = text('assistant') as AssistantBlock;
    const nodes = groupBlocks([first, ...reads, answer]);
    expect(nodes[0]).toBe(first);
    expect(nodes[2]).toBe(answer);
    const group = nodes[1] as ToolGroup;
    expect(group.id).toBe(`group-${reads[0]!.id}`);
    expect(group.members).toEqual(reads);
    expect(group.members[0]).toBe(reads[0]);
  });

  it('exposes running/error aggregation for the summary row', () => {
    const group = groupBlocks([read(), read('/w/b', 'error'), read('/w/c', 'running')])[0] as ToolGroup;
    expect(groupHasError(group)).toBe(true);
    expect(groupHasRunning(group)).toBe(true);
    const calm = groupBlocks([read(), read(), read()])[0] as ToolGroup;
    expect(groupHasError(calm)).toBe(false);
    expect(groupHasRunning(calm)).toBe(false);
  });

  it('sums only real frame durations — turn fallbacks never fabricate a total', () => {
    const framed = groupBlocks([read(), read(), read()])[0] as ToolGroup;
    expect(framed.durationMs).toBe(36);
    const fallback = { ...read(), durationSource: 'turn' as const, durationMs: 5000 };
    const unknown = { ...read(), startedAt: undefined, durationMs: undefined };
    const mixed = groupBlocks([read(), fallback, unknown])[0] as ToolGroup;
    expect(mixed.durationMs).toBe(12);
    expect(mixed.startedAt).toBe(0);
  });

  it('folds ordinary memory reads with the read run and keeps the row', () => {
    const memory = tool('MemoryRead');
    const reads = [read(), read(), memory];
    const nodes = groupBlocks(reads);
    expect(nodes).toHaveLength(1);
    const group = nodes[0] as ToolGroup;
    expect(group.members[2]).toBe(memory);
    expect(isReadStep(memory)).toBe(true);
    expect(isReadStep(tool('MemorySearch', 'done', { args: { query: 'notes' } }))).toBe(true);
  });

  it('keeps a memory write out of a pure read run', () => {
    const before = [read(), read()];
    const memory = tool('MemoryWrite');
    const after = read();
    expect(isReadStep(memory)).toBe(false);
    expect(groupBlocks([...before, memory, after])).toEqual([...before, memory, after]);
  });

  it('claims exactly the three memory tools', () => {
    expect(isMemoryToolName('MemoryWrite')).toBe(true);
    expect(isMemoryToolName('MemoryRead')).toBe(true);
    expect(isMemoryToolName('MemorySearch')).toBe(true);
    expect(isMemoryToolName('Write')).toBe(false);
    expect(isMemoryToolName('Memory')).toBe(false);
  });
});

describe('groupSummary', () => {
  it('names objects per verb, de-duplicated and capped', () => {
    const group = groupBlocks([
      read('/w/plan.ts'),
      read('/w/plan.ts'),
      read('/w/notes.md'),
      tool('Grep', 'done', { args: { pattern: 'TODO' } }),
      read('/w/a.ts'),
      read('/w/b.ts'),
      read('/w/c.ts'),
      read('/w/d.ts'),
    ])[0] as ToolGroup;
    expect(groupSummary(group)).toEqual([
      { verb: 'read', targets: ['plan.ts', 'notes.md'], more: 0 },
      { verb: 'search', targets: ['TODO'], more: 0 },
      { verb: 'read', targets: ['a.ts', 'b.ts', 'c.ts'], more: 1 },
    ]);
  });
});

describe('foldHistory', () => {
  const inTurn = <T extends { turnId?: string }>(block: T, turnId: string): T => ({ ...block, turnId });

  it('folds settled process runs of finished turns and leaves the live turn open', () => {
    const past = [
      inTurn(text('user'), 't1'),
      inTurn(thinking(), 't1'),
      inTurn(read('/w/a.ts'), 't1'),
      inTurn(tool('Edit', 'error'), 't1'),
      inTurn(text('assistant'), 't1'),
    ];
    const live = [inTurn(text('user'), 't2'), inTurn(thinking(), 't2'), inTurn(read('/w/b.ts'), 't2')];
    const nodes = foldHistory([...past, ...live], latestTurnId([...past, ...live]));
    expect(nodes.map((node) => node.kind)).toEqual(['user', 'history-fold', 'assistant', 'user', 'thinking', 'tool']);
    const fold = nodes[1] as HistoryFold;
    expect(fold).toMatchObject({ id: `fold-${past[1]!.id}`, turnId: 't1', steps: 2, thoughts: 1, failed: 1 });
    expect(fold.members).toEqual(past.slice(1, 4));
  });

  it('breaks at messages and subagent rows, never spans turns, and skips single rows', () => {
    const blocks = [
      inTurn(thinking(), 't1'),
      inTurn(text('assistant'), 't1'),
      inTurn(read(), 't1'),
      inTurn(read(), 't2'),
      inTurn(shell(), 't2'),
    ];
    const nodes = foldHistory(blocks, 't3');
    expect(nodes.map((node) => node.kind)).toEqual(['thinking', 'assistant', 'tool', 'history-fold']);
  });

  it('keeps running work and turn-less rows in place', () => {
    const running = inTurn(tool('Read', 'running'), 't1');
    const loose = read();
    const nodes = foldHistory([inTurn(read(), 't1'), running, loose, loose], 't9');
    expect(nodes.every((node) => node.kind !== 'history-fold')).toBe(true);
  });
});

describe('folding the live turn, subagents, images and ends (FOLDING.md)', () => {
  const inTurn = <T extends { turnId?: string }>(block: T, turnId: string): T => ({ ...block, turnId });
  const image = (turnId: string): ToolBlock => inTurn(tool('ReadMediaFile', 'done', {
    args: { path: 'C:/w/shot.png' },
    output: [
      { type: 'text', text: '<image path="C:/w/shot.png">' },
      { type: 'image_url', imageUrl: { url: 'blobref:image/png;0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' } },
      { type: 'text', text: '</image>' },
    ],
  }), turnId);
  const agent = (id: string, status: SubagentBlock['status'], turnId = 't2'): SubagentBlock => ({
    kind: 'subagent', id: `subagent-${id}`, subagentId: id, parentAgentId: 'main', parentToolCallId: undefined,
    parentTurnId: turnId, name: id, description: undefined, model: undefined, thinkingEffort: undefined,
    status, summary: undefined, error: undefined, startedAt: undefined, endedAt: undefined, toolCallCount: 0, transcript: [],
  });

  it('folds the live turn’s settled work and leaves only its newest row out', () => {
    const blocks = [inTurn(text('user'), 't2'), inTurn(thinking(), 't2'), inTurn(read('/w/a'), 't2'), inTurn(shell(), 't2'), inTurn(read('/w/b'), 't2')];
    const nodes = foldHistory(blocks, latestTurnId(blocks));
    expect(nodes.map((node) => node.kind)).toEqual(['user', 'history-fold', 'tool']);
    expect((nodes[1] as HistoryFold).members).toEqual(blocks.slice(1, 4));
    expect(nodes[2]).toBe(blocks[4]);
  });

  it('folds memory reads, searches and writes with ordinary process, counts failures, and keeps live and user rows out', () => {
    const memoryRead = inTurn(tool('MemoryRead'), 't1');
    const memorySearch = inTurn(tool('MemorySearch', 'error', { args: { query: 'notes' } }), 't1');
    const openQuestion: QuestionBlock = {
      kind: 'question',
      id: 'q-live',
      request: {
        question_id: 'q-live',
        session_id: 'session_test',
        turn_id: 1,
        questions: [{
          id: 'q1',
          question: 'Continue?',
          options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }],
        }],
        created_at: '2026-01-01T00:00:00.000Z',
      },
      outcome: undefined,
    };
    const memoryWrite = inTurn(tool('MemoryWrite'), 't1');
    const ordinary = inTurn(read('/w/a'), 't1');
    const user = inTurn(text('user'), 't1');
    const running = inTurn(tool('MemoryRead', 'running'), 't1');
    const nodes = foldHistory([memoryRead, memorySearch, openQuestion, memoryWrite, ordinary, user, running], 't9');
    expect(nodes.map((node) => node.kind)).toEqual(['history-fold', 'question', 'history-fold', 'user', 'tool']);
    expect(nodes[0]).toMatchObject({ steps: 2, failed: 1, members: [memoryRead, memorySearch] });
    expect(nodes[1]).toBe(openQuestion);
    expect(nodes[2]).toMatchObject({ steps: 2, failed: 0, members: [memoryWrite, ordinary] });
    expect(nodes[3]).toBe(user);
    expect(nodes[4]).toBe(running);
  });

  it('folds ordinary memory into the same process run and leaves a running memory row out', () => {
    const memory = inTurn(tool('MemoryWrite'), 't1');
    const thought = inTurn(thinking(), 't1');
    const command = inTurn(shell(), 't1');
    const running = inTurn(tool('MemoryRead', 'running'), 't1');
    const nodes = foldHistory([memory, thought, command, running], 't9');
    expect(nodes.map((node) => node.kind)).toEqual(['history-fold', 'tool']);
    const fold = nodes[0] as HistoryFold;
    expect(fold.members).toEqual([memory, thought, command]);
    expect(fold.members[0]).toBe(memory);
    expect(nodes[1]).toBe(running);
  });

  it('keeps a completed shell foldable on its own and with the process beside it', () => {
    const alone = inTurn(shell(), 't1');
    expect(foldHistory([alone], 't9')).toMatchObject([{ kind: 'history-fold', steps: 1, members: [alone] }]);
    const broken = [inTurn(shell(), 't1'), inTurn(text('assistant'), 't1'), inTurn(shell(), 't1')];
    expect(foldHistory(broken, 't9').map((node) => node.kind)).toEqual(['history-fold', 'assistant', 'history-fold']);
    const together = [inTurn(thinking(), 't2'), inTurn(shell(), 't2'), inTurn(read('/w/a'), 't2')];
    const nodes = foldHistory(together, 't9');
    expect(nodes.map((node) => node.kind)).toEqual(['history-fold']);
    expect((nodes[0] as HistoryFold).members).toEqual(together);
    expect(nodes[0]).toMatchObject({ steps: 2, thoughts: 1 });
  });

  it('folds completed empty shells without moving prose or hiding running shells', () => {
    const before = inTurn(text('assistant'), 't2');
    const thought = inTurn(thinking(), 't2');
    const empty = inTurn(shell(), 't2');
    const after = inTurn(text('assistant'), 't2');
    const nodes = foldHistory([before, thought, empty, after], undefined);
    expect(nodes.map((node) => node.kind)).toEqual(['assistant', 'history-fold', 'assistant']);
    expect((nodes[1] as HistoryFold).members).toEqual([thought, empty]);
    expect(nodes[1]).toMatchObject({ steps: 1, thoughts: 1 });
    expect(foldHistory([thought, { ...empty, done: false }], 't2').map((node) => node.kind)).toEqual(['thinking', 'shell']);
  });

  it('keeps rows the reader holds in place, folding around them', () => {
    const blocks = [inTurn(thinking(), 't2'), inTurn(read('/w/a'), 't2'), inTurn(shell(), 't2'), inTurn(read('/w/b'), 't2')];
    const nodes = foldHistory(blocks, 't2', { keepOpen: new Set([blocks[1]!.id, blocks[2]!.id]) });
    // Held rows break the run: nothing folds that would move them.
    expect(nodes.map((node) => node.kind)).toEqual(['thinking', 'tool', 'shell', 'tool']);
  });

  it('folds settled subagents into the line, counting them, and keeps a live set as a group', () => {
    const settled = [inTurn(read('/w/a'), 't1'), agent('a1', 'completed', 't1'), agent('a2', 'failed', 't1'), inTurn(shell(), 't1'), inTurn(text('assistant'), 't1')];
    const folded = foldHistory(settled, 't9');
    expect(folded.map((node) => node.kind)).toEqual(['history-fold', 'assistant']);
    expect(folded[0]).toMatchObject({ steps: 2, agents: 2, failed: 1 });
    const live = [inTurn(read('/w/a'), 't2'), inTurn(shell(), 't2'), agent('b1', 'completed'), agent('b2', 'running'), inTurn(thinking(), 't2')];
    const nodes = foldHistory(live, 't2');
    expect(nodes.map((node) => node.kind)).toEqual(['history-fold', 'subagent-group', 'thinking']);
    expect((nodes[1] as SubagentGroup).members.map((member) => member.subagentId)).toEqual(['b1', 'b2']);
  });

  it('gives image reads a row of their own that breaks the fold, latest only at the live end', () => {
    const blocks = [inTurn(read('/w/a'), 't1'), inTurn(shell(), 't1'), image('t1'), image('t1'), inTurn(read('/w/b'), 't1'), inTurn(shell(), 't1'), inTurn(text('user'), 't2'), inTurn(read('/w/c'), 't2'), image('t2')];
    const nodes = foldHistory(blocks, latestTurnId(blocks));
    expect(nodes.map((node) => node.kind)).toEqual(['history-fold', 'media-run', 'history-fold', 'user', 'tool', 'media-run']);
    expect(nodes[1]).toMatchObject({ latest: false });
    expect((nodes[1] as MediaRun).members).toHaveLength(2);
    expect(nodes[5]).toMatchObject({ latest: true });
    expect(isReadStep(image('t1'))).toBe(false);
  });

  it('gives an image that arrives as the result’s own attachment the same row', () => {
    const attached = (turnId: string): ToolBlock => inTurn(tool('external_paint', 'done', {
      media: [{ kind: 'image', fileId: 'f_acp_2f1a', name: 'answer.png', mime: 'image/png' }],
    }), turnId);
    const blocks = [inTurn(read('/w/a'), 't1'), inTurn(shell(), 't1'), attached('t1'), inTurn(text('user'), 't2'), attached('t2')];
    const nodes = foldHistory(blocks, latestTurnId(blocks));
    expect(nodes.map((node) => node.kind)).toEqual(['history-fold', 'media-run', 'user', 'media-run']);
    const historical = nodes[1] as MediaRun;
    expect(historical).toMatchObject({ latest: false });
    expect(historical.members).toHaveLength(1);
    expect(nodes[3]).toMatchObject({ latest: true });
  });

  it.each([false, true])('merges completion echoes by execution, retaining separate resumes and same-name agents (summaryFirst=%s)', (summaryFirst) => {
    const note = (id: string, taskId: string, body: string): SystemBlock => ({
      kind: 'system', id, variant: 'task', taskId, turnId: 't2', createdAt: undefined,
      text: `Title: Background agent completed\n${body}`,
    });
    const full = note('system-receipt-1', 'run-1', 'First result.');
    const summary = note('system-agent-frame-task-notified:run-1', 'run-1', 'Completed.');
    const tasks = [
      { id: 'run-1', agent_id: 'a1', status: 'completed', output_preview: 'First result.' },
      { id: 'run-2', agent_id: 'a1', status: 'completed', output_preview: 'Second result.' },
      { id: 'run-3', agent_id: 'a2', status: 'completed', output_preview: 'First result.' },
    ];
    const nodes = readSubagentEndings([
      { ...agent('a1', 'completed', 't1'), name: 'Inspector' },
      { ...agent('a2', 'completed', 't1'), name: 'Inspector' },
      inTurn(thinking(), 't2'),
      ...(summaryFirst ? [summary, full] : [full, summary]),
      note('system-receipt-2', 'run-2', 'Second result.'),
      note('system-receipt-3', 'run-3', 'First result.'),
      inTurn(text('assistant'), 't2'),
    ], tasks);
    const endings = nodes.filter((node) => node.kind === 'subagent-ended');
    expect(endings.map((node) => node.taskId)).toEqual(['run-1', 'run-2', 'run-3']);
    expect(endings[0]).toMatchObject({ id: 'ended-task-run-1', note: full, task: tasks[0], dispatchOnPage: true });
    expect(foldHistory(nodes, 't9').filter((node) => node.kind === 'subagent-ended')).toHaveLength(3);
    expect(readSubagentEndings(nodes, tasks).filter((node) => node.kind === 'subagent-ended')).toEqual(endings);
  });

  it('reads a subagent’s task notification as its end: dropped beside its card, a row in a later turn', () => {
    const note = (id: string, taskId: string, turnId: string, text = 'Background agent completed\nDone.'): SystemBlock =>
      ({ kind: 'system', id, variant: 'task', text, createdAt: undefined, turnId, taskId });
    const tasks = [
      { id: 'task-a', agent_id: 'a1', status: 'completed' },
      { id: 'task-b', agent_id: 'a2', status: 'failed' },
      { id: 'task-x', status: 'completed' },
    ];
    const nodes = readSubagentEndings([
      agent('a1', 'completed', 't1'), agent('a2', 'failed', 't1'), note('n1', 'task-a', 't1'),
      inTurn(text('user'), 't2'), note('n2', 'task-b', 't2', 'Background agent failed\nboom'), note('n3', 'task-x', 't2'),
    ], tasks);
    expect(nodes.map((node) => node.kind)).toEqual(['subagent', 'subagent', 'user', 'subagent-ended', 'system']);
    expect(nodes[3]).toMatchObject({ agentId: 'a2', outcome: 'failed', dispatchOnPage: true });
    // Both completed and failed cross-turn endings stay in view as named rows.
    const ended = foldHistory([inTurn(read('/w/a'), 't2'), { ...(nodes[3] as SubagentEnding), outcome: 'completed' }, inTurn(read('/w/b'), 't2'), inTurn(text('assistant'), 't2')], 't2');
    expect(ended.map((node) => node.kind)).toEqual(['tool', 'subagent-ended', 'tool', 'assistant']);
    const failed = foldHistory([inTurn(read('/w/a'), 't2'), nodes[3]!, inTurn(read('/w/b'), 't2'), inTurn(text('assistant'), 't2')], 't2');
    expect(failed.map((node) => node.kind)).toEqual(['tool', 'subagent-ended', 'tool', 'assistant']);
  });

  it('folds delivered AgentSend rows into their contiguous turn process group and keeps queued or unknown deliveries visible', () => {
    const sent1: Block = {
      kind: 'subagent-event', id: 'send-1', subagentId: 'web_shared_remote_spaces', parentAgentId: 'main',
      name: 'web_shared_remote_spaces', event: 'sent', status: 'completed', turnId: 't1',
      message: 'First instruction', messageId: 'msg-1', delivery: 'delivered', at: '2026-01-01T00:00:01.000Z',
    };
    const sent2: Block = {
      kind: 'subagent-event', id: 'send-2', subagentId: 'web_shared_remote_spaces', parentAgentId: 'main',
      name: 'web_shared_remote_spaces', event: 'sent', status: 'completed', turnId: 't1',
      message: 'Second instruction', messageId: 'msg-2', delivery: 'delivered', at: '2026-01-01T00:00:02.000Z',
    };
    const queued: Block = {
      kind: 'subagent-event', id: 'send-3', subagentId: 'web_shared_remote_spaces', parentAgentId: 'main',
      name: 'web_shared_remote_spaces', event: 'sent', status: 'completed', turnId: 't1',
      message: 'Queued instruction', messageId: 'msg-3', delivery: 'queued', at: '2026-01-01T00:00:03.000Z',
    };
    const nodes = foldHistory([inTurn(thinking(), 't1'), sent1, sent2, queued, inTurn(text('assistant'), 't1')], 't9');
    expect(nodes.map((node) => node.kind)).toEqual(['history-fold', 'subagent-event', 'assistant']);
    const fold = nodes[0] as HistoryFold;
    expect(fold.sentMessages).toEqual([{ subagentId: 'web_shared_remote_spaces', name: 'web_shared_remote_spaces', count: 2 }]);
    expect(fold.notes).toBe(0);
    expect(fold.members).toHaveLength(3);
    expect(nodes[1]).toBe(queued);
  });

  it('emits SubagentEnding when a same-turn notification is separated from its dispatch card by conversation or questions', () => {
    const card = { ...agent('web_shared_remote_spaces', 'completed', 't1'), taskId: 'task-ws-1', name: 'web_shared_remote_spaces' };
    const note: SystemBlock = {
      kind: 'system', id: 'n-ws-1', variant: 'task', taskId: 'task-ws-1', turnId: 't1', createdAt: undefined,
      text: 'Title: Background agent completed\nRemote space sync verified.',
    };
    const tasks = [{ id: 'task-ws-1', agent_id: 'web_shared_remote_spaces', status: 'completed', output_preview: 'Remote space sync verified.' }];
    const separated = readSubagentEndings([card, inTurn(text('assistant'), 't1'), note], tasks);
    expect(separated.map((node) => node.kind)).toEqual(['subagent', 'assistant', 'subagent-ended']);
    expect(separated[2]).toMatchObject({
      agentId: 'web_shared_remote_spaces',
      taskId: 'task-ws-1',
      dispatchOnPage: true,
      dispatchCardId: 'subagent-web_shared_remote_spaces',
    });
  });

  it('keeps failed background command notifications and settled questions independent from adjacent Worked folds', () => {
    const settledQ: QuestionBlock = {
      kind: 'question',
      id: 'q-done',
      request: {
        question_id: 'q-done',
        session_id: 'session_test',
        turn_id: 1,
        questions: [{ id: 'q1', question: 'Which database?', options: [] }],
        created_at: '2026-01-01T00:00:00.000Z',
      },
      outcome: { kind: 'answered', at: '2026-01-01T00:00:05.000Z', answers: { q1: 'Postgres' } },
    };
    const failedCmd: SystemBlock = {
      kind: 'system',
      id: 'sys-bash-fail',
      variant: 'task',
      taskId: 'bash-1',
      turnId: 't1',
      createdAt: '2026-01-01T00:00:06.000Z',
      text: 'Title: Background process failed\nSeverity: warning\nBash: pnpm test failed. Exit code: 2.',
      taskNotification: {
        title: 'Background process failed',
        severity: 'warning',
        description: 'Bash: pnpm test',
        exitCode: 2,
      },
    };
    const nodes = foldHistory([
      inTurn(thinking(), 't1'),
      inTurn(read('/w/a'), 't1'),
      settledQ,
      inTurn(read('/w/b'), 't1'),
      inTurn(shell(), 't1'),
      failedCmd,
      inTurn(text('assistant'), 't1'),
    ], 't9');
    expect(nodes.map((node) => node.kind)).toEqual([
      'history-fold',
      'question',
      'history-fold',
      'system',
      'assistant',
    ]);
  });
});
