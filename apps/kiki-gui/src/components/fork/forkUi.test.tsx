// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@kiki/protocol';
import { createViewState, type AgentForest, type AgentTreeNode, type Block, type SessionController } from '@kiki/session-core/session';

import { I18nProvider } from '../../i18n';
import { withPortalQueries } from '../../test/portalQuery';
import { BtwFloatingCard } from './BtwFloatingCard';
import { ForkLaunchPopover } from './ForkLaunchPopover';
import { ForkProvenanceMark } from './ForkProvenanceMark';
import { buildSessionForkLineage } from './forkLineageModel';
import { TimelineOffshootRail } from './TimelineOffshootRail';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    workspace_id: 'wd_test_0123456789ab',
    title: `Session ${id}`,
    created_at: '2026-11-18T00:00:00Z',
    updated_at: '2026-11-18T00:00:00Z',
    busy: false,
    metadata: { cwd: '/workspace' },
    agent_config: { model: 'test-model' },
    usage: { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 },
    permission_rules: [],
    message_count: 2,
    last_seq: 1,
    ...overrides,
  } as Session;
}

function makeBranchNode(agentId: string, overrides: Partial<AgentTreeNode> = {}): AgentTreeNode {
  return {
    agentId,
    parentAgentId: 'main',
    name: agentId,
    label: `Branch ${agentId}`,
    isBranch: true,
    branchSeed: 'fresh',
    toolsLocked: false,
    status: 'idle',
    busy: false,
    toolCallCount: 0,
    toolCallCountKnown: true,
    childIds: [],
    ...overrides,
  };
}

let mountedRoot: Root | null = null;
let mountedContainer: HTMLDivElement | null = null;

function mount(ui: React.ReactNode, initialEntry = '/s/s-main', locale: 'zh' | 'en' = 'zh') {
  window.localStorage.setItem('kiki.locale', locale);
  mountedContainer = document.createElement('div');
  document.body.appendChild(mountedContainer);
  mountedRoot = createRoot(mountedContainer);
  let currentPath = initialEntry;
  function PathProbe() {
    const loc = useLocation();
    currentPath = loc.pathname;
    return null;
  }
  act(() => {
    mountedRoot!.render(
      <I18nProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <PathProbe />
          {ui}
        </MemoryRouter>
      </I18nProvider>,
    );
  });
  return {
    container: withPortalQueries(mountedContainer),
    getPath: () => currentPath,
  };
}

afterEach(() => {
  if (mountedRoot !== null) {
    act(() => {
      mountedRoot!.unmount();
    });
    mountedRoot = null;
  }
  if (mountedContainer !== null) {
    mountedContainer.remove();
    mountedContainer = null;
  }
});

