// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildAnnotationsPrefix, type TimelineBlockLike } from '@kiki/session-core/composer';
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

async function renderTray(blocks: readonly TimelineBlockLike[]) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider>
        <AnnotationTray sessionId="s" blocks={blocks} />
      </I18nProvider>,
    );
  });
  return {
    container,
    cleanup: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

describe('AnnotationTray', () => {
  it('is absent while nothing has been sent', async () => {
    const { container, cleanup } = await renderTray(sentBlocks.slice(0, 1));
    expect(container.querySelector('[data-annotation-tray]')).toBeNull();
    await cleanup();
  });

  it('is one collapsed count line for notes already in the conversation', async () => {
    const { container, cleanup } = await renderTray(sentBlocks);
    const toggle = container.querySelector<HTMLButtonElement>('[data-annotation-tray-toggle]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('1 note already in this conversation');
    expect(container.querySelectorAll('[data-annotation-tray-row]')).toHaveLength(0);
    await act(async () => { toggle.click(); });
    expect(container.querySelectorAll('[data-annotation-tray-row]')).toHaveLength(1);
    expect(container.querySelector('[data-annotation-tray-show]')).not.toBeNull();
    await cleanup();
  });
});
