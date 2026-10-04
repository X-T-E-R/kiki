// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SPACE_PREFERENCES, type SpaceDetail } from '@kiki/protocol';

import type { KikiClient } from './client';
import {
  clearSpaceAuthority,
  configureSpaceAuthority,
  configureSpacePreferencePorts,
  dropCachedSpacePreferences,
  importDevicePreferences,
  loadCachedSpacePreferences,
  resolveSpaceDeviceConflict,
  retrySpacePreferenceItem,
  spaceAuthoritySnapshot,
  spaceDeviceConflictResolved,
  spaceIdentityKey,
  spaceIdentityOf,
  spacePreferenceValue,
  writeSpacePreferenceItem,
} from './spaceAuthority';

const ACME = { serverId: 'server-a', homeId: 'h-acme' };
const OTHER = { serverId: 'server-b', homeId: 'h-acme' };

function detail(fields: Partial<SpaceDetail> = {}): SpaceDetail {
  return {
    schema: 2, id: 'h-acme', name: 'ACME', primary: false, revision: 'r1',
    inherit: {
      config: true, agents: true, instructions: true, skills: true, mcp: true,
      appearance: true, plugins: false, credentials: 'shared', generic_roots: true,
    },
    groups: [], items: [],
    preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'dark' },
    preference_authority: true, restart_required: false,
    ...fields,
  };
}

function client(homes: Record<string, unknown>): KikiClient {
  return { klient: { rest: { homes } } } as unknown as KikiClient;
}

beforeEach(() => {
  localStorage.clear();
  clearSpaceAuthority();
  configureSpacePreferencePorts(undefined);
});

describe('space identity', () => {
  it('needs the server, not just the home, before a space has an identity', () => {
    expect(spaceIdentityOf(undefined, 'main')).toBeNull();
    expect(spaceIdentityOf('', 'main')).toBeNull();
    expect(spaceIdentityOf('server-a', 'main')).toEqual({ serverId: 'server-a', homeId: 'main' });
  });

  it('keys the cache by server and home, so one server never reads another’s values', () => {
    expect(spaceIdentityKey(ACME)).not.toBe(spaceIdentityKey(OTHER));
    configureSpaceAuthority(ACME, detail());
    dropCachedSpacePreferences(ACME);
    clearSpaceAuthority();
    // Another server serving a space with the same home id finds nothing.
    loadCachedSpacePreferences('h-acme');
    expect(spaceAuthoritySnapshot().confirmed).toBeNull();
  });
});

describe('confirmed values and the boot cache', () => {
  it('accepts a detail as the space’s own values and remembers them for the next launch', () => {
    configureSpaceAuthority(ACME, detail());
    expect(spaceAuthoritySnapshot().authoritative).toBe(true);
    expect(spacePreferenceValue('theme')).toBe('dark');
    clearSpaceAuthority();
    loadCachedSpacePreferences('h-acme');
    expect(spaceAuthoritySnapshot().confirmed?.theme).toBe('dark');
    expect(spaceAuthoritySnapshot().authoritative).toBe(false);
  });

  it('keeps a space without authority visible as such', () => {
    configureSpaceAuthority(ACME, detail({ preference_authority: false, preferences: { ...DEFAULT_SPACE_PREFERENCES } }));
    expect(spaceAuthoritySnapshot().authoritative).toBe(false);
    expect(spacePreferenceValue('theme')).toBe('system');
  });
});

