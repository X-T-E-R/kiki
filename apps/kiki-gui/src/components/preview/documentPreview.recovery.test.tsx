// @vitest-environment jsdom

/**
 * The Office preview recovery, driven through the three real states the server
 * reports. Each one has to do a different thing to the same plugin, and none of
 * them may reach for a work mode, a second plugin, or an unconsented install.
 */

import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import type { KikiClient } from '../../lib/client';
import { RendererInstall } from './RendererInstall';

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
  vi.restoreAllMocks();
});

async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  await act(async () => { root.render(<I18nProvider>{node}</I18nProvider>); });
  return container;
}

async function click(container: HTMLElement, selector: string): Promise<void> {
  const button = container.querySelector(selector);
  expect(button, selector).not.toBeNull();
  await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    listPluginMarketplace: vi.fn(async () => ({ configured: true, entries: [{ id: 'kiki-office', displayName: 'Office', source: 'https://example.test/office.zip', sha256: 'a'.repeat(64), tier: 'official' }] })),
    previewPlugin: vi.fn(async () => ({ id: 'kiki-office', fingerprint: 'b'.repeat(64), changes: [], consentRequired: true, permissions: { fs: 'workspace' }, contributions: ['tool:office'], contextTokens: 100, unsupported: [] })),
    installPreviewedPlugin: vi.fn(async () => ({ id: 'kiki-office' })),
    setPluginEnabled: vi.fn(async () => ({ ok: true })),
    installPluginPrerequisite: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } as unknown as KikiClient;
}

describe('Office preview recovery follows the real plugin state', () => {
  it('installs a missing plugin through a previewed, consented, fingerprinted install, then the program', async () => {
    const client = fakeClient();
    const onInstalled = vi.fn();
    const container = await render(<RendererInstall client={client} pluginId="kiki-office" prerequisiteId="officecli" pluginState="not-installed" fileName="deck.pptx" onInstalled={onInstalled} />);

    // The offer says what will be installed before anything runs.
    expect(container.querySelector('[data-plugin-state="not-installed"]')).not.toBeNull();
    await click(container, '[data-install-dependency]');

    // The real plan is shown and the candidate is not run before consent.
    expect(client.previewPlugin).toHaveBeenCalledWith('https://example.test/office.zip', 'a'.repeat(64));
    expect(client.installPreviewedPlugin).not.toHaveBeenCalled();
    expect(container.querySelector('[data-consent-permissions]')?.textContent).toContain('workspace');

    await click(container, '[data-install-confirm]');
    expect(client.installPreviewedPlugin).toHaveBeenCalledWith({ source: 'https://example.test/office.zip', sha256: 'a'.repeat(64), fingerprint: 'b'.repeat(64), consent: true });
    // A new plugin lands disabled, so the same action turns it on.
    expect(client.setPluginEnabled).toHaveBeenCalledWith('kiki-office', true);
    expect(client.installPluginPrerequisite).toHaveBeenCalledWith('kiki-office', 'officecli');
    expect(onInstalled).toHaveBeenCalled();
  });

  it('turns a plugin the user disabled back on, without installing anything', async () => {
    const client = fakeClient();
    const onInstalled = vi.fn();
    const container = await render(<RendererInstall client={client} pluginId="kiki-office" prerequisiteId="officecli" pluginState="disabled" fileName="deck.pptx" onInstalled={onInstalled} />);

    // The consent says in as many words that this re-enables what they turned off.
    expect(container.querySelector('[data-renderer-ask]')?.textContent).toContain('switched off');
    await click(container, '[data-install-dependency]');

    expect(client.previewPlugin).not.toHaveBeenCalled();
    expect(client.installPreviewedPlugin).not.toHaveBeenCalled();
    expect(client.setPluginEnabled).toHaveBeenCalledWith('kiki-office', true);
    expect(client.installPluginPrerequisite).toHaveBeenCalledWith('kiki-office', 'officecli');
    expect(onInstalled).toHaveBeenCalled();
  });

  it('installs only the program when the plugin is already in place', async () => {
    const client = fakeClient();
    const onInstalled = vi.fn();
    const container = await render(<RendererInstall client={client} pluginId="kiki-office" prerequisiteId="officecli" pluginState="enabled" fileName="deck.pptx" onInstalled={onInstalled} />);

    await click(container, '[data-install-dependency]');
    expect(client.installPluginPrerequisite).toHaveBeenCalledWith('kiki-office', 'officecli');
    expect(client.setPluginEnabled).not.toHaveBeenCalled();
    expect(client.installPreviewedPlugin).not.toHaveBeenCalled();
    expect(onInstalled).toHaveBeenCalled();
  });

  it('says so instead of installing a substitute when this home does not offer the plugin', async () => {
    const client = fakeClient({ listPluginMarketplace: vi.fn(async () => ({ configured: true, entries: [] })) });
    const onInstalled = vi.fn();
    const container = await render(<RendererInstall client={client} pluginId="kiki-office" prerequisiteId="officecli" pluginState="not-installed" fileName="deck.pptx" onInstalled={onInstalled} />);

    await click(container, '[data-install-dependency]');
    expect(container.querySelector('[data-install-error]')?.textContent).toContain('kiki-office');
    expect(client.installPreviewedPlugin).not.toHaveBeenCalled();
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it('offers a retry where a step failed instead of making the user start over', async () => {
    const installPluginPrerequisite = vi.fn(async (): Promise<{ ok: true }> => { throw new Error('nope'); });
    const client = fakeClient();
    Object.assign(client, { installPluginPrerequisite });
    const onInstalled = vi.fn();
    const container = await render(<RendererInstall client={client} pluginId="kiki-office" prerequisiteId="officecli" pluginState="enabled" fileName="deck.pptx" onInstalled={onInstalled} />);

    await click(container, '[data-install-dependency]');
    expect(container.querySelector('[data-install-error]')?.textContent).toContain('nope');
    expect(onInstalled).not.toHaveBeenCalled();

    installPluginPrerequisite.mockResolvedValue({ ok: true });
    await click(container, '[data-retry-install]');
    expect(onInstalled).toHaveBeenCalled();
  });
});
