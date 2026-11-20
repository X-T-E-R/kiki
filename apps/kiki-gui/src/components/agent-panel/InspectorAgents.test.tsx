// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AgentTranscript, type AgentTranscriptSnapshot, type TranscriptOperation } from '@kiki/transcript';
import { buildAgentForest, sessionAgentForestFromAgentSnapshots, type AgentForest } from '@kiki/session-core/session';

import { I18nProvider } from '../../i18n';
import { configureSubagentScale } from '../../lib/subagentScaleConfig';
import { AgentRoster, RailCrumbs } from './InspectorAgents';

const mounts: { container: HTMLDivElement; root: Root }[] = [];
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const { container, root } of mounts.splice(0)) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
  vi.useRealTimers();
});
afterAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

function replay(agentId: string, ops: readonly TranscriptOperation[]): AgentTranscriptSnapshot {
  const store = new AgentTranscript(agentId);
  store.apply([
    {
      op: 'reset',
      agentId,
      snapshot: { items: [], tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {}, hasMoreOlder: false },
    },
    ...ops,
  ]);
  return store.snapshot();
}

/** A resumed child: its first run ended, the new turn opened, no message or token yet. */
function resumedChildForest(): AgentForest {
  const startedAt = new Date(Date.now() - 5_000).toISOString();
  const main = replay('main', [
    {
      op: 'task.upsert',
      task: { taskId: 'task-child', kind: 'subagent', state: 'running', name: 'composer_v6', agentId: 'child-1', detached: true, startedAt, outputTail: '' },
    },
  ]);
  const child = replay('child-1', [
    { op: 'turn.upsert', turn: { kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, endedAt: startedAt } },
    { op: 'meta.merge', meta: { activity: 'idle', agent: { model: 'claude-opus-5-5', phase: { kind: 'ended', turnId: 1, reason: 'completed', durationMs: 1, at: 0 } } } },
    { op: 'turn.upsert', turn: { kind: 'turn', turnId: 't2', ordinal: 2, state: 'running', origin: { kind: 'other', payload: { kind: 'agent_message', senderAgentId: 'main' } }, startedAt } },
  ]);
  return sessionAgentForestFromAgentSnapshots(new Map([['main', main], ['child-1', child]]));
}

async function renderRoster(forest: AgentForest): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounts.push({ container, root });
  await act(async () => {
    root.render(
      <I18nProvider>
        <AgentRoster forest={forest} waitingAgentIds={new Set()} onSelect={() => {}} />
      </I18nProvider>,
    );
  });
  return container;
}

describe('AgentRoster busy state', () => {
  it('shows a resumed subagent as working before its first message arrives', async () => {
    const forest = resumedChildForest();
    // A detached child keeps its `background` status; busy is what the row reads.
    expect(forest.byId['child-1']).toMatchObject({ status: 'background', busy: true });
    const container = await renderRoster(forest);
    const text = container.textContent ?? '';
    expect(text).toContain('composer_v6');
    expect(text).toContain('Working');
    expect(text).not.toContain('Background');
  });
});


