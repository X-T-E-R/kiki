import { describe, expect, it } from 'vitest';

import { groupBlocks, groupHasError, groupHasRunning, groupToolNames, type ToolGroup } from './grouping';
import type { AssistantBlock, ToolBlock, UserBlock } from './transcript';

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
    progressText: undefined,
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
});
