// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { recordConnectionEvent, resetConnectionLog } from '../state/connectionDiagnostics';
import { normalizeDesktopFailure, type DesktopRecovery } from '../state/desktopConnection';
import { AppConnectionBanner } from './AppConnectionBanner';

const remoteHarness = vi.hoisted(() => ({
  connectionId: null as string | null,
  spaceKey: 'main' as string,
  sshLabel: null as string | null,
  activateLocal: vi.fn(),
  connectionsList: vi.fn<() => Promise<unknown[]>>(async () => []),
}));

vi.mock('../state/connection', () => {
  const read = () => ({
    client: null,
    localClient: {
      baseUrl: 'http://127.0.0.1:58627',
      klient: {
        rest: {
          homes: { list: async () => ({ items: [{ id: 'main', name: 'Main space', path: 'C:/kiki', primary: true }] }) },
          connections: { list: remoteHarness.connectionsList },
        },
      },
    },
    connectionId: remoteHarness.connectionId,
    spaceKey: remoteHarness.spaceKey,
    sshLabel: remoteHarness.sshLabel,
    activateLocal: remoteHarness.activateLocal,
  });
  return {
    useConnection: read,
    useOptionalConnection: read,
  };
});

const roots: Root[] = [];
const hosts: HTMLElement[] = [];
const rawDiagnostic = 'The local service identity, authentication mode or GUI protocol is unavailable. Reopen the intended space or inspect its service logs; no second service was started.';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => { delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
beforeEach(() => {
  resetConnectionLog();
  remoteHarness.connectionId = null;
  remoteHarness.spaceKey = 'main';
  remoteHarness.sshLabel = null;
  remoteHarness.activateLocal.mockReset();
  remoteHarness.connectionsList.mockReset().mockResolvedValue([]);
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount(); });
  for (const host of hosts.splice(0)) host.remove();
});