describe('buildSessionForkLineage', () => {
  const blocks: readonly Block[] = [
    { kind: 'user', id: 'u-0', userMessageId: 'msg-u0', turnId: '0', text: 'First prompt', createdAt: '2026-11-18T00:00:00Z' },
    { kind: 'assistant', id: 'a-0', messageId: 'msg-a0', turnId: '0', text: 'First reply', streaming: false, createdAt: '2026-11-18T00:00:05Z' },
    { kind: 'user', id: 'u-1', userMessageId: 'msg-u1', turnId: '1', text: 'Second prompt', createdAt: '2026-11-18T00:01:00Z' },
    { kind: 'assistant', id: 'a-1', messageId: 'msg-a1', turnId: '1', text: 'Second reply', streaming: false, createdAt: '2026-11-18T00:01:05Z' },
  ];

  it('resolves origin provenance and anchors forks & branches to exact turn blocks while excluding ephemeral BTW', () => {
    const current = makeSession('s-main', {
      title: 'Main Architecture',
      forked_from: {
        session_id: 's-parent',
        title: 'Cached Parent Title',
        turn_index: 3,
        seed: 'compact',
      },
    });
    const forkAtReply0 = makeSession('s-fork-0', {
      title: 'Fork: Alternative Schema',
      forked_from: {
        session_id: 's-main',
        through_message_id: 'msg-a0',
        turn_index: 0,
        through_user_message: false,
        seed: 'verbatim',
        forked_at: '2026-11-18T00:02:00Z',
      },
    });
    const forkAtUser1 = makeSession('s-fork-1', {
      title: 'Fork: Main Architecture',
      forked_from: {
        session_id: 's-main',
        turn_index: 1,
        through_user_message: true,
        seed: 'fresh',
        forked_at: '2026-11-18T00:03:00Z',
      },
    });
    const realBranch = makeBranchNode('b-explore', {
      label: 'Try SQLite WAL',
      branchBaseTurnId: 1,
      branchBaseMessageId: 'msg-u1',
      status: 'running',
      busy: true,
      createdAt: '2026-11-18T00:04:00Z',
    });
    const ephemeralBtw = makeBranchNode('b-btw', {
      label: 'BTW',
      toolsLocked: true,
      branchBaseTurnId: 1,
      createdAt: '2026-11-18T00:05:00Z',
    });
    const forest: AgentForest = {
      roots: [],
      byId: {
        'b-explore': realBranch,
        'b-btw': ephemeralBtw,
      },
    };

    const lineage = buildSessionForkLineage({
      currentSessionId: 's-main',
      currentSession: current,
      sessions: [current, forkAtReply0, forkAtUser1],
      forest,
      waitingAgentIds: new Set(),
      blocks,
      untitledLabel: '未命名会话',
    });

    expect(lineage.origin).toEqual({
      sessionId: 's-parent',
      title: 'Cached Parent Title',
      turnIndex: 3,
      throughMessageId: undefined,
      seed: 'compact',
    });
    expect(lineage.allOffshoots.map((item) => item.id)).toEqual(['b-explore', 's-fork-1', 's-fork-0']);
    expect(lineage.byBlockId.get('a-0')?.map((item) => item.title)).toEqual(['Alternative Schema']);
    expect(lineage.byBlockId.get('u-1')?.map((item) => item.id)).toEqual(['s-fork-1']);
    expect(lineage.byBlockId.get('a-1')?.map((item) => item.id)).toEqual(['b-explore']);
  });

  it('keeps wire turnId and user turn_index aligned across branchFold turns and deduplicates Fork: titles', () => {
    const current = makeSession('s-main', { title: 'Main Architecture' });
    const blocksWithFold: readonly Block[] = [
      { kind: 'user', id: 'u-0', userMessageId: 'msg-u0', turnId: '0', text: 'First prompt', createdAt: '2026-11-18T00:00:00Z' },
      { kind: 'assistant', id: 'a-0', messageId: 'msg-a0', turnId: '0', text: 'First reply', streaming: false, createdAt: '2026-11-18T00:00:05Z' },
      {
        kind: 'user',
        id: 'u-fold',
        userMessageId: 'msg-fold',
        turnId: '1',
        text: 'Merged branch summary',
        branchFold: { branchId: 'b-merged', branchTitle: 'Merged' },
        createdAt: '2026-11-18T00:01:00Z',
      },
      { kind: 'assistant', id: 'a-fold', messageId: 'msg-afold', turnId: '1', text: 'Noted.', streaming: false, createdAt: '2026-11-18T00:01:05Z' },
      { kind: 'user', id: 'u-2', userMessageId: 'msg-u2', turnId: '2', text: 'Second user prompt', createdAt: '2026-11-18T00:02:00Z' },
      { kind: 'assistant', id: 'a-2', messageId: 'msg-a2', turnId: '2', text: 'Second reply', streaming: false, createdAt: '2026-11-18T00:02:05Z' },
    ];
    const unrenamedFork = makeSession('s-fork-2', {
      title: 'Fork: Main Architecture',
      last_prompt: 'Explore zero-copy transport',
      forked_from: {
        session_id: 's-main',
        turn_index: 1,
        through_user_message: false,
        seed: 'verbatim',
        forked_at: '2026-11-18T00:03:00Z',
      },
    });
    const postFoldBranch = makeBranchNode('b-wire-2', {
      label: 'Wire Turn 2 Branch',
      branchBaseTurnId: 2,
      createdAt: '2026-11-18T00:04:00Z',
    });
    const btwFixtureNode = makeBranchNode('btw-1', {
      label: '名称尚未读取',
      toolsLocked: false,
      createdAt: '2026-11-18T00:05:00Z',
    });
    const lineage = buildSessionForkLineage({
      currentSessionId: 's-main',
      currentSession: current,
      sessions: [current, unrenamedFork],
      forest: {
        roots: [],
        byId: {
          'b-wire-2': postFoldBranch,
          'btw-1': btwFixtureNode,
        },
      },
      waitingAgentIds: new Set(),
      blocks: blocksWithFold,
      untitledLabel: '未命名会话',
    });

    expect(lineage.allOffshoots.map((item) => item.id)).toEqual(['b-wire-2', 's-fork-2']);
    expect(lineage.byBlockId.get('a-0')).toBeUndefined();
    expect(lineage.byBlockId.get('a-fold')).toBeUndefined();
    expect(lineage.byBlockId.get('a-2')?.map((item) => item.id)).toEqual(['b-wire-2', 's-fork-2']);
    expect(lineage.byBlockId.get('a-2')?.find((item) => item.id === 's-fork-2')?.title).toBe('Explore zero-copy transport');
  });
});

