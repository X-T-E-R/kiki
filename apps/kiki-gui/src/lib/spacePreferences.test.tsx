// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPACE_PREFERENCES, type SpaceDetail } from '@kiki/protocol';
import { configureSpacePortableSettings, readSettings, writeSettings } from '@kiki/session-core/settings';
import { configureSpaceStorage } from '@kiki/session-core/storage';
import type { KikiClient } from './client';
import { clearSpaceAuthority, configureSpaceAuthority, configureSpacePreferencePorts, resolveSpaceDeviceConflict, retrySpacePreferenceItem, spaceAuthoritySnapshot, writeSpacePreferenceItem } from './spaceAuthority';
import { applyDeviceAppearanceToSpace, deviceSpacePreferences, useSpacePreferencesFrame } from './spacePreferences';
import { spaceSettingsKeys, spaceSettingsTargetOf, type SpaceSettingsTarget } from './spaceSettings';
import { OriginBadge } from '../components/settings/spaces/OriginBadge';
import { writeSkinPrefs } from './skins/store';
import { SpacePrefOrigin } from '../components/settings/spaces/SpacePrefOrigin';
import { SpaceSettingsDetail } from '../components/settings/spaces/SpaceSettingsDetail';
import { I18nProvider } from '../i18n';
import { applyCurrentSkin, startSkinSync } from './skins/sync';
import { effectiveBackgroundPrefs, readStoredBackgroundPrefs } from './skins/background';

let surfaceConnection: { client: KikiClient; meta: { server_id: string; current_space_id?: string } };
vi.mock('../state/connection', () => ({ useConnection: () => surfaceConnection }));

