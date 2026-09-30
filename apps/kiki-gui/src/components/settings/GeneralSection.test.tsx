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
import { PermissionsSection } from './PermissionsSection';
import { PlanSettings } from './PlanSettings';
import { SessionsSection } from './SessionsSection';

const getConfig = vi.fn();
const patchConfig = vi.fn();
const meta = vi.fn();
const listModels = vi.fn();
const listTools = vi.fn(async () => ({ tools: [] }));

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { getConfig, patchConfig, meta, listModels, listTools } }),
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
  listModels.mockReset().mockResolvedValue({
    items: [
      { id: 'kimi-for-coding', provider: 'kimi', name: 'Kimi for Coding' },
      { id: 'custom-model', provider: 'openai', name: 'Custom Model' },
    ],
  });
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
    ...(typeof patch['session_title'] === 'object' && patch['session_title'] !== null
      ? { session_title: patch['session_title'] }
      : {}),
    ...(typeof patch['experimental'] === 'object' && patch['experimental'] !== null
      ? { experimental: patch['experimental'] }
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

async function renderSection(section: 'general' | 'permissions' | 'sessions' | 'plan' = 'plan'): Promise<HTMLDivElement> {
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
          {section === 'plan' ? <PlanSettings /> : section === 'permissions' ? <PermissionsSection /> : section === 'sessions' ? <SessionsSection /> : <GeneralSection />}
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

async function commitInput(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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

  it('saves the timeout when the field commits (Enter or blur), like the other number fields', async () => {
    const container = await renderSection('plan');
    const input = container.querySelector<HTMLInputElement>('#plan-gate-timeout')!;
    await setInputValue(input, '30');
    expect(patchConfig).not.toHaveBeenCalled();
    await commitInput(input);
    expect(patchConfig).toHaveBeenCalledWith({ plan: { enter_approval_timeout_ms: 30_000 } });
  });

  it('rejects a timeout below the 5s floor without patching', async () => {
    const container = await renderSection('plan');
    const input = container.querySelector<HTMLInputElement>('#plan-gate-timeout')!;
    await setInputValue(input, '3');
    await commitInput(input);
    expect(patchConfig).not.toHaveBeenCalled();
    expect(container.textContent).toContain('at least 5 seconds');
    expect(input.value).toBe('3');
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

  it('keeps General to device preferences and puts server defaults on their own pages', async () => {
    const app = await renderSection('general');
    expect(app.querySelector('#st-card-language')).not.toBeNull();
    expect(app.querySelector('#st-card-append-timing')).not.toBeNull();
    for (const moved of ['#st-card-permission-defaults', '#st-card-session-title', '#st-card-questions', '[data-question-behavior]']) {
      expect(app.querySelector(moved), moved).toBeNull();
    }
    // Nothing on General talks to the server.
    expect(getConfig).not.toHaveBeenCalled();
    const permissions = await renderSection('permissions');
    expect(permissions.querySelector('#st-card-permission-defaults')).not.toBeNull();
    expect(permissions.querySelector('#st-card-permission-defaults [data-settings-effect="newSessions"]')).not.toBeNull();
  });

  it('offers four permission defaults, saving review immediately', async () => {
    const container = await renderSection('permissions');
    const card = container.querySelector('#st-card-permission-defaults')!;
    const choices = [...card.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Default permission mode"] button')];
    expect(choices.map((choice) => choice.textContent)).toEqual(['Ask every time', 'Auto', 'Approve for me', 'Full access']);
    await click(choices[2]!);
    expect(patchConfig).toHaveBeenCalledWith({ default_permission_mode: 'review' });
    expect(card.textContent).toContain('reviewer checks sensitive actions');
  });

  it('writes the dangerous Bash guard from the default mode card', async () => {
    const container = await renderSection('permissions');
    const choice = container.querySelector<HTMLButtonElement>('#st-card-permission-defaults [role="group"][aria-label="Dangerous Bash commands"] button:nth-child(2)')!;
    await click(choice);
    expect(patchConfig).toHaveBeenCalledWith({ permission: { dangerous_bash: 'on' } });
    expect(container.textContent).toContain('Full access');
  });

  it('saves the question blocking choice immediately on Sessions', async () => {
    const container = await renderSection('sessions');
    const card = container.querySelector('#st-card-questions')!;
    expect(card.querySelector('[data-question-behavior]')?.textContent).toContain('Don’t block');
    await click([...card.querySelectorAll('button')].find((button) => button.textContent === 'Block')!);
    expect(patchConfig).toHaveBeenCalledWith({ interaction: { ask_user_question: 'blocking' } });
  });

  it('turns session titles on with one switch and shows the model picker only while on', async () => {
    getConfig.mockResolvedValue({ ...CONFIG, experimental: { auto_session_title: false } });
    meta.mockResolvedValue({ experimental_flags: { auto_session_title: false } });
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const card = container.querySelector('#st-card-session-title')!;
    expect(card.querySelector('#session-title-model')).toBeNull();
    expect([...card.querySelectorAll('button')].some((button) => button.textContent === 'Save')).toBe(false);
    await click(card.querySelector('[role="switch"]')!.closest('label')!.querySelector('input')!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(patchConfig).toHaveBeenCalledWith({
      experimental: { auto_session_title: true },
      replace_domains: ['experimental'],
    });
  });

  it('writes the title model the moment it is picked', async () => {
    getConfig.mockResolvedValue({ ...CONFIG, experimental: { auto_session_title: true } });
    const container = await renderSection('sessions');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const card = container.querySelector('#st-card-session-title')!;
    await click(card.querySelector('#session-title-model')!);
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) => row.textContent?.includes('custom-model'))!;
    await click(option);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(patchConfig).toHaveBeenCalledWith({ session_title: { model: 'custom-model' }, replace_domains: ['session_title'] });
  });
});
