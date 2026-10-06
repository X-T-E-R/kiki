// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../i18n';
import { EffortPicker } from './fields';

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
