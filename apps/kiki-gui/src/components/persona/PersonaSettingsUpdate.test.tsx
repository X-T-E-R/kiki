// @vitest-environment jsdom

/**
 * PersonaSettingsUpdate as the folded chapter it is in the rail: one word of
 * state while closed, the readings and the actions once opened. The revision
 * fields are optional on the wire, so the absent-persona case is a case, not a
 * defensive branch.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionPersonaSettings } from '@kiki/protocol';
import { clearToasts, getToasts } from '../../lib/toasts';

import { I18nProvider } from '../../i18n';
import { PersonaSettingsDialog, PersonaSettingsUpdate } from './PersonaSettingsUpdate';

const getPersonaSettings = vi.fn();
const applyPersonaSettings = vi.fn();

vi.mock('../../state/connection', () => ({
  useConnection: () => ({ client: { getPersonaSettings, applyPersonaSettings }, scopeId: 'local', sshLabel: null }),
  useOptionalConnection: () => null,
}));

const mounted: Root[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
beforeAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = false; });
beforeEach(() => {
  getPersonaSettings.mockReset();
  applyPersonaSettings.mockReset();
  clearToasts();
  localStorage.setItem('kiki.locale', 'zh');
});
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => { root.unmount(); });
  document.body.replaceChildren();
});

async function render(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(I18nProvider, null,
      createElement(PersonaSettingsUpdate, { sessionId: 'session_daily_lin_lan' }))));
  });
  for (let index = 0; index < 4; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

/** The header menu's drawer, mounted through the shared Dialog primitive. */
async function renderDialog(onClose: () => void): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(I18nProvider, null,
      createElement(PersonaSettingsDialog, { sessionId: 'session_daily_lin_lan', onClose }))));
  });
  for (let index = 0; index < 4; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return container;
}

const behind: SessionPersonaSettings = {
  personaId: 'lin-lan', boundRevision: 'aaaaaaaa11111111', latestRevision: 'bbbbbbbb22222222', hasUpdate: true,
};

const stateOf = (container: HTMLElement) => container.querySelector('[data-persona-binding-state]')?.getAttribute('data-persona-binding-state');

