import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Session } from '@moonshot-ai/protocol';

import { I18nProvider } from '../i18n';
import { buildAgentForest } from '../state/agentTree';
import { createViewState, type SubagentBlock } from '../state/transcript';
import { AgentBreadcrumb } from './AgentBreadcrumb';
import { AgentTreeView } from './AgentTreeView';
import { Transcript } from './Transcript';
import { ContextMeter } from './ContextMeter';
import { PendingBadge } from './PendingBadge';
import { QueueStrip } from './QueueStrip';
import {
  NOT_FOUND_FALLBACK_MS,
  agentDetailPath,
  agentOlderErrorText,
  agentTranscriptPoll,
  beginAgentOlderFetch,
  finishAgentOlderFetch,
  INITIAL_AGENT_OLDER_FETCH_GATE,
  isApprovalShortcutAmbiguous,
  resetAgentOlderFetchGate,
  settleAgentOlderFetch,
  isTerminalEscapeTarget,
  resolveAllApprovals,
  resolveApprovalShortcutTarget,
  resolveControlledFlag,
  resolveControlledValue,
  SessionRouteView,
  shouldClearModeOverride,
  shouldCloseSessionChromeOnEscape,
  shouldHandleApprovalShortcut,
  TerminalToggle,
} from './SessionView';

vi.mock('./TerminalPanel', () => ({ TerminalPanel: () => null }));

function renderTerminalToggle(available: boolean): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <TerminalToggle available={available} open={false} onToggle={() => {}} />
    </I18nProvider>,
  );
}

describe('SessionView terminal capability', () => {
  it('omits the terminal toggle when the server omits terminal capability', () => {
    expect(renderTerminalToggle(false)).not.toContain('data-terminal-toggle');
  });

  it('renders the terminal toggle when the server advertises terminal capability', () => {
    expect(renderTerminalToggle(true)).toContain('data-terminal-toggle');
  });
});

describe('QueueStrip', () => {
  const noop = () => {};
  // Copy assertions are English: pin the locale source (Node's built-in
  // navigator reports the OS language) for this describe only.
  beforeAll(() => {
    vi.stubGlobal('navigator', { language: 'en-US' });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('renders one row per queued prompt with drain-order numbers and actions', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <QueueStrip
          items={[
            { promptId: 'p1', text: 'first parked prompt' },
            { promptId: 'p2', text: 'second parked prompt' },
          ]}
          onSendNow={noop}
          onRemove={noop}
          onClearAll={noop}
        />
      </I18nProvider>,
    );
    expect(html).toContain('data-queue-strip');
    expect(html).toContain('2 prompts queued');
    expect(html).toContain('#1');
    expect(html).toContain('#2');
    expect(html).toContain('first parked prompt');
    expect(html).toContain('second parked prompt');
    expect(html).toContain('Send now');
    expect(html).toContain('Remove');
    expect(html).toContain('Clear all');
  });

  it('disables Send now while the session is resyncing', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <QueueStrip
          items={[{ promptId: 'p1', text: 'parked' }]}
          onSendNow={noop}
          onRemove={noop}
          onClearAll={noop}
          sendNowDisabled
        />
      </I18nProvider>,
    );
    expect(html).toContain('aria-label="Send now"');
    expect(html).toMatch(/disabled="" title="Sending is paused until the session is in sync."/);
    expect(html).toContain('Sending is paused until the session is in sync.');
    expect(html).toContain('aria-label="Remove"');
    expect(html).not.toMatch(/disabled="" title="Take this prompt out of the queue"/);
  });

  it('renders nothing for an empty queue', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <QueueStrip items={[]} onSendNow={noop} onRemove={noop} onClearAll={noop} />
      </I18nProvider>,
    );
    expect(html).toBe('');
  });
});

