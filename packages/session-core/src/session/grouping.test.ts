import { describe, expect, it } from 'vitest';

import { groupBlocks, groupHasError, groupHasRunning, groupToolNames, type ToolGroup } from './grouping';
import type { AssistantBlock, ShellBlock, ThinkingBlock, ToolBlock, UserBlock } from './transcript';

let counter = 0;
function tool(name: string, status: ToolBlock['status'] = 'done'): ToolBlock {
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
  };
}

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
  return {
    kind: 'thinking',
    id: `think-t${counter}`,
    text: 'pondering',
    streaming: false,
    createdAt: undefined,
  };
}

function text(kind: 'user' | 'assistant'): UserBlock | AssistantBlock {
  counter += 1;
  return kind === 'user'
    ? { kind, id: `u${counter}`, text: 'hi', createdAt: '2026-01-01T00:00:00.000Z' }
    : { kind, id: `a${counter}`, text: 'hello', streaming: false, createdAt: undefined };
}

describe('groupBlocks', () => {
  it('folds runs of ≥2 consecutive tool blocks into one group', () => {
    const nodes = groupBlocks([tool('Read'), tool('Edit'), tool('Bash')]);
    expect(nodes).toHaveLength(1);
    const group = nodes[0] as ToolGroup;
    expect(group.kind).toBe('tool-group');
    expect(group.tools.map((t) => t.name)).toEqual(['Read', 'Edit', 'Bash']);
  });

  it('keeps a single tool block bare', () => {
    const nodes = groupBlocks([tool('Read')]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe('tool');
  });

  it('breaks runs at any non-tool block', () => {
    const nodes = groupBlocks([
      tool('Read'),
      tool('Edit'),
      text('assistant') as AssistantBlock,
      tool('Bash'),
      tool('Glob'),
    ]);
    expect(nodes.map((n) => n.kind)).toEqual(['tool-group', 'assistant', 'tool-group']);
    expect((nodes[0] as ToolGroup).tools).toHaveLength(2);
    expect((nodes[2] as ToolGroup).tools).toHaveLength(2);
  });

  it('preserves order and identity around groups', () => {
    const first = text('user') as UserBlock;
    const nodes = groupBlocks([first, tool('A'), tool('B'), text('assistant') as AssistantBlock]);
    expect(nodes[0]).toBe(first);
    expect(nodes[2]!.kind).toBe('assistant');
    expect((nodes[1] as ToolGroup).id).toBe(`group-tool-t${counter - 2}`);
  });

  it('exposes running/error aggregation for the summary row', () => {
    const group = groupBlocks([tool('A'), tool('B', 'error'), tool('C', 'running')])[0] as ToolGroup;
    expect(groupHasError(group)).toBe(true);
    expect(groupHasRunning(group)).toBe(true);
    const calm = groupBlocks([tool('A'), tool('B')])[0] as ToolGroup;
    expect(groupHasError(calm)).toBe(false);
    expect(groupHasRunning(calm)).toBe(false);
  });

  it('summarizes tool names with a +N overflow', () => {
    const group = groupBlocks([tool('A'), tool('B'), tool('C'), tool('D'), tool('E')])[0] as ToolGroup;
    expect(groupToolNames(group)).toBe('A, B, C, D +1');
  });

  it('folds shell and thinking steps into the run — they carry no assistant prose', () => {
    const nodes = groupBlocks([tool('Read'), shell(), thinking(), tool('Edit')]);
    expect(nodes).toHaveLength(1);
    const group = nodes[0] as ToolGroup;
    expect(group.kind).toBe('tool-group');
    expect(group.tools).toHaveLength(2);
    expect(group.shells).toHaveLength(1);
    expect(group.thinking).toHaveLength(1);
    expect(group.count).toBe(4);
    expect(groupToolNames(group)).toBe('Read, Edit, shell');
  });

  it('keeps a single isolated shell or thinking step bare', () => {
    expect(groupBlocks([shell()])).toHaveLength(1);
    expect(groupBlocks([shell()])[0]!.kind).toBe('shell');
    expect(groupBlocks([thinking()])).toHaveLength(1);
    expect(groupBlocks([thinking()])[0]!.kind).toBe('thinking');
  });

  it('never folds assistant text or subagent events — they break the run', () => {
    const nodes = groupBlocks([
      tool('Read'),
      shell(),
      text('assistant') as AssistantBlock,
      shell(),
      thinking(),
    ]);
    expect(nodes.map((n) => n.kind)).toEqual(['tool-group', 'assistant', 'tool-group']);
    expect((nodes[0] as ToolGroup).count).toBe(2);
    expect((nodes[2] as ToolGroup).count).toBe(2);
  });

  it('aggregates running shells and isError shells into the summary flags', () => {
    counter += 1;
    const runningShell: ShellBlock = {
      kind: 'shell',
      id: `shell-r${counter}`,
      commandId: `cr${counter}`,
      command: 'npm test',
      output: '',
      done: false,
      isError: undefined,
    };
    counter += 1;
    const failedShell: ShellBlock = {
      kind: 'shell',
      id: `shell-e${counter}`,
      commandId: `ce${counter}`,
      command: 'npm build',
      output: '',
      done: true,
      isError: true,
    };
    const group = groupBlocks([runningShell, failedShell])[0] as ToolGroup;
    expect(groupHasRunning(group)).toBe(true);
    expect(groupHasError(group)).toBe(true);
  });

  it('sums only real frame durations — turn fallbacks never fabricate a total', () => {
    const framed = groupBlocks([tool('A'), tool('B')])[0] as ToolGroup;
    expect(framed.durationMs).toBe(24);
    counter += 1;
    const fallback: ToolBlock = {
      ...tool('C'),
      durationSource: 'turn',
      durationMs: 5000,
    };
    const mixed = groupBlocks([tool('A'), fallback])[0] as ToolGroup;
    expect(mixed.durationMs).toBe(12);
    counter += 1;
    const unknown: ToolBlock = { ...tool('D'), startedAt: undefined, durationMs: undefined };
    const noTiming = groupBlocks([tool('A'), unknown])[0] as ToolGroup;
    expect(noTiming.durationMs).toBe(12);
    expect(noTiming.startedAt).toBe(0);
  });

  it('derives the group id from the first step, whatever its kind', () => {
    counter += 1;
    const first = shell();
    const nodes = groupBlocks([first, tool('A')]);
    expect((nodes[0] as ToolGroup).id).toBe(`group-${first.id}`);
  });
});