describe('AgentRoster metadata identity and state', () => {
  it('renders failed saving from the live phase above a retained running task without a running timer', async () => {
    const startedAt = '2026-01-01T00:00:00.000Z';
    const main = replay('main', [{ op: 'task.upsert', task: { taskId: 'saved-task', kind: 'subagent', state: 'running',
      agentId: 'saved-child', detached: false, startedAt, outputTail: '' } }]);
    const child = replay('saved-child', [{ op: 'meta.merge', meta: { agent: { phase: { kind: 'interrupted', turnId: 1,
      reason: 'error', message: 'Turn execution ended, but saving failed. Restore writable storage.', at: Date.parse(startedAt) + 60_000 } } } }]);
    const forest = sessionAgentForestFromAgentSnapshots(new Map([['main', main], ['saved-child', child]]), [{
      id: 'saved-child', session_id: 'fixture-session', kind: 'subagent', description: 'Saved worker', label: 'Saved worker',
      status: 'running', activity_status: 'unknown', status_source: 'metadata', live: true,
    }]);
    expect(forest.byId['saved-child']).toMatchObject({ status: 'failed', busy: false });
    const container = await renderRoster(forest);
    const saved = container.querySelector<HTMLElement>('[data-agent-id="saved-child"]');
    expect(saved?.dataset['rosterBucket']).toBe('ended');
    expect(saved?.querySelector<HTMLElement>('[data-agent-status]')?.dataset['agentStatus']).toBe('failed');
    expect(saved?.textContent).toContain('saving failed');
    expect(saved?.textContent).not.toContain('Working');
    expect(saved?.querySelector('.status-dot-busy')).toBeNull();
  });

  it('renders recorded names and distinct completed, idle, lost and unknown states without historical running timers', async () => {
    const at = '2026-01-01T00:00:00.000Z';
    const old = replay('main', [{ op: 'task.upsert', task: { taskId: 'old', kind: 'subagent', state: 'running', agentId: 'named', detached: false, startedAt: at, outputTail: '' } }]);
    const row = { session_id: 'fixture-session', kind: 'subagent' as const, created_at: at, status: 'running' as const, live: false,
      status_source: 'metadata' as const, name_source: 'user_label' as const };
    const forest = sessionAgentForestFromAgentSnapshots(new Map([['main', old]]), [
      { ...row, id: 'named', description: 'Protocol investigation', label: 'Protocol investigation', status: 'completed', activity_status: 'completed', completed_at: '2026-01-01T00:01:00.000Z', model: 'fixture/model' },
      { ...row, id: 'idle', description: 'Idle worker', activity_status: 'idle', status_source: 'runtime', live: true },
      { ...row, id: 'unknown', description: 'unknown', activity_status: 'unknown', name_source: 'unreported' },
      { ...row, id: 'lost', description: 'Lost worker', status: 'failed', activity_status: 'lost' },
    ]);
    const container = await renderRoster(forest);
    const named = container.querySelector('[data-agent-id="named"]');
    expect(named?.textContent).toContain('Protocol investigation');
    expect(named?.querySelector('[data-agent-status]')?.getAttribute('data-agent-status')).toBe('completed');
    expect(named?.getAttribute('data-agent-name-source')).toBe('user_label');
    expect(named?.getAttribute('title')).toContain('Status: session registry');
    expect(container.querySelector('[data-agent-id="idle"]')?.getAttribute('data-roster-bucket')).toBe('idle');
    expect(container.querySelector('[data-roster-unknown-group]')).toBeNull();
    const unknown = container.querySelector('[data-agent-id="unknown"]');
    expect(unknown?.getAttribute('data-roster-bucket')).toBe('unknown');
    expect(unknown?.querySelector('[data-agent-status]')?.textContent).toBe('Status unknown');
    expect(unknown?.querySelector('[data-life]')).toBeNull();
    expect(unknown?.textContent).toContain('Name not registered');
    expect(unknown?.textContent).not.toContain('Idle');
    expect(container.querySelector('[data-agent-id="lost"]')?.textContent).toContain('Lost');
    expect(container.textContent).not.toContain('Working');
  });
});


it('keeps historical duration fixed, omits missing execution timing and only ticks a real running row', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-04T00:00:00.000Z'));
  const at = '2026-01-01T00:00:00.000Z';
  const end = '2026-01-01T00:01:00.000Z';
  const row = { session_id: 'fixture-session', kind: 'subagent' as const, created_at: at,
    description: 'Recorded worker', status_source: 'metadata' as const, name_source: 'profile' as const, live: false };
  const forest = sessionAgentForestFromAgentSnapshots(new Map(), [
    { ...row, id: 'done', status: 'completed', activity_status: 'completed', started_at: at, completed_at: end },
    { ...row, id: 'untimed', status: 'completed', activity_status: 'completed', completed_at: end },
    { ...row, id: 'idle', status: 'running', activity_status: 'idle', started_at: at },
    { ...row, id: 'unknown', status: 'running', activity_status: 'unknown', started_at: at },
    { ...row, id: 'live', status: 'running', activity_status: 'running', started_at: at, status_source: 'runtime', live: true },
  ]);
  const container = await renderRoster(forest);
  const state = (id: string) => container.querySelector(`[data-agent-id="${id}"] [data-agent-status]`);
  const fixed = state('done')?.textContent;
  expect(fixed).toBe('Completed · 1m 0s');
  expect(state('untimed')?.textContent).toBe('Completed');
  expect(state('idle')?.textContent).toBe('Idle');
  expect(state('unknown')?.textContent).toBe('Status unknown');
  expect(state('unknown')?.getAttribute('data-agent-status')).toBe('unknown');
  expect(container.querySelector('[data-roster-unknown-group]')).toBeNull();
  expect(state('live')?.textContent).toBe('72h 0m');
  for (const id of ['done', 'untimed', 'idle', 'unknown']) {
    expect(state(id)?.className).not.toContain('text-success');
    expect(container.querySelector(`[data-agent-id="${id}"] .bg-success`)).toBeNull();
  }
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(state('done')?.textContent).toBe(fixed);
  expect(state('untimed')?.textContent).toBe('Completed');
  expect(state('live')?.textContent).toBe('72h 1m');
});