describe('SessionView route ownership', () => {
  it('changes the child owner key synchronously on session A to B navigation', () => {
    const props = { onToggleSidebar: () => {}, sessions: [] };
    const sessionA = SessionRouteView({ ...props, sessionId: 'session-a' });
    const sessionB = SessionRouteView({ ...props, sessionId: 'session-b' });

    expect(sessionA.key).toBe('session-a');
    expect(sessionB.key).toBe('session-b');
    expect(sessionB.key).not.toBe(sessionA.key);
  });
});

describe('store-controlled mode pills', () => {
  it('prefers the local optimistic echo, then the store value, then the default', () => {
    expect(resolveControlledValue('yolo', 'manual', 'auto')).toBe('yolo');
    expect(resolveControlledValue(undefined, 'yolo', 'auto')).toBe('yolo');
    expect(resolveControlledValue(undefined, undefined, 'auto')).toBe('auto');
  });

  it('keeps the configured default until the snapshot lands for flag pills', () => {
    // Before load the store holds zero-value defaults — the client default wins.
    expect(resolveControlledFlag(undefined, false, false, true)).toBe(true);
    // After load the server-reported value is authoritative.
    expect(resolveControlledFlag(undefined, false, true, true)).toBe(false);
    // A local click always wins over both.
    expect(resolveControlledFlag(true, false, true, false)).toBe(true);
  });

  it('retires the optimistic echo only when the store reports the same value', () => {
    expect(shouldClearModeOverride('auto', 'auto')).toBe(true);
    expect(shouldClearModeOverride('auto', 'manual')).toBe(false);
    expect(shouldClearModeOverride('auto', undefined)).toBe(false);
    expect(shouldClearModeOverride(undefined, 'auto')).toBe(false);
  });
});

describe('resolveApprovalShortcutTarget', () => {
  const card = (
    id: string,
    flags: Partial<{ pending: boolean; visible: boolean; focused: boolean }> = {},
  ) => ({
    id,
    pending: flags.pending ?? true,
    visible: flags.visible ?? true,
    focused: flags.focused ?? false,
  });

  it('uses the focused pending card even when others are visible', () => {
    expect(
      resolveApprovalShortcutTarget([
        card('a1', { visible: true }),
        card('a2', { visible: true, focused: true }),
      ]),
    ).toBe('a2');
  });

  it('uses the only visible pending card when nothing is focused', () => {
    expect(
      resolveApprovalShortcutTarget([
        card('a1', { visible: false }),
        card('a2', { visible: true }),
      ]),
    ).toBe('a2');
  });

  it('returns undefined when several pending cards are visible and none is focused', () => {
    expect(
      resolveApprovalShortcutTarget([
        card('a1', { visible: true }),
        card('a2', { visible: true }),
      ]),
    ).toBeUndefined();
  });

  it('does not hit a focused resolved card', () => {
    expect(
      resolveApprovalShortcutTarget([
        card('a1', { pending: false, focused: true, visible: true }),
        card('a2', { visible: true }),
      ]),
    ).toBeUndefined();
  });
});

describe('isApprovalShortcutAmbiguous', () => {
  const card = (
    id: string,
    flags: Partial<{ pending: boolean; visible: boolean; focused: boolean }> = {},
  ) => ({
    id,
    pending: flags.pending ?? true,
    visible: flags.visible ?? true,
    focused: flags.focused ?? false,
  });

  it('flags several visible pending cards with nothing focused', () => {
    expect(
      isApprovalShortcutAmbiguous([
        card('a1', { visible: true }),
        card('a2', { visible: true }),
      ]),
    ).toBe(true);
  });

  it('is not ambiguous once a pending card has focus', () => {
    expect(
      isApprovalShortcutAmbiguous([
        card('a1', { visible: true }),
        card('a2', { visible: true, focused: true }),
      ]),
    ).toBe(false);
  });

  it('is not ambiguous for a single visible card or off-screen extras', () => {
    expect(isApprovalShortcutAmbiguous([card('a1')])).toBe(false);
    expect(
      isApprovalShortcutAmbiguous([
        card('a1', { visible: true }),
        card('a2', { visible: false }),
      ]),
    ).toBe(false);
    expect(isApprovalShortcutAmbiguous([])).toBe(false);
  });
});

