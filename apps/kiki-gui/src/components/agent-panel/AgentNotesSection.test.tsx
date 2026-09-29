// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
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
  return { container, cleanup: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

const meta = { rev: 4, hash: 'h', writtenTurn: 12, writtenStep: 't12.3', coveredMessageId: 'msg-9', windowEpoch: 2 };

describe('AgentNotesSection', () => {
  it('renders nothing when the agent has written no notes', async () => {
    const { container, cleanup } = await render({ notes: { goal: '  ' }, meta });
    expect(container.querySelector('[data-agent-notes-section]')).toBeNull();
    await cleanup();
  });

  it('shows the goal line closed and every written section, revision and watermark open', async () => {
    const { container, cleanup } = await render({
      notes: { goal: 'Ship the tray fix\nwith tests', next: 'Take screenshots', open: 'Mobile width?' },
      meta,
    });
    const toggle = container.querySelector<HTMLButtonElement>('[data-agent-notes-section] button')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-agent-notes-goal]')?.textContent).toBe('Ship the tray fix');
    expect(container.querySelector('[data-agent-notes-part]')).toBeNull();
    await act(async () => { toggle.click(); });
    expect([...container.querySelectorAll('[data-agent-notes-part]')].map((part) => part.getAttribute('data-agent-notes-part')))
      .toEqual(['goal', 'next', 'open']);
    expect(container.querySelector('[data-agent-notes-meta]')?.textContent).toBe('Revision 4 · written in turn 12 · context window 2');
    await cleanup();
  });
});
