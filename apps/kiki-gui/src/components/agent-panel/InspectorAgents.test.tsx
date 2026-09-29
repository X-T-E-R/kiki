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
