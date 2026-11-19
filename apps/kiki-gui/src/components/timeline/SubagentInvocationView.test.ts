// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentForest, SessionController, SubagentBlock, SubagentGroup, ToolBlock } from '@kiki/session-core/session';
import type { ContentRef } from '@kiki/transcript';
import { I18nProvider } from '../../i18n';
import { TranscriptDetailProvider } from '../transcriptDetail';
import { SubagentGroupRow } from './FoldRows';
import { InvocationContext, parseAgentReceipt, useInvocationDetails } from './SubagentInvocationView';

const mountedRoots: Array<{ root: Root; host: HTMLDivElement }> = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: ReturnType<typeof createElement>): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(I18nProvider, null, node));
  });
  mountedRoots.push({ root, host });
  return host;
}

afterEach(() => {
  while (mountedRoots.length > 0) {
    const entry = mountedRoots.pop()!;
    act(() => {
      entry.root.unmount();
    });
    entry.host.remove();
  }
});

function makeFakeController(options: {
  refs?: readonly ContentRef[];
  rangeKeys?: ReadonlySet<string>;
  lookupToolCall?: ReturnType<typeof vi.fn>;
} = {}): SessionController {
  const refs = options.refs ?? [];
  const rangeKeys = options.rangeKeys ?? new Set<string>();
  const lookupToolCall = options.lookupToolCall ?? vi.fn(async () => ({ status: 'not_found' as const }));
  return {
    subscribe: () => () => {},
    getContentRevision: () => 0,
    getState: () => ({ transcriptResetVersion: 1 }),
    getToolCallDetail: () => undefined,
    contentRefsFor: () => refs,
    isContentRange: (_agentId: string, ref: ContentRef) => rangeKeys.has(ref.path.join('.')),
    getAgentState: () => ({ detailLoads: {} }),
    beginContentRead: () => ({ release: () => {}, retry: () => {} }),
    lookupToolCall,
    copyToolCallField: vi.fn(async () => ''),
    copyContentField: vi.fn(async () => ''),
  } as unknown as SessionController;
}

function InvocationHarness({ toolCallId }: { toolCallId: string }) {
  const { button, body } = useInvocationDetails(toolCallId, 'main');
  return createElement('div', null, button, body);
}

describe('invocation receipt header', () => {
  it('stops at the first blank line, preserves colons, and accepts future advisory fields', () => {
    const receipt = parseAgentReceipt('task_id: task:one\r\nagent_id: child\r\nbinding_advisories: [{"code":"future_code","effectiveValue":"high","extra":true}]\r\n \r\nactual_profile: not-a-header');
    expect(receipt.headers['task_id']).toBe('task:one');
    expect(receipt.headers['actual_profile']).toBeUndefined();
    expect(receipt.advisories).toEqual([{ code: 'future_code', effectiveValue: 'high', extra: true }]);
  });

  it('distinguishes a known empty list from legacy first-only receipts', () => {
    expect(parseAgentReceipt('binding_advisories: []\nbinding_advisory_first: {"code":"old"}').advisories).toEqual([]);
    const legacy = parseAgentReceipt('binding_advisory_count: 3\nbinding_advisory_first: {"code":"old"}');
    expect(legacy.advisories).toBeUndefined();
    expect(legacy.first).toEqual({ code: 'old' });
    expect(legacy.headers['binding_advisory_count']).toBe('3');
  });

  it('rejects malformed structured advisory data but retains raw header values', () => {
    for (const value of ['oops', '[null]', '[1]', '{"code":"wrong-container"}']) {
      const receipt = parseAgentReceipt(`binding_advisories: ${value}\nbinding_advisory_first: null`);
      expect(receipt.advisories).toBeUndefined();
      expect(receipt.first).toBeUndefined();
      expect(receipt.headers['binding_advisories']).toBe(value);
    }
  });
});