async function mount(wsStatus: 'connecting' | 'open' | 'closed', recovery?: DesktopRecovery, locale = 'en', suppressInitialConnecting?: boolean) {
  localStorage.setItem('kiki.locale', locale);
  const container = document.createElement('div');
  document.body.append(container);
  hosts.push(container);
  const root = createRoot(container);
  roots.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onReconnect = vi.fn();
  const onOpenConnectionSettings = vi.fn();
  const render = async (status = wsStatus, state = recovery, suppress = suppressInitialConnecting) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <AppConnectionBanner
              wsStatus={status}
              suppressInitialConnecting={suppress}
              recovery={state}
              onReconnect={onReconnect}
              onOpenConnectionSettings={onOpenConnectionSettings}
            />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => { for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  await render();
  return { container, onReconnect, onOpenConnectionSettings, render };
}

async function click(button: Element | null) {
  await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('AppConnectionBanner', () => {
  it('announces a parked connection as a polite status with the reconnect action', async () => {
    const { container, onReconnect } = await mount('closed');
    const banner = container.querySelector('[data-app-banner]');
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.getAttribute('aria-live')).toBeNull();
    expect(banner?.textContent).toContain('Disconnected from the server.');
    await click(container.querySelector('button'));
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it('offers an in-place reconnect action while reconnecting outside desktop recovery', async () => {
    const { container, onReconnect } = await mount('connecting');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Connection lost — reconnecting…');
    const button = container.querySelector('[data-banner-reconnect]');
    expect(button?.textContent).toBe('Reconnect now');
    await click(button);
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it('names the remote space on disconnect and offers Back to Main space after repeated retry failures without exposing UUIDs', async () => {
    const connId = '22222222-2222-4222-8222-222222222222';
    remoteHarness.connectionId = connId;
    remoteHarness.spaceKey = `remote:${connId}`;
    remoteHarness.connectionsList.mockResolvedValue([
      {
        id: connId,
        label: 'GPU Workstation',
        endpoint: 'http://127.0.0.1:59001',
        target: { homeId: connId, hostId: 'gpu-host', protocol: 1 },
        credentialRef: connId,
        enabled: true,
        purposes: ['gui'],
        backgroundSummary: false,
        state: 'online',
        activeLeases: 0,
      },
    ]);

    const { container, render, onReconnect } = await mount('connecting');
    const banner = container.querySelector('[data-app-banner]')!;
    expect(banner.textContent).toContain('Lost connection to GPU Workstation. Reconnecting…');
    expect(banner.textContent).not.toContain('remote:');
    expect(banner.textContent).not.toContain(connId);
    expect(container.querySelector('[data-banner-back-local]')).toBeNull();

    await act(async () => { recordConnectionEvent({ kind: 'retry', attempt: 3, delayMs: 2_000 }); });
    await render('connecting');
    expect(banner.textContent).toContain('Still can’t reach GPU Workstation. Retrying.');
    expect(container.querySelector('[data-banner-reconnect]')?.textContent).toBe('Retry now');
    const backBtn = container.querySelector('[data-banner-back-local]');
    expect(backBtn?.textContent).toBe('Back to Main space');
    expect(remoteHarness.activateLocal).not.toHaveBeenCalled();

    await click(container.querySelector('[data-banner-reconnect]'));
    expect(onReconnect).toHaveBeenCalledOnce();
    await click(backBtn);
    expect(remoteHarness.activateLocal).toHaveBeenCalledOnce();
  });

  it('renders nothing while connected or during the initial connecting grace window', async () => {
    const { container, render } = await mount('open');
    expect(container.querySelector('[data-app-banner]')).toBeNull();
    await render('connecting', undefined, true);
    expect(container.querySelector('[data-app-banner]')).toBeNull();
    await render('connecting', undefined, false);
    expect(container.querySelector('[data-app-banner]')).not.toBeNull();
  });

  it.each(['en', 'zh'])('keeps a short stable %s strip through repeated backoff and preserves the raw diagnostic in details', async (locale) => {
    const failure = normalizeDesktopFailure({ message: rawDiagnostic, stderrTail: ['fixture stderr'], logPath: 'C:/Users/example/.kiki/logs/desktop-backend.log' });
    const { container, render, onReconnect } = await mount('closed', { status: 'retrying', failure }, locale);
    const banner = container.querySelector('[data-app-banner]')!;
    const text = banner.textContent;
    const classes = banner.className;
    expect(text).toContain(locale === 'zh' ? '正在重连' : 'reconnecting');
    expect(text).not.toContain(rawDiagnostic);
    expect(text).not.toContain(locale === 'zh' ? '立即重连' : 'Reconnect now');
    for (const status of ['connecting', 'closed', 'connecting', 'closed'] as const) {
      await render(status, { status: 'retrying', failure });
      expect(container.querySelector('[data-app-banner]')).toBe(banner);
      expect(banner.textContent).toBe(text);
      expect(banner.className).toBe(classes);
    }
    await click(banner.querySelector('button'));
    const details = document.querySelector('[role="dialog"]');
    expect(details?.textContent).toContain(rawDiagnostic);
    expect(details?.textContent).toContain('fixture stderr');
    expect(details?.textContent).toContain('desktop-backend.log');
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it.each(['identity', 'authentication', 'protocol'] as const)('gives a settings action rather than reconnect for a blocked %s', async (kind) => {
    const { container, onOpenConnectionSettings, onReconnect } = await mount('closed', { status: 'blocked', failure: normalizeDesktopFailure({ kind, message: rawDiagnostic }) }, 'zh');
    const banner = container.querySelector('[data-app-banner]')!;
    expect(banner.textContent).toContain('连接已暂停');
    expect(banner.textContent).not.toContain(rawDiagnostic);
    const buttons = Array.from(banner.querySelectorAll('button'));
    expect(buttons.map((button) => button.textContent)).toEqual(['连接设置', '连接详情']);
    await click(buttons[0]!);
    expect(onOpenConnectionSettings).toHaveBeenCalledOnce();
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('does not promote an unknown diagnostic category into a permanent refusal', () => {
    expect(normalizeDesktopFailure({ message: rawDiagnostic, kind: 'starting', stderrTail: [1, 'line'] })).toEqual({ message: rawDiagnostic, kind: undefined, stderrTail: ['line'], logPath: null });
  });
});