describe('writing one preference', () => {
  const preview = vi.fn();
  const apply = vi.fn();

  beforeEach(() => {
    preview.mockReset();
    apply.mockReset();
    configureSpaceAuthority(ACME, detail());
    configureSpacePreferencePorts({
      client: () => client({ preview, apply }),
      spaceId: () => 'h-acme',
      identity: () => ACME,
    });
  });

  it('sends a preview and its apply, then takes the server’s answer', async () => {
    preview.mockResolvedValue({ token: 't1', rows: [{ id: 'pref:theme', blocked_reason: undefined }] });
    apply.mockResolvedValue({ detail: detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'light' } }), applied: ['pref:theme'] });
    await expect(writeSpacePreferenceItem('theme', 'light')).resolves.toBe(true);
    expect(preview).toHaveBeenCalledWith('h-acme', { action: 'edit', changes: [{ id: 'pref:theme', value: 'light' }] });
    expect(apply).toHaveBeenCalledWith('h-acme', { token: 't1', selected: ['pref:theme'] });
    expect(spacePreferenceValue('theme')).toBe('light');
    expect(spaceAuthoritySnapshot().writes['theme']).toBeUndefined();
  });

  it('keeps the draft and records the failure when the write does not land', async () => {
    preview.mockRejectedValue(new Error('offline'));
    await expect(writeSpacePreferenceItem('theme', 'light')).resolves.toBe(false);
    // The person’s choice is still on screen, marked as not saved.
    expect(spacePreferenceValue('theme')).toBe('light');
    expect(spacePreferenceValue('theme')).not.toBe(spaceAuthoritySnapshot().confirmed?.theme);
    expect(spaceAuthoritySnapshot().writes['theme']?.state).toBe('error');
  });

  it('refuses a row the server blocked instead of writing it anyway', async () => {
    preview.mockResolvedValue({ token: 't1', rows: [{ id: 'pref:theme', blocked_reason: 'Resource content is unavailable' }] });
    await expect(writeSpacePreferenceItem('theme', 'light')).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('the device’s other look', () => {
  it('records that this device settled the question', () => {
    configureSpaceAuthority(ACME, detail());
    expect(spaceDeviceConflictResolved(ACME)).toBe(false);
    resolveSpaceDeviceConflict(ACME);
    expect(spaceDeviceConflictResolved(ACME)).toBe(true);
  });

  it('follows the server’s answer on an import, including the conflict it reports', async () => {
    const importPreferences = vi.fn().mockResolvedValue({
      detail: detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'light' } }),
      imported: false,
      device_conflict: true,
    });
    const result = await importDevicePreferences(client({ importPreferences }), ACME, 'device-1', { theme: 'light' });
    expect(result).toEqual({ imported: false, conflict: true });
    expect(spaceAuthoritySnapshot().deviceConflict).toBe(true);
    expect(importPreferences).toHaveBeenCalledWith('h-acme', { values: { theme: 'light' }, device_id: 'device-1' });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function connect(identity = ACME, homes: Record<string, unknown>) {
  configureSpacePreferencePorts({ client: () => client(homes), spaceId: () => identity.homeId, identity: () => identity });
}

describe('authority isolation and response ordering', () => {
  it('uses the exact server cache once the server is known, even with the same home', () => {
    configureSpaceAuthority(OTHER, detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'light' } }));
    configureSpaceAuthority(ACME, detail());
    clearSpaceAuthority();
    loadCachedSpacePreferences('h-acme', 'server-b');
    expect(spaceAuthoritySnapshot().identity).toEqual(OTHER);
    expect(spacePreferenceValue('theme')).toBe('light');
    clearSpaceAuthority();
    loadCachedSpacePreferences('h-acme', 'server-c');
    expect(spaceAuthoritySnapshot().confirmed).toBeNull();
  });

  it('lets A finish its apply without publishing over B or dropping B’s failed draft', async () => {
    const late = deferred<{ detail: SpaceDetail }>();
    const applyA = vi.fn().mockReturnValue(late.promise);
    configureSpaceAuthority(ACME, detail());
    connect(ACME, { preview: vi.fn().mockResolvedValue({ token: 'a', rows: [{ id: 'pref:theme' }] }), apply: applyA });
    const pending = writeSpacePreferenceItem('theme', 'light');
    await Promise.resolve();
    configureSpaceAuthority(OTHER, detail());
    connect(OTHER, { preview: vi.fn().mockRejectedValue(new Error('B offline')) });
    await writeSpacePreferenceItem('theme', 'system');
    const held = spaceAuthoritySnapshot();
    late.resolve({ detail: detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'light' } }) });
    await expect(pending).resolves.toBe(true);
    expect(applyA).toHaveBeenCalledOnce();
    expect(spaceAuthoritySnapshot()).toBe(held);
    clearSpaceAuthority();
    loadCachedSpacePreferences('h-acme', 'server-a');
    expect(spacePreferenceValue('theme')).toBe('light');
  });

  it('keeps B unchanged after an old A import or failure returns', async () => {
    configureSpaceAuthority(ACME, detail({ preference_authority: false }));
    const lateImport = deferred<{ detail: SpaceDetail; imported: boolean; device_conflict: boolean }>();
    const pendingImport = importDevicePreferences(client({ importPreferences: () => lateImport.promise }), ACME, 'device-1', { theme: 'light' });
    const lateFailure = deferred<unknown>();
    connect(ACME, { preview: () => lateFailure.promise });
    const pendingWrite = writeSpacePreferenceItem('theme', 'light');
    configureSpaceAuthority(OTHER, detail());
    const held = spaceAuthoritySnapshot();
    lateImport.resolve({ detail: detail(), imported: true, device_conflict: true });
    lateFailure.reject(new Error('A offline'));
    await pendingImport;
    await pendingWrite;
    expect(spaceAuthoritySnapshot()).toBe(held);
  });

  it('does not let an older same-item response clear a newer failed draft', async () => {
    configureSpaceAuthority(ACME, detail());
    const late = deferred<{ detail: SpaceDetail }>();
    const preview = vi.fn().mockResolvedValueOnce({ token: 'old', rows: [{ id: 'pref:theme' }] }).mockRejectedValueOnce(new Error('new offline'));
    connect(ACME, { preview, apply: () => late.promise });
    const old = writeSpacePreferenceItem('theme', 'light');
    await Promise.resolve();
    await writeSpacePreferenceItem('theme', 'system');
    late.resolve({ detail: detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'light' } }) });
    await old;
    expect(spacePreferenceValue('theme')).toBe('system');
    expect(spaceAuthoritySnapshot().writes.theme?.state).toBe('error');
  });

  it('preserves in-flight drafts and errors during background detail refresh', async () => {
    configureSpaceAuthority(ACME, detail());
    const late = deferred<unknown>();
    connect(ACME, { preview: () => late.promise });
    const pending = writeSpacePreferenceItem('theme', 'light');
    configureSpaceAuthority(ACME, detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, proseFont: 'sans' } }));
    expect(spaceAuthoritySnapshot().drafts.theme).toBe('light');
    expect(spaceAuthoritySnapshot().writes.theme?.state).toBe('saving');
    late.reject(new Error('offline'));
    await pending;
    const held = spaceAuthoritySnapshot();
    configureSpaceAuthority(ACME, detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, proseFont: 'sans' } }));
    expect(spaceAuthoritySnapshot().drafts).toEqual(held.drafts);
    expect(spaceAuthoritySnapshot().writes).toEqual(held.writes);
    expect(spacePreferenceValue('theme')).toBe('light');
    expect(spacePreferenceValue('proseFont')).toBe('sans');
  });

  it('does not roll back an independently saved field when another full apply detail arrives late', async () => {
    configureSpaceAuthority(ACME, detail());
    const lateTheme = deferred<{ detail: SpaceDetail }>();
    const lateFont = deferred<{ detail: SpaceDetail }>();
    connect(ACME, {
      preview: vi.fn().mockImplementation((_id, request) => Promise.resolve({ token: request.changes[0].id, rows: [{ id: request.changes[0].id }] })),
      apply: vi.fn().mockImplementation((_id, request) => request.token === 'pref:theme' ? lateTheme.promise : lateFont.promise),
    });
    const theme = writeSpacePreferenceItem('theme', 'light');
    const font = writeSpacePreferenceItem('proseFont', 'sans');
    await Promise.resolve();
    lateFont.resolve({ detail: detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'dark', proseFont: 'sans' } }) });
    await font;
    lateTheme.resolve({ detail: detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'light', proseFont: 'serif' } }) });
    await theme;
    expect(spaceAuthoritySnapshot().confirmed).toMatchObject({ theme: 'light', proseFont: 'sans' });
  });
});