function detail(fields: Partial<SpaceDetail> = {}): SpaceDetail {
  return {
    schema: 2, id: 'main', name: 'Main', primary: true, revision: 'r1',
    inherit: { config: true, agents: true, instructions: true, skills: true, mcp: true, appearance: true, plugins: false, credentials: 'shared', generic_roots: true },
    groups: [], items: [], preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'dark' },
    preference_authority: true, restart_required: false, ...fields,
  };
}
function mockClient(homes: Record<string, unknown>): KikiClient {
  return { klient: { rest: { homes } } } as unknown as KikiClient;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function Frame({ client, serverId, children }: { client: KikiClient; serverId: string; children?: ReactNode }) {
  useSpacePreferencesFrame(spaceSettingsTargetOf(client, { ...surfaceConnection.meta, server_id: serverId }));
  return children ?? null;
}
let root: Root;
let container: HTMLDivElement;
let query: QueryClient;
async function flush() {
  await act(async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function render(client: KikiClient, serverId = 'server-a', surfaces = false) {
  surfaceConnection = { client, meta: { server_id: serverId, current_space_id: surfaces ? 'h-acme' : 'main' } };
  const children = surfaces ? createElement(I18nProvider, null,
    createElement(SpacePrefOrigin, { item: 'theme', label: 'Theme' }),
    createElement(SpaceSettingsDetail, { target: { client, identity: { serverId, homeId: 'h-acme' } }, name: 'ACME' }),
  ) : null;
  await act(async () => { root.render(createElement(QueryClientProvider, { client: query }, createElement(Frame, { client, serverId }, children))); });
  await flush();
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  configureSpaceStorage(null);
  configureSpacePortableSettings(undefined);
  clearSpaceAuthority();
  configureSpacePreferencePorts(undefined);
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  query.clear();
  container.remove();
  configureSpacePortableSettings(undefined);
  clearSpaceAuthority();
  configureSpacePreferencePorts(undefined);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

// All clients here are local mocks. No account, transport, or real home is used.
describe('production React preference frame', () => {
  it('reads the device’s raw portable settings while the bridge displays server values', async () => {
    localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'light', proseFont: 'sans', foldSteps: true, motion: 'reduce', sendShortcut: 'cmd-enter' }));
    const importPreferences = vi.fn();
    const client = mockClient({ detail: vi.fn().mockResolvedValue(detail()), importPreferences });
    await render(client);
    expect(readSettings().theme).toBe('dark');
    expect(deviceSpacePreferences()).toMatchObject({ theme: 'light', proseFont: 'sans', foldSteps: true });
    expect(deviceSpacePreferences()).not.toHaveProperty('motion');
    expect(spaceAuthoritySnapshot().deviceConflict).toBe(true);
    expect(importPreferences).not.toHaveBeenCalled();
  });

  it('imports only raw device choices into a space without authority', async () => {
    localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'light', foldSteps: true }));
    const importPreferences = vi.fn().mockResolvedValue({ detail: detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'light', foldSteps: true } }), imported: true, device_conflict: false });
    await render(mockClient({ detail: () => Promise.resolve(detail({ preference_authority: false, preferences: { ...DEFAULT_SPACE_PREFERENCES } })), importPreferences }));
    expect(importPreferences).toHaveBeenCalledOnce();
    expect(importPreferences.mock.calls[0]?.[1].values).toMatchObject({ theme: 'light', foldSteps: true });
    expect(spaceAuthoritySnapshot().confirmed?.theme).toBe('light');
  });

  it('writes and explicit retry update the same server-qualified query, preserving failed drafts', async () => {
    const preview = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ token: 'ok', rows: [{ id: 'pref:theme' }] });
    const apply = vi.fn().mockResolvedValue({ detail: detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'light' } }) });
    await render(mockClient({ detail: () => Promise.resolve(detail()), preview, apply }));
    await act(async () => { await writeSpacePreferenceItem('theme', 'light'); });
    expect(spaceAuthoritySnapshot().drafts.theme).toBe('light');
    expect(spaceAuthoritySnapshot().writes.theme?.state).toBe('error');
    expect(readSettings().theme).toBe('light');
    expect(spaceAuthoritySnapshot().confirmed?.theme).toBe('dark');
    await act(async () => { retrySpacePreferenceItem('theme'); });
    await flush();
    const saved = query.getQueryData<SpaceDetail>([...spaceSettingsKeys.detail('main'), 'server-a']);
    expect(saved?.preferences.theme).toBe('light');
    expect(query.getQueryData(spaceSettingsKeys.detail('main'))).toBeUndefined();
    expect(spaceAuthoritySnapshot().drafts.theme).toBeUndefined();
    expect(spaceAuthoritySnapshot().writes.theme).toBeUndefined();
  });

  it('a background read started before a save cannot roll the save back', async () => {
    const late = deferred<SpaceDetail>();
    const read = vi.fn().mockResolvedValueOnce(detail()).mockReturnValueOnce(late.promise);
    await render(mockClient({ detail: read, preview: () => Promise.resolve({ token: 'ok', rows: [{ id: 'pref:theme' }] }), apply: () => Promise.resolve({ detail: detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'light' } }) }) }));
    await act(async () => { void query.invalidateQueries({ queryKey: [...spaceSettingsKeys.detail('main'), 'server-a'] }); });
    await act(async () => { await writeSpacePreferenceItem('theme', 'light'); });
    await act(async () => { late.resolve(detail()); });
    await flush();
    expect(spaceAuthoritySnapshot().confirmed?.theme).toBe('light');
    expect(query.getQueryData<SpaceDetail>([...spaceSettingsKeys.detail('main'), 'server-a'])?.preferences.theme).toBe('light');
  });

  it('does not resurrect A cache while B with the same home is loading', async () => {
    await render(mockClient({ detail: () => Promise.resolve(detail()) }));
    const late = deferred<SpaceDetail>();
    await render(mockClient({ detail: () => late.promise }), 'server-b');
    expect(spaceAuthoritySnapshot().confirmed).toBeNull();
    await act(async () => { late.resolve(detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'light' } })); });
    await flush();
    expect(spaceAuthoritySnapshot().identity).toEqual({ serverId: 'server-b', homeId: 'main' });
    expect(spaceAuthoritySnapshot().confirmed?.theme).toBe('light');
  });

  it('the explicit device-look choice previews raw values and its late apply cannot switch back to A', async () => {
    localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'light' }));
    const late = deferred<{ detail: SpaceDetail }>();
    const preview = vi.fn().mockImplementation((_id, request) => Promise.resolve({ token: 'ok', rows: request.changes.map((row: { id: string }) => ({ id: row.id })) }));
    const client = mockClient({ detail: () => Promise.resolve(detail()), preview, apply: () => late.promise });
    await render(client);
    let pending!: Promise<boolean>;
    await act(async () => { pending = applyDeviceAppearanceToSpace(client, { serverId: 'server-a', homeId: 'main' }); });
    expect(preview.mock.calls[0]?.[1].changes).toContainEqual({ id: 'pref:theme', value: 'light' });
    await act(async () => { configureSpaceAuthority({ serverId: 'server-b', homeId: 'main' }, detail()); });
    const held = spaceAuthoritySnapshot();
    await act(async () => { late.resolve({ detail: detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'light' } }) }); await pending; });
    expect(spaceAuthoritySnapshot()).toBe(held);
  });
});

