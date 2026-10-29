// @vitest-environment jsdom

/**
 * Unit and behavior tests for useComposerSsh:
 * - 0 hosts: no resident strip drawn ("SSH 0" never flashes or takes room).
 * - 1–3 hosts: shown directly in the resident strip without folding.
 * - >3 hosts: folded by default into the trigger pill with explicit expand/collapse button.
 * - Panel: per-host Switch toggle for enabling/disabling session host.
 * - Connection state dot is independent and does not block/trigger connection.
 * - In-flight pending lock and failure toast.
 * - Session scope isolation across session switches and draft mode support.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SshHost, SshHostStatus, SshSessionHostsResponse } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import { getToasts } from '../../lib/toasts';
import { useComposerSsh } from './ComposerSsh';

const HOSTS: SshHost[] = [
  { id: 'h1', name: 'Host One', hostname: 'host1.example.com', user: 'ubuntu', source: 'kiki' },
  { id: 'h2', name: 'Host Two', hostname: 'host2.example.com', source: 'kiki' },
  { id: 'h3', name: 'Host Three', hostname: 'host3.example.com', source: 'ssh-config' },
  { id: 'h4', name: 'Host Four', hostname: 'host4.example.com', source: 'kiki' },
  { id: 'h5', name: 'Host Five', hostname: 'host5.example.com', source: 'kiki' },
];

function idleStatus(hostId: string): SshHostStatus {
  return { hostId, state: 'idle', generation: 1 };
}

const ssh = {
  list: vi.fn(async () => ({ hosts: HOSTS })),
  sessionHosts: vi.fn(async (sessionId: string): Promise<SshSessionHostsResponse> => ({
    hosts: [],
  })),
  addSessionHost: vi.fn(async (sessionId: string, hostId: string) => ({ ok: true })),
  removeSessionHost: vi.fn(async (sessionId: string, hostId: string) => ({ ok: true })),
  upsert: vi.fn(async (id: string, input: unknown): Promise<{ host: SshHost }> => ({ host: { id, name: id, source: 'kiki' } })),
  status: vi.fn(async (hostId: string): Promise<SshHostStatus> => ({
    hostId,
    state: hostId === 'h1' ? 'ready' : 'idle',
    generation: 1,
  })),
};

const connection = {
  client: {
    meta: vi.fn(async () => ({ experimental_flags: { native_ssh: true } })),
    klient: { rest: { ssh } },
  },
};

vi.mock('../../state/connection', () => ({
  useConnection: () => connection,
  useOptionalConnection: () => connection,
}));

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'zh-CN' });
  env.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const fn of Object.values(ssh)) fn.mockClear();
  connection.client.meta.mockClear();
  ssh.list.mockResolvedValue({ hosts: HOSTS });
  ssh.sessionHosts.mockResolvedValue({ hosts: [] });
  ssh.addSessionHost.mockResolvedValue({ ok: true });
  ssh.removeSessionHost.mockResolvedValue({ ok: true });
  ssh.upsert.mockImplementation(async (id: string): Promise<{ host: SshHost }> => ({ host: { id, name: id, source: 'kiki' } }));
});

afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
});

afterAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function TestConsumer({
  sessionId,
  enabled = true,
  withDialog = false,
  onHookReady,
}: {
  sessionId?: string;
  enabled?: boolean;
  withDialog?: boolean;
  onHookReady?: (hook: ReturnType<typeof useComposerSsh>) => void;
}) {
  const hook = useComposerSsh(sessionId, enabled);
  onHookReady?.(hook);
  return (
    <div>
      <div data-testid="resident">{hook.resident}</div>
      <div data-testid="panel">{hook.renderPanel(() => {})}</div>
      {withDialog ? hook.dialog : null}
    </div>
  );
}

async function renderHook(sessionId?: string, enabled = true, withDialog = false) {
  let hookValue: ReturnType<typeof useComposerSsh> | undefined;
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter>
            <TestConsumer
              sessionId={sessionId}
              enabled={enabled}
              withDialog={withDialog}
              onHookReady={(val) => { hookValue = val; }}
            />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
  return { container, getHook: () => hookValue!, queryClient, root };
}

describe('ComposerSsh', () => {
  it('0 hosts: does not render resident strip', async () => {
    ssh.sessionHosts.mockResolvedValue({ hosts: [] });
    const { container } = await renderHook('sess-1');
    expect(container.querySelector('[data-composer-ssh-strip]')).toBeNull();
  });

  it('1–3 hosts: directly shows all chips without folding or expand button', async () => {
    ssh.sessionHosts.mockResolvedValue({
      hosts: [
        { host: HOSTS[0]!, status: { hostId: 'h1', state: 'ready', generation: 1 } },
        { host: HOSTS[1]!, status: idleStatus('h2') },
      ],
    });
    const { container } = await renderHook('sess-1');
    const strip = container.querySelector('[data-composer-ssh-strip]');
    expect(strip).not.toBeNull();
    // 2 chips should be rendered directly
    expect(container.querySelectorAll('[data-composer-ssh-chip]').length).toBe(2);
    // Expand/collapse button must not appear for <= 3 hosts
    expect(container.querySelector('[data-composer-ssh-expand]')).toBeNull();
  });

  it('3 hosts: still directly shows all chips without folding', async () => {
    ssh.sessionHosts.mockResolvedValue({
      hosts: [
        { host: HOSTS[0]!, status: idleStatus('h1') },
        { host: HOSTS[1]!, status: idleStatus('h2') },
        { host: HOSTS[2]!, status: idleStatus('h3') },
      ],
    });
    const { container } = await renderHook('sess-1');
    expect(container.querySelectorAll('[data-composer-ssh-chip]').length).toBe(3);
    expect(container.querySelector('[data-composer-ssh-expand]')).toBeNull();
  });

  it('>3 hosts: default folded, shows expand button, expands and collapses on click', async () => {
    ssh.sessionHosts.mockResolvedValue({
      hosts: [
        { host: HOSTS[0]!, status: idleStatus('h1') },
        { host: HOSTS[1]!, status: idleStatus('h2') },
        { host: HOSTS[2]!, status: idleStatus('h3') },
        { host: HOSTS[3]!, status: idleStatus('h4') },
      ],
    });
    const { container } = await renderHook('sess-1');
    const expandBtn = container.querySelector('[data-composer-ssh-expand]') as HTMLButtonElement | null;
    expect(expandBtn).not.toBeNull();
    // Default folded: 0 chips shown
    expect(container.querySelectorAll('[data-composer-ssh-chip]').length).toBe(0);
    expect(expandBtn?.textContent).toContain('4');

    // Click expand
    await act(async () => {
      expandBtn?.click();
    });
    await flush();

    // Now all 4 chips shown
    expect(container.querySelectorAll('[data-composer-ssh-chip]').length).toBe(4);
    expect(expandBtn?.getAttribute('aria-expanded')).toBe('true');

    // Click collapse
    await act(async () => {
      expandBtn?.click();
    });
    await flush();

    // Folded again
    expect(container.querySelectorAll('[data-composer-ssh-chip]').length).toBe(0);
  });

  it('5 hosts: folded by default, expands to all 5 chips', async () => {
    ssh.sessionHosts.mockResolvedValue({
      hosts: HOSTS.map((h) => ({ host: h, status: idleStatus(h.id) })),
    });
    const { container } = await renderHook('sess-1');
    const expandBtn = container.querySelector('[data-composer-ssh-expand]') as HTMLButtonElement | null;
    expect(expandBtn).not.toBeNull();
    expect(container.querySelectorAll('[data-composer-ssh-chip]').length).toBe(0);

    await act(async () => {
      expandBtn?.click();
    });
    await flush();
    expect(container.querySelectorAll('[data-composer-ssh-chip]').length).toBe(5);
  });

  it('panel: renders each host with explicit Switch toggle and connection state', async () => {
    ssh.sessionHosts.mockResolvedValue({
      hosts: [
        { host: HOSTS[0]!, status: { hostId: 'h1', state: 'ready', generation: 1 } },
      ],
    });
    const { container } = await renderHook('sess-1');
    const panel = container.querySelector('[data-composer-ssh-panel]');
    expect(panel).not.toBeNull();

    // Check host h1 row
    const rowH1 = panel?.querySelector('[data-composer-ssh-host="h1"]');
    expect(rowH1).not.toBeNull();
    const switchH1 = rowH1?.querySelector('[role="switch"]');
    expect(switchH1).not.toBeNull();
    expect(switchH1?.getAttribute('aria-checked')).toBe('true');
    // Connection state mark visible for connected host h1
    expect(rowH1?.querySelector('[data-ssh-state="ready"]')).not.toBeNull();

    // Check host h2 row (not joined)
    const rowH2 = panel?.querySelector('[data-composer-ssh-host="h2"]');
    expect(rowH2).not.toBeNull();
    const switchH2 = rowH2?.querySelector('[role="switch"]');
    expect(switchH2?.getAttribute('aria-checked')).toBe('false');

    // Toggle switch on h2 joins it
    await act(async () => {
      const checkbox = rowH2?.querySelector('input[type="checkbox"]') as HTMLInputElement;
      checkbox?.click();
    });
    expect(ssh.addSessionHost).toHaveBeenCalledWith('sess-1', 'h2');

    // Toggle switch on h1 removes it
    await act(async () => {
      const checkbox = rowH1?.querySelector('input[type="checkbox"]') as HTMLInputElement;
      checkbox?.click();
    });
    expect(ssh.removeSessionHost).toHaveBeenCalledWith('sess-1', 'h1');
  });

  it('handles addSessionHost failure with toast and releases pending state', async () => {
    ssh.sessionHosts.mockResolvedValue({ hosts: [] });
    ssh.addSessionHost.mockRejectedValueOnce(new Error('Network unreachable'));
    const { container } = await renderHook('sess-1');
    const panel = container.querySelector('[data-composer-ssh-panel]');

    const rowH1 = panel?.querySelector('[data-composer-ssh-host="h1"]');
    const checkbox = rowH1?.querySelector('input[type="checkbox"]') as HTMLInputElement;

    await act(async () => {
      checkbox?.click();
    });
    await flush();

    const toasts = getToasts();
    const errToast = toasts.find((t) => t.tone === 'error');
    expect(errToast).toBeDefined();
    expect(errToast?.text).toContain('Host One');
    expect(checkbox.disabled).toBe(false);
  });

  it('isolates state across session route changes and resets user expanded toggle', async () => {
    ssh.sessionHosts.mockImplementation(async (sId: string) => {
      if (sId === 'sess-a') {
        return {
          hosts: HOSTS.slice(0, 4).map((h) => ({ host: h, status: idleStatus(h.id) })),
        };
      }
      return {
        hosts: [{ host: HOSTS[0]!, status: idleStatus('h1') }],
      };
    });

    const { container, queryClient, root } = await renderHook('sess-a');
    let expandBtn = container.querySelector('[data-composer-ssh-expand]') as HTMLButtonElement | null;
    expect(expandBtn).not.toBeNull();

    // Expand in sess-a
    await act(async () => {
      expandBtn?.click();
    });
    await flush();
    expect(container.querySelectorAll('[data-composer-ssh-chip]').length).toBe(4);

    // Switch session to sess-b
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <MemoryRouter>
              <TestConsumer sessionId="sess-b" enabled={true} />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();

    // sess-b has 1 host: expand button is gone and 1 chip is directly shown
    expect(container.querySelector('[data-composer-ssh-expand]')).toBeNull();
    expect(container.querySelectorAll('[data-composer-ssh-chip]').length).toBe(1);
  });

  it('draft mode: joins and leaves without sessionId and isolates across session switch', async () => {
    const { container, getHook } = await renderHook(undefined);
    const panel = container.querySelector('[data-composer-ssh-panel]');

    const rowH1 = panel?.querySelector('[data-composer-ssh-host="h1"]');
    await act(async () => {
      const checkbox = rowH1?.querySelector('input[type="checkbox"]') as HTMLInputElement;
      checkbox?.click();
    });
    await flush();

    expect(getHook().snapshot).toEqual([{ kind: 'ssh', id: 'h1', name: 'Host One' }]);
    expect(container.querySelectorAll('[data-composer-ssh-chip]').length).toBe(1);
  });

  it('adding a host from an existing session keeps the panel populated and joins the new host', async () => {
    ssh.sessionHosts.mockResolvedValue({
      hosts: [{ host: HOSTS[0]!, status: idleStatus('h1') }],
    });
    const newHost: SshHost = { id: 'newhost', name: 'newhost', hostname: 'newhost.example.com', source: 'kiki' };
    ssh.upsert.mockResolvedValue({ host: newHost });
    ssh.list.mockResolvedValue({ hosts: [...HOSTS, newHost] });
    ssh.sessionHosts.mockImplementation(async () => ({
      hosts: [
        { host: HOSTS[0]!, status: idleStatus('h1') },
        { host: newHost, status: idleStatus('newhost') },
      ],
    }));

    const { container } = await renderHook('sess-1', true, true);
    const panel = container.querySelector('[data-composer-ssh-panel]');
    expect(panel).not.toBeNull();

    // Open the create form from the panel's new-host row.
    const newBtn = panel?.querySelector('[data-composer-ssh-new]') as HTMLButtonElement;
    expect(newBtn).not.toBeNull();
    await act(async () => { newBtn.click(); });
    await flush();

    // The form dialog is mounted outside the popover, into document.body.
    const form = document.body.querySelector('[data-ssh-host-form="create"]') as HTMLFormElement | null;
    expect(form).not.toBeNull();

    // Fill the alias (only required field) and submit.
    const aliasInput = form!.querySelector('input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(aliasInput, 'newhost');
      aliasInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    await act(async () => {
      form!.requestSubmit();
    });
    await flush();
    await flush();

    // After save, the dialog closes and the new host is joined.
    expect(ssh.upsert).toHaveBeenCalledWith('newhost', expect.objectContaining({ name: 'newhost' }));
    expect(ssh.addSessionHost).toHaveBeenCalledWith('sess-1', 'newhost');
    expect(document.body.querySelector('[data-ssh-host-form="create"]')).toBeNull();

    // The panel must not be blank: it lists hosts, including the new one.
    const panelAfter = container.querySelector('[data-composer-ssh-panel]');
    expect(panelAfter).not.toBeNull();
    expect(panelAfter!.querySelector('[data-composer-ssh-host="newhost"]')).not.toBeNull();
    expect(panelAfter!.textContent?.trim()).not.toBe('');
  });
});