describe('latest intent and reconnect generation', () => {
  it('keeps the newer confirmed value when same-item successes return backwards', async () => {
    configureSpaceAuthority(ACME, detail());
    const oldResult = deferred<{ detail: SpaceDetail }>();
    const newResult = deferred<{ detail: SpaceDetail }>();
    connect(ACME, {
      preview: vi.fn().mockResolvedValueOnce({ token: 'old', rows: [{ id: 'pref:theme' }] }).mockResolvedValueOnce({ token: 'new', rows: [{ id: 'pref:theme' }] }),
      apply: vi.fn().mockImplementation((_id, request) => request.token === 'old' ? oldResult.promise : newResult.promise),
    });
    const old = writeSpacePreferenceItem('theme', 'light');
    const newer = writeSpacePreferenceItem('theme', 'system');
    await Promise.resolve();
    newResult.resolve({ detail: detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'system' } }) });
    await newer;
    oldResult.resolve({ detail: detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'light' } }) });
    await old;
    expect(spaceAuthoritySnapshot().confirmed?.theme).toBe('system');
    expect(spaceAuthoritySnapshot().drafts).toEqual({});
    expect(spaceAuthoritySnapshot().writes).toEqual({});
  });

  it('does not publish an old A apply into a new A visit after A → B → A', async () => {
    configureSpaceAuthority(ACME, detail());
    const latePreview = deferred<{ token: string; rows: { id: string }[] }>();
    const apply = vi.fn().mockResolvedValue({ detail: detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'light' } }) });
    connect(ACME, { preview: () => latePreview.promise, apply });
    const pending = writeSpacePreferenceItem('theme', 'light');
    configureSpaceAuthority(OTHER, detail());
    configureSpaceAuthority(ACME, detail({ preferences: { ...DEFAULT_SPACE_PREFERENCES, theme: 'system' } }));
    const held = spaceAuthoritySnapshot();
    latePreview.resolve({ token: 'old', rows: [{ id: 'pref:theme' }] });
    await expect(pending).resolves.toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    expect(spaceAuthoritySnapshot()).toBe(held);
  });
});

it('retry while disconnected keeps the unsaved draft and its error visible', async () => {
  configureSpaceAuthority(ACME, detail());
  connect(ACME, { preview: vi.fn().mockRejectedValue(new Error('offline')) });
  await writeSpacePreferenceItem('theme', 'light');
  const held = spaceAuthoritySnapshot();
  configureSpacePreferencePorts(undefined);
  retrySpacePreferenceItem('theme');
  await Promise.resolve();
  expect(spaceAuthoritySnapshot()).toBe(held);
  expect(spaceAuthoritySnapshot().writes.theme?.state).toBe('error');
});