describe('shouldHandleApprovalShortcut', () => {
  it('gates y/n while an overlay is open', () => {
    expect(shouldHandleApprovalShortcut({ key: 'y', overlayOpen: true, inEditable: false })).toBe(false);
    expect(shouldHandleApprovalShortcut({ key: 'n', overlayOpen: true, inEditable: false })).toBe(false);
  });

  it('allows y/n only when no overlay owns the keyboard', () => {
    expect(shouldHandleApprovalShortcut({ key: 'y', overlayOpen: false, inEditable: false })).toBe(true);
    expect(shouldHandleApprovalShortcut({ key: 'n', overlayOpen: false, inEditable: false })).toBe(true);
    expect(shouldHandleApprovalShortcut({ key: 'y', overlayOpen: false, inEditable: true })).toBe(false);
    expect(shouldHandleApprovalShortcut({ key: 'Escape', overlayOpen: false, inEditable: false })).toBe(false);
  });
});

describe('isTerminalEscapeTarget', () => {
  it('ignores missing or non-element targets', () => {
    expect(isTerminalEscapeTarget(null)).toBe(false);
  });
});

describe('shouldCloseSessionChromeOnEscape', () => {
  it('closes rail/terminal only when no overlay or PTY owns Escape', () => {
    expect(shouldCloseSessionChromeOnEscape({
      key: 'Escape',
      defaultPrevented: false,
      overlayOpen: false,
      terminalFocused: false,
    })).toBe(true);
    expect(shouldCloseSessionChromeOnEscape({
      key: 'Escape',
      defaultPrevented: true,
      overlayOpen: false,
      terminalFocused: false,
    })).toBe(false);
    expect(shouldCloseSessionChromeOnEscape({
      key: 'Escape',
      defaultPrevented: false,
      overlayOpen: true,
      terminalFocused: false,
    })).toBe(false);
    expect(shouldCloseSessionChromeOnEscape({
      key: 'Escape',
      defaultPrevented: false,
      overlayOpen: false,
      terminalFocused: true,
    })).toBe(false);
    expect(shouldCloseSessionChromeOnEscape({
      key: 'y',
      defaultPrevented: false,
      overlayOpen: false,
      terminalFocused: false,
    })).toBe(false);
  });
});

describe('agent transcript poll', () => {
  it('uses a light main roster page and a full selected-agent page', () => {
    expect(agentTranscriptPoll({ selectedAgentId: undefined })).toEqual({
      pageSize: 1,
      refetchInterval: 5000,
    });
    expect(agentTranscriptPoll({ selectedAgentId: 'agent-1' })).toEqual({
      pageSize: 100,
      refetchInterval: 1500,
    });
  });
});

