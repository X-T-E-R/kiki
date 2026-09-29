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
  stepObject,
  type HistoryFold,
  type ToolGroup,
} from './grouping';
import type { AssistantBlock, ShellBlock, ThinkingBlock, ToolBlock, UserBlock } from './transcript';

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
