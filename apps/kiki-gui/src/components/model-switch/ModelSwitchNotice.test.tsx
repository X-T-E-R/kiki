// @vitest-environment jsdom

/**
 * One timeline row per switch operation. The copy follows the real state, and
 * only states with a legal action grow buttons: pending offers change/cancel,
 * preparing offers nothing (by contract only a pending operation can be
 * cancelled), failed offers retry / fresh / keep-original.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { NoticeBlock } from '@kiki/session-core/session';
import { I18nProvider } from '../../i18n';
import { ModelSwitchActionsContext, ModelSwitchNotice } from './ModelSwitchNotice';

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

type ModelSwitchInfo = NonNullable<NoticeBlock['modelSwitch']>;

function block(info: Partial<ModelSwitchInfo>, error?: { code: string; message: string }): NoticeBlock {
  return {
    kind: 'notice',
    id: 'notice-switch',
    createdAt: '2026-10-03T10:00:00.000Z',
    text: 'model.switch',
    tone: 'neutral',
    modelSwitch: {
      operationId: 'op-1',
      mode: 'direct',
      state: 'pending',
      from: 'example/old',
      to: 'example/new',
      ...info,
      ...(error === undefined ? {} : { error }),
    },
  };
}

async function renderNotice(
  notice: NoticeBlock,
  actions?: Parameters<typeof ModelSwitchActionsContext.Provider>[0]['value'],
): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <I18nProvider>
        <ModelSwitchActionsContext.Provider value={actions}>
          <ModelSwitchNotice block={notice} />
        </ModelSwitchActionsContext.Provider>
      </I18nProvider>,
    );
  });
  return container;
}

function actionNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-model-switch-action]'))
    .map((button) => button.dataset['modelSwitchAction']!);
}

describe('ModelSwitchNotice', () => {
  it('names the queued switch and its mode while it waits', async () => {
    const container = await renderNotice(block({ state: 'pending', mode: 'fresh' }));
    expect(container.textContent).toContain('Will switch to example/new when idle');
    expect(container.textContent).toContain('Fresh context');
    expect(container.querySelector('[data-model-switch-notice="pending"]')).not.toBeNull();
  });

  it('offers change and cancel on a pending switch and wires them to the operation id', async () => {
    const cancel = vi.fn();
    const edit = vi.fn();
    const container = await renderNotice(block({ state: 'pending' }), { cancel, edit });
    expect(actionNames(container)).toEqual(['edit', 'cancel']);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-model-switch-action="cancel"]')!.click(); });
    expect(cancel).toHaveBeenCalledWith('op-1');
  });

  it('reports progress without a cancel button once preparing', async () => {
    const cancel = vi.fn();
    const container = await renderNotice(
      block({ state: 'preparing', mode: 'compact' }),
      { cancel },
    );
    expect(container.textContent).toContain('example/old is summarizing the conversation…');
    expect(actionNames(container)).toEqual([]);
  });

  it('separates the three finished modes, including a same-model fresh', async () => {
    const direct = await renderNotice(block({ state: 'completed', mode: 'direct' }));
    expect(direct.textContent).toContain('Switched to example/new');
    expect(direct.textContent).toContain('Kept the current context');
    const compact = await renderNotice(block({ state: 'completed', mode: 'compact', summaryGenerated: true }));
    expect(compact.textContent).toContain('example/old summarized the conversation');
    const compactEmpty = await renderNotice(block({ state: 'completed', mode: 'compact', summaryGenerated: false }));
    expect(compactEmpty.textContent).toContain('Nothing to summarize; handed over directly');
    const fresh = await renderNotice(block({ state: 'completed', mode: 'fresh' }));
    expect(fresh.textContent).toContain('Continuing with a fresh context');
    const sameModel = await renderNotice(block({ state: 'completed', mode: 'fresh', from: 'k', to: 'k' }));
    expect(sameModel.textContent).toContain('Started a new context');
    expect(sameModel.textContent).toContain('Task progress is preserved');
  });

  it('reports the failure, its reason, and the three recovery paths', async () => {
    const retry = vi.fn();
    const retryAsFresh = vi.fn();
    const keepOriginal = vi.fn();
    const container = await renderNotice(
      block({ state: 'failed', mode: 'compact' }, { code: 'summary_failed', message: 'upstream timeout' }),
      { retry, retryAsFresh, keepOriginal },
    );
    expect(container.textContent).toContain('example/old couldn’t produce the summary');
    expect(container.textContent).toContain('upstream timeout');
    expect(container.querySelector('[data-notice-key]')).not.toBeNull();
    expect(actionNames(container)).toEqual(['retry', 'retry-fresh', 'keep-original']);
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-model-switch-action="retry-fresh"]')!.click(); });
    expect(retryAsFresh).toHaveBeenCalledWith('op-1');
  });

  it('hides a recovery path the surface cannot offer yet', async () => {
    const container = await renderNotice(block({ state: 'failed' }), { retry: vi.fn(), keepOriginal: vi.fn() });
    expect(actionNames(container)).toEqual(['retry', 'keep-original']);
  });

  it('states a cancellation plainly and keeps actions disabled while one runs', async () => {
    const cancelled = await renderNotice(block({ state: 'cancelled' }));
    expect(cancelled.textContent).toContain('Cancelled the switch to example/new');
    const busy = await renderNotice(block({ state: 'failed' }), {
      retry: vi.fn(),
      pendingOperationId: 'op-1',
    });
    expect(busy.querySelector<HTMLButtonElement>('[data-model-switch-action="retry"]')!.disabled).toBe(true);
  });

  it('stays copy-only where no actions are provided', async () => {
    const container = await renderNotice(block({ state: 'pending' }));
    expect(actionNames(container)).toEqual([]);
    expect(container.textContent).toContain('Will switch to example/new when idle');
  });
});
