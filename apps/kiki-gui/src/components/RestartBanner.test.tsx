// @vitest-environment jsdom

/**
 * RestartBanner restart-decision semantics. The banner no longer trusts any
 * cached busy count: clicking "Restart now" runs a fresh, complete busy scan
 * (`fetchBusySessionCount`) and only an end-to-end scan resolving zero busy
 * sessions restarts directly. Busy, unknown (failed / incomplete scan), and
 * thrown errors all open the confirm. We mock the connection's client (feeding
 * `listSessions`) and the desktop bridge so the decision path is observable
 * without Tauri.
 *
 * Copy assertions are English: pin the locale source (Node's built-in
 * navigator reports the OS language) for the whole file.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import {
  clearRestartRequirement,
  markRestartRequired,
} from '../lib/settings';
import { RestartBanner } from './RestartBanner';

const { listSessions, restartNativeServer, nudge } = vi.hoisted(() => ({
  listSessions: vi.fn(),
  restartNativeServer: vi.fn(),
  nudge: vi.fn(),
}));

const session = (id: string, busy: boolean) => ({ id, busy });
const page = (items: ReturnType<typeof session>[], hasMore = false) => ({ items, has_more: hasMore });

vi.mock('../state/connection', () => ({
  useConnection: () => ({
    client: { listSessions },
    socket: { nudge },
  }),
}));

vi.mock('../host', () => ({
  useHost: () => ({ kind: 'tauri', restartServer: restartNativeServer }),
}));

interface Deferred {
  promise: Promise<ReturnType<typeof page>>;
  resolve: (value: ReturnType<typeof page>) => void;
}

function deferred(): Deferred {
  let resolve!: (value: ReturnType<typeof page>) => void;
  const promise = new Promise<ReturnType<typeof page>>((res) => { resolve = res; });
  return { promise, resolve };
}

const containers: HTMLDivElement[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  clearRestartRequirement();
  listSessions.mockReset();
  restartNativeServer.mockReset().mockResolvedValue(undefined);
  nudge.mockReset();
});

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
  localStorage.clear();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});

interface BannerHandle {
  container: HTMLDivElement;
  root: Root;
  queryClient: QueryClient;
}

async function renderBanner(): Promise<BannerHandle> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <RestartBanner />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
  return { container, root, queryClient };
}

/** Flush the fetch + restart promise chain inside act. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function clickBannerButton(container: HTMLElement, text: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (button === undefined) throw new Error(`No button with text "${text}"`);
  await act(async () => { button.click(); });
}

async function clickDialogButton(container: HTMLElement, text: string): Promise<void> {
  const dialog = container.querySelector<HTMLElement>('[role="alertdialog"]');
  if (dialog === null) throw new Error('No confirm dialog open');
  const button = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (button === undefined) throw new Error(`Dialog has no button with text "${text}"`);
  await act(async () => { button.click(); });
}

describe('RestartBanner restart decision', () => {
  it('fresh scan resolving zero busy sessions restarts directly, without a cached read', async () => {
    listSessions.mockResolvedValue(page([session('a', false), session('b', false)]));
    markRestartRequired(['Kimi Home']);
    const { container, queryClient } = await renderBanner();

    // No busy query runs until the click — the decision is never served from cache.
    expect(listSessions).not.toHaveBeenCalled();

    await clickBannerButton(container, 'Restart now');
    await settle();

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(restartNativeServer).toHaveBeenCalledTimes(1);
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Restart now');
  });

  it('a busy response at click time opens the confirm instead of a direct kill', async () => {
    // The server was idle on a prior read, then became busy: the click's fresh
    // scan is what matters, and it must not trust the stale-zero state.
    listSessions.mockResolvedValue(page([
      session('a', true),
      session('b', true),
      session('c', false),
    ]));
    markRestartRequired(['Kimi Home']);
    const { container } = await renderBanner();

    await clickBannerButton(container, 'Restart now');
    await settle();

    expect(restartNativeServer).not.toHaveBeenCalled();
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(container.textContent).toContain('Restart to apply pending changes?');
    expect(container.textContent).toContain('terminates 2 running session task(s)');
  });

  it('counts busy sessions across a multi-page scan', async () => {
    listSessions
      .mockResolvedValueOnce(page([session('a', true), session('b', false)], true))
      .mockResolvedValueOnce(page([session('c', true), session('d', false)]));
    markRestartRequired(['Kimi Home']);
    const { container } = await renderBanner();

    await clickBannerButton(container, 'Restart now');
    await settle();

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(restartNativeServer).not.toHaveBeenCalled();
    expect(container.textContent).toContain('terminates 2 running session task(s)');
  });

  it('treats an incomplete page walk as unknown and confirms conservatively', async () => {
    // has_more keeps returning true past the page budget → unknown.
    listSessions.mockResolvedValue(page([session('a', false)], true));
    markRestartRequired(['Kimi Home']);
    const { container } = await renderBanner();

    await clickBannerButton(container, 'Restart now');
    await settle();

    expect(restartNativeServer).not.toHaveBeenCalled();
    expect(container.textContent).toContain('could not confirm whether any sessions are running');
  });

  it('treats a scan rejection as unknown and confirms conservatively', async () => {
    listSessions.mockRejectedValue(new Error('network down'));
    markRestartRequired(['Kimi Home']);
    const { container } = await renderBanner();

    await clickBannerButton(container, 'Restart now');
    await settle();

    expect(restartNativeServer).not.toHaveBeenCalled();
    expect(container.textContent).toContain('could not confirm whether any sessions are running');
  });

  it('cancel does not restart and keeps the requirement armed', async () => {
    listSessions.mockResolvedValue(page([session('a', true)]));
    markRestartRequired(['Kimi Home']);
    const { container } = await renderBanner();

    await clickBannerButton(container, 'Restart now');
    await settle();
    await clickDialogButton(container, 'Cancel');
    await settle();

    expect(restartNativeServer).not.toHaveBeenCalled();
    expect(nudge).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Restart now');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('confirm restarts and clears the requirement on success', async () => {
    listSessions.mockResolvedValue(page([session('a', true)]));
    markRestartRequired(['Kimi Home']);
    const { container, queryClient } = await renderBanner();

    await clickBannerButton(container, 'Restart now');
    await settle();
    await clickDialogButton(container, 'Restart now');
    await settle();

    expect(restartNativeServer).toHaveBeenCalledTimes(1);
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Restart now');
  });

  it('keeps the banner armed when the restart rejects', async () => {
    restartNativeServer.mockRejectedValue(new Error('restart failed'));
    listSessions.mockResolvedValue(page([session('a', true)]));
    markRestartRequired(['Kimi Home']);
    const { container, queryClient } = await renderBanner();

    await clickBannerButton(container, 'Restart now');
    await settle();
    await clickDialogButton(container, 'Restart now');
    await settle();

    expect(restartNativeServer).toHaveBeenCalledTimes(1);
    expect(nudge).not.toHaveBeenCalled();
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    expect(container.textContent).toContain('restart failed');
    expect(container.textContent).toContain('Restart now');
  });

  it('a superseded scan never restarts: rapid double-click fires exactly one restart', async () => {
    const first = deferred();
    listSessions
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(page([session('a', false)]));
    markRestartRequired(['Kimi Home']);
    const { container } = await renderBanner();

    // Two clicks before React re-renders the disabled state: both start a scan,
    // the first is superseded by the second and must not drive a restart.
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Restart now',
    );
    if (button === undefined) throw new Error('No restart button');
    await act(async () => {
      button.click();
      button.click();
    });

    // Second scan resolves immediately (idle) → restarts once.
    await settle();
    // First scan resolves late; it is superseded and must not restart again.
    first.resolve(page([session('a', true)]));
    await settle();

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(restartNativeServer).toHaveBeenCalledTimes(1);
  });
});