describe('useInvocationDetails fast fallback', () => {
  it('skips lookupToolCall when InvocationContext already holds complete non-range fallback output', async () => {
    const lookupToolCall = vi.fn(async () => ({ status: 'not_found' as const }));
    const controller = makeFakeController({ lookupToolCall });
    const tool: ToolBlock = {
      kind: 'tool',
      id: 'tool-call-1',
      toolCallId: 'call-1',
      name: 'AgentRun',
      args: { description: 'Review diff', prompt: 'Inspect the branch carefully.' },
      argsText: '',
      display: undefined,
      description: undefined,
      status: 'done',
      output: 'task_id: task-1\nagent_id: child-1\n\nAll checks passed.',
      isError: false,
      durationMs: undefined,
      progressText: undefined,
      frameId: 'f-1',
      turnId: 't-1',
      stepId: 's-1',
    };
    const inner = createElement(
      InvocationContext.Provider,
      { value: { callerAgentId: 'main', tools: new Map([['call-1', tool]]), hasMore: false, loadOlder: async () => false } },
      createElement(InvocationHarness, { toolCallId: 'call-1' }),
    );
    const host = mount(
      createElement(TranscriptDetailProvider, {
        controller,
        load: async () => true,
        loads: {},
        sessionId: 's1',
        agentId: 'main',
        children: inner,
      }),
    );
    const toggle = host.querySelector<HTMLButtonElement>('[data-invocation-toggle="call-1"]');
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle!.click();
    });
    expect(host.querySelector('[data-invocation-tool="call-1"]')).not.toBeNull();
    expect(host.textContent).toContain('Inspect the branch carefully.');
    expect(host.textContent).toContain('All checks passed.');
    expect(lookupToolCall).not.toHaveBeenCalled();
  });

  it('still calls lookupToolCall when fallback has a range field on output', async () => {
    const lookupToolCall = vi.fn(async () => ({ status: 'not_found' as const }));
    const outputRef: ContentRef = {
      source: { kind: 'frame', id: 'f-2', turnId: 't-1', stepId: 's-1' },
      path: ['output'],
      revision: '1',
      kind: 'text',
      offset: 256,
      total: 4096,
    };
    const controller = makeFakeController({
      refs: [outputRef],
      rangeKeys: new Set(['output']),
      lookupToolCall,
    });
    const tool: ToolBlock = {
      kind: 'tool',
      id: 'tool-call-2',
      toolCallId: 'call-2',
      name: 'AgentRun',
      args: { description: 'Large output', prompt: 'Run audit' },
      argsText: '',
      display: undefined,
      description: undefined,
      status: 'done',
      output: 'truncated preview',
      isError: false,
      durationMs: undefined,
      progressText: undefined,
      frameId: 'f-2',
      turnId: 't-1',
      stepId: 's-1',
    };
    const inner = createElement(
      InvocationContext.Provider,
      { value: { callerAgentId: 'main', tools: new Map([['call-2', tool]]), hasMore: false, loadOlder: async () => false } },
      createElement(InvocationHarness, { toolCallId: 'call-2' }),
    );
    const host = mount(
      createElement(TranscriptDetailProvider, {
        controller,
        load: async () => true,
        loads: {},
        sessionId: 's1',
        agentId: 'main',
        children: inner,
      }),
    );
    const toggle = host.querySelector<HTMLButtonElement>('[data-invocation-toggle="call-2"]');
    await act(async () => {
      toggle!.click();
    });
    expect(lookupToolCall).toHaveBeenCalledTimes(1);
    expect(lookupToolCall).toHaveBeenCalledWith('main', 'call-2', expect.any(AbortSignal));
  });
});

