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
const listModels = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { getConfig, patchConfig, meta, listModels } }),
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

async function renderSection(section: 'general' | 'models' | 'plan' = 'plan'): Promise<HTMLDivElement> {
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
          {section === 'plan' ? <PlanSettings /> : <GeneralSection area={section === 'models' ? 'models' : 'app'} />}
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

  it('saves the timeout on explicit Save, not on blur', async () => {
    const container = await renderSection('plan');
    const input = container.querySelector<HTMLInputElement>('#plan-gate-timeout')!;
    await setInputValue(input, '30');
    expect(patchConfig).not.toHaveBeenCalled();
    const save = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!;
    await click(save);
    expect(patchConfig).toHaveBeenCalledWith({ plan: { enter_approval_timeout_ms: 30_000 } });
  });

  it('rejects a timeout below the 5s floor without patching', async () => {
    const container = await renderSection('plan');
    const input = container.querySelector<HTMLInputElement>('#plan-gate-timeout')!;
    await setInputValue(input, '3');
    const save = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save')!;
    await click(save);
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

  it('places permission defaults with models while keeping device preferences in Your app', async () => {
    const app = await renderSection('general');
    expect(app.querySelector('#st-card-permission-defaults')).toBeNull();
    expect(app.querySelector('#st-card-language')).not.toBeNull();
    const models = await renderSection('models');
    expect(models.querySelector('#st-card-permission-defaults')).not.toBeNull();
    expect(models.querySelector('#st-card-language')).toBeNull();
    expect(models.querySelector('#plan-gate-timeout')).toBeNull();
  });

  it('offers four permission defaults, saving review immediately', async () => {
    const container = await renderSection('models');
    const card = container.querySelector('#st-card-permission-defaults')!;
    const choices = [...card.querySelectorAll<HTMLButtonElement>('button')];
    expect(choices.map((choice) => choice.textContent)).toEqual(['Ask every time', 'Auto', 'Approve for me', 'Full access']);
    await click(choices[2]!);
    expect(patchConfig).toHaveBeenCalledWith({ default_permission_mode: 'review' });
    expect(card.textContent).toContain('reviewer checks sensitive actions');
  });

  it('saves the server-side question blocking choice immediately in Composer & session', async () => {
    const container = await renderSection('general');
    const card = container.querySelector('#st-card-composer')!;
    expect(card.querySelector('[data-question-behavior]')?.textContent).toContain('Don’t block');
    await click([...card.querySelectorAll('button')].find((button) => button.textContent === 'Block')!);
    expect(patchConfig).toHaveBeenCalledWith({ interaction: { ask_user_question: 'blocking' } });
  });

  it('renders single flag card with unified save and model searchable select for auto_session_title', async () => {
    const container = await renderSection('general');
    const sessionCard = container.querySelector('#st-card-session-title')!;
    expect(sessionCard).not.toBeNull();
    // In single-flag card, the feature label is not duplicated
    expect(sessionCard.querySelector('details[data-technical-details]')).not.toBeNull();
    // It should have the searchable select for session title model
    const modelSelect = sessionCard.querySelector('#session-title-model');
    expect(modelSelect).not.toBeNull();
    // There should only be one Save button in this card
    const buttons = [...sessionCard.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === 'Save',
    );
    expect(buttons.length).toBe(1);
  });

  it('SETTINGS-1: does not overwrite a new model selection made while a save is pending', async () => {
    let resolvePatch!: (value: unknown) => void;
    const pendingPatch = new Promise((resolve) => {
      resolvePatch = resolve;
    });

    patchConfig.mockImplementationOnce(async () => {
      const res = await pendingPatch;
      return res;
    });

    const container = await renderSection('general');
    const sessionCard = container.querySelector('#st-card-session-title')!;

    // Initial edit: select 'custom-model'
    const hiddenInput = sessionCard.querySelector<HTMLInputElement>('[data-session-title-model-input]')!;
    await setInputValue(hiddenInput, 'custom-model');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const saveButton = [...sessionCard.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Save',
    )!;
    expect(saveButton.disabled).toBe(false);

    // Trigger save - this enters saving=true
    await act(async () => {
      saveButton.click();
    });

    // While saving is pending, the SearchableSelect button is disabled
    const selectTrigger = sessionCard.querySelector<HTMLButtonElement>('#session-title-model')!;
    expect(selectTrigger.disabled).toBe(true);

    // Concurrently, if a new value arrives (e.g. from input or fast reselection)
    await setInputValue(hiddenInput, 'newer-concurrent-model');
    expect(hiddenInput.value).toBe('newer-concurrent-model');

    // Now let the first save resolve with the server echoing 'custom-model'
    await act(async () => {
      resolvePatch({
        ...CONFIG,
        session_title: { model: 'custom-model' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The newer draft must NOT be overwritten by the echoed 'custom-model'
    expect(hiddenInput.value).toBe('newer-concurrent-model');
    // And dirty remains true so the user can save the newer choice
    expect(saveButton.disabled).toBe(false);
  });
});
