// @vitest-environment jsdom

/**
 * The ended-subagent row's trailing actions: icon tiles, not text buttons.
 * "Go to the dispatch" and "open the agent" keep their words in the tooltip
 * and the accessible name while the glyphs carry the row — the same jump /
 * open icons the rail uses for the same two entries.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { SubagentEnding } from '@kiki/session-core/session';

import { I18nProvider } from '../../i18n';
import { SubagentEndedRow } from './FoldRows';

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root !== undefined) await act(async () => { root!.unmount(); });
  root = undefined;
  host?.remove();
  host = undefined;
});

function makeEnding(overrides: Partial<SubagentEnding> = {}): SubagentEnding {
  return {
    kind: 'subagent-ended',
    id: 'ended-1',
    turnId: 't1',
    agentId: 'agent-1',
    taskId: 'task-1',
    outcome: 'completed',
    note: {
      kind: 'system',
      id: 'note-1',
      variant: 'task',
      text: 'Done.\nShipped the slice.',
      createdAt: '2026-10-02T00:00:00Z',
    },
    dispatchOnPage: true,
    ...overrides,
  };
}

async function renderRow({
  ending = makeEnding(),
  onOpenAgent,
  onLocateDispatch,
}: {
  ending?: SubagentEnding;
  onOpenAgent?: (agentId: string) => void;
  onLocateDispatch?: (agentId: string) => void;
} = {}): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <I18nProvider>
        <SubagentEndedRow
          ending={ending}
          name="scout"
          model={undefined}
          summary={undefined}
          elapsed="2m"
          onOpenAgent={onOpenAgent ?? (() => undefined)}
          onLocateDispatch={onLocateDispatch ?? (() => undefined)}
          renderReceipt={(markdown) => <div>{markdown}</div>}
        />
      </I18nProvider>,
    );
  });
  return host;
}

describe('SubagentEndedRow trailing actions', () => {
  it('renders jump-to-dispatch and open as labelled icon tiles, not text buttons', async () => {
    const container = await renderRow();
    const dispatch = container.querySelector('[data-subagent-ended-dispatch]')!;
    const open = container.querySelector('[data-agent-open]')!;

    // The words move to the tooltip and the accessible name…
    expect(dispatch.getAttribute('aria-label')).toBe('Go to where it was dispatched');
    expect(dispatch.getAttribute('title')).toBe('Go to where it was dispatched');
    expect(open.getAttribute('aria-label')).toBe('Open scout');
    expect(open.getAttribute('title')).toBe('Open scout');
    // …leaving no visible text on the row, only the glyphs the rail uses for
    // the same two entries (locate ↑, open ↗).
    expect(dispatch.textContent).toBe('');
    expect(open.textContent).toBe('');
    expect(dispatch.querySelector('[data-icon="arrowUp"]')).not.toBeNull();
    expect(open.querySelector('[data-icon="external"]')).not.toBeNull();

    // A quiet 28px tile (40px on coarse pointers): no border, no pill, and
    // the same box the row's other trailing slots align to.
    for (const tile of [dispatch, open]) {
      expect(tile.className).toContain('min-h-7');
      expect(tile.className).toContain('w-7');
      expect(tile.className).toContain('pointer-coarse:w-10');
      expect(tile.className).not.toContain('border');
      expect(tile.className).not.toContain('px-2');
    }
  });

  it('keeps both click targets wired to their entries', async () => {
    const opened: string[] = [];
    const located: string[] = [];
    const container = await renderRow({
      onOpenAgent: (id) => { opened.push(id); },
      onLocateDispatch: (id) => { located.push(id); },
    });
    await act(async () => {
      (container.querySelector('[data-subagent-ended-dispatch]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('[data-agent-open]') as HTMLButtonElement).click();
    });
    expect(located).toEqual(['agent-1']);
    expect(opened).toEqual(['agent-1']);
  });

  it('drops the dispatch tile when the card is not on this page', async () => {
    const container = await renderRow({ ending: makeEnding({ dispatchOnPage: false }) });
    expect(container.querySelector('[data-subagent-ended-dispatch]')).toBeNull();
    expect(container.querySelector('[data-agent-open]')).not.toBeNull();
  });

  it('drops both tiles when neither entry exists', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <I18nProvider>
          <SubagentEndedRow
            ending={makeEnding()}
            name="scout"
            model={undefined}
            summary={undefined}
            elapsed="2m"
            renderReceipt={(markdown) => <div>{markdown}</div>}
          />
        </I18nProvider>,
      );
    });
    expect(host.querySelector('[data-subagent-ended-dispatch]')).toBeNull();
    expect(host.querySelector('[data-agent-open]')).toBeNull();
  });
});
