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

import type {
  HumanTakeoverLease,
  MeshContextProjection,
  SshHost,
  SshHostStatus,
  SshSessionHostsResponse,
} from '@kiki/protocol';

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

function emptyMeshProjection(sessionId: string): MeshContextProjection {
  return {
    sessionId,
    revision: 1,
    contextBlock: null,
    byteLength: 0,
    lease: {
      sessionId,
      revision: 1,
      epoch: 1,
      updatedAt: 1_700_000_000_000,
      nodes: [],
      seats: [],
      workspaceCopies: [],
      portTunnels: [],
    },
  };
}

const mesh = {
  getSessionLease: vi.fn(async (sessionId: string): Promise<MeshContextProjection> => emptyMeshProjection(sessionId)),
  unpinResource: vi.fn(async (sessionId: string) => emptyMeshProjection(sessionId)),
  closeTunnel: vi.fn(async (_tunnelId: string) => ({ closed: true })),
  inspectTakeover: vi.fn(async (_targetId: string): Promise<{ lease: HumanTakeoverLease | null; epoch: number }> => ({
    lease: null,
    epoch: 0,
  })),
};

const connection: {
  client: {
    meta: ReturnType<typeof vi.fn>;
    klient: { rest: { ssh: typeof ssh; mesh?: typeof mesh } };
  };
} = {
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
  for (const fn of Object.values(mesh)) fn.mockClear();
  connection.client.meta.mockClear();
  connection.client.meta.mockResolvedValue({ experimental_flags: { native_ssh: true } });
  connection.client.klient.rest = { ssh };
  ssh.list.mockResolvedValue({ hosts: HOSTS });
  ssh.sessionHosts.mockResolvedValue({ hosts: [] });
  ssh.addSessionHost.mockResolvedValue({ ok: true });
  ssh.removeSessionHost.mockResolvedValue({ ok: true });
  ssh.upsert.mockImplementation(async (id: string): Promise<{ host: SshHost }> => ({ host: { id, name: id, source: 'kiki' } }));
  mesh.getSessionLease.mockImplementation(async (sessionId: string) => emptyMeshProjection(sessionId));
  mesh.unpinResource.mockImplementation(async (sessionId: string) => emptyMeshProjection(sessionId));
  mesh.closeTunnel.mockResolvedValue({ closed: true });
  mesh.inspectTakeover.mockResolvedValue({ lease: null, epoch: 0 });
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

  it('2 hosts: renders compact bare summary trigger and shows host chips inside upward popover', async () => {
    ssh.sessionHosts.mockResolvedValue({
      hosts: [
        { host: HOSTS[0]!, status: { hostId: 'h1', state: 'ready', generation: 1 } },
        { host: HOSTS[1]!, status: idleStatus('h2') },
      ],
    });
    const { container } = await renderHook('sess-1');
    const strip = container.querySelector('[data-composer-ssh-strip]');
    expect(strip).not.toBeNull();
    const toggle = strip!.querySelector<HTMLButtonElement>('[data-composer-ssh-toggle]')!;
    expect(toggle.textContent).toContain('Host One +1');
    // Popover is closed at rest: zero host chips mounted in the bar.
    expect(document.querySelectorAll('[data-composer-ssh-chip]').length).toBe(0);
    await act(async () => { toggle.click(); });
    await flush();
    expect(document.querySelectorAll('[data-composer-ssh-chip]').length).toBe(2);
    const chip = document.querySelector('[data-composer-ssh-chip="h1"]')!;
    const removeBtn = chip.querySelector('[data-composer-ssh-chip-remove]')!;
    expect(chip.className).toContain('h-6');
    expect(removeBtn.className).toContain('h-5');
    expect(removeBtn.className).toContain('w-5');
  });

  it('3 hosts: shows Host One +2 summary trigger and opens all 3 chips in popover', async () => {
    ssh.sessionHosts.mockResolvedValue({
      hosts: [
        { host: HOSTS[0]!, status: idleStatus('h1') },
        { host: HOSTS[1]!, status: idleStatus('h2') },
        { host: HOSTS[2]!, status: idleStatus('h3') },
      ],
    });
    const { container } = await renderHook('sess-1');
    const toggle = container.querySelector<HTMLButtonElement>('[data-composer-ssh-toggle]')!;
    expect(toggle.textContent).toContain('Host One +2');
    await act(async () => { toggle.click(); });
    await flush();
    expect(document.querySelectorAll('[data-composer-ssh-chip]').length).toBe(3);
  });

  it('4 hosts: shows Host One +3 summary trigger and opens/closes all 4 chips via popover', async () => {
    ssh.sessionHosts.mockResolvedValue({
      hosts: [
        { host: HOSTS[0]!, status: idleStatus('h1') },
        { host: HOSTS[1]!, status: idleStatus('h2') },
        { host: HOSTS[2]!, status: idleStatus('h3') },
        { host: HOSTS[3]!, status: idleStatus('h4') },
      ],
    });
    const { container } = await renderHook('sess-1');
    const toggle = container.querySelector<HTMLButtonElement>('[data-composer-ssh-toggle]')!;
    expect(toggle.textContent).toContain('Host One +3');
    expect(document.querySelectorAll('[data-composer-ssh-chip]').length).toBe(0);

    await act(async () => { toggle.click(); });
    await flush();
    expect(document.querySelectorAll('[data-composer-ssh-chip]').length).toBe(4);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    await act(async () => { toggle.click(); });
    await flush();
    expect(document.querySelectorAll('[data-composer-ssh-chip]').length).toBe(0);
  });

  it('5 hosts: shows Host One +4 summary trigger and opens all 5 chips in popover', async () => {
    ssh.sessionHosts.mockResolvedValue({
      hosts: HOSTS.map((h) => ({ host: h, status: idleStatus(h.id) })),
    });
    const { container } = await renderHook('sess-1');
    const toggle = container.querySelector<HTMLButtonElement>('[data-composer-ssh-toggle]')!;
    expect(toggle.textContent).toContain('Host One +4');
    await act(async () => { toggle.click(); });
    await flush();
    expect(document.querySelectorAll('[data-composer-ssh-chip]').length).toBe(5);
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
    const toggleA = container.querySelector<HTMLButtonElement>('[data-composer-ssh-toggle]')!;
    expect(toggleA.textContent).toContain('Host One +3');

    await act(async () => { toggleA.click(); });
    await flush();
    expect(document.querySelectorAll('[data-composer-ssh-chip]').length).toBe(4);

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

    // sess-b has 1 host: summary updates to Host One
    expect(container.querySelector('[data-composer-ssh-toggle]')?.textContent).toContain('Host One');
    expect(container.querySelector('[data-composer-ssh-toggle]')?.textContent).not.toContain('+');
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
    expect(container.querySelector('[data-composer-ssh-toggle]')?.textContent).toContain('Host One');
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

    // The panel must not be blank: it lists both the previously joined host and
    // the newly added one (the reported failure was a blank panel right here).
    const panelAfter = container.querySelector('[data-composer-ssh-panel]');
    expect(panelAfter).not.toBeNull();
    expect(panelAfter!.querySelector('[data-composer-ssh-host="h1"]')).not.toBeNull();
    expect(panelAfter!.querySelector('[data-composer-ssh-host="newhost"]')).not.toBeNull();
    expect(panelAfter!.textContent?.trim()).not.toBe('');

    // The resident strip keeps showing both hosts (`Host One +1`), not a blank card.
    expect(container.querySelector('[data-composer-ssh-toggle]')?.textContent).toContain('Host One +1');
  });

  it('stays hidden when SSH=0 and Mesh=0 even with mesh REST wired', async () => {
    connection.client.klient.rest = { ssh, mesh };
    ssh.sessionHosts.mockResolvedValue({ hosts: [] });
    mesh.getSessionLease.mockResolvedValue(emptyMeshProjection('sess-idle'));

    const { container } = await renderHook('sess-idle');
    expect(mesh.getSessionLease).toHaveBeenCalledWith('sess-idle');
    expect(container.querySelector('[data-composer-ssh-strip]')).toBeNull();
  });

  it('unifies pinned Mesh resources and active port tunnels into the upward capsule with unpin, close-tunnel, human_controlling mark, and Escape dismissal', async () => {
    connection.client.meta.mockResolvedValue({ experimental_flags: { native_ssh: false } });
    connection.client.klient.rest = { ssh, mesh };

    let currentProjection: MeshContextProjection = {
      sessionId: 'sess-mesh',
      revision: 3,
      contextBlock: null,
      byteLength: 0,
      lease: {
        sessionId: 'sess-mesh',
        revision: 3,
        epoch: 2,
        updatedAt: 1_700_000_000_000,
        nodes: [
          {
            nodeId: 'node-gpu',
            label: 'GPU Mac',
            trustTier: 'trusted_personal',
            capabilities: ['execute', 'port_tunnel'],
            state: 'online',
            platform: 'darwin',
            pinnedAt: 1_700_000_000_000,
            createdBySession: false,
          },
        ],
        seats: [
          {
            seatId: 'seat-1',
            nodeId: 'node-gpu',
            label: 'Claude Seat',
            state: 'running',
            pinnedAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            createdBySession: true,
          },
        ],
        workspaceCopies: [
          {
            copyId: 'copy-1',
            nodeId: 'node-gpu',
            sourceRoot: '/Users/dev/repos/kiki',
            copyPath: '/tmp/cow/copy-1',
            strategy: 'apfs_clone',
            dirty: true,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
          },
        ],
        portTunnels: [
          {
            tunnelId: 'tun-5173',
            nodeId: 'node-gpu',
            remoteHost: '127.0.0.1',
            remotePort: 3000,
            localHost: '127.0.0.1',
            localPort: 5173,
            healthy: true,
            createdAt: 1_700_000_000_000,
          },
        ],
      },
    };
    mesh.getSessionLease.mockImplementation(async () => currentProjection);
    mesh.inspectTakeover.mockImplementation(async (targetId: string) => ({
      lease: targetId === 'node-gpu'
        ? {
            targetId: 'node-gpu',
            holder: 'human',
            epoch: 4,
            acquiredAt: Date.now() - 10_000,
            expiresAt: Date.now() + 60_000,
            reason: 'manual debug',
          }
        : null,
      epoch: 4,
    }));

    const { container } = await renderHook('sess-mesh');
    const strip = container.querySelector('[data-composer-ssh-strip]');
    expect(strip).not.toBeNull();
    const toggle = strip!.querySelector<HTMLButtonElement>('[data-composer-ssh-toggle]')!;
    expect(toggle.textContent).toContain('GPU Mac +3');
    // Takeover is only probed lazily once the popover opens.
    expect(mesh.inspectTakeover).not.toHaveBeenCalled();

    await act(async () => { toggle.click(); });
    await flush();
    await flush();

    const popup = document.querySelector<HTMLElement>('[data-composer-ssh-list]');
    expect(popup).not.toBeNull();
    expect(popup!.dataset['floatingOwner']).toBe('composer-ssh-strip');
    expect(popup!.querySelector('[data-composer-mesh-section]')).not.toBeNull();
    expect(popup!.querySelector('[data-composer-mesh-item="node:node-gpu"]')).not.toBeNull();
    expect(popup!.querySelector('[data-composer-mesh-item="seat:seat-1"]')).not.toBeNull();
    expect(popup!.querySelector('[data-composer-mesh-item="workspace_copy:copy-1"]')).not.toBeNull();
    expect(popup!.querySelector('[data-composer-mesh-tunnel="tun-5173"]')?.textContent).toContain('127.0.0.1:5173 → 3000');
    expect(popup!.querySelector('[data-composer-mesh-item="node:node-gpu"] [data-composer-mesh-takeover="human"]')).not.toBeNull();
    // Native SSH flag is off so the SSH host panel is omitted cleanly.
    expect(popup!.querySelector('[data-composer-ssh-panel]')).toBeNull();

    // Unpinning the node calls unpinResource and updates the summary count.
    currentProjection = {
      ...currentProjection,
      lease: { ...currentProjection.lease, nodes: [] },
    };
    const unpinNodeBtn = popup!.querySelector<HTMLButtonElement>('[data-composer-mesh-unpin="node:node-gpu"]')!;
    await act(async () => { unpinNodeBtn.click(); });
    await flush();
    await flush();
    expect(mesh.unpinResource).toHaveBeenCalledWith('sess-mesh', { kind: 'node', id: 'node-gpu' });
    expect(toggle.textContent).toContain('Claude Seat +2');

    // Closing the port tunnel closes it on the server, unpins it from the session lease, and updates count.
    currentProjection = {
      ...currentProjection,
      lease: { ...currentProjection.lease, portTunnels: [] },
    };
    const closeTunnelBtn = document.querySelector<HTMLButtonElement>('[data-composer-mesh-tunnel-close="tun-5173"]')!;
    await act(async () => { closeTunnelBtn.click(); });
    await flush();
    await flush();
    expect(mesh.closeTunnel).toHaveBeenCalledWith('tun-5173');
    expect(mesh.unpinResource).toHaveBeenCalledWith('sess-mesh', { kind: 'port_tunnel', id: 'tun-5173' });
    expect(toggle.textContent).toContain('Claude Seat +1');

    // Escape dismisses the upward popover cleanly.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flush();
    expect(document.querySelector('[data-composer-ssh-list]')).toBeNull();
  });

  it('combines SSH host count with pinned Mesh node and port tunnel count in the single capsule', async () => {
    connection.client.klient.rest = { ssh, mesh };
    ssh.sessionHosts.mockResolvedValue({
      hosts: [{ host: HOSTS[0]!, status: { hostId: 'h1', state: 'ready', generation: 1 } }],
    });
    mesh.getSessionLease.mockResolvedValue({
      sessionId: 'sess-both',
      revision: 1,
      contextBlock: null,
      byteLength: 0,
      lease: {
        sessionId: 'sess-both',
        revision: 1,
        epoch: 1,
        updatedAt: 1_700_000_000_000,
        nodes: [
          {
            nodeId: 'node-1',
            label: 'Mac Studio',
            trustTier: 'trusted_personal',
            capabilities: ['execute'],
            state: 'online',
            pinnedAt: 1_700_000_000_000,
            createdBySession: false,
          },
        ],
        seats: [],
        workspaceCopies: [],
        portTunnels: [
          {
            tunnelId: 'tun-8080',
            nodeId: 'node-1',
            remoteHost: '127.0.0.1',
            remotePort: 8080,
            localHost: '127.0.0.1',
            localPort: 18080,
            healthy: true,
            createdAt: 1_700_000_000_000,
          },
        ],
      },
    });

    const { container } = await renderHook('sess-both');
    const toggle = container.querySelector<HTMLButtonElement>('[data-composer-ssh-toggle]')!;
    // 1 SSH host + 1 Mesh node + 1 port tunnel = 3 total -> "Host One +2"
    expect(toggle.textContent).toContain('Host One +2');

    await act(async () => { toggle.click(); });
    await flush();
    const popup = document.querySelector<HTMLElement>('[data-composer-ssh-list]')!;
    expect(popup.querySelector('[data-composer-ssh-chip="h1"]')).not.toBeNull();
    expect(popup.querySelector('[data-composer-mesh-item="node:node-1"]')).not.toBeNull();
    expect(popup.querySelector('[data-composer-mesh-tunnel="tun-8080"]')).not.toBeNull();
    expect(popup.querySelector('[data-composer-ssh-panel]')).not.toBeNull();
  });
});