describe('device conflict choices', () => {
  it('using the space look only settles this device’s question, without overwriting either baseline', async () => {
    const raw = JSON.stringify({ theme: 'light', motion: 'reduce', sendShortcut: 'cmd-enter' });
    localStorage.setItem('kiki.settings', raw);
    const preview = vi.fn();
    const apply = vi.fn();
    const importPreferences = vi.fn();
    await render(mockClient({ detail: () => Promise.resolve(detail()), preview, apply, importPreferences }));
    await act(async () => { resolveSpaceDeviceConflict(); });
    expect(readSettings().theme).toBe('dark');
    expect(deviceSpacePreferences().theme).toBe('light');
    expect(spaceAuthoritySnapshot().deviceConflict).toBe(false);
    expect(localStorage.getItem('kiki.settings')).toBe(raw);
    expect(preview).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(importPreferences).not.toHaveBeenCalled();
  });

  it('compares and imports raw skin/tweaks, including an empty device tweak set', async () => {
    localStorage.setItem('kiki.skin', JSON.stringify({ selection: { source: 'builtin', id: 'inkstone' }, tweaks: {} }));
    const space = detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'system', tweaks: { radius: 12 } } });
    const preview = vi.fn().mockRejectedValue(new Error('offline'));
    const client = mockClient({ detail: () => Promise.resolve(space), preview });
    await render(client);
    expect(spaceAuthoritySnapshot().deviceConflict).toBe(true);
    await act(async () => { await applyDeviceAppearanceToSpace(client, { serverId: 'server-a', homeId: 'main' }); });
    expect(preview.mock.calls[0]?.[1].changes).toContainEqual({ id: 'pref:skin', value: { source: 'builtin', id: 'inkstone' } });
    expect(preview.mock.calls[0]?.[1].changes).toContainEqual({ id: 'pref:tweaks', value: {} });
    expect(spaceAuthoritySnapshot().drafts.tweaks).toEqual({});
    expect(spaceAuthoritySnapshot().writes.tweaks?.state).toBe('error');
    expect(spaceAuthoritySnapshot().deviceConflict).toBe(true);
  });

  it('does not send an automatic import when this device has only defaults', async () => {
    const importPreferences = vi.fn();
    await render(mockClient({ detail: () => Promise.resolve(detail({ preference_authority: false, preferences: { ...DEFAULT_SPACE_PREFERENCES } })), importPreferences }));
    expect(importPreferences).not.toHaveBeenCalled();
    expect(spaceAuthoritySnapshot().authoritative).toBe(false);
  });
});