describe('agent older fetch', () => {
  it('records a real error and refuses to re-enter while in flight', () => {
    expect(agentOlderErrorText(new Error('history down'))).toBe('history down');
    const started = beginAgentOlderFetch({
      selectedAgentId: 'agent-1',
      sessionId: 'sess-1',
      oldestTurnId: 'turn-1',
      hasMore: true,
      gate: INITIAL_AGENT_OLDER_FETCH_GATE,
    });
    expect(started?.request).toEqual({
      generation: 0,
      sessionId: 'sess-1',
      agentId: 'agent-1',
    });
    expect(started?.gate).toEqual({ generation: 0, inFlight: true });
    expect(
      beginAgentOlderFetch({
        selectedAgentId: 'agent-1',
        sessionId: 'sess-1',
        oldestTurnId: 'turn-1',
        hasMore: true,
        gate: started!.gate,
      }),
    ).toBeUndefined();
    expect(
      beginAgentOlderFetch({
        selectedAgentId: undefined,
        sessionId: 'sess-1',
        oldestTurnId: 'turn-1',
        hasMore: true,
        gate: INITIAL_AGENT_OLDER_FETCH_GATE,
      }),
    ).toBeUndefined();
  });

  it('lets B fetch immediately and drops a stale A settle after a switch', async () => {
    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
      });
      return { promise, resolve, reject };
    };

    let gate = INITIAL_AGENT_OLDER_FETCH_GATE;
    let current = { sessionId: 'sess-1', selectedAgentId: 'agent-1' as string | undefined };
    const writes: string[] = [];

    const startA = beginAgentOlderFetch({
      selectedAgentId: 'agent-1',
      sessionId: 'sess-1',
      oldestTurnId: 'turn-a',
      hasMore: true,
      gate,
    });
    expect(startA).toBeDefined();
    gate = startA!.gate;
    const heldA = deferred<string>();
    const settleA = settleAgentOlderFetch({
      getGate: () => gate,
      setGate: (next) => { gate = next; },
      request: startA!.request,
      current: () => current,
      work: () => heldA.promise,
      onSuccess: (value) => { writes.push(`A:${value}`); },
      onError: (error) => { writes.push(`A-error:${agentOlderErrorText(error)}`); },
    });

    current = { sessionId: 'sess-1', selectedAgentId: 'agent-2' };
    gate = resetAgentOlderFetchGate(gate);
    expect(gate).toEqual({ generation: 1, inFlight: false });

    const startB = beginAgentOlderFetch({
      selectedAgentId: 'agent-2',
      sessionId: 'sess-1',
      oldestTurnId: 'turn-b',
      hasMore: true,
      gate,
    });
    expect(startB).toBeDefined();
    gate = startB!.gate;
    const heldB = deferred<string>();
    const settleB = settleAgentOlderFetch({
      getGate: () => gate,
      setGate: (next) => { gate = next; },
      request: startB!.request,
      current: () => current,
      work: () => heldB.promise,
      onSuccess: (value) => { writes.push(`B:${value}`); },
      onError: (error) => { writes.push(`B-error:${agentOlderErrorText(error)}`); },
    });

    heldA.resolve('older-a');
    await expect(settleA).resolves.toEqual({ committed: false });
    expect(writes).toEqual([]);
    expect(gate).toEqual({ generation: 1, inFlight: true });

    heldB.resolve('older-b');
    await expect(settleB).resolves.toEqual({ committed: true, value: 'older-b' });
    expect(writes).toEqual(['B:older-b']);
    expect(gate).toEqual({ generation: 1, inFlight: false });
  });

  it('drops a stale A failure without clearing B in flight', async () => {
    const deferred = <T,>() => {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
      });
      return { promise, resolve, reject };
    };

    let gate = INITIAL_AGENT_OLDER_FETCH_GATE;
    let current = { sessionId: 'sess-1', selectedAgentId: 'agent-1' as string | undefined };
    const writes: string[] = [];
    const startA = beginAgentOlderFetch({
      selectedAgentId: 'agent-1',
      sessionId: 'sess-1',
      oldestTurnId: 'turn-a',
      hasMore: true,
      gate,
    })!;
    gate = startA.gate;
    const heldA = deferred<string>();
    const settleA = settleAgentOlderFetch({
      getGate: () => gate,
      setGate: (next) => { gate = next; },
      request: startA.request,
      current: () => current,
      work: () => heldA.promise,
      onSuccess: (value) => { writes.push(`A:${value}`); },
      onError: (error) => { writes.push(`A-error:${agentOlderErrorText(error)}`); },
    });

    current = { sessionId: 'sess-1', selectedAgentId: 'agent-2' };
    gate = resetAgentOlderFetchGate(gate);
    const startB = beginAgentOlderFetch({
      selectedAgentId: 'agent-2',
      sessionId: 'sess-1',
      oldestTurnId: 'turn-b',
      hasMore: true,
      gate,
    })!;
    gate = startB.gate;
    const heldB = deferred<string>();
    const settleB = settleAgentOlderFetch({
      getGate: () => gate,
      setGate: (next) => { gate = next; },
      request: startB.request,
      current: () => current,
      work: () => heldB.promise,
      onSuccess: (value) => { writes.push(`B:${value}`); },
      onError: (error) => { writes.push(`B-error:${agentOlderErrorText(error)}`); },
    });

    heldA.reject(new Error('history down'));
    await expect(settleA).resolves.toEqual({ committed: false });
    expect(writes).toEqual([]);
    expect(finishAgentOlderFetch(gate, startA.request)).toEqual(gate);
    expect(gate).toEqual({ generation: 1, inFlight: true });

    heldB.resolve('older-b');
    await expect(settleB).resolves.toEqual({ committed: true, value: 'older-b' });
    expect(writes).toEqual(['B:older-b']);
  });
});

