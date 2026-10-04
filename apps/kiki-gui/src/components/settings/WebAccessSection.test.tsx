// @vitest-environment jsdom

/**
 * The web access card: what it says when the entry is closed, when it is
 * open, and what each control actually asks the server for.
 *
 * The permissions sentence is asserted verbatim. It is the one line that has
 * to stay true — a link is full use of this Kiki — and the copy is the part of
 * this surface a reader is most likely to act on, so it is checked rather than
 * trusted.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { useConnection } from '../../state/connection';
import { translate } from '@kiki/session-core/i18n';
import type { WebAccessStatus } from '@kiki/protocol';
import { WebAccessSection } from './WebAccessSection';

const webAccess = {
  status: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  issueLink: vi.fn(),
  revoke: vi.fn(),
  current: vi.fn(),
  exchange: vi.fn(),
  logout: vi.fn(),
};

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { klient: { rest: { webAccess } } }, localClient: null }),
}));

vi.mock('../../host', () => ({ useHost: () => ({ kind: 'web' }) }));

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const queryClients: QueryClient[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

function status(over: Partial<WebAccessStatus> = {}): WebAccessStatus {
  return {
    enabled: false, mode: null, url: null, expiresAt: null,
    host: '127.0.0.1', port: 58627, insecure: false, sessions: [], ...over,
  };
}

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US', clipboard: { writeText: vi.fn(async () => undefined) } });
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
  webAccess.status.mockReset();
  webAccess.enable.mockReset();
  webAccess.disable.mockReset();
  webAccess.issueLink.mockReset();
  webAccess.revoke.mockReset();
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  // The status is a background read, so the card is mounted the way the real
  // settings page mounts it: inside a query client.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false } },
  });
  queryClients.push(queryClient);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider><WebAccessSection /></I18nProvider>
      </QueryClientProvider>,
    );
  });
  // The status is a background read, so the first paint is the loading line;
  // wait for the card to answer rather than asserting against a spinner.
  // Timers are faked so expiry text is deterministic, which means the settle
  // has to advance them.
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return container;
}

const click = async (node: Element | null | undefined): Promise<void> => {
  await act(async () => {
    (node as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
};
const find = (container: HTMLElement, selector: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(selector);

describe('closed entry', () => {
  beforeEach(() => { webAccess.status.mockResolvedValue(status()); });

  it('offers both ways to open, and says the link is full use of this Kiki', async () => {
    const container = await render();
    expect(find(container, '[data-web-access-status="off"]')).not.toBeNull();
    expect(find(container, '[data-web-access-start-temporary]')).not.toBeNull();
    expect(find(container, '[data-web-access-start-persistent]')).not.toBeNull();
    expect(find(container, '[data-web-access-powers]')!.textContent)
      .toBe('Anyone holding the link can use this Kiki in full, with the same access you have.');
  });

  it('asks for a temporary entry without a host or a port', async () => {
    webAccess.enable.mockResolvedValue(status({ enabled: true, mode: 'temporary' }));
    const container = await render();
    await click(find(container, '[data-web-access-start-temporary]'));
    expect(webAccess.enable).toHaveBeenCalledWith({ mode: 'temporary' });
  });

  it('asks for an always-on entry', async () => {
    webAccess.enable.mockResolvedValue(status({ enabled: true, mode: 'persistent' }));
    const container = await render();
    await click(find(container, '[data-web-access-start-persistent]'));
    expect(webAccess.enable).toHaveBeenCalledWith({ mode: 'persistent' });
  });

  it('reports a refusal in the person’s terms instead of staying silent', async () => {
    webAccess.enable.mockRejectedValue(new Error('tls_required'));
    const container = await render();
    await click(find(container, '[data-web-access-start-temporary]'));
    const feedback = find(container, '[data-feedback-tone="error"]');
    expect(feedback).not.toBeNull();
    expect(feedback!.textContent).toContain('tls_required');
  });

  it('keeps the address out of the way until it is asked for', async () => {
    const container = await render();
    expect(find(container, '#web-access-details')!.hidden).toBe(true);
    await click(find(container, '[data-web-access-details-toggle]'));
    expect(find(container, '#web-access-details')!.hidden).toBe(false);
    expect(find(container, '[data-copy-field="web-access-address"]')).not.toBeNull();
  });
});

describe('open entry', () => {
  beforeEach(() => {
    webAccess.status.mockResolvedValue(status({
      enabled: true, mode: 'persistent', url: 'http://192.168.1.20:58627/',
    }));
  });

  it('says it is always on and offers the address, a new link, and turning it off', async () => {
    const container = await render();
    expect(find(container, '[data-web-access-status="persistent"]')).not.toBeNull();
    expect(find(container, '[data-web-access-new-link]')).not.toBeNull();
    expect(find(container, '[data-web-access-off]')).not.toBeNull();
    // The permission sentence is the same one sentence whether temporary or not.
    expect(find(container, '[data-web-access-powers]')!.textContent)
      .toBe('Anyone holding the link can use this Kiki in full, with the same access you have.');
  });

  it('issues a one-time link and shows it once', async () => {
    webAccess.issueLink.mockResolvedValue({
      url: 'http://192.168.1.20:58627/#access=' + 'a'.repeat(43),
      expiresAt: NOW + 600_000,
    });
    const container = await render();
    await click(find(container, '[data-web-access-new-link]'));
    // The link is shown in a dialog, which is portalled to the document.
    const field = document.querySelector<HTMLElement>('[data-copy-field="web-access-link"]');
    expect(field).not.toBeNull();
    expect(field!.textContent).toContain('#access=');
    expect(document.querySelector('[data-web-access-link-expires]')).not.toBeNull();
  });

  it('confirms before turning it off, and names what ends', async () => {
    const container = await render();
    await click(find(container, '[data-web-access-off]'));
    // Nothing is sent on the click itself.
    expect(webAccess.disable).not.toHaveBeenCalled();
    const confirm = document.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]');
    expect(confirm).not.toBeNull();
    expect(confirm!.textContent).toContain('Turn off web access?');
  });

  it('does not claim a link is open when the server reports it is not', async () => {
    webAccess.status.mockResolvedValue(status({ enabled: false, mode: 'persistent' }));
    const container = await render();
    expect(find(container, '[data-web-access-open]')).toBeNull();
    expect(find(container, '[data-web-access-status="off"]')).not.toBeNull();
  });
});

describe('temporary entry', () => {
  it('shows when it closes, and still says the same thing about permissions', async () => {
    webAccess.status.mockResolvedValue(status({
      enabled: true, mode: 'temporary', url: 'http://127.0.0.1:58627/',
      expiresAt: NOW + 8 * 3_600_000,
    }));
    const container = await render();
    const line = find(container, '[data-web-access-status="temporary"]')!;
    expect(line.textContent).toContain('Closes');
    expect(find(container, '[data-web-access-powers]')!.textContent)
      .toBe('Anyone holding the link can use this Kiki in full, with the same access you have.');
  });
});

describe('signed-in browsers', () => {
  it('says so plainly when there are none', async () => {
    webAccess.status.mockResolvedValue(status({ enabled: true, mode: 'persistent', url: 'http://x/' }));
    const container = await render();
    expect(find(container, '[data-web-access-browsers-empty]')).not.toBeNull();
  });

  it('lists each browser with its own sign-out', async () => {
    webAccess.status.mockResolvedValue(status({
      enabled: true, mode: 'persistent', url: 'http://x/',
      sessions: [
        { id: 's1', label: 'Pixel phone', createdAt: NOW - 60_000, lastUsedAt: NOW - 30_000, expiresAt: NOW + 3_600_000 },
        { id: 's2', label: 'Office laptop', createdAt: NOW - 60_000, lastUsedAt: NOW - 90_000, expiresAt: NOW + 3_600_000 },
      ],
    }));
    const container = await render();
    expect(find(container, '[data-web-access-session="s1"]')).not.toBeNull();
    expect(find(container, '[data-web-access-session="s2"]')).not.toBeNull();
    expect(find(container, '[data-web-access-browsers-empty]')).toBeNull();
    expect(find(container, '[data-web-access-revoke-all]')).not.toBeNull();
  });
});

describe('unencrypted entry', () => {
  it('says the connection is not encrypted without being asked', async () => {
    webAccess.status.mockResolvedValue(status({
      enabled: true, mode: 'persistent', url: 'http://192.168.1.20:58627/', insecure: true,
    }));
    const container = await render();
    const note = find(container, '[data-web-access-insecure]')!;
    expect(note.textContent).toBe('This connection is not encrypted. Anyone on the network can read what is sent.');
  });
});

describe('copy', () => {
  it('exists in both locales for every key the card uses', () => {
    const keys = [
      'st.web.title', 'st.web.hint', 'st.web.powers', 'st.web.off', 'st.web.temporary',
      'st.web.persistent', 'st.web.startTemporary', 'st.web.startPersistent', 'st.web.turnOff',
      'st.web.newLink', 'st.web.address', 'st.web.signedIn', 'st.web.revoke', 'st.web.revokeAll',
      'st.web.linkTitle', 'st.web.linkCopy', 'st.web.insecureHint',
    ] as const;
    for (const key of keys) {
      expect(translate('en', key), `en ${key}`).not.toBe(key);
      expect(translate('zh', key), `zh ${key}`).not.toBe(key);
    }
  });
});
