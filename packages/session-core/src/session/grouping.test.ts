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
import type { AssistantBlock, ShellBlock, SubagentBlock, SystemBlock, ThinkingBlock, ToolBlock, UserBlock } from './transcript';

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

  it('never folds the memory tools — their rows carry view/undo actions', () => {
    const memory = tool('MemoryRead');
    const blocks = [read(), read(), memory, read()];
    expect(groupBlocks(blocks)).toEqual(blocks);
    expect(isReadStep(memory)).toBe(false);
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
    expect(foldHistory(nodes, 't9').find((node) => node.kind === 'history-fold' && node.turnId === 't2')).toMatchObject({ agentsDone: 3, thoughts: 1 });
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
    // A completed end folds with the turn's work; one that failed stays out.
    const ended = foldHistory([inTurn(read('/w/a'), 't2'), { ...(nodes[3] as SubagentEnding), outcome: 'completed' }, inTurn(text('assistant'), 't2')], 't2');
    expect(ended[0]).toMatchObject({ kind: 'history-fold', agentsDone: 1 });
    const failed = foldHistory([inTurn(read('/w/a'), 't2'), nodes[3]!, inTurn(read('/w/b'), 't2'), inTurn(text('assistant'), 't2')], 't2');
    expect(failed.map((node) => node.kind)).toEqual(['tool', 'subagent-ended', 'tool', 'assistant']);
  });
});
