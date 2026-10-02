// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { I18nProvider } from '../../i18n';
import { AgentNotesSection, type AgentNotesSectionProps } from './AgentNotesSection';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('kiki.locale', 'en');
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function render(props: AgentNotesSectionProps) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<I18nProvider><AgentNotesSection {...props} /></I18nProvider>); });
  return {
    container,
    rerender: async (next: AgentNotesSectionProps) => {
      await act(async () => { root.render(<I18nProvider><AgentNotesSection {...next} /></I18nProvider>); });
    },
    cleanup: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

const meta = { rev: 4, hash: 'h', writtenTurn: 12, writtenStep: 't12.3', coveredMessageId: 'msg-9', windowEpoch: 2 };

async function openSection(container: HTMLElement) {
  const toggle = container.querySelector<HTMLButtonElement>('[data-agent-notes-section] button[aria-expanded]')!;
  await act(async () => { toggle.click(); });
}

describe('AgentNotesSection', () => {
  it('keeps the loading line and the empty line apart', async () => {
    const { container, rerender, cleanup } = await render({ notes: undefined, meta: undefined, loaded: false });
    expect(container.querySelector<HTMLElement>('[data-agent-notes-state]')?.dataset['agentNotesState']).toBe('loading');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Reading working notes…');
    // Neither state folds: there is nothing to unfold yet.
    expect(container.querySelector('button[aria-expanded]')).toBeNull();
    await rerender({ notes: undefined, meta: undefined, loaded: true });
    expect(container.querySelector<HTMLElement>('[data-agent-notes-state]')?.dataset['agentNotesState']).toBe('empty');
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain('No working notes yet.');
    expect(container.textContent).not.toContain('Reading working notes');
    await cleanup();
  });

  it('reads whitespace-only notes as the empty state, never as content', async () => {
    const { container, cleanup } = await render({ notes: { goal: '  ', next: '\n' }, meta, loaded: true });
    expect(container.querySelector<HTMLElement>('[data-agent-notes-state]')?.dataset['agentNotesState']).toBe('empty');
    expect(container.querySelector('[data-agent-notes-part]')).toBeNull();
    await cleanup();
  });

  it('shows the goal line closed and every written section, revision and turn open', async () => {
    const { container, cleanup } = await render({
      notes: { goal: 'Ship the tray fix\nwith tests', next: 'Take screenshots', open: 'Mobile width?' },
      meta,
      loaded: true,
    });
    const toggle = container.querySelector<HTMLButtonElement>('[data-agent-notes-section] button')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-agent-notes-goal]')?.textContent).toBe('Ship the tray fix');
    expect(container.querySelector('[data-agent-notes-part]')).toBeNull();
    await act(async () => { toggle.click(); });
    expect([...container.querySelectorAll<HTMLElement>('[data-agent-notes-part]')].map((part) => part.dataset['agentNotesPart']))
      .toEqual(['goal', 'next', 'open']);
    // The humanized watermark: turn and revision, never the internal ids.
    const metaLine = container.querySelector('[data-agent-notes-meta]');
    expect(metaLine?.textContent).toBe('Updated in turn 12 · revision 4');
    expect(metaLine?.textContent).not.toContain('context window');
    expect(metaLine?.textContent).not.toContain('t12.3');
    expect(metaLine?.textContent).not.toContain('msg-9');
    await cleanup();
  });

  it('renders all eight sections in the canonical order with their labels', async () => {
    const { container, cleanup } = await render({
      notes: {
        open: 'o', next: 'n', files: 'f', evidence: 'e',
        rejected: 'r', decided: 'd', directives: 'i', goal: 'g',
      },
      meta,
      loaded: true,
    });
    await openSection(container);
    const parts = [...container.querySelectorAll<HTMLElement>('[data-agent-notes-part]')];
    expect(parts.map((part) => part.dataset['agentNotesPart']))
      .toEqual(['goal', 'directives', 'decided', 'rejected', 'evidence', 'files', 'next', 'open']);
    const labels = parts.map((part) => part.querySelector('dt')?.textContent);
    expect(labels).toEqual(['Goal', 'User instructions', 'Decided', 'Ruled out', 'Evidence', 'Files', 'Next', 'Open questions']);
    await cleanup();
  });

  it('clamps a long section to four lines with the shared show-more toggle', async () => {
    const long = Array.from({ length: 30 }, (_, index) => `evidence line ${index}`).join('\n');
    const { container, cleanup } = await render({ notes: { goal: 'g', evidence: long }, meta, loaded: true });
    await openSection(container);
    const evidence = container.querySelector('[data-agent-notes-part="evidence"]')!;
    const paragraph = evidence.querySelector('dd p')!;
    expect(paragraph.className).toContain('line-clamp-4');
    expect(paragraph.className).toContain('whitespace-pre-wrap');
    expect(paragraph.textContent).toContain('evidence line 29');
    await cleanup();
  });

  it('settles back to the empty state when the agent clears its notes', async () => {
    const { container, rerender, cleanup } = await render({
      notes: { goal: 'Temporary goal', next: 'Cleanup' },
      meta,
      loaded: true,
    });
    await openSection(container);
    expect(container.textContent).toContain('Temporary goal');
    // The agent clears its list: the panel must not keep the stale text.
    await rerender({ notes: undefined, meta: undefined, loaded: true });
    expect(container.textContent).not.toContain('Temporary goal');
    expect(container.textContent).not.toContain('Cleanup');
    expect(container.querySelector<HTMLElement>('[data-agent-notes-state]')?.dataset['agentNotesState']).toBe('empty');
    expect(container.textContent).toContain('No working notes yet.');
    await cleanup();
  });
});
