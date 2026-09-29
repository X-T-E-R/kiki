// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildAnnotationsPrefix, type SelectionAnnotation, type TimelineBlockLike } from '@kiki/session-core/composer';
import { I18nProvider } from '../i18n';
import { AnnotationTray } from './AnnotationTray';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem('kiki.locale', 'en');
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const sentBlocks: TimelineBlockLike[] = [
  { id: 'a1', kind: 'assistant', text: 'The cursor pages older turns in batches of twenty.' },
  { id: 'u2', kind: 'user', text: `${buildAnnotationsPrefix([{ quote: 'batches of twenty', comment: 'match the server cap' }])}ok?` },
];
const draft: SelectionAnnotation = { id: 'draft-1', quote: 'older turns', comment: 'also check the fold' };

async function renderTray(pending: readonly SelectionAnnotation[], blocks: readonly TimelineBlockLike[]) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider>
        <AnnotationTray sessionId="s" blocks={blocks} pending={pending} onUpdatePending={() => {}} onRemovePending={() => {}} />
      </I18nProvider>,
    );
  });
  return {
    container,
    cleanup: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

describe('AnnotationTray', () => {
  it('leaves once nothing is waiting to be sent, even with notes in the conversation', async () => {
    const { container, cleanup } = await renderTray([], sentBlocks);
    expect(container.querySelector('[data-annotation-tray]')).toBeNull();
    await cleanup();
  });

  it('counts only unsent notes and keeps the sent ones behind one collapsed line', async () => {
    const { container, cleanup } = await renderTray([draft], sentBlocks);
    const toggle = container.querySelector<HTMLButtonElement>('[data-annotation-tray-toggle]')!;
    expect(toggle.textContent).toContain('1');
    expect(toggle.textContent).toContain('also check the fold');
    await act(async () => { toggle.click(); });
    expect(container.querySelector('[data-annotation-tray-row="draft-1"]')).not.toBeNull();
    const sentToggle = container.querySelector<HTMLButtonElement>('[data-annotation-tray-sent-toggle]')!;
    expect(sentToggle.getAttribute('aria-expanded')).toBe('false');
    expect(sentToggle.textContent).toBe('1 note already in this conversation');
    expect(container.querySelectorAll('[data-annotation-tray-row]')).toHaveLength(1);
    await act(async () => { sentToggle.click(); });
    expect(container.querySelectorAll('[data-annotation-tray-row]')).toHaveLength(2);
    expect(container.querySelector('[data-annotation-tray-show]')).not.toBeNull();
    await cleanup();
  });
});