describe('ForkProvenanceMark & TimelineOffshootRail', () => {
  it('navigates back to parent session on ForkProvenanceMark click', () => {
    const { container, getPath } = mount(
      <ForkProvenanceMark
        origin={{ sessionId: 's-origin', title: 'Origin Chat', turnIndex: 4 }}
      />,
      '/s/s-child',
    );
    const btn = container.querySelector<HTMLButtonElement>('[data-forked-from="s-origin"]')!;
    expect(btn.textContent).toContain('分叉自 Origin Chat · #5');
    act(() => {
      btn.click();
    });
    expect(getPath()).toBe('/s/s-origin');
  });

  it('collapses offshoots past 2 pills and dispatches fork/branch clicks', () => {
    const onOpenFork = vi.fn();
    const onOpenBranch = vi.fn();
    const { container } = mount(
      <TimelineOffshootRail
        items={[
          { key: 'b1', kind: 'branch', id: 'agent-b1', title: 'Branch One', createdAtMs: 3, branchState: 'running' },
          { key: 'f1', kind: 'fork', id: 'sess-f1', title: 'Fork One', createdAtMs: 2 },
          { key: 'f2', kind: 'fork', id: 'sess-f2', title: 'Fork Two', createdAtMs: 1 },
        ]}
        onOpenFork={onOpenFork}
        onOpenBranch={onOpenBranch}
      />,
    );
    expect(container.querySelectorAll('[data-offshoot-pill]')).toHaveLength(2);
    const more = container.querySelector<HTMLButtonElement>('[data-offshoot-more]')!;
    expect(more.textContent).toBe('+1');
    act(() => {
      more.click();
    });
    expect(container.querySelectorAll('[data-offshoot-pill]')).toHaveLength(3);
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-offshoot-id="agent-b1"]')!.click();
      container.querySelector<HTMLButtonElement>('[data-offshoot-id="sess-f2"]')!.click();
    });
    expect(onOpenBranch).toHaveBeenCalledWith('agent-b1');
    expect(onOpenFork).toHaveBeenCalledWith('sess-f2');
  });
});

describe('ForkLaunchPopover & BtwFloatingCard', () => {
  it('opens anchored popover, selects seed mode, and launches fork / in-place branch / btw without modal', () => {
    const onForkSession = vi.fn();
    const onStartBranch = vi.fn();
    const onStartSideQuestion = vi.fn();
    const { container } = mount(
      <ForkLaunchPopover
        origin={{ sessionId: 's-parent', title: 'Parent', turnIndex: 1 }}
        offshoots={[{ key: 'f1', kind: 'fork', id: 's-child', title: 'Child Fork', createdAtMs: 1 }]}
        canFork
        canBranch
        canSideQuestion
        onOpenSession={() => undefined}
        onOpenBranch={() => undefined}
        onForkSession={onForkSession}
        onStartBranch={onStartBranch}
        onStartSideQuestion={onStartSideQuestion}
      />,
    );

    const trigger = container.querySelector<HTMLButtonElement>('[data-header-fork-trigger]')!;
    expect(container.querySelector('[data-header-fork-count]')?.textContent).toBe('1');
    act(() => {
      trigger.click();
    });
    expect(container.querySelector('[data-header-fork-popover]')).not.toBeNull();

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-fork-popover-seed="compact"]')!.click();
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-fork-popover-action="fork"]')!.click();
    });
    expect(onForkSession).toHaveBeenCalledWith('compact');
  });

  it('streams BTW side question above composer and closes cleanly on Escape', async () => {
    const retainAgentView = vi.fn();
    const releaseAgentView = vi.fn();
    const onClose = vi.fn();
    const onExpand = vi.fn();
    const onSend = vi.fn(async () => undefined);
    const btwState = {
      ...createViewState('s-main'),
      blocks: [
        { kind: 'user', id: 'u1', text: 'What port does it use?', createdAt: '2026-11-18T00:00:00Z' },
        { kind: 'assistant', id: 'a1', text: 'Port `58627`.', streaming: false, createdAt: '2026-11-18T00:00:01Z' },
      ] as readonly Block[],
    };
    const fakeController = {
      retainAgentView,
      releaseAgentView,
      subscribeAgent: () => () => undefined,
      getAgentState: () => btwState,
    } as unknown as SessionController;

    const { container } = mount(
      <BtwFloatingCard
        sessionId="s-main"
        agentId="agent-btw-1"
        controller={fakeController}
        onSendQuestion={onSend}
        onExpandFullView={onExpand}
        onClose={onClose}
      />,
    );

    expect(retainAgentView).toHaveBeenCalledWith(expect.stringContaining('btw-dock:s-main:agent-btw-1'), 'agent-btw-1', 'delta');
    expect(container.textContent).toContain('What port does it use?');
    expect(container.textContent).toContain('58627');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens ForkLaunchPopover programmatically via openRequest', () => {
    const onStartBranch = vi.fn();
    const { container: popContainer } = mount(
      <ForkLaunchPopover
        origin={undefined}
        offshoots={[]}
        canFork
        canBranch
        canSideQuestion
        openRequest={{ seq: 1, focusBranch: true }}
        onOpenSession={() => undefined}
        onOpenBranch={() => undefined}
        onForkSession={() => undefined}
        onStartBranch={onStartBranch}
        onStartSideQuestion={() => undefined}
      />,
    );
    expect(popContainer.querySelector('[data-header-fork-popover]')).not.toBeNull();
    act(() => {
      popContainer.querySelector<HTMLButtonElement>('[data-fork-popover-action="branch"]')!.click();
    });
    expect(onStartBranch).toHaveBeenCalledWith('', 'verbatim', 'route');
  });
});