async function click(container: HTMLElement, selector: string): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(selector)!.click();
  });
  for (let index = 0; index < 3; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const head = '[data-persona-binding] button[aria-expanded]';

/** The drawer portals out of the container, so its clicks start from the document. */
async function clickOn(root: Document | HTMLElement, selector: string): Promise<void> {
  await act(async () => {
    root.querySelector<HTMLButtonElement>(selector)!.click();
  });
  for (let index = 0; index < 3; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('folded', () => {
  it('states the situation without opening anything', async () => {
    getPersonaSettings.mockResolvedValue(behind);
    const container = await render();
    expect(stateOf(container)).toBe('update');
    expect(container.querySelector(head)?.textContent).toContain('角色设置');
    expect(container.querySelector(head)?.textContent).toContain('有更新');
    // The technical readings stay out of the way until asked for.
    expect(container.textContent).not.toContain('aaaaaaaa');
    expect(container.querySelector('[data-persona-binding-apply]')).toBeNull();
  });

  it('says 有会话自定义 when only the conversation differs', async () => {
    getPersonaSettings.mockResolvedValue({ ...behind, boundRevision: 'bbbbbbbb22222222', hasUpdate: false, overrides: { model: 'fixture/kiki-pro' } });
    const container = await render();
    expect(stateOf(container)).toBe('overrides');
    expect(container.querySelector(head)?.textContent).toContain('有会话自定义');
  });

  it('says 已是最新 when nothing differs', async () => {
    getPersonaSettings.mockResolvedValue({ personaId: 'lin-lan', boundRevision: 'bbbbbbbb22222222', latestRevision: 'bbbbbbbb22222222', hasUpdate: false });
    const container = await render();
    expect(stateOf(container)).toBe('current');
    expect(container.querySelector(head)?.textContent).toContain('已是最新');
  });

  it('renders nothing for a conversation with no persona', async () => {
    getPersonaSettings.mockResolvedValue({ hasUpdate: false });
    const container = await render();
    expect(container.querySelector('[data-persona-binding]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('names the failure on the head and offers the retry', async () => {
    getPersonaSettings.mockRejectedValueOnce(new Error('read failed')).mockResolvedValue(behind);
    const container = await render();
    expect(stateOf(container)).toBe('failed');
    expect(container.querySelector('[data-persona-binding-error]')).not.toBeNull();

    await click(container, '[data-persona-binding-error] button:not([aria-expanded])');
    expect(stateOf(container)).toBe('update');
  });
});

describe('the header menu\'s drawer', () => {
  it('shows the title, the state and the actions at once — nothing folded', async () => {
    getPersonaSettings.mockResolvedValue({ ...behind, overrides: { model: 'fixture/kiki-pro' } });
    const container = await renderDialog(vi.fn());

    // The drawer mounts through a body portal, like every other dialog here.
    const drawer = document.querySelector('[data-persona-settings-dialog]');
    expect(drawer?.getAttribute('data-persona-settings-dialog')).toBe('lin-lan');
    expect(document.body.textContent).toContain('本对话的角色设置');
    expect(document.body.textContent).toContain('有更新');
    // No click needed: the readings, the rule and both actions are on screen.
    expect(document.body.textContent).toContain('aaaaaaaa');
    expect(document.querySelector('[data-persona-binding-apply]')).not.toBeNull();
    expect(document.querySelector('[data-persona-binding-restore]')).not.toBeNull();
  });

  it('is a way to restore defaults even when no new revision exists', async () => {
    getPersonaSettings.mockResolvedValue({ personaId: 'lin-lan', boundRevision: 'bbbbbbbb22222222', latestRevision: 'bbbbbbbb22222222', hasUpdate: false, overrides: { thinking: 'high' } });
    const container = await renderDialog(vi.fn());
    expect(container.textContent).toBe('');
    expect(document.body.textContent).toContain('有会话自定义');
    expect(document.querySelector('[data-persona-binding-apply]')).toBeNull();
    expect(document.querySelector('[data-persona-binding-restore]')).not.toBeNull();

    applyPersonaSettings.mockResolvedValue({ personaId: 'lin-lan', boundRevision: 'bbbbbbbb22222222', latestRevision: 'bbbbbbbb22222222', hasUpdate: false });
    await clickOn(document, '[data-persona-binding-restore]');
    expect(document.body.textContent).toContain('恢复角色默认？');
    // The drawer's own trigger carries the same words, so the confirmation is
    // read from the alert dialog rather than from the whole document.
    const alert = document.querySelector('[role="alertdialog"], [role="dialog"][data-stacked]') ?? document.body;
    const confirm = [...alert.querySelectorAll('button')].find((button) => button.textContent === '恢复角色默认');
    await act(async () => { confirm!.click(); });
    for (let index = 0; index < 3; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(applyPersonaSettings).toHaveBeenCalledWith('session_daily_lin_lan', { restoreDefaults: true });
  });

  it('carries the failed read and its retry instead of an empty drawer', async () => {
    getPersonaSettings.mockRejectedValueOnce(new Error('read failed')).mockResolvedValue(behind);
    await renderDialog(vi.fn());
    expect(document.querySelector('[data-persona-binding-error]')).not.toBeNull();
    await clickOn(document, '[data-persona-binding-retry]');
    expect(document.querySelector('[data-persona-binding-apply]')).not.toBeNull();
  });

  it('draws nothing for a conversation with no persona', async () => {
    getPersonaSettings.mockResolvedValue({ hasUpdate: false });
    const container = await renderDialog(vi.fn());
    expect(container.textContent).toBe('');
    expect(document.querySelector('[data-persona-settings-dialog]')).toBeNull();
  });

  it('closes through the shared primitive, leaving the page alone', async () => {
    getPersonaSettings.mockResolvedValue(behind);
    const onClose = vi.fn();
    await renderDialog(onClose);
    await clickOn(document, '[data-persona-settings-close]');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('opened', () => {
  it('shows the readings, applies the current settings, and follows the server', async () => {
    getPersonaSettings.mockResolvedValue({ ...behind, overrides: { model: 'fixture/kiki-pro' } });
    applyPersonaSettings.mockResolvedValue({ personaId: 'lin-lan', boundRevision: 'bbbbbbbb22222222', latestRevision: 'bbbbbbbb22222222', hasUpdate: false });
    const container = await render();

    await click(container, head);
    expect(container.textContent).toContain('aaaaaaaa');
    expect(container.textContent).toContain('bbbbbbbb');
    expect(container.textContent).toContain('空闲时才能应用');
    expect(container.querySelector('[data-persona-binding-overrides]')?.textContent).toContain('模型');
    // Restore is reachable from the same row as apply.
    expect(container.querySelector('[data-persona-binding-restore]')).not.toBeNull();

    await click(container, '[data-persona-binding-apply]');
    expect(applyPersonaSettings).toHaveBeenCalledWith('session_daily_lin_lan', {});
    expect(stateOf(container)).toBe('current');
    expect(container.querySelector('[data-persona-binding-apply]')).toBeNull();
    expect(getToasts().some((toast) => toast.text.includes('已应用'))).toBe(true);
  });

  it('keeps the reading and says why when applying is refused', async () => {
    getPersonaSettings.mockResolvedValue(behind);
    applyPersonaSettings.mockRejectedValue(new Error('Wait for this conversation to become idle before applying persona settings.'));
    const container = await render();

    await click(container, head);
    await click(container, '[data-persona-binding-apply]');
    expect(container.querySelector('[data-persona-binding-failure]')?.textContent).toContain('idle');
    expect(stateOf(container)).toBe('update');
    expect(container.querySelector('[data-persona-binding-apply]')).not.toBeNull();
  });

  it('confirms before dropping the conversation\'s own overrides', async () => {
    getPersonaSettings.mockResolvedValue({ ...behind, overrides: { model: 'fixture/kiki-pro' } });
    applyPersonaSettings.mockResolvedValue({ personaId: 'lin-lan', boundRevision: 'bbbbbbbb22222222', latestRevision: 'bbbbbbbb22222222', hasUpdate: false });
    const container = await render();

    await click(container, head);
    await click(container, '[data-persona-binding-restore]');
    expect(document.body.textContent).toContain('恢复角色默认？');
    expect(document.body.textContent).toContain('同时清除会话内自定义');

    const confirm = [...document.querySelectorAll('button')].find((button) => button.textContent === '恢复角色默认' && button.closest('[role="alertdialog"], [role="dialog"]') !== null);
    await act(async () => { confirm!.click(); });
    for (let index = 0; index < 3; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(applyPersonaSettings).toHaveBeenCalledWith('session_daily_lin_lan', { restoreDefaults: true });
    expect(stateOf(container)).toBe('current');
  });

  it('offers restore alone when only the overrides differ, and no action at all when nothing does', async () => {
    getPersonaSettings.mockResolvedValue({ personaId: 'lin-lan', boundRevision: 'bbbbbbbb22222222', latestRevision: 'bbbbbbbb22222222', hasUpdate: false, overrides: { thinking: 'high' } });
    const container = await render();
    expect(stateOf(container)).toBe('overrides');
    await click(container, head);
    // Nothing to apply, but the overrides are droppable right here.
    expect(container.querySelector('[data-persona-binding-apply]')).toBeNull();
    expect(container.querySelector('[data-persona-binding-restore]')).not.toBeNull();

    getPersonaSettings.mockResolvedValue({ personaId: 'lin-lan', boundRevision: 'bbbbbbbb22222222', latestRevision: 'bbbbbbbb22222222', hasUpdate: false });
    const plain = await render();
    await click(plain, head);
    expect(plain.querySelector('[data-persona-binding-apply]')).toBeNull();
    expect(plain.querySelector('[data-persona-binding-restore]')).toBeNull();
    expect(plain.querySelector('[data-persona-binding-current]')).not.toBeNull();
  });
});
