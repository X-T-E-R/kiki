// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import type { KikiConfigResponse } from '../../lib/client';
import {
  CommunicationSection,
  ThreadCommunicationCard,
  NotifyParentCard,
  TokenCountingCard,
} from './CommunicationSection';
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

describe('CommunicationSection', () => {
  it('renders all three cards on the communication section', async () => {
    const container = await renderComponent(<CommunicationSection />);
    expect(container.querySelector('#st-card-thread-communication')).not.toBeNull();
    expect(container.querySelector('#st-card-notify-parent')).not.toBeNull();
    expect(container.querySelector('#st-card-token-counting')).not.toBeNull();
  });

  it('updates and patches thread communication independently', async () => {
    const container = await renderComponent(<ThreadCommunicationCard />);
    const card = container.querySelector('#st-card-thread-communication')!;
    const toggle = card.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.checked).toBe(true);

    // Toggle off
    await click(toggle);
    expect(toggle.checked).toBe(false);

    const saveBtn = [...card.querySelectorAll('button')].find((b) => b.textContent?.includes('Save'))!;
    expect(saveBtn.disabled).toBe(false);

    await click(saveBtn);
    expect(patchConfig).toHaveBeenCalledWith({
      thread_communication: { enabled: false },
      replace_domains: ['thread_communication'],
    });
    expect(card.textContent).toContain('Thread communication settings saved and echoed by the server.');
  });

  it('updates and patches notify parent toggle independently', async () => {
    const container = await renderComponent(<NotifyParentCard />);
    const card = container.querySelector('#st-card-notify-parent')!;
    const toggle = card.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.checked).toBe(true);

    // Toggle off
    await click(toggle);
    expect(toggle.checked).toBe(false);

    const saveBtn = [...card.querySelectorAll('button')].find((b) => b.textContent?.includes('Save'))!;
    expect(saveBtn.disabled).toBe(false);

    await click(saveBtn);
    expect(patchConfig).toHaveBeenCalledWith({
      agents: { notify_parent: false },
    });
    expect(card.textContent).toContain('Subagent parent notification settings saved and echoed by the server.');
  });

  it('updates and patches token counting strategy independently', async () => {
    const container = await renderComponent(<TokenCountingCard />);
    const card = container.querySelector('#st-card-token-counting')!;
    const select = card.querySelector<HTMLSelectElement>('select')!;
    expect(select.value).toBe('measured');

    await act(async () => {
      select.value = 'estimated';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const saveBtn = [...card.querySelectorAll('button')].find((b) => b.textContent?.includes('Save'))!;
    expect(saveBtn.disabled).toBe(false);

    await click(saveBtn);
    expect(patchConfig).toHaveBeenCalledWith({
      token_counting: { strategy: 'estimated' },
      replace_domains: ['token_counting'],
    });
    expect(card.textContent).toContain('Token counting settings saved and echoed by the server.');
  });

  it('verifies AdvancedSection no longer mounts communication cards', async () => {
    const container = await renderComponent(<AdvancedSection />);
    expect(container.querySelector('#st-card-advanced')).not.toBeNull();
    expect(container.querySelector('#st-card-resource-limits')).not.toBeNull();
    expect(container.querySelector('#st-card-communication')).toBeNull();
    expect(container.querySelector('#st-card-thread-communication')).toBeNull();
    expect(container.querySelector('#st-card-notify-parent')).toBeNull();
    expect(container.querySelector('#st-card-token-counting')).toBeNull();
  });
});