it('discards an abandoned A detail request even when the frame visits A again', async () => {
  const late = deferred<SpaceDetail>();
  const readA = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValueOnce(detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'light' } }));
  const clientA = mockClient({ detail: readA });
  await render(clientA);
  await render(mockClient({ detail: () => Promise.resolve(detail()) }), 'server-b');
  await render(clientA);
  expect(readA).toHaveBeenCalledTimes(2);
  expect(spaceAuthoritySnapshot().confirmed?.theme).toBe('light');
  await act(async () => { late.resolve(detail()); });
  await flush();
  expect(spaceAuthoritySnapshot().confirmed?.theme).toBe('light');
  expect(query.getQueryData<SpaceDetail>([...spaceSettingsKeys.detail('main'), 'server-a'])?.preferences.theme).toBe('light');
});

describe('frame and both preference surfaces consuming a server switch', () => {
  async function click(selector: string) {
    const button = document.querySelector<HTMLButtonElement>(selector);
    expect(button, selector).not.toBeNull();
    await act(async () => { button!.click(); });
    await flush();
  }
  function surfaceDetail(spacing: number): SpaceDetail {
    return detail({
      id: 'h-acme', primary: false, undo_id: 'undo-1',
      preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'dark', tweaks: { spacing } },
      groups: [{ domain: 'appearance', mode: 'follow', fixed_count: 1, follow_count: 0 }],
      items: [{
        id: 'pref:theme', name: 'Theme', domain: 'appearance', kind: 'preference',
        selection: { mode: 'fixed', reason: 'edited' }, stored: 'dark', effective: 'dark', main: 'light', actual: 'dark',
        origin: 'home', available: true, pending: false, activation: 'immediate', revision: 'r1', main_revision: 'm1', dependencies: [], can_push: true,
      }],
    });
  }

  it('ignores old A read, preview and undo after B loads, without opening a B plan or touching B’s draft/error/conflict', async () => {
    configureSpaceStorage({ homeId: 'h-acme' });
    localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'light' }));
    const lateRead = deferred<SpaceDetail>();
    const latePreview = deferred<unknown>();
    const lateUndo = deferred<unknown>();
    const readA = vi.fn().mockResolvedValueOnce(surfaceDetail(1)).mockReturnValueOnce(lateRead.promise);
    const previewA = vi.fn().mockReturnValue(latePreview.promise);
    const undoA = vi.fn().mockReturnValue(lateUndo.promise);
    const applyA = vi.fn();
    await render(mockClient({ detail: readA, preview: previewA, undo: undoA, apply: applyA }), 'server-a', true);
    const stop = startSkinSync();
    try {
      await act(async () => { void query.invalidateQueries({ queryKey: [...spaceSettingsKeys.detail('h-acme'), 'server-a'] }); });
      await click('[data-pref-origin-menu="theme"]');
      await click('[data-space-menu-item="follow"]');
      await click('[data-space-change="appearance"]');
      await click('[data-space-change-cancel]');
      expect(document.querySelector('[data-space-change-dialog]')).toBeNull();
      await click('[data-space-undo]');
      expect(previewA).toHaveBeenCalledTimes(2);
      expect(undoA).toHaveBeenCalledOnce();
      const previewB = vi.fn().mockRejectedValue(new Error('B offline'));
      const applyB = vi.fn();
      const readB = vi.fn().mockResolvedValue(surfaceDetail(1.16));
      await render(mockClient({ detail: readB, preview: previewB, apply: applyB }), 'server-b', true);
      await act(async () => { await writeSpacePreferenceItem('theme', 'system'); });
      const held = spaceAuthoritySnapshot();
      const keyB = [...spaceSettingsKeys.detail('h-acme'), 'server-b'];
      const cachedB = query.getQueryData(keyB);
      const css = document.documentElement.style.getPropertyValue('--spacing');
      expect(css).toBe('0.29rem');
      expect(held.identity).toEqual({ serverId: 'server-b', homeId: 'h-acme' });
      expect(held.drafts.theme).toBe('system');
      expect(held.writes.theme?.state).toBe('error');
      expect(held.deviceConflict).toBe(true);
      localStorage.setItem('kiki.space.h-acme.kiki.background', JSON.stringify({
        light: { media: [{ id: 'local-example', kind: 'image', mime: 'image/png', name: 'old.png', bytes: 4 }], interval: 0, look: {} },
        dark: null, linked: true, assist: true,
      }));
      expect(readStoredBackgroundPrefs().light?.media[0]?.id).toBe('local-example');
      expect(effectiveBackgroundPrefs().light).toBeNull();
      await act(async () => {
        lateRead.resolve(surfaceDetail(0.88));
        latePreview.resolve({ token: 'old-a', rows: [{ id: 'pref:theme', same_value: false, conflict: false, selected: true }] });
        lateUndo.resolve({ detail: surfaceDetail(0.88) });
      });
      await flush();
      expect(spaceAuthoritySnapshot()).toBe(held);
      expect(query.getQueryData(keyB)).toBe(cachedB);
      expect(document.documentElement.style.getPropertyValue('--spacing')).toBe(css);
      expect(effectiveBackgroundPrefs().light).toBeNull();
      expect(readStoredBackgroundPrefs().light?.media[0]?.id).toBe('local-example');
      expect(document.querySelector('[data-space-change-dialog]')).toBeNull();
      expect(document.querySelector('[data-space-settings] [data-feedback-tone]')).toBeNull();
      expect(document.querySelector<HTMLButtonElement>('[data-space-device-use]')?.disabled).toBe(false);
      expect(previewB).toHaveBeenCalledOnce();
      expect(applyB).not.toHaveBeenCalled();
      expect(applyA).not.toHaveBeenCalled();
    } finally {
      stop();
      applyCurrentSkin();
    }
  });

  it('unmounts an open A plan on switching and ignores an already-issued A device apply result', async () => {
    configureSpaceStorage({ homeId: 'h-acme' });
    localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'light' }));
    const lateApply = deferred<unknown>();
    const previewA = vi.fn().mockImplementation((_id, request) => Promise.resolve({ token: 'a', rows: (request.changes ?? [{ id: 'pref:theme' }]).map((row: { id: string }) => ({ id: row.id, selected: true, same_value: false, conflict: false })) }));
    const applyA = vi.fn().mockReturnValue(lateApply.promise);
    await render(mockClient({ detail: () => Promise.resolve(surfaceDetail(1)), preview: previewA, apply: applyA }), 'server-a', true);
    await click('[data-space-device-use]');
    expect(applyA).toHaveBeenCalledOnce();
    await click('[data-pref-origin-menu="theme"]');
    await click('[data-space-menu-item="follow"]');
    expect(document.querySelector('[data-space-change-dialog]')).not.toBeNull();
    const previewB = vi.fn();
    const applyB = vi.fn();
    await render(mockClient({ detail: () => Promise.resolve(surfaceDetail(1.16)), preview: previewB, apply: applyB }), 'server-b', true);
    const held = spaceAuthoritySnapshot();
    expect(held.deviceConflict).toBe(true);
    expect(document.querySelector('[data-space-change-dialog]')).toBeNull();
    await act(async () => { lateApply.resolve({ detail: surfaceDetail(0.88) }); });
    await flush();
    expect(spaceAuthoritySnapshot()).toBe(held);
    expect(document.querySelector('[data-space-settings] [data-feedback-tone]')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[data-space-device-use]')?.disabled).toBe(false);
    expect(previewB).not.toHaveBeenCalled();
    expect(applyB).not.toHaveBeenCalled();
  });
});


