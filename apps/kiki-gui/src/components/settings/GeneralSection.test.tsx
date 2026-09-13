// @vitest-environment jsdom

/**
 * PlanSettings plan-gate defaults slice: the toggle writes `[plan] gate`
 * and the seconds field writes `enter_approval_timeout_ms` (floor 5000).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import type { KikiConfigResponse } from '../../lib/client';
import { GeneralSection } from './GeneralSection';
import { PlanSettings } from './PlanSettings';

const getConfig = vi.fn();
const patchConfig = vi.fn();
const meta = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { getConfig, patchConfig, meta } }),
}));
vi.mock('../../host', () => ({
  useHost: () => ({ kind: 'browser' }),
}));

const CONFIG: KikiConfigResponse = {
  default_permission_mode: 'manual',
  default_plan_mode: false,
  plan: { gate: 'gated', enterApprovalTimeoutMs: 15_000 },
} as KikiConfigResponse;

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  getConfig.mockReset().mockResolvedValue(CONFIG);
  meta.mockReset().mockResolvedValue({ experimental_flags: { auto_session_title: true } });
  patchConfig.mockReset().mockImplementation(async (patch: Record<string, unknown>) => ({
    ...CONFIG,
    ...(typeof patch['default_permission_mode'] === 'string'
      ? { default_permission_mode: patch['default_permission_mode'] }
      : {}),
    ...(typeof patch['default_plan_mode'] === 'boolean'
      ? { default_plan_mode: patch['default_plan_mode'] }
      : {}),
    ...(typeof patch['plan'] === 'object' && patch['plan'] !== null
      ? { plan: { ...CONFIG.plan, ...(patch['plan'] as Record<string, unknown>) } }
      : {}),
  }));
});

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function renderSection(section: 'general' | 'plan' = 'plan'): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          {section === 'plan' ? <PlanSettings /> : <GeneralSection />}
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  // Let the config query land and sync the local defaults.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function gateSwitch(container: HTMLDivElement): HTMLElement {
  const row = [...container.querySelectorAll('label')].find(
    (label) => label.textContent === 'Require approval when the model changes plan mode',
  );
  expect(row).toBeDefined();
  return row!.querySelector<HTMLElement>('[role="switch"]')!;
}

describe('PlanSettings plan gate defaults', () => {
  it('reflects the server plan gate and timeout', async () => {
    const container = await renderSection('plan');
    const toggle = gateSwitch(container);
    // gate: 'gated' reads as the approval switch being on.
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    const input = container.querySelector<HTMLInputElement>('#plan-gate-timeout')!;
    expect(input.value).toBe('15');
  });

  it('writes plan.gate on toggle', async () => {
    const container = await renderSection('plan');
    const toggle = gateSwitch(container);
    await click(toggle);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(patchConfig).toHaveBeenCalledWith({ plan: { gate: 'free' } });
  });

  it('writes enter_approval_timeout_ms in milliseconds on blur', async () => {
    const container = await renderSection('plan');
    const input = container.querySelector<HTMLInputElement>('#plan-gate-timeout')!;
    await setInputValue(input, '30');
    await act(async () => {
      input.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
      // React onBlur listens via focusout.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(patchConfig).toHaveBeenCalledWith({ plan: { enter_approval_timeout_ms: 30_000 } });
  });

  it('rejects a timeout below the 5s floor without patching', async () => {
    const container = await renderSection('plan');
    const input = container.querySelector<HTMLInputElement>('#plan-gate-timeout')!;
    await setInputValue(input, '3');
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(patchConfig).not.toHaveBeenCalled();
    expect(container.textContent).toContain('at least 5 seconds');
    expect(input.value).toBe('15');
  });

  it('merges a partial plan echo without dropping other config fields', async () => {
    const container = await renderSection('plan');
    patchConfig.mockResolvedValueOnce({ default_plan_mode: true } as KikiConfigResponse);
    const defaultPlanSwitch = container.querySelector<HTMLElement>('[data-plan-settings] [role="switch"]')!;
    await click(defaultPlanSwitch);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(defaultPlanSwitch.getAttribute('aria-checked')).toBe('true');
    expect(gateSwitch(container).getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector<HTMLInputElement>('#plan-gate-timeout')?.value).toBe('15');
  });

  it('reverts a failed plan save to the server draft and keeps the error visible', async () => {
    const container = await renderSection('plan');
    patchConfig.mockRejectedValueOnce(new Error('fixture offline'));
    const defaultPlanSwitch = container.querySelector<HTMLElement>('[data-plan-settings] [role="switch"]')!;
    await click(defaultPlanSwitch);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(defaultPlanSwitch.getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toContain('fixture offline');
  });

  it('keeps permission defaults on General without mounting plan controls', async () => {
    const container = await renderSection('general');
    expect(container.querySelector('#st-card-permission-defaults')).not.toBeNull();
    expect(container.querySelector('#plan-gate-timeout')).toBeNull();
    expect(container.textContent).toContain('Default permission mode');
  });
});