describe('resolveAllApprovals', () => {
  it('resolves every pending id and reports failures without rejecting', async () => {
    const calls: Array<[string, string]> = [];
    const controller = {
      resolveApproval: (id: string, decision: 'approved' | 'rejected') => {
        calls.push([id, decision]);
        return id === 'a2' ? Promise.reject(new Error('expired')) : Promise.resolve();
      },
    };
    const result = await resolveAllApprovals(controller, ['a1', 'a2', 'a3'], 'approved');
    expect(calls).toEqual([
      ['a1', 'approved'],
      ['a2', 'approved'],
      ['a3', 'approved'],
    ]);
    expect(result).toEqual({ total: 3, failed: 1 });
  });

  it('reports zero failures when every decision lands', async () => {
    const controller = { resolveApproval: () => Promise.resolve() };
    await expect(resolveAllApprovals(controller, ['a1'], 'rejected')).resolves.toEqual({
      total: 1,
      failed: 0,
    });
  });
});

describe('ContextMeter', () => {
  const noop = () => {};
  beforeAll(() => {
    vi.stubGlobal('navigator', { language: 'en-US' });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  function renderMeter(used: number, limit: number): string {
    return renderToStaticMarkup(
      <I18nProvider>
        <ContextMeter used={used} limit={limit} onCompact={noop} />
      </I18nProvider>,
    );
  }

  it('shows the rounded percentage without a compact hint below 80%', () => {
    const html = renderMeter(50_000, 100_000);
    expect(html).toContain('50%');
    expect(html).not.toContain('compact?');
    expect(html).not.toContain('amber-card');
  });

  it('turns amber and suggests compaction at exactly 80%', () => {
    const html = renderMeter(80_000, 100_000);
    expect(html).toContain('80%');
    expect(html).toContain('compact?');
    expect(html).toContain('amber-card');
  });

  it('clamps the display at 100% when usage overruns the limit', () => {
    const html = renderMeter(120_000, 100_000);
    expect(html).toContain('100%');
    expect(html).toContain('compact?');
  });
});

describe('session-not-found fallback', () => {
  it('waits three seconds before falling back home', () => {
    expect(NOT_FOUND_FALLBACK_MS).toBe(3000);
  });
});

describe('PendingBadge', () => {
  function sessionFixture(id: string, pending: Session['pending_interaction']): Session {
    return {
      id,
      workspace_id: 'wd_test',
      title: `Session ${id}`,
      created_at: '2026-08-12T00:00:00.000Z',
      updated_at: '2026-08-12T00:00:00.000Z',
      busy: false,
      pending_interaction: pending,
      archived: false,
      metadata: { cwd: 'C:/fixture' },
      agent_config: { model: '' },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_cost_usd: 0,
        context_tokens: 0,
        context_limit: 0,
        turn_count: 0,
      },
      permission_rules: [],
      message_count: 0,
      last_seq: 0,
    };
  }

  function renderBadge(sessions: readonly Session[]): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <I18nProvider>
          <PendingBadge sessions={sessions} />
        </I18nProvider>
      </MemoryRouter>,
    );
  }

  beforeAll(() => {
    vi.stubGlobal('navigator', { language: 'en-US' });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('renders nothing when no session waits on the user', () => {
    expect(renderBadge([sessionFixture('s1', 'none')])).toBe('');
    expect(renderBadge([])).toBe('');
  });

  it('counts every session with a pending approval or question', () => {
    const html = renderBadge([
      sessionFixture('s1', 'approval'),
      sessionFixture('s2', 'question'),
      sessionFixture('s3', 'none'),
    ]);
    expect(html).toContain('data-pending-badge');
    expect(html).toContain('2 sessions waiting on you');
  });
});

describe('agent tree chrome', () => {
  beforeAll(() => {
    vi.stubGlobal('navigator', { language: 'en-US' });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const forest = buildAgentForest(
    [],
    [
      { agentId: 'main', name: 'Main' },
      { agentId: 'agent-1', parentAgentId: 'main', name: 'Child', status: 'running', toolCallCount: 2 },
      { agentId: 'agent-2', parentAgentId: 'agent-1', name: 'Grandchild', status: 'completed', toolCallCount: 1 },
    ],
  );

  it('renders a Session > Parent > Current breadcrumb without a second Session crumb', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <AgentBreadcrumb
          crumbs={[forest.byId['main']!, forest.byId['agent-1']!, forest.byId['agent-2']!]}
          onOpenSession={() => {}}
          onOpenAgent={() => {}}
        />
      </I18nProvider>,
    );
    expect(html).toContain('data-agent-breadcrumb');
    expect(html.match(/>Session</g)).toHaveLength(1);
    expect(html).toContain('Child');
    expect(html).toContain('Grandchild');
    expect(html).not.toContain('>Main<');
  });

  it('opens a grandchild from a parent detail route via the session-absolute path', () => {
    expect(agentDetailPath('sess-1', 'agent-2')).toBe('/s/sess-1/agent/agent-2');
    const opened: string[] = [];
    const grandchild: SubagentBlock = {
      kind: 'subagent',
      id: 'subagent-agent-2',
      subagentId: 'agent-2',
      parentAgentId: 'agent-1',
      parentToolCallId: 'call-2',
      name: 'Grandchild',
      description: undefined,
      model: undefined,
      thinkingEffort: undefined,
      status: 'completed',
      summary: undefined,
      error: undefined,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      toolCallCount: 0,
      transcript: [],
    };
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/s/sess-1/agent/agent-1']}>
        <I18nProvider>
          <Transcript
            state={{ ...createViewState('sess-1'), loaded: true, blocks: [grandchild] }}
            onLoadOlder={async () => false}
            onResolveApproval={async () => {}}
            onAnswerQuestion={async () => {}}
            onDismissQuestion={async () => {}}
            forest={forest}
            onOpenAgent={(agentId) => { opened.push(agentDetailPath('sess-1', agentId)); }}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('data-agent-open="agent-2"');
    expect(html).toContain('type="button"');
    expect(html).not.toContain('href="/s/sess-1/agent/agent-1/agent/agent-2"');
    expect(html).not.toContain('href="agent/agent-2"');
    expect(opened).toEqual([]);
  });

  it('renders a nested tree with depth and does not flatten grandchildren', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <AgentTreeView forest={forest} selectedAgentId="agent-1" onOpen={() => {}} />
      </I18nProvider>,
    );
    expect(html).toContain('data-agent-tree');
    expect(html).toContain('data-agent-id="agent-1"');
    expect(html).toContain('data-agent-depth="1"');
    expect(html).toContain('Child');
    expect(html).toContain('Grandchild');
    expect(html).toContain('2 tools');
  });
});
