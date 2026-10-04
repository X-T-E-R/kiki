// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { AddSourceDialog } from './AddSourceDialog';
import type { InstallRequest } from './InstallFlow';

const getConfig = vi.fn(async () => ({ plugins: { marketplaceUrl: 'https://example.test/catalog.json' } }));
const patchConfig = vi.fn(async (body: unknown) => body);
vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { getConfig, patchConfig } }),
}));
vi.mock('../../host', () => ({ useHost: () => ({ kind: 'browser' }) }));

const mounted: Root[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
beforeAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = false; });
beforeEach(() => {
  localStorage.setItem('kiki.locale', 'en');
  getConfig.mockClear();
  patchConfig.mockClear();
});
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => { root.unmount(); });
  document.body.replaceChildren();
});

async function render() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const onPreview = vi.fn<(request: InstallRequest) => void>();
  const onClose = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <AddSourceDialog onClose={onClose} onPreview={onPreview} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  return { container, onPreview, onClose };
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => { node.click(); });
}

// The dialog is a portal, so its content lives on the document, not in the
// container the tree was mounted into.
const panel = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const inPanel = <T extends HTMLElement>(selector: string): T => panel().querySelector<T>(selector)!;
const sourceInput = () => inPanel<HTMLInputElement>('[data-autofocus]');
const digestInput = () => inPanel<HTMLInputElement>('input[aria-invalid]');
const setSource = async (value: string) => { await type(sourceInput(), value); };

describe('AddSourceDialog', () => {
  it('asks for the one source of this install, and nothing else', async () => {
    await render();
    // The catalog address is a standing server setting, edited where it is
    // read (Plugins ▸ Advanced, and Settings). It is not this dialog's input.
    expect(panel().querySelector('[data-catalog-source]')).toBeNull();
    expect(panel().textContent).not.toContain('Advanced');
    expect(getConfig).not.toHaveBeenCalled();
    expect(patchConfig).not.toHaveBeenCalled();
    expect(sourceInput()).not.toBeNull();
  });

  it('carries a GitHub source to the one preview step', async () => {
    const { onPreview } = await render();
    await setSource('https://github.com/owner/repo');
    await click(inPanel('[data-add-source-submit]'));
    expect(onPreview).toHaveBeenCalledWith({
      source: 'https://github.com/owner/repo',
      sha256: undefined,
      displayName: 'repo',
    });
  });

  it('keeps the ZIP digest with its source, and a local folder as a path', async () => {
    const zip = await render();
    await click(inPanel('[data-segment="zip"]'));
    await setSource('https://example.test/plugin.zip');
    // Review stays shut until the digest is a real SHA-256: the preview is
    // the server's, and it checks what was reviewed.
    expect(inPanel<HTMLButtonElement>('[data-add-source-submit]').disabled).toBe(true);
    await type(digestInput(), 'a'.repeat(64));
    await click(inPanel('[data-add-source-submit]'));
    expect(zip.onPreview).toHaveBeenCalledWith({
      source: 'https://example.test/plugin.zip',
      sha256: 'a'.repeat(64),
      displayName: 'plugin',
    });

    document.querySelector<HTMLElement>('[role="dialog"]')!.remove();
    const path = await render();
    await click(inPanel('[data-segment="path"]'));
    await setSource('C:/projects/my-plugin');
    await click(inPanel('[data-add-source-submit]'));
    expect(path.onPreview).toHaveBeenCalledWith({
      source: 'C:/projects/my-plugin',
      sha256: undefined,
      displayName: 'my-plugin',
    });
  });

  it('keeps the catalog editor reachable from the page that reads it', async () => {
    // The other two mounts still exist; this dialog is simply not one of them.
    const { CatalogSourceField } = await import('./AddSourceDialog');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(root);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <I18nProvider>
            <CatalogSourceField />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    // It reads the standing value, so the address a user set in Settings is
    // the one an install dialog would have shown too.
    const field = container.querySelector<HTMLInputElement>('[data-catalog-source] input');
    for (let attempt = 0; attempt < 10 && field?.value === ''; attempt += 1) {
      await act(async () => { await new Promise((done) => { setTimeout(done, 0); }); });
    }
    expect(field?.value).toBe('https://example.test/catalog.json');
  });
});
