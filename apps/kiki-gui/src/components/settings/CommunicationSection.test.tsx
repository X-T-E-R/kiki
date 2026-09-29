// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import type { KikiConfigResponse } from '../../lib/client';
import { AgentMessagingCard, TokenCountingCard } from './CommunicationSection';
import { ResourceLimitsCard } from './EngineLimitSettings';
import { AdvancedSection } from './AdvancedSection';

const getConfig = vi.fn();
const patchConfig = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { getConfig, patchConfig } }),
}));

const INITIAL_CONFIG: KikiConfigResponse = {
  thread_communication: { enabled: true },
  token_counting: { strategy: 'measured' },
  agents: { enabled: true, notify_parent: true },
  workspace_instance: { idleTtlMs: 300_000 },
  image: { maxEdgePx: 2048, readByteBudget: 4_000_000 },
  permission: {},
  loop_control: {},
  background: {},
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
  getConfig.mockReset().mockResolvedValue(INITIAL_CONFIG);
  patchConfig.mockReset().mockImplementation(async (patch: Record<string, unknown>) => ({
    ...INITIAL_CONFIG,
    ...patch,
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

async function renderComponent(node: React.ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider>{node}</I18nProvider>
      </QueryClientProvider>,
    );
  });
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

function switchIn(container: Element, which: 'thread' | 'notify'): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`[data-agent-messaging="${which}"] input[type="checkbox"]`)!;
}

describe('Agent messaging and token counting', () => {
  it('shows both messaging channels in one card with no save button', async () => {
    const container = await renderComponent(<AgentMessagingCard />);
    const card = container.querySelector('#st-card-agent-messaging')!;
    expect(switchIn(card, 'thread').checked).toBe(true);
    expect(switchIn(card, 'notify').checked).toBe(true);
    expect([...card.querySelectorAll('button')].some((button) => button.textContent?.includes('Save'))).toBe(false);
  });

  it('patches thread communication on its own when that switch flips', async () => {
    const container = await renderComponent(<AgentMessagingCard />);
    const card = container.querySelector('#st-card-agent-messaging')!;
    await click(switchIn(card, 'thread'));
    expect(patchConfig).toHaveBeenCalledTimes(1);
    expect(patchConfig).toHaveBeenCalledWith({
      thread_communication: { enabled: false },
      replace_domains: ['thread_communication'],
    });
    expect(switchIn(card, 'thread').checked).toBe(false);
    expect(switchIn(card, 'notify').checked).toBe(true);
    expect(card.textContent).toContain('Saved');
  });

  it('patches parent notification on its own and rolls back on failure', async () => {
    const container = await renderComponent(<AgentMessagingCard />);
    const card = container.querySelector('#st-card-agent-messaging')!;
    await click(switchIn(card, 'notify'));
    expect(patchConfig).toHaveBeenCalledWith({ agents: { notify_parent: false } });
    patchConfig.mockRejectedValueOnce(new Error('offline'));
    await click(switchIn(card, 'notify'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(switchIn(card, 'notify').checked).toBe(false);
    expect(card.textContent).toContain('offline');
  });

  it('saves the token counting strategy the moment it is picked', async () => {
    const container = await renderComponent(<TokenCountingCard />);
    const card = container.querySelector('#st-card-token-counting')!;
    const trigger = card.querySelector<HTMLButtonElement>('#token-counting-strategy')!;
    expect(trigger.textContent).toContain('measured');
    await click(trigger);
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) => row.textContent === 'estimated')!;
    await click(option);
    expect(patchConfig).toHaveBeenCalledWith({
      token_counting: { strategy: 'estimated' },
      replace_domains: ['token_counting'],
    });
  });

  it('keeps the raw JSON editor free of the messaging cards', async () => {
    const container = await renderComponent(<AdvancedSection />);
    expect(container.querySelector('#st-card-advanced')).not.toBeNull();
    expect(container.querySelector('#st-card-agent-messaging')).toBeNull();
    expect(container.querySelector('#st-card-token-counting')).toBeNull();
  });
});
