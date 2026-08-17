// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { ContextMeter } from './ContextMeter';

const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

describe('ContextMeter interaction', () => {
  it('opens details without compacting, then compacts only from the panel action', async () => {
    const onCompact = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <I18nProvider>
          <ContextMeter used={80_000} limit={100_000} onCompact={onCompact} />
        </I18nProvider>,
      );
    });

    const meter = container.querySelector<HTMLButtonElement>('[data-context-meter]');
    expect(meter).not.toBeNull();
    await act(async () => { meter!.click(); });

    expect(onCompact).not.toHaveBeenCalled();
    const details = container.querySelector('[data-context-details]');
    expect(details?.textContent).toContain('Context details');
    expect(details?.textContent).toContain('Used');
    expect(details?.textContent).toContain('Available');
    expect(details?.textContent).toContain('Limit');

    const compact = container.querySelector<HTMLButtonElement>('[data-context-compact]');
    expect(compact).not.toBeNull();
    await act(async () => { compact!.click(); });

    expect(onCompact).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-context-details]')).toBeNull();
    await act(async () => { root.unmount(); });
  });
});
