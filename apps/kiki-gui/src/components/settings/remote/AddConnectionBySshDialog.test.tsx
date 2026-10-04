// @vitest-environment jsdom

/**
 * Two remote-space surfaces that can only be judged from what the plan and the
 * message actually say: the SSH way into a space, and where a bridged message
 * came from.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONNECTION_PROTOCOL } from '@kiki/protocol';
import type { RemoteConnection, SshHost, SshRemotePlan } from '@kiki/protocol';
import type { UserBlock } from '@kiki/session-core/session';

import { I18nProvider } from '../../../i18n';
import { AddConnectionBySshDialog } from './AddConnectionBySshDialog';
import { BridgedOriginLine } from '../../message/BridgedOriginLine';
import { registerScopeNavigation } from '../../../lib/navScope';

const sshPlan = vi.fn();
const sshExecute = vi.fn();
const sshRegister = vi.fn();
const connections = { sshPlan, sshExecute, sshRegister, list: vi.fn(), add: vi.fn() };
const client = { klient: { rest: { connections } } } as never;
const host = { kind: 'tauri' as 'tauri' | 'browser' };

vi.mock('../../../host', () => ({ useHost: () => host }));
vi.mock('../../../state/connection', () => ({ useConnection: () => ({ localClient: null }) }));

/** The home a bridged message and a browsable remote space both name. */
const SOURCE_HOME = '1a5b2f0e-6c1d-4a2f-9b3e-2f0c1d2e3f40';

const PROFILE: SshHost = {
  id: 'ssh-1', name: 'acme-box', source: 'kiki', hostname: '10.0.0.9', user: 'kiki', port: 22,
} as SshHost;

function plan(state: SshRemotePlan['state']): SshRemotePlan {
  return {
    id: 'plan-1',
    profile: { id: 'profile-1', label: 'acme-box', target: { kind: 'alias', alias: 'ssh-1' }, releaseChannel: 'stable', remoteHome: 'C:/kiki', remoteExecutable: 'kiki', remoteShell: 'posix' },
    state,
    target: { homeId: SOURCE_HOME, hostId: 'acme-box', protocol: CONNECTION_PROTOCOL },
    serverId: state === 'attach' ? undefined : 'srv-1',
    expiresAt: Date.now() + 600_000,
    effects: { startsServer: state === 'ensure_required', serverLifetime: state === 'attach' ? 'existing' : 'until_explicit_stop', opensInbound: false, installsSoftware: false },
  };
}

function record(purposes: readonly ('gui' | 'bridge')[]): RemoteConnection {
  return {
    id: '2b6c3f1a-7d2e-4b3f-8c4f-3a1b2c3d4e50', label: 'ACME', endpoint: 'https://acme.test',
    target: { homeId: SOURCE_HOME, hostId: 'acme-box', protocol: CONNECTION_PROTOCOL },
    credentialRef: 'cred-1', enabled: true, backgroundSummary: false, purposes: [...purposes], state: 'online',
    activeLeases: 0,
  };
}

function bridged(sourceHomeId: string | undefined, location: 'local' | 'network' = 'network'): UserBlock {
  return {
    kind: 'user', id: 'user-1', text: 'from the other machine', createdAt: '2026-10-03T00:00:00Z',
    bridgedPeer: { source: { hostId: 'acme-box', workspaceId: 'main', sessionId: 'session_x' }, sourceHomeId, targetHomeId: 'local-home', bridgeId: 'bridge-1', revision: 3, location, messageId: 'm1' },
  } as UserBlock;
}

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
const roots: Root[] = [];
function render(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  roots.push(root);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>{node}</I18nProvider>
      </QueryClientProvider>,
    );
  });
  // Dialogs render through a portal on document.body; the own container is empty.
  return { container: document.body, root, queryClient };
}

beforeAll(() => { vi.stubGlobal('navigator', { language: 'en-US' }); env.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { env.IS_REACT_ACT_ENVIRONMENT = false; vi.unstubAllGlobals(); });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => { root.unmount(); }); document.body.innerHTML = ''; });

