// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AgentTranscript, type AgentTranscriptSnapshot, type TranscriptOperation } from '@kiki/transcript';
import { sessionAgentForestFromAgentSnapshots, type AgentForest } from '@kiki/session-core/session';

import { I18nProvider } from '../../i18n';
import { AgentRoster } from './InspectorAgents';

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
    expect(container.querySelector('[data-agent-id="unknown"]')?.getAttribute('data-roster-bucket')).toBe('unknown');
    expect(container.querySelector('[data-agent-id="unknown"]')?.textContent).toContain('Name not registered');
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