describe('confirmed endpoint identity consumers', () => {
  const prefRow: SpaceDetail['items'][number] = {
    id: 'pref:theme', name: 'Theme', domain: 'appearance', kind: 'preference',
    selection: { mode: 'fixed', reason: 'edited' }, stored: 'dark', effective: 'dark', main: 'light', actual: 'dark',
    origin: 'home', available: true, pending: false, activation: 'immediate', revision: 'r1', main_revision: 'm1', dependencies: [], can_push: true,
  };
  const remoteDetail = (homeId: string) => detail({
    id: homeId, primary: false, undo_id: 'remote-undo',
    groups: [{ domain: 'appearance', mode: 'follow', fixed_count: 1, follow_count: 0 }],
    items: [prefRow, { ...prefRow, id: 'config:default_model', name: 'Default model', domain: 'config', kind: 'config', effective: 'remote-model' }],
  });
  async function renderEndpoint(client: KikiClient, currentSpaceId: string | undefined, management?: SpaceSettingsTarget) {
    surfaceConnection = { client, meta: { server_id: 'remote-server', current_space_id: currentSpaceId } };
    const target = management ?? spaceSettingsTargetOf(client, surfaceConnection.meta);
    const config = { providers: {}, origins: { default_model: { '': 'home' } } } as Parameters<typeof OriginBadge>[0]['config'];
    const children = createElement(I18nProvider, null,
      createElement(SpacePrefOrigin, { item: 'theme', label: 'Theme' }),
      createElement(OriginBadge, { config, domain: 'default_model', label: 'Default model' }),
      createElement(SpaceSettingsDetail, { target, name: management ? 'Local ACME' : 'Remote' }),
    );
    await act(async () => { root.render(createElement(QueryClientProvider, { client: query }, createElement(Frame, { client, serverId: 'remote-server' }, children))); });
    await flush();
  }
  async function click(selector: string) {
    const button = document.querySelector<HTMLButtonElement>(selector);
    expect(button, selector).not.toBeNull();
    await act(async () => { button!.click(); });
    await flush();
  }

  it('uses the remote confirmed subspace in a browser, not main or the desktop home, for frame and both origins', async () => {
    configureSpaceStorage({ homeId: 'h-desktop', name: 'Desktop' });
    const read = vi.fn().mockResolvedValue(remoteDetail('h-remote'));
    const preview = vi.fn().mockResolvedValue({ token: 'remote-plan', rows: [{ id: 'pref:theme' }] });
    const apply = vi.fn().mockResolvedValue({ detail: remoteDetail('h-remote') });
    await renderEndpoint(mockClient({ detail: read, preview, apply }), 'h-remote');
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith('h-remote');
    expect(spaceAuthoritySnapshot().identity).toEqual({ serverId: 'remote-server', homeId: 'h-remote' });
    expect(document.querySelector('[data-pref-origin="theme-fixed"]')).not.toBeNull();
    expect(document.querySelector('[data-origin-restore="config:default_model"]')).not.toBeNull();
    expect(document.querySelector('[data-space-settings="h-remote"]')).not.toBeNull();
    await act(async () => { await writeSpacePreferenceItem('theme', 'light'); });
    expect(preview).toHaveBeenCalledWith('h-remote', expect.objectContaining({ changes: [{ id: 'pref:theme', value: 'light' }] }));
    expect(apply).toHaveBeenCalledWith('h-remote', expect.objectContaining({ token: 'remote-plan' }));
    expect(query.getQueryData([...spaceSettingsKeys.detail('main'), 'remote-server'])).toBeUndefined();
    expect(query.getQueryData([...spaceSettingsKeys.detail('h-desktop'), 'remote-server'])).toBeUndefined();
  });

  it('keeps a colliding local management target off remote appearance while its dialog and undo use the local client', async () => {
    configureSpaceStorage({ homeId: 'h-acme' });
    localStorage.setItem('kiki.settings', JSON.stringify({ theme: 'light' }));
    const localDetail = { ...remoteDetail('h-acme'), name: 'Local ACME', preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'light' as const }, undo_id: 'local-undo' };
    const localRead = vi.fn().mockResolvedValue(localDetail);
    const localPreview = vi.fn().mockResolvedValue({ token: 'local-plan', rows: [{ id: 'pref:theme', selected: true, same_value: false, conflict: false }] });
    const localApply = vi.fn().mockResolvedValue({ detail: localDetail, applied: ['pref:theme'] });
    const localUndo = vi.fn().mockResolvedValue({ detail: localDetail });
    const local = mockClient({ detail: localRead, preview: localPreview, apply: localApply, undo: localUndo });
    const remoteRead = vi.fn().mockResolvedValue(remoteDetail('h-acme'));
    const remotePreview = vi.fn();
    const remoteApply = vi.fn();
    const remoteUndo = vi.fn();
    await renderEndpoint(mockClient({ detail: remoteRead, preview: remotePreview, apply: remoteApply, undo: remoteUndo }), 'h-acme', { client: local, identity: { serverId: 'local-server', homeId: 'h-acme' } });
    const held = spaceAuthoritySnapshot();
    expect(held.deviceConflict).toBe(true);
    expect(document.querySelector('[data-space-device-conflict]')).toBeNull();
    expect(remoteRead).toHaveBeenCalledWith('h-acme');
    expect(localRead).toHaveBeenCalledWith('h-acme');
    await click('[data-space-change="appearance"]');
    await click('[data-space-change-apply]');
    await click('[data-space-undo]');
    expect(localPreview).toHaveBeenCalledWith('h-acme', expect.objectContaining({ groups: ['appearance'] }));
    expect(localApply).toHaveBeenCalledWith('h-acme', { token: 'local-plan', selected: ['pref:theme'] });
    expect(localUndo).toHaveBeenCalledWith('h-acme', 'local-undo');
    expect(spaceAuthoritySnapshot()).toBe(held);
    expect(query.getQueryData<SpaceDetail>([...spaceSettingsKeys.detail('h-acme'), 'local-server'])?.name).toBe('Local ACME');
    for (const spy of [remotePreview, remoteApply, remoteUndo]) expect(spy).not.toHaveBeenCalled();
  });

  it('clears old drafts/conflict on missing identity and rejects portable writes without guessing a target or changing old device values', async () => {
    const raw = JSON.stringify({ theme: 'light', motion: 'full' });
    localStorage.setItem('kiki.settings', raw);
    await render(mockClient({ detail: () => Promise.resolve(detail()), preview: () => Promise.reject(new Error('offline')) }));
    await act(async () => { await writeSpacePreferenceItem('theme', 'system'); });
    expect(spaceAuthoritySnapshot().writes.theme?.state).toBe('error');
    const cache = localStorage.getItem('kiki.spacePreferences.cache');
    const read = vi.fn();
    const preview = vi.fn();
    const apply = vi.fn();
    const importPreferences = vi.fn();
    await renderEndpoint(mockClient({ detail: read, preview, apply, importPreferences }), undefined);
    expect(spaceAuthoritySnapshot()).toMatchObject({ identity: null, confirmed: null, drafts: {}, writes: {}, deviceConflict: false });
    expect(document.querySelector('[data-pref-origin="theme-unknown"]')).not.toBeNull();
    expect(document.querySelector('[data-space-settings-failed]')).not.toBeNull();
    await act(async () => {
      expect(await writeSpacePreferenceItem('theme', 'dark')).toBe(false);
      writeSettings({ theme: 'dark', motion: 'reduce' });
      writeSkinPrefs({ selection: { source: 'builtin', id: 'inkstone' } });
    });
    expect(JSON.parse(localStorage.getItem('kiki.settings')!).theme).toBe('light');
    expect(readSettings().motion).toBe('reduce');
    expect(localStorage.getItem('kiki.skin')).toBeNull();
    expect(localStorage.getItem('kiki.spacePreferences.cache')).toBe(cache);
    for (const spy of [read, preview, apply, importPreferences]) expect(spy).not.toHaveBeenCalled();
  });
});