it('folds a large unknown history, names it unknown, and keeps an active unknown parent', async () => {
  const forest = buildAgentForest([], [
    { agentId: 'main', name: 'Main' },
    { agentId: 'parent', parentAgentId: 'main', name: 'Parent', status: 'unknown' },
    { agentId: 'child', parentAgentId: 'parent', name: 'Child', status: 'running' },
    ...Array.from({ length: 4 }, (_, index) => ({
      agentId: `old-${index}`, parentAgentId: 'main', name: `Old ${index}`, status: 'unknown' as const,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      agentId: `done-${index}`, parentAgentId: 'main', name: `Done ${index}`, status: 'completed' as const,
    })),
  ]);
  const container = await renderRoster(forest);
  expect(container.querySelector('[data-agent-id="parent"]')?.getAttribute('data-roster-bucket')).toBe('unknown');
  expect(container.querySelector('[data-agent-id="old-0"]')).toBeNull();
  expect(container.querySelector('[data-agent-id="done-0"]')).toBeNull();
  const unknown = container.querySelector<HTMLButtonElement>('[data-roster-unknown-group]');
  const done = container.querySelector<HTMLButtonElement>('[data-roster-done-group]');
  expect(unknown?.textContent).toContain('4 status unknown');
  expect(unknown?.textContent).not.toContain('Idle');
  expect(unknown?.textContent).not.toContain('finished');
  expect(unknown?.querySelector('[data-life]')).toBeNull();
  expect(unknown?.getAttribute('aria-expanded')).toBe('false');
  expect(done?.textContent).toContain('finished');
  expect(done?.getAttribute('aria-expanded')).toBe('false');

  await act(async () => { unknown?.click(); });
  const old = container.querySelector('[data-agent-id="old-0"]');
  expect(old?.getAttribute('data-roster-bucket')).toBe('unknown');
  expect(old?.querySelector('[data-agent-status]')?.textContent).toBe('Status unknown');
  expect(old?.textContent).not.toContain('Idle');
  expect(old?.querySelector('[data-life]')).toBeNull();
  expect(container.querySelector('[data-roster-done-group]')?.getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('[data-agent-id="done-0"]')).toBeNull();

  await act(async () => { container.querySelector<HTMLButtonElement>('[data-roster-toggle="parent"]')?.click(); });
  expect(container.querySelector('[data-agent-id="child"]')?.getAttribute('data-roster-bucket')).toBe('running');

  await act(async () => { container.querySelector<HTMLButtonElement>('[data-roster-done-group]')?.click(); });
  expect(container.querySelector('[data-agent-id="done-0"]')).not.toBeNull();
  expect(container.querySelector('[data-agent-id="old-0"]')).not.toBeNull();
  expect(container.querySelector('[data-roster-unknown-group]')?.getAttribute('aria-expanded')).toBe('true');

  await act(async () => { container.querySelector<HTMLButtonElement>('[data-roster-filter="unknown"]')?.click(); });
  expect(container.querySelector('[data-roster-unknown-group]')).toBeNull();
  expect(container.querySelector('[data-agent-id="old-0"]')?.getAttribute('data-roster-bucket')).toBe('unknown');
  expect(container.querySelector('[data-agent-id="parent"]')?.getAttribute('data-roster-bucket')).toBe('unknown');
  expect(container.querySelector('[data-agent-id="child"]')).toBeNull();
  expect(container.querySelector('[data-agent-id="done-0"]')).toBeNull();
});

