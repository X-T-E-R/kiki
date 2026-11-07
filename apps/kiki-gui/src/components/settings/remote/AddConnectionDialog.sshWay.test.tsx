// @vitest-environment jsdom

/**
 * The add-connection form's second way in. The SSH tab used to be unreachable
 * in practice: only Settings › SSH hosts passed the saved hosts, so the add
 * form always showed the URL way alone. The form now reads the same control
 * home's SSH hosts under the same flag the SSH page uses, and says where to
 * add one when there are none.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteConnection, SshHost } from '@kiki/protocol';

import { I18nProvider } from '../../../i18n';
import { AddConnectionDialog } from './AddConnectionDialog';

const HOST: SshHost = {
  id: 'ssh-acme', name: 'acme-box', source: 'kiki', hostname: '10.0.0.9', user: 'kiki', port: 22,
} as SshHost;

const listHosts = vi.fn();
const meta = vi.fn();
const listSpaces = vi.fn();
const sshConnect = vi.fn();
const navigate = vi.fn();

function client(nativeSsh: boolean) {
  return {
    meta,
    klient: {
      rest: {
        homes: { list: listSpaces },
        connections: { list: vi.fn().mockResolvedValue([]), add: vi.fn(), pair: vi.fn(), sshConnect },
        ssh: { list: listHosts },
      },
    },
  } as never;
}

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
const roots: Root[] = [];

async function render(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  // A fresh cache per render: `meta` and the SSH host list are shared query
  // keys, so a reused client would let one case answer another's question.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter>{node}</MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  // The SSH way is gated on this home's `/meta` flag, and the host list on
  // that flag resolving true: both are awaited before the form is judged.
  for (let tick = 0; tick < 6; tick += 1) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  return { container, document };
}

beforeAll(() => { vi.stubGlobal('navigator', { language: 'en-US' }); env.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { env.IS_REACT_ACT_ENVIRONMENT = false; vi.unstubAllGlobals(); });
beforeEach(() => {
  navigate.mockReset();
  listHosts.mockReset().mockResolvedValue({ hosts: [HOST] });
  listSpaces.mockReset().mockResolvedValue({ items: [{ id: 'main', name: 'Main space', path: 'C:/kiki', primary: true }] });
  sshConnect.mockReset().mockResolvedValue({ id: 'c1', label: 'acme-box' });
  meta.mockReset().mockResolvedValue({ experimental_flags: { native_ssh: true } });
});
afterEach(async () => {
  // The dialog renders through a portal on document.body, so the container is
  // not enough to clear it; every root is unmounted first.
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  document.body.innerHTML = '';
});

describe('the SSH way into the add-connection form', () => {
  it('offers it when this home has a saved SSH host, without the caller passing one', async () => {
    const { document } = await render(
      <AddConnectionDialog client={client(true)} onClose={vi.fn()} onAdded={vi.fn()} />,
    );
    expect(document.querySelector('[data-remote-add-way="ssh"]')).not.toBeNull();
    // The URL way is untouched: it is still the first thing offered.
    expect(document.querySelector('[data-remote-add-way="url"]')).not.toBeNull();
  });

  it('hides it when this home cannot reach one over SSH', async () => {
    meta.mockResolvedValue({ experimental_flags: { native_ssh: false } });
    const { document } = await render(
      <AddConnectionDialog client={client(false)} onClose={vi.fn()} onAdded={vi.fn()} />,
    );
    expect(document.querySelector('[data-remote-add-way="ssh"]')).toBeNull();
  });

  it('connects over SSH from the saved host without a preview plan', async () => {
    const onAdded = vi.fn();
    const { document } = await render(
      <AddConnectionDialog client={client(true)} onClose={vi.fn()} onAdded={onAdded} />,
    );
    expect(listHosts).toHaveBeenCalled();
    await act(async () => { (document.querySelector('[data-remote-add-way="ssh"]') as HTMLButtonElement).click(); });
    for (let tick = 0; tick < 4; tick += 1) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(document.querySelector('[data-remote-ssh-plan]')).toBeNull();
    expect(document.querySelector('[data-remote-ssh-form]')).not.toBeNull();
    await act(async () => { (document.querySelector('[data-remote-ssh-submit]') as HTMLButtonElement).click(); });
    expect(sshConnect).toHaveBeenCalledWith(expect.objectContaining({
      label: 'acme-box',
      backgroundSummary: true,
      profile: expect.objectContaining({
        target: { kind: 'host', hostname: '10.0.0.9', username: 'kiki', port: 22 },
        releaseChannel: 'stable',
        remoteHome: 'C:/kiki',
      }),
    }));
    expect(onAdded).toHaveBeenCalledTimes(1);
  });

  it('points at the SSH page when this home can reach one but has saved none', async () => {
    listHosts.mockResolvedValue({ hosts: [] });
    const { document } = await render(
      <AddConnectionDialog client={client(true)} onClose={vi.fn()} onAdded={vi.fn()} />,
    );
    const note = document.querySelector('[data-remote-ssh-no-hosts]');
    expect(note).not.toBeNull();
    // The tab is still there: the way exists, there is just nothing to pick yet.
    expect(document.querySelector('[data-remote-add-way="ssh"]')).not.toBeNull();
  });

  it('pairs from an address and a code, and refuses an empty form', async () => {
    const pair = vi.fn().mockResolvedValue({ id: 'c1', label: 'B' } as RemoteConnection);
    const clientWithAdd = {
      ...(client(true) as unknown as { klient: { rest: Record<string, unknown> } }),
      klient: { rest: { homes: { list: listSpaces }, ssh: { list: listHosts },
        connections: { list: vi.fn().mockResolvedValue([]), pair } } },
    } as never;
    const onAdded = vi.fn();
    const { document } = await render(
      <AddConnectionDialog client={clientWithAdd} onClose={vi.fn()} onAdded={onAdded} />,
    );
    const form = document.querySelector('[data-remote-add-form]') as HTMLFormElement;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(pair).not.toHaveBeenCalled();
    const setValue = (element: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const endpoint = document.querySelector('[data-remote-endpoint]') as HTMLInputElement;
    const code = document.querySelector('[data-remote-code]') as HTMLInputElement;
    await act(async () => {
      setValue(endpoint, 'http://192.168.1.40:5523');
      setValue(code, 'k9f27x4m');
    });
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(pair).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'http://192.168.1.40:5523', code: 'K9F2-7X4M', backgroundSummary: true }));
    expect(onAdded).toHaveBeenCalledTimes(1);
  });
});
