// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { readDesktopPrefs, readSettings, writeDesktopPrefs, writeSettings, DEFAULT_AWAY_NOTIFICATION_KINDS } from '@kiki/session-core/settings';

import { I18nProvider } from '../../../i18n';
import { AwayNotificationsCard } from './AwayNotificationsCard';

const hostState: { notify: (() => Promise<void>) | undefined } = { notify: async () => undefined };
vi.mock('../../../host', () => ({
  useHost: () => ({ kind: 'browser', notify: hostState.notify }),
}));

const mounts: { container: HTMLDivElement; root: Root }[] = [];
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'en-US' });
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  hostState.notify = async () => undefined;
  writeDesktopPrefs({ notifications: true });
  writeSettings({ awayNotifications: DEFAULT_AWAY_NOTIFICATION_KINDS });
});

afterEach(async () => {
  for (const { container, root } of mounts.splice(0)) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounts.push({ container, root });
  await act(async () => {
    root.render(<I18nProvider><AwayNotificationsCard /></I18nProvider>);
  });
  return container;
}

function kindToggle(container: HTMLElement, kind: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`[data-notify-away-kind="${kind}"] input[type="checkbox"]`)!;
}

describe('AwayNotificationsCard', () => {
  it('writes each kind switch to local settings', async () => {
    const card = await render();
    expect(kindToggle(card, 'completed').checked).toBe(true);
    await act(async () => { kindToggle(card, 'completed').click(); });
    expect(readSettings().awayNotifications).toEqual({ ...DEFAULT_AWAY_NOTIFICATION_KINDS, completed: false });
    expect(kindToggle(card, 'completed').checked).toBe(false);
  });

  it('hides the per-kind switches while the master switch is off, and stores it as the desktop preference', async () => {
    const card = await render();
    const master = card.querySelector<HTMLInputElement>('#notify-away-enabled')!;
    await act(async () => { master.click(); });
    expect(readDesktopPrefs().notifications).toBe(false);
    expect(card.querySelector('[data-notify-away-kinds]')).toBeNull();
  });

  it('says why nothing can be switched on a host without notifications', async () => {
    hostState.notify = undefined;
    const card = await render();
    expect(card.querySelector('[data-notify-away]')).toBeNull();
    expect(card.textContent).toContain('cannot show system notifications');
  });
});