describe('SubagentGroupRow transient idle/unknown guard', () => {
  function makeSubagentMember(index: number, status: SubagentBlock['status'] = 'running'): SubagentBlock {
    return {
      kind: 'subagent',
      id: `sub-block-${index}`,
      subagentId: `child-${index}`,
      parentAgentId: 'main',
      parentToolCallId: `call-${index}`,
      name: `worker_${index}`,
      description: `worker ${index}`,
      model: undefined,
      thinkingEffort: undefined,
      status,
      summary: undefined,
      error: undefined,
      startedAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
      endedAt: undefined,
      toolCallCount: 0,
      transcript: [],
    };
  }

  function makeForest(nodes: readonly AgentForest['roots'][number][]): AgentForest {
    const byId: Record<string, AgentForest['roots'][number]> = {};
    for (const node of nodes) byId[node.agentId] = node;
    return { roots: [byId['main']!], byId };
  }

  it('never counts a live queued/starting subagent with transient unstarted idle or unknown forest status as done', () => {
    const members = Array.from({ length: 7 }, (_, i) => makeSubagentMember(i + 1, 'running'));
    const group: SubagentGroup = { kind: 'subagent-group', id: 'grp-1', turnId: 't-1', members };
    const forest = makeForest([
      { agentId: 'main', name: 'main', label: 'main', status: 'running', busy: true, toolCallCount: 7, childIds: members.map((m) => m.subagentId) },
      { agentId: 'child-1', name: 'worker_1', label: 'worker_1', status: 'running', busy: true, toolCallCount: 0, childIds: [], startedAt: '2026-01-01T00:00:01.000Z' },
      { agentId: 'child-2', name: 'worker_2', label: 'worker_2', status: 'running', busy: true, toolCallCount: 0, childIds: [], startedAt: '2026-01-01T00:00:02.000Z' },
      { agentId: 'child-3', name: 'worker_3', label: 'worker_3', status: 'running', busy: true, toolCallCount: 0, childIds: [], startedAt: '2026-01-01T00:00:03.000Z' },
      { agentId: 'child-4', name: 'worker_4', label: 'worker_4', status: 'running', busy: true, toolCallCount: 0, childIds: [], startedAt: '2026-01-01T00:00:04.000Z' },
      { agentId: 'child-5', name: 'worker_5', label: 'worker_5', status: 'background', busy: true, toolCallCount: 0, childIds: [] },
      { agentId: 'child-6', name: 'worker_6', label: 'worker_6', status: 'unknown', busy: false, toolCallCount: 0, childIds: [] },
      { agentId: 'child-7', name: 'worker_7', label: 'worker_7', status: 'idle', busy: false, toolCallCount: 0, childIds: [] },
    ]);
    const host = mount(
      createElement(SubagentGroupRow, {
        group,
        forest,
        renderMember: (member) => createElement('span', { key: member.id }, member.name),
      }),
    );
    const groupEl = host.querySelector('[data-subagent-group]');
    expect(groupEl?.getAttribute('data-subagent-group')).toBe('7');
    expect(groupEl?.getAttribute('data-subagent-group-done')).toBe('0');
  });

  it('still counts a historical settled idle node with toolCallCount or error as done', () => {
    const members = [makeSubagentMember(1, 'running'), makeSubagentMember(2, 'running')];
    const group: SubagentGroup = { kind: 'subagent-group', id: 'grp-2', turnId: 't-1', members };
    const forest = makeForest([
      { agentId: 'main', name: 'main', label: 'main', status: 'running', busy: true, toolCallCount: 2, childIds: ['child-1', 'child-2'] },
      { agentId: 'child-1', name: 'worker_1', label: 'worker_1', status: 'idle', busy: false, toolCallCount: 2, error: 'failed', childIds: [] },
      { agentId: 'child-2', name: 'worker_2', label: 'worker_2', status: 'idle', busy: false, toolCallCount: 0, childIds: [] },
    ]);
    const host = mount(
      createElement(SubagentGroupRow, {
        group,
        forest,
        renderMember: (member) => createElement('span', { key: member.id }, member.name),
      }),
    );
    const groupEl = host.querySelector('[data-subagent-group]');
    expect(groupEl?.getAttribute('data-subagent-group-done')).toBe('1');
  });
});
