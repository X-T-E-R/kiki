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

async function setValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
    expect(trigger.textContent).toContain('Measured only');
    await click(trigger);
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) => row.textContent?.includes('Estimated only'))!;
    // The stored value stays visible as the option's caption, not as its name.
    expect(option.textContent).toContain('estimated');
    await click(option);
    expect(patchConfig).toHaveBeenCalledWith({
      token_counting: { strategy: 'estimated' },
      replace_domains: ['token_counting'],
    });
    expect(card.querySelector<HTMLButtonElement>('#token-counting-strategy')!.textContent).toContain('Estimated only');
  });

  it('describes the default token strategy as the live size above the last measurement', async () => {
    getConfig.mockResolvedValue({ ...INITIAL_CONFIG, token_counting: { strategy: 'measured+estimated' } });
    const container = await renderComponent(<TokenCountingCard />);
    const card = container.querySelector('#st-card-token-counting')!;
    expect(card.querySelector<HTMLButtonElement>('#token-counting-strategy')!.textContent).toContain('Measured + estimated');
    expect(card.textContent).toContain('never below the last measured total');
    await click(card.querySelector('#token-counting-strategy')!);
    const [first] = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(first!.textContent).toContain('measured+estimated');
    await click(first!);
    expect(patchConfig).toHaveBeenCalledWith({
      token_counting: { strategy: 'measured+estimated' },
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

describe('workspace and image limits', () => {
  it('edits the idle reclamation in seconds and round-trips exact milliseconds', async () => {
    const container = await renderComponent(<ResourceLimitsCard />);
    const card = container.querySelector('#st-card-resource-limits')!;
    const fields = [...card.querySelectorAll<HTMLInputElement>('input')];
    // 300000 ms of stored idle TTL reads as 300 s; the other ceilings keep their engine units.
    expect(fields.map((input) => input.value)).toEqual(['300', '2048', '4000000']);
    expect(card.textContent).toContain('Workspace idle reclamation (s)');
    // The fine print — the engine mechanism, "the directory is not deleted", 0,
    // and the engine default — is one tap away per field, not on the first
    // screen. A label and its current value are enough to operate these.
    expect(card.textContent).not.toContain('The directory is not deleted.');
    expect(card.textContent).not.toContain('Releases the resident workspace instance');
    expect(card.textContent).not.toContain('Longest-edge limit for images');
    expect(card.textContent).not.toContain('larger images are compressed first');
    const openHelp = async (label: string): Promise<string> => {
      const field = [...card.querySelectorAll('label')].find((node) => node.textContent === label)!;
      const trigger = field.parentElement!.querySelector<HTMLButtonElement>('[data-setting-help]')!;
      await act(async () => { trigger.click(); });
      // Read through this trigger's own describedby target: each `i` owns its
      // own bubble, so a page-level query would prove nothing.
      const id = trigger.getAttribute('aria-describedby');
      return id === null ? '' : document.querySelector(`#${id}`)?.textContent ?? '';
    };
    const idleHelp = await openHelp('Workspace idle reclamation (s)');
    expect(idleHelp).toContain('The directory is not deleted.');
    expect(idleHelp).toContain('300 s');
    expect(await openHelp('Image maximum edge (px)')).toContain('2000 px');
    expect(await openHelp('Image read byte budget')).toContain('262144 bytes (256 KiB)');
    // A second tap on the same `i` puts that bubble away again.
    const budget = [...card.querySelectorAll('label')]
      .find((node) => node.textContent === 'Image read byte budget')!
      .parentElement!.querySelector<HTMLButtonElement>('[data-setting-help]')!;
    await act(async () => { budget.click(); });
    expect(budget.getAttribute('aria-describedby')).toBeNull();
    await setValue(fields[0]!, '2.5');
    await click([...card.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(patchConfig).toHaveBeenCalledWith({
      workspace_instance: { idle_ttl_ms: 2500 },
      image: { max_edge_px: 2048, read_byte_budget: 4_000_000 },
      replace_domains: ['workspace_instance', 'image'],
    });
  });

  it('clears a saved ceiling instead of writing the engine default', async () => {
    const container = await renderComponent(<ResourceLimitsCard />);
    const card = container.querySelector('#st-card-resource-limits')!;
    await setValue(card.querySelector<HTMLInputElement>('input')!, '');
    await click([...card.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    const patch = patchConfig.mock.calls.at(-1)![0] as { workspace_instance: Record<string, unknown> };
    expect(patch.workspace_instance['idle_ttl_ms']).toBeUndefined();
    expect(JSON.parse(JSON.stringify(patch.workspace_instance))).not.toHaveProperty('idle_ttl_ms');
  });
});
