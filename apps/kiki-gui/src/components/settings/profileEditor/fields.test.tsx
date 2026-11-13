// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../i18n';
import { AliasChips, EffortPicker, ModelPicker } from './fields';

vi.mock('../../../state/connection', () => ({
  useConnection: () => ({ client: {} }),
}));

const mounted: Root[] = [];
beforeAll(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterAll(() => { vi.unstubAllGlobals(); });
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => { root.unmount(); });
  document.body.replaceChildren();
});

async function render(value: string, supported: readonly string[]) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const onChange = vi.fn();
  await act(async () => {
    root.render(<I18nProvider><EffortPicker id="effort-picker" value={value} supported={supported} onChange={onChange} /></I18nProvider>);
  });
  await act(async () => { container.querySelector<HTMLButtonElement>('#effort-picker')!.click(); });
  return { container: document.body, onChange };
}

const values = (container: HTMLElement) => [...container.querySelectorAll('[role="option"]')].map((row) => row.getAttribute('data-option-value'));

describe('EffortPicker display order', () => {
  it('keeps unset first and an explicit selection while sorting a supported copy', async () => {
    const supported = Object.freeze(['high', 'max', 'low', 'medium', 'xhigh']);
    const { container, onChange } = await render('high', supported);
    expect(values(container)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(container.querySelector('[role="option"][data-option-value="high"]')?.getAttribute('aria-selected')).toBe('true');
    expect(onChange).not.toHaveBeenCalled();
    expect(supported).toEqual(['high', 'max', 'low', 'medium', 'xhigh']);
  });

  it('preserves vendor values and keeps an unsupported pin available', async () => {
    const { container } = await render('Vendor-Pin', ['high', 'Vendor-ULTRA', 'low']);
    expect(values(container)).toEqual(['', 'low', 'Vendor-ULTRA', 'high', 'Vendor-Pin']);
    expect(container.querySelector('[role="option"][data-option-value="Vendor-Pin"]')?.getAttribute('aria-selected')).toBe('true');
  });
});

describe('ProfileEditor shared ModelPicker fields', () => {
  it('mounts the shared ModelPicker for both single model alias and menu AliasChips', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    const onModel = vi.fn();
    const onMenu = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const models = [{ id: 'fixture/kiki-pro', provider_id: 'fixture', remote_id: 'kiki-pro', display_name: 'Kiki Pro', max_context_size: 128000 }];
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <ModelPicker id="profile-model" value="fixture/kiki-pro" models={models} allowInherit onChange={onModel} />
            <AliasChips id="profile-menu" values={[]} models={models} addLabel="Add model" onChange={onMenu} />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    const singleTrigger = container.querySelector<HTMLButtonElement>('#profile-model')!;
    const addTrigger = container.querySelector<HTMLButtonElement>('#profile-menu-add')!;
    expect(singleTrigger.hasAttribute('data-model-picker')).toBe(true);
    expect(singleTrigger.textContent).toContain('fixture/kiki-pro');
    expect(addTrigger.hasAttribute('data-model-picker')).toBe(true);
  });
});
