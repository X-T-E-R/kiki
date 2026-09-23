// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Task } from '@kiki/protocol';
import { buildAgentForest, createViewState } from '@kiki/session-core/session';
import { I18nProvider } from '../i18n';
import { RightRail, type SubagentRailContext } from './RightRail';

vi.mock('./AgentPanelContainer', () => ({
  AgentPanelContainer: () => <div data-panel-props />,
}));

const forest = buildAgentForest([], [
  { agentId: 'main', name: 'Main' },
  { agentId: 'agent-1', parentAgentId: 'main', name: 'Researcher', status: 'running' },
]);
const context: SubagentRailContext = {
  agentId: 'agent-1',
  block: undefined,
  pendingInteractionCount: 1,
  onJumpToSpawn: () => {},
};
const tasks: Task[] = [
  {
    id: 'background-1', session_id: 'sess-1', kind: 'bash', description: 'Dev server',
    status: 'running', created_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'subagent-1', session_id: 'sess-1', kind: 'subagent', agent_id: 'agent-1',
    description: 'Researcher', status: 'running', created_at: '2026-01-01T00:01:00.000Z',
  },
];
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

async function renderRail({ subagent, empty = false }: { subagent?: SubagentRailContext; empty?: boolean } = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounts.push({ container, root });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <I18nProvider>
          <RightRail
            state={{ ...createViewState('sess-1'), tasks: empty ? [] : tasks }}
            forest={empty ? buildAgentForest([], [{ agentId: 'main', name: 'Main' }]) : forest}
            selectedAgentId={subagent?.agentId}
            subagent={subagent}
            onCancelTask={() => {}}
            onStopAgentTask={async () => {}}
            onOpenSubagent={() => {}}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
  });
  return container;
}

function sharedChapters(container: Element) {
  return [...container.querySelectorAll<HTMLElement>('[data-agent-panel-scroll] > section:not([data-subagent-context])')]
    .map((section) => ({
      title: section.querySelector(':scope > div > button > span:last-child')?.textContent,
      className: section.className,
    }));
}

describe('RightRail shared chapters', () => {
  it('renders the same tree, background tasks, bulk subagent stop and session chapters in both modes', async () => {
    const main = await renderRail();
    const child = await renderRail({ subagent: context });

    expect(sharedChapters(main)).toEqual(sharedChapters(child));
    expect(sharedChapters(child).map((chapter) => chapter.title)).toEqual([
      'Subagents', 'Background tasks', 'Session',
    ]);
    for (const rail of [main, child]) {
      expect(rail.querySelector('[data-agent-tree] [data-agent-id="agent-1"]')).not.toBeNull();
      expect(rail.querySelector('[data-subagent-scroll] [data-subagents-view-all]')).not.toBeNull();
      expect(rail.querySelector('[data-tasks-scroll] [data-task-open="background-1"]')).not.toBeNull();
      expect(rail.querySelector('[data-task-open="subagent-1"]')).toBeNull();
      expect(rail.querySelector('[data-terminate-all-subagents]')).not.toBeNull();
      expect(rail.querySelector('[data-panel-props]')).not.toBeNull();
    }
    expect(main.querySelector('[data-subagent-context]')).toBeNull();
    const highlight = child.querySelector('[data-subagent-context]');
    expect(highlight?.className).toContain('border-accent/40');
    expect(highlight?.textContent).toContain('Subagent task');
    expect(highlight?.textContent).toContain('Navigate');
    expect(highlight?.querySelector('[data-needs-input]')?.textContent).toContain('1');
    expect(child.querySelector('[data-tasks-scroll]')?.closest('section')?.nextElementSibling).toBe(highlight);
    expect(highlight?.nextElementSibling?.matches('[data-panel-props]')).toBe(true);
  });

  it('keeps empty chapters hidden and retains collapsible chapter behavior in both modes', async () => {
    for (const subagent of [undefined, context]) {
      const empty = await renderRail({ subagent, empty: true });
      expect(sharedChapters(empty).map((chapter) => chapter.title)).toEqual(['Session']);
      expect(empty.querySelector('[data-subagent-context]') !== null).toBe(subagent !== undefined);

      const populated = await renderRail({ subagent });
      const tree = populated.querySelector('[data-agent-tree]');
      const section = tree?.closest('section');
      const toggle = section?.querySelector<HTMLButtonElement>(':scope > div > button');
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      await act(async () => { toggle?.click(); });
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(section?.querySelector('[data-agent-tree]')).toBeNull();
      await act(async () => { toggle?.click(); });
      expect(section?.querySelector('[data-agent-tree]')).not.toBeNull();
    }
  });
});
