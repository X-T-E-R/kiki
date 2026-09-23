// @vitest-environment jsdom

/**
 * OAuthDeviceCard — the device sign-in card. The open-verification action
 * (W0S-02) routes through the host's openUrl channel where one is available
 * (desktop webviews reject `window.open`), falls back to `window.open` with
 * its return value checked in the browser, and surfaces a blocked or failed
 * open as a visible inline line instead of silently doing nothing.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OAuthFlowSnapshot } from '@kiki/protocol';

import { I18nProvider } from '../i18n';
import { OAuthDeviceCard } from './OAuthDeviceCard';

const hostMocks = vi.hoisted(() => ({
  openUrl: undefined as unknown as ((url: string) => Promise<void>) | undefined,
}));
vi.mock('../host', () => ({
  useHost: () => ({ openUrl: hostMocks.openUrl }),
}));

const PENDING_SNAPSHOT: OAuthFlowSnapshot = {
  flow_id: 'flow-1',
  provider: 'acme',
  status: 'pending',
  verification_uri: 'https://example.com/activate',
  verification_uri_complete: 'https://example.com/activate?code=ABCD-EFGH',
  user_code: 'ABCD-EFGH',
  expires_in: 900,
  interval: 5,
  expires_at: '2099-01-01T00:00:00Z',
};

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function makeRoot(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  containers.push(container);
  roots.push(root);
  return { root, container };
}

function renderCard(root: Root, snapshot: OAuthFlowSnapshot): void {
  act(() => {
    root.render(
      <I18nProvider>
        <OAuthDeviceCard
          snapshot={snapshot}
          cancelling={false}
          onCancel={() => {}}
          onRetry={() => {}}
          onDismiss={() => {}}
        />
      </I18nProvider>,
    );
  });
}

async function clickOpenButton(container: HTMLDivElement): Promise<void> {
  const open = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => entry.textContent === 'Open verification page');
  expect(open).toBeTruthy();
  await act(async () => {
    open!.click();
  });
}

beforeAll(() => {
  localStorage.setItem('kiki.locale', 'en');
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(() => {
  hostMocks.openUrl = vi.fn(async () => {});
});

afterEach(() => {
  for (const root of roots) {
    act(() => { root.unmount(); });
  }
  roots.length = 0;
  containers.length = 0;
  vi.unstubAllGlobals();
});

describe('device sign-in open-verification action', () => {
  it('opens the verification page through the host channel on desktop', async () => {
    const { root, container } = makeRoot();
    renderCard(root, PENDING_SNAPSHOT);
    await clickOpenButton(container);
    expect(hostMocks.openUrl).toHaveBeenCalledWith(PENDING_SNAPSHOT.verification_uri_complete);
    // No failure line while the host opener succeeds.
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows a visible failure line when the host opener rejects', async () => {
    hostMocks.openUrl = vi.fn(async () => { throw new Error('blocked'); });
    const { root, container } = makeRoot();
    renderCard(root, PENDING_SNAPSHOT);
    await clickOpenButton(container);
    expect(hostMocks.openUrl).toHaveBeenCalledOnce();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('The browser blocked the new window.');
  });

  it('falls back to window.open and flags a blocked pop-up in the browser', async () => {
    // No openUrl on the host — the browser shell — so the card uses
    // window.open with its return value checked.
    hostMocks.openUrl = undefined;
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const { root, container } = makeRoot();
    renderCard(root, PENDING_SNAPSHOT);
    await clickOpenButton(container);
    expect(open).toHaveBeenCalledWith(
      PENDING_SNAPSHOT.verification_uri_complete,
      '_blank',
      'noopener,noreferrer',
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('The browser blocked the new window.');
  });

  it('shows the device code so the user can complete the flow manually', () => {
    const { root, container } = makeRoot();
    renderCard(root, PENDING_SNAPSHOT);
    expect(container.textContent).toContain('ABCD-EFGH');
  });
});