describe('adding a remote space over SSH', () => {
  beforeEach(() => {
    host.kind = 'tauri';
    sshPlan.mockReset();
    sshExecute.mockReset();
    sshRegister.mockReset();
  });

  it('offers attach for a Kiki already running there, and starts nothing', async () => {
    sshPlan.mockResolvedValue(plan('attach'));
    const onAdded = vi.fn();
    const { container } = render(
      <AddConnectionBySshDialog client={client} profiles={[PROFILE]} defaultHome="C:/kiki" onClose={vi.fn()} onAdded={onAdded} />,
    );
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-remote-ssh-state]')?.textContent).toContain('already running');
    const submit = container.querySelector('[data-remote-ssh-submit]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(container.querySelector('[data-remote-ssh-effects]')?.textContent).toContain('keeps whatever lifetime it already has');
    await act(async () => { submit.click(); });
    expect(sshExecute).not.toHaveBeenCalled();
    expect(sshRegister).toHaveBeenCalledTimes(1);
    expect(sshRegister.mock.calls[0]?.[0]).toMatchObject({ purpose: 'gui', planId: 'plan-1' });
    expect(onAdded).toHaveBeenCalledTimes(1);
  });

  it('says the started server runs on until it is stopped explicitly', async () => {
    sshPlan.mockResolvedValue(plan('ensure_required'));
    const { container } = render(
      <AddConnectionBySshDialog client={client} profiles={[PROFILE]} defaultHome="C:/kiki" onClose={vi.fn()} onAdded={vi.fn()} />,
    );
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    const effects = container.querySelector('[data-remote-ssh-effects]')?.textContent ?? '';
    expect(effects).toContain('until it is stopped explicitly');
    expect(effects).toContain('after you close this window');
    const submit = container.querySelector('[data-remote-ssh-submit]') as HTMLButtonElement;
    await act(async () => { submit.click(); });
    expect(sshExecute).toHaveBeenCalledWith('plan-1', { ensure: true });
  });

  it('keeps the form and says what failed when planning fails', async () => {
    sshPlan.mockRejectedValue(new Error('the other Kiki did not answer'));
    const onAdded = vi.fn();
    const { container } = render(
      <AddConnectionBySshDialog client={client} profiles={[PROFILE]} defaultHome="C:/kiki" onClose={vi.fn()} onAdded={onAdded} />,
    );
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-remote-ssh-state]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('the other Kiki did not answer');
    expect(onAdded).not.toHaveBeenCalled();
  });
});

describe('a bridged message names its source', () => {
  beforeEach(() => { host.kind = 'tauri'; });

  it('states the source home and host, and where the hop ran', () => {
    const { container } = render(<BridgedOriginLine block={bridged(SOURCE_HOME)} records={[]} />);
    const text = container.querySelector('[data-bridged-origin-text]')?.textContent ?? '';
    expect(text).toContain('acme-box');
    expect(text).toContain('over the network');
    expect(container.querySelector('[data-bridged-origin-open]')).toBeNull();
  });

  it('says this machine for a hop that stayed local', () => {
    const { container } = render(<BridgedOriginLine block={bridged(undefined, 'local')} records={[]} />);
    expect(container.querySelector('[data-bridged-origin-text]')?.textContent).toContain('this machine');
  });

  it('offers a way in only for a source registered here as a browsable space', async () => {
    const navigated: unknown[] = [];
    const unregister = registerScopeNavigation(async (request) => { navigated.push(request); });
    const onOpen = vi.fn();
    const { container } = render(
      <BridgedOriginLine block={bridged(SOURCE_HOME)} records={[record(['gui'])]} onOpen={onOpen} />,
    );
    const open = container.querySelector('[data-bridged-origin-open]') as HTMLButtonElement;
    expect(open).not.toBeNull();
    await act(async () => { open.click(); });
    expect(onOpen).toHaveBeenCalledTimes(1);
    unregister();
  });

  it('does not offer a bridge-only source as a browsable entry', () => {
    const { container } = render(
      <BridgedOriginLine block={bridged(SOURCE_HOME)} records={[record(['bridge'])]} onOpen={vi.fn()} />,
    );
    expect(container.querySelector('[data-bridged-origin-text]')?.textContent).toContain('acme-box');
    expect(container.querySelector('[data-bridged-origin-open]')).toBeNull();
  });
});