it('renders a live worker through cold parent recovery and stale idle metadata, then returns to real idle and completion', async () => {
  const startedAt = '2026-01-01T00:00:01.000Z';
  const activeAt = '2026-01-01T00:00:03.000Z';
  const endedAt = '2026-01-01T00:00:05.000Z';
  const main = replay('main', [{ op: 'task.upsert', task: { taskId: 'current-dispatch', kind: 'subagent',
    state: 'running', agentId: 'live-child', name: 'Protocol worker', detached: false, startedAt, outputTail: '' } }]);
  const child = replay('live-child', [
    { op: 'turn.upsert', turn: { kind: 'turn', turnId: 't2', ordinal: 2, state: 'running', origin: { kind: 'user' }, startedAt: activeAt } },
    { op: 'meta.merge', meta: { activity: 'turn', agent: { phase: { kind: 'running', turnId: 2, step: 1, stepId: 't2.1', since: Date.parse(activeAt) } } } },
  ]);
  const snapshots = new Map([['main', main], ['live-child', child]]);
  const row = { id: 'live-child', session_id: 'fixture-session', kind: 'subagent' as const,
    description: 'Protocol worker', label: 'Protocol worker', status: 'running' as const,
    activity_status: 'idle' as const, status_source: 'runtime' as const, live: true, started_at: startedAt };
  for (const rows of [[], [row]]) {
    const forest = sessionAgentForestFromAgentSnapshots(snapshots, rows, new Set(['main']));
    const container = await renderRoster(forest);
    const worker = container.querySelector('[data-agent-id="live-child"]');
    expect(worker?.getAttribute('data-roster-bucket')).toBe('running');
    expect(worker?.querySelector('[data-agent-status]')?.getAttribute('data-agent-status')).toBe('running');
    expect(worker?.textContent).not.toContain('Idle');
    expect(worker?.querySelector('.bg-success')).not.toBeNull();
  }
  const idleChild = replay('live-child', [{ op: 'meta.merge', meta: { activity: 'idle', agent: { phase: { kind: 'idle' } } } }]);
  snapshots.set('live-child', idleChild);
  const idle = await renderRoster(sessionAgentForestFromAgentSnapshots(snapshots, [row], new Set(['main'])));
  expect(idle.querySelector('[data-agent-id="live-child"]')?.getAttribute('data-roster-bucket')).toBe('idle');
  expect(idle.querySelector('[data-agent-status]')?.textContent).toBe('Idle');
  expect(idle.querySelector('.bg-success')).toBeNull();
  snapshots.set('main', replay('main', [{ op: 'task.upsert', task: { ...main.tasks[0]!, state: 'completed', endedAt } }]));
  const complete = await renderRoster(sessionAgentForestFromAgentSnapshots(snapshots, [{ ...row,
    status: 'completed', activity_status: 'completed', completed_at: endedAt }]));
  expect(complete.querySelector('[data-agent-status]')?.getAttribute('data-agent-status')).toBe('completed');
  expect(complete.querySelector('[data-agent-id="live-child"]')?.getAttribute('data-roster-bucket')).toBe('ended');
  expect(complete.querySelector('.bg-success')).toBeNull();
});

function buildLargeSubagentForest(count: number): AgentForest {
  const byId: Record<string, AgentForest['byId'][string]> = {};
  const childIds: string[] = [];
  const baseMs = Date.parse('2026-11-20T00:00:00.000Z');
  for (let i = 0; i < count; i += 1) {
    const id = `subagent_${String(i).padStart(5, '0')}`;
    childIds.push(id);
    const isRunning = i === 0 || i === 1;
    const isWaiting = i === 2;
    byId[id] = {
      agentId: id,
      parentAgentId: 'main',
      name: id,
      label: `Worker ${String(i).padStart(5, '0')}`,
      status: isRunning ? 'running' : isWaiting ? 'suspended' : 'completed',
      busy: isRunning,
      toolCallCount: 1,
      childIds: [],
      startedAt: new Date(baseMs + i * 1000).toISOString(),
      endedAt: isRunning || isWaiting ? undefined : new Date(baseMs + i * 1000 + 500).toISOString(),
    };
  }
  byId['main'] = {
    agentId: 'main',
    name: 'main',
    label: 'Main',
    status: 'running',
    busy: true,
    toolCallCount: 0,
    childIds,
  };
  return { byId, roots: [byId['main']!] };
}

describe('10,000-subagent bounded roster & server search', () => {
  afterEach(() => {
    configureSubagentScale(null);
  });

  it('bounds mounted DOM rows to <= 60 on 10,000 subagents even when the ended group opens, and filters by exact id', async () => {
    const forest = buildLargeSubagentForest(10_000);
    const opened: string[] = [];
    const startMs = performance.now();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounts.push({ container, root });
    await act(async () => {
      root.render(
        <I18nProvider>
          <AgentRoster
            forest={forest}
            waitingAgentIds={new Set(['subagent_00002'])}
            onSelect={(id) => { opened.push(id); }}
          />
        </I18nProvider>,
      );
    });
    const renderMs = performance.now() - startMs;
    expect(renderMs).toBeLessThan(2_000);

    // Collapsed initial render shows only active/waiting + the single ended group row.
    expect(container.querySelectorAll('[data-agent-id]').length).toBeLessThanOrEqual(10);
    const doneGroup = container.querySelector<HTMLButtonElement>('[data-roster-done-group]');
    expect(doneGroup?.textContent).toContain('9997');

    // Expanding the 9,997-item ended group stays bounded via settledRosterWindow + virtualizer.
    await act(async () => { doneGroup?.click(); });
    const mountedAfterExpand = container.querySelectorAll('[data-agent-id]').length;
    expect(mountedAfterExpand).toBeGreaterThan(0);
    expect(mountedAfterExpand).toBeLessThanOrEqual(60);
    expect(container.querySelector('[data-roster-window-hint]')?.textContent).toContain('Showing latest 64');

    // Searching finds subagent_09999 and clicking opens it.
    const input = container.querySelector<HTMLInputElement>('[data-roster-search]')!;
    expect(input).not.toBeNull();
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(input, 'subagent_09999');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const targetRow = container.querySelector<HTMLButtonElement>('[data-agent-id="subagent_09999"]');
    expect(targetRow).not.toBeNull();
    await act(async () => { targetRow?.click(); });
    expect(opened).toEqual(['subagent_09999']);
  });

  it('shows search and exact totals from agentCounts on sparse hydration and merges debounced remote searchSubagents hits', async () => {
    configureSubagentScale({ searchDebounceMs: 10, searchResultLimit: 32 });
    const sparseForest = buildLargeSubagentForest(3);
    const remoteSearch = vi.fn(async (query: string, _options?: { readonly limit?: number; readonly signal?: AbortSignal }) => [
      {
        agentId: 'subagent_09999',
        parentAgentId: 'main',
        name: 'subagent_09999',
        label: `Worker 09999 (${query})`,
        status: 'completed' as const,
        busy: false,
        toolCallCount: 4,
        childIds: [],
        endedAt: '2026-11-20T03:00:00.000Z',
      },
    ]);
    const opened: string[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounts.push({ container, root });
    await act(async () => {
      root.render(
        <I18nProvider>
          <AgentRoster
            forest={sparseForest}
            waitingAgentIds={new Set(['subagent_00002'])}
            agentCounts={{
              total: 10_001,
              subagents: 10_000,
              completed: 9_997,
              failed: 0,
              cancelled: 0,
              active: 3,
              unknown: 0,
            }}
            onSearchSubagents={remoteSearch}
            onSelect={(id) => { opened.push(id); }}
          />
        </I18nProvider>,
      );
    });

    // Search input stays visible even with only 3 hydrated nodes because agentCounts.subagents === 10,000.
    const input = container.querySelector<HTMLInputElement>('[data-roster-search]');
    expect(input).not.toBeNull();
    expect(container.querySelector('[data-roster-done-group]')?.textContent).toContain('9997');

    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(input!, 'subagent_09999');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => { window.setTimeout(resolve, 40); });
    });

    expect(remoteSearch).toHaveBeenCalledTimes(1);
    expect(remoteSearch.mock.calls[0]?.[0]).toBe('subagent_09999');
    expect(remoteSearch.mock.calls[0]?.[1]?.limit).toBe(32);
    const remoteButton = container.querySelector<HTMLButtonElement>('[data-agent-id="subagent_09999"]');
    expect(remoteButton).not.toBeNull();
    await act(async () => { remoteButton?.click(); });
    expect(opened).toEqual(['subagent_09999']);
  });

  it('preserves fallbackLabel in RailCrumbs when a historical agent is outside the hydrated forest window', async () => {
    const sparseForest = buildLargeSubagentForest(2);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounts.push({ container, root });
    await act(async () => {
      root.render(
        <I18nProvider>
          <RailCrumbs
            forest={sparseForest}
            focusedAgentId="agent-12"
            fallbackLabel="Historic Auditor"
            onSelect={() => {}}
            close={null}
          />
        </I18nProvider>,
      );
    });
    const heading = container.querySelector('[data-rail-owner-heading]');
    expect(heading?.textContent).toContain('Historic Auditor');
    expect(heading?.textContent).not.toContain('agent-12');
    expect(container.querySelector('[data-inspect-main]')?.textContent).toBe('Main agent');
  });
});
