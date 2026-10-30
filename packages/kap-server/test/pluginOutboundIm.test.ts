import { chmod, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IConfigService, ISessionManager, type Scope } from '@kiki/agent-core-v2';
import type { PluginImSendRequest } from '@kiki/agent-core-v2';
import { NotificationService } from '../src/services/notifications/notificationService';
import { ensurePluginDigestReceipts } from '../src/services/notifications/pluginDigestDelivery';
import { sendProvider } from '../src/services/notifications/providerDelivery';
import type { ProviderContext } from '@nb-im/core';

const transport = vi.hoisted(() => ({
  posts: [] as Array<{ body: string; authorization?: string }>,
  entered: 0,
  mode: 'ok' as 'ok' | 'throw' | 'status',
  status: 200,
  body: '{}',
  hold: undefined as Promise<void> | undefined,
  afterDispatch: undefined as Promise<void> | undefined,
  marker: 'leak-marker',
}));

vi.mock('@nb-im/core', async (original) => {
  const donor = await original<typeof import('@nb-im/core')>();
  return {
    ...donor,
    webhookProvider: (id: Parameters<typeof donor.webhookProvider>[0]) => donor.webhookProvider(id, {
      post: async (input, permit) => {
        transport.entered += 1;
        if (transport.hold !== undefined) await transport.hold;
        const state = permit();
        if (state !== 'ready') return { blocked: state };
        if (transport.mode === 'throw') throw new Error(transport.marker);
        transport.posts.push({ body: input.body, authorization: input.authorization });
        if (transport.afterDispatch !== undefined) await transport.afterDispatch;
        if (transport.mode === 'status') return { status: transport.status, body: transport.body };
        return { status: 200, body: '{}' };
      },
    }),
  };
});

const scenes = { work_complete: false, question_pending: false };
const mailPlugin = 'kiki-mail';
const signal = () => new AbortController().signal;

function quietNow(): { start: string; end: string; time_zone: string } {
  const now = new Date();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const end = (minutes + 120) % 1440;
  const format = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  return { start: format(minutes), end: format(end), time_zone: 'UTC' };
}

describe('plugin digest delivery', () => {
  let home: string;
  let service: NotificationService;
  let stored: unknown;
  const errors: string[] = [];
  const secret = 'SuperSecretTokenValue123';
  const digest = 'New mail from ada@example.test about the contract';

  beforeEach(() => {
    transport.posts = [];
    transport.entered = 0;
    transport.mode = 'ok';
    transport.status = 200;
    transport.body = '{}';
    transport.hold = undefined;
    transport.afterDispatch = undefined;
    errors.length = 0;
  });
  afterEach(async () => {
    const current = service;
    service = undefined as unknown as NotificationService;
    await current?.close();
    if (home) await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  async function boot(record = errors, reuse = false): Promise<NotificationService> {
    if (!reuse) {
      home = await mkdtemp(join(tmpdir(), 'kiki-plugin-im-'));
      stored = undefined;
    }
    const config = {
      ready: Promise.resolve(),
      get: () => stored,
      replaceSections: async (sections: Record<string, unknown>) => { stored = sections['notifications']; },
    };
    const core = { accessor: { get: (key: unknown) => {
      if (key === IConfigService) return config;
      if (key === ISessionManager) return { list: () => [] };
      throw new Error('unexpected_app_service');
    } } } as unknown as Scope;
    service = new NotificationService(core, home, () => false, () => { record.push('notification-error'); });
    await service.start();
    return service;
  }

  async function httpChannel(target = service, token?: string): Promise<void> {
    const options: Record<string, unknown> = { endpoint: 'https://example.test/', format: 'json' };
    const slots: Record<string, { provider_id: 'http'; provider_instance_id: 'hook'; purpose: 'http_bearer'; env: 'NBIM_HTTP_BEARER' }> = {};
    if (token !== undefined) {
      options['auth_slot'] = 'bearer';
      slots['bearer'] = { provider_id: 'http', provider_instance_id: 'hook', purpose: 'http_bearer', env: 'NBIM_HTTP_BEARER' };
    }
    await target.upsertInstance('hook', { provider_id: 'http', enabled: true, revision: 'v1', options }, slots);
    if (token !== undefined) await target.setCredential('bearer', token);
    await target.upsertChannel('mail', {
      provider_instance_id: 'hook', enabled: true, revision: 'v1', target: {}, directions: ['send'], scenes, label: 'Ops',
    });
  }

  function request(routeRevision: string, extra: Partial<PluginImSendRequest> = {}): PluginImSendRequest {
    return { channelId: 'mail', routeRevision, idempotencyKey: 'mail-1', accountRef: 'account-a', text: digest, ...extra };
  }

  it('stays unavailable before the runtime starts', async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-plugin-im-'));
    const core = { accessor: { get: (key: unknown) => {
      if (key === IConfigService) return { ready: Promise.resolve(), get: () => undefined };
      if (key === ISessionManager) return { list: () => [] };
      throw new Error('unexpected_app_service');
    } } } as unknown as Scope;
    service = new NotificationService(core, home, () => false, () => { errors.push('notification-error'); });
    expect(await service.pluginImCapabilities(signal())).toEqual({ outbound: false, inbound: false });
    expect(await service.pluginImRoutes(signal())).toEqual([]);
  });

  it('lists only usable routes and sends the digest through the configured provider', async () => {
    await boot();
    await httpChannel(service, secret);
    await service.upsertInstance('toast', { provider_id: 'windows_toast', enabled: true, revision: 'v1', options: {} }, {});
    await service.upsertChannel('desktop', {
      provider_instance_id: 'toast', enabled: true, revision: 'v1', target: {}, directions: ['send'],
      scenes: { work_complete: true, question_pending: true },
    });
    await service.upsertChannel('closed', {
      provider_instance_id: 'hook', enabled: false, revision: 'v1', target: {}, directions: ['send'], scenes,
    });
    const caps = await service.pluginImCapabilities(signal());
    const routes = await service.pluginImRoutes(signal());
    expect(caps).toEqual({ outbound: true, inbound: false });
    expect(routes).toEqual([{ channelId: 'mail', providerId: 'http', label: 'Ops', routeRevision: routes[0]?.routeRevision }]);
    expect(routes[0]?.routeRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(routes)).not.toContain(secret);
    const sent = await service.pluginImSend(request(routes[0]!.routeRevision), signal(), mailPlugin);
    expect(sent).toEqual({ status: 'accepted', retryable: false });
    expect(JSON.stringify(sent)).not.toContain(secret);
    expect(JSON.stringify(sent)).not.toContain(digest);
    expect(transport.posts).toEqual([{
      body: JSON.stringify({ text: digest, category: 'mail_digest' }),
      authorization: `Bearer ${secret}`,
    }]);
    expect(errors).toEqual([]);
  });

  it('keeps the fixed work-complete sentence on the notification path', async () => {
    await boot();
    await httpChannel();
    service.sendTest('mail');
    await vi.waitFor(() => {
      expect(transport.posts.some((post) => post.body.includes('工作已完成'))).toBe(true);
    }, { timeout: 5000 });
    expect(transport.posts.some((post) => post.body.includes('mail_digest') || post.body.includes(digest))).toBe(false);
  });

  it('does not call the provider when the master switch, channel, revision, or credential blocks the send', async () => {
    await boot();
    await httpChannel(service, secret);
    const revision = (await service.pluginImRoutes(signal()))[0]!.routeRevision;
    const global = service.getSettings().global;
    await service.updateSettings({ ...global, enabled: false });
    expect(await service.pluginImCapabilities(signal())).toEqual({ outbound: true, inbound: false });
    expect(await service.pluginImRoutes(signal())).toEqual([]);
    expect(await service.pluginImSend(request(revision), signal(), mailPlugin)).toMatchObject({ status: 'failed', diagnosticCode: 'notifications_disabled', retryable: false });
    await service.updateSettings({ ...global, quiet_hours: quietNow() });
    const quietRevision = (await service.pluginImRoutes(signal()))[0]!.routeRevision;
    expect((await service.pluginImSend(request(quietRevision), signal(), mailPlugin)).status).toBe('accepted');
    expect(transport.posts).toHaveLength(1);
    await service.upsertChannel('mail', {
      provider_instance_id: 'hook', enabled: false, revision: 'v1', target: {}, directions: ['send'], scenes, label: 'Ops',
    });
    expect(await service.pluginImRoutes(signal())).toEqual([]);
    expect(await service.pluginImSend(request(quietRevision), signal(), mailPlugin)).toMatchObject({ diagnosticCode: 'route_disabled' });
    await service.upsertChannel('mail', {
      provider_instance_id: 'hook', enabled: true, revision: 'v2', target: {}, directions: ['send'], scenes, label: 'Ops',
    });
    expect(await service.pluginImSend(request(quietRevision), signal(), mailPlugin)).toMatchObject({ diagnosticCode: 'route_changed' });
    expect(transport.posts).toHaveLength(1);
    const next = (await service.pluginImRoutes(signal()))[0]!.routeRevision;
    expect(next).not.toBe(quietRevision);
    await service.setCredential('bearer', secret);
    expect(await service.pluginImSend(request(next), signal(), mailPlugin)).toMatchObject({ diagnosticCode: 'route_changed' });
    const rotated = (await service.pluginImRoutes(signal()))[0]!.routeRevision;
    expect(await service.pluginImSend(request(rotated), signal(), mailPlugin)).toMatchObject({ status: 'failed', diagnosticCode: 'idempotency_conflict' });
    expect((await service.pluginImSend(request(rotated, { idempotencyKey: 'mail-2' }), signal(), mailPlugin)).status).toBe('accepted');
    expect(transport.posts).toHaveLength(2);
    expect(JSON.stringify(await service.pluginImRoutes(signal()))).not.toContain(secret);
    expect(errors).toEqual([]);
  });

  it('does not repeat an accepted, failed, or unknown send for the same account and key', async () => {
    await boot();
    await httpChannel();
    const revision = (await service.pluginImRoutes(signal()))[0]!.routeRevision;
    expect((await service.pluginImSend(request(revision), signal(), mailPlugin)).status).toBe('accepted');
    expect((await service.pluginImSend(request(revision), signal(), mailPlugin)).status).toBe('accepted');
    expect((await service.pluginImSend(request(revision, { accountRef: 'account-b' }), signal(), mailPlugin)).status).toBe('accepted');
    expect(transport.posts).toHaveLength(2);
    transport.mode = 'status';
    transport.status = 401;
    const denied = await service.pluginImSend(request(revision, { idempotencyKey: 'mail-denied' }), signal(), mailPlugin);
    expect(denied).toMatchObject({ status: 'failed', diagnosticCode: 'webhook_auth', retryable: false });
    expect(JSON.stringify(denied)).not.toContain(digest);
    await service.pluginImSend(request(revision, { idempotencyKey: 'mail-denied' }), signal(), mailPlugin);
    transport.status = 500;
    const unclear = await service.pluginImSend(request(revision, { idempotencyKey: 'mail-unknown' }), signal(), mailPlugin);
    expect(unclear).toMatchObject({ status: 'unknown', retryable: false, diagnosticCode: 'webhook_response_unknown' });
    await service.pluginImSend(request(revision, { idempotencyKey: 'mail-unknown' }), signal(), mailPlugin);
    expect(transport.posts).toHaveLength(4);
    const conflict = await service.pluginImSend(request(revision, { idempotencyKey: 'mail-unknown', text: 'A different digest' }), signal(), mailPlugin);
    expect(conflict).toMatchObject({ status: 'failed', diagnosticCode: 'idempotency_conflict' });
    expect(transport.posts).toHaveLength(4);
    await service.close();
    transport.posts = [];
    const restarted = await boot(errors, true);
    const again = (await restarted.pluginImRoutes(signal()))[0]!.routeRevision;
    expect(await restarted.pluginImSend(request(again, { idempotencyKey: 'mail-unknown' }), signal(), mailPlugin)).toMatchObject({ status: 'unknown', retryable: false });
    expect(transport.posts).toHaveLength(0);
  });

  it('joins one in-flight send and cancels before the provider dispatch', async () => {
    await boot();
    await httpChannel();
    const revision = (await service.pluginImRoutes(signal()))[0]!.routeRevision;
    let release = () => {};
    transport.hold = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const cancelled = service.pluginImSend(request(revision, { idempotencyKey: 'mail-cancel' }), controller.signal, mailPlugin);
    await vi.waitFor(() => expect(transport.entered).toBe(1));
    controller.abort();
    release();
    await expect(cancelled).resolves.toMatchObject({ status: 'cancelled', retryable: false });
    expect(transport.posts).toHaveLength(0);
    const aborted = new AbortController();
    aborted.abort();
    expect(await service.pluginImSend(request(revision, { idempotencyKey: 'mail-cancel' }), aborted.signal, mailPlugin)).toMatchObject({ status: 'cancelled' });
    expect(transport.entered).toBe(1);
    let releaseSend = () => {};
    transport.hold = new Promise<void>((resolve) => { releaseSend = resolve; });
    transport.entered = 0;
    const first = service.pluginImSend(request(revision, { idempotencyKey: 'mail-join' }), signal(), mailPlugin);
    await vi.waitFor(() => expect(transport.entered).toBe(1));
    const second = service.pluginImSend(request(revision, { idempotencyKey: 'mail-join' }), signal(), mailPlugin);
    const other = service.pluginImSend(request(revision, { idempotencyKey: 'mail-join', text: 'other digest' }), signal(), mailPlugin);
    await expect(other).resolves.toMatchObject({ diagnosticCode: 'idempotency_conflict' });
    expect(transport.entered).toBe(1);
    releaseSend();
    await expect(first).resolves.toMatchObject({ status: 'accepted', retryable: false });
    await expect(second).resolves.toMatchObject({ status: 'accepted', retryable: false });
    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0]?.body).toContain(digest);
    expect(transport.posts[0]?.body).not.toContain('other digest');
    transport.mode = 'throw';
    const thrown = await service.pluginImSend(request(revision, { idempotencyKey: 'mail-throw' }), signal(), mailPlugin);
    expect(thrown).toMatchObject({ status: 'unknown', retryable: false });
    expect(JSON.stringify(thrown)).not.toContain(transport.marker);
    expect(errors).toEqual([]);
  });

  it('pauses settings before joining a hung digest and preserves its unknown receipt', async () => {
    await boot();
    await httpChannel();
    const revision = (await service.pluginImRoutes(signal()))[0]!.routeRevision;
    let release = () => {};
    transport.afterDispatch = new Promise<void>((resolve) => { release = resolve; });
    const pending = service.pluginImSend(request(revision), signal(), mailPlugin);
    await vi.waitFor(() => expect(transport.posts).toHaveLength(1));
    const started = performance.now();
    await service.updateSettings({ ...service.getSettings().global, enabled: false });
    expect(performance.now() - started).toBeLessThan(1500);
    await expect(pending).resolves.toMatchObject({ status: 'unknown', retryable: false });
    expect(await service.pluginImRoutes(signal())).toEqual([]);
    release();
    transport.afterDispatch = undefined;
    await service.updateSettings({ ...service.getSettings().global, enabled: true });
    const next = (await service.pluginImRoutes(signal()))[0]!.routeRevision;
    expect(next).toBe(revision);
    expect(await service.pluginImSend(request(next), signal(), mailPlugin)).toMatchObject({ status: 'unknown' });
    expect(transport.posts).toHaveLength(1);
    await service.close();
    await boot(errors, true);
    expect(await service.pluginImSend(request(revision), signal(), mailPlugin)).toMatchObject({ status: 'unknown' });
    expect(transport.posts).toHaveLength(1);
  });

  it.each([false, true])('closes hung scene and digest sends after dispatch=%s', async (dispatched) => {
    await boot();
    await httpChannel(service, secret);
    const revision = (await service.pluginImRoutes(signal()))[0]!.routeRevision;
    let release = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    if (dispatched) transport.afterDispatch = hold;
    else transport.hold = hold;
    service.sendTest('mail');
    const pending = service.pluginImSend(request(revision), signal(), mailPlugin);
    await vi.waitFor(() => expect(transport.entered).toBe(2), { timeout: 5000 });
    const started = performance.now();
    await service.close();
    expect(performance.now() - started).toBeLessThan(1500);
    await expect(pending).resolves.toMatchObject(dispatched ? { status: 'unknown' } : { status: 'failed', diagnosticCode: 'route_changed' });
    release();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(transport.posts).toHaveLength(dispatched ? 2 : 0);
    await boot(errors, true);
    expect(service.listDeliveries()[0]).toMatchObject({ status: dispatched ? 'unknown' : 'failed',
      result: { diagnostic_code: dispatched ? 'send_outcome_unknown' : 'dispatch_stale' } });
    expect((await service.pluginImSend(request(revision), signal(), mailPlugin)).status).toBe(dispatched ? 'unknown' : 'accepted');
    expect(transport.posts).toHaveLength(dispatched ? 2 : 1);
  });

  it('settles caller cancellation after dispatch while the transport remains blocked', async () => {
    await boot();
    await httpChannel();
    const revision = (await service.pluginImRoutes(signal()))[0]!.routeRevision;
    let release = () => {};
    transport.afterDispatch = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const pending = service.pluginImSend(request(revision), controller.signal, mailPlugin);
    await vi.waitFor(() => expect(transport.posts).toHaveLength(1));
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: 'unknown' });
    release();
    expect(await service.pluginImSend(request(revision), signal(), mailPlugin)).toMatchObject({ status: 'unknown' });
    expect(transport.posts).toHaveLength(1);
  });

  it('lets two plugins send the same account key once each and keeps both receipts across restart', async () => {
    await boot();
    await httpChannel();
    const revision = (await service.pluginImRoutes(signal()))[0]!.routeRevision;
    let release = () => {};
    transport.hold = new Promise<void>((resolve) => { release = resolve; });
    const mail = service.pluginImSend(request(revision), signal(), mailPlugin);
    const calendar = service.pluginImSend(request(revision), signal(), 'kiki-calendar');
    await vi.waitFor(() => expect(transport.entered).toBe(2));
    release();
    await expect(mail).resolves.toMatchObject({ status: 'accepted', retryable: false });
    await expect(calendar).resolves.toMatchObject({ status: 'accepted', retryable: false });
    expect(transport.posts).toHaveLength(2);
    await service.close();
    transport.posts = [];
    transport.entered = 0;
    const restarted = await boot(errors, true);
    const again = (await restarted.pluginImRoutes(signal()))[0]!.routeRevision;
    expect((await restarted.pluginImSend(request(again), signal(), mailPlugin)).status).toBe('accepted');
    expect((await restarted.pluginImSend(request(again), signal(), 'kiki-calendar')).status).toBe('accepted');
    expect(transport.posts).toHaveLength(0);
  });

  it('keeps an armed receipt as unknown across restart and does not send again', async () => {
    await boot();
    await httpChannel();
    const revision = (await service.pluginImRoutes(signal()))[0]!.routeRevision;
    let release = () => {};
    transport.hold = new Promise<void>((resolve) => { release = resolve; });
    const pending = service.pluginImSend(request(revision, { idempotencyKey: 'mail-armed' }), signal(), mailPlugin);
    await vi.waitFor(() => expect(transport.entered).toBe(1));
    const snap = join(home, 'armed.sqlite').replaceAll('\\', '/');
    const reader = new DatabaseSync(join(home, 'notifications', 'outbox.sqlite'));
    const armed = reader.prepare(
      `SELECT state FROM plugin_digest_receipts WHERE plugin_id = ? AND account_ref = ? AND idempotency_key = ?`,
    ).get(mailPlugin, 'account-a', 'mail-armed') as { state?: string } | undefined;
    expect(armed?.state).toBe('armed');
    reader.exec(`VACUUM INTO '${snap}'`);
    reader.close();
    release();
    await expect(pending).resolves.toMatchObject({ status: 'accepted' });
    await service.close();
    await rm(join(home, 'notifications'), { recursive: true, force: true });
    await mkdir(join(home, 'notifications'), { recursive: true });
    const restored = join(home, 'notifications', 'outbox.sqlite');
    await copyFile(snap, restored);
    await chmod(restored, 0o600);
    transport.posts = [];
    transport.entered = 0;
    const restarted = await boot(errors, true);
    const again = (await restarted.pluginImRoutes(signal()))[0]!.routeRevision;
    expect(await restarted.pluginImSend(request(again, { idempotencyKey: 'mail-armed' }), signal(), mailPlugin)).toMatchObject({
      status: 'unknown', retryable: false, diagnosticCode: 'send_outcome_unknown',
    });
    expect(transport.posts).toHaveLength(0);
  });

  it('preserves unscoped digest receipts and does not resend them', async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-plugin-im-'));
    stored = undefined;
    await mkdir(join(home, 'notifications'), { recursive: true });
    const seeded = new DatabaseSync(join(home, 'notifications', 'outbox.sqlite'));
    seeded.exec(`CREATE TABLE plugin_digest_receipts (
      account_ref TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY (account_ref, idempotency_key)
    )`);
    const insert = seeded.prepare(`INSERT INTO plugin_digest_receipts
      (account_ref, idempotency_key, fingerprint, channel_id, text_hash, state)
      VALUES (?, ?, 'legacy-fingerprint', 'mail', ?, ?)`);
    insert.run('account-a', 'mail-accepted', 'legacy-hash-accepted', 'accepted');
    insert.run('account-a', 'mail-armed', 'legacy-hash-armed', 'armed');
    seeded.close();
    await chmod(join(home, 'notifications', 'outbox.sqlite'), 0o600);
    await boot(errors, true);
    await httpChannel(service, secret);
    const revision = (await service.pluginImRoutes(signal()))[0]!.routeRevision;
    expect(await service.pluginImSend(request(revision, { idempotencyKey: 'mail-accepted' }), signal(), mailPlugin)).toMatchObject({
      status: 'unknown', retryable: false, diagnosticCode: 'send_outcome_unknown',
    });
    expect(await service.pluginImSend(request(revision, { idempotencyKey: 'mail-armed' }), signal(), 'kiki-calendar')).toMatchObject({
      status: 'unknown', retryable: false, diagnosticCode: 'send_outcome_unknown',
    });
    expect(transport.posts).toHaveLength(0);
    expect((await service.pluginImSend(request(revision, { idempotencyKey: 'mail-new' }), signal(), 'kiki-calendar')).status).toBe('accepted');
    expect(transport.posts).toHaveLength(1);
    const current = service;
    service = undefined as unknown as NotificationService;
    await current.close();
    const reader = new DatabaseSync(join(home, 'notifications', 'outbox.sqlite'));
    try {
      expect(reader.prepare(`SELECT idempotency_key, fingerprint, text_hash, state
        FROM plugin_digest_receipts_unscoped ORDER BY idempotency_key`).all()).toEqual([
        { idempotency_key: 'mail-accepted', fingerprint: 'legacy-fingerprint', text_hash: 'legacy-hash-accepted', state: 'accepted' },
        { idempotency_key: 'mail-armed', fingerprint: 'legacy-fingerprint', text_hash: 'legacy-hash-armed', state: 'armed' },
      ]);
      expect(reader.prepare(`SELECT idempotency_key FROM plugin_digest_receipts ORDER BY idempotency_key`).all()).toEqual([
        { idempotency_key: 'mail-new' },
      ]);
    } finally {
      reader.close();
    }
  });

  it('keeps a damaged digest table unchanged', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE plugin_digest_receipts (noise TEXT)');
    db.prepare(`INSERT INTO plugin_digest_receipts (noise) VALUES ('keep-me')`).run();
    expect(ensurePluginDigestReceipts(db)).toBe('unavailable');
    expect(db.prepare('SELECT noise FROM plugin_digest_receipts').get()).toEqual({ noise: 'keep-me' });
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugin_digest_receipts_unscoped'`).all()).toEqual([]);
    db.close();
  });

  it('does not leave an empty digest table when legacy rename is interrupted', () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec(`CREATE TABLE plugin_digest_receipts (
      account_ref TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY (account_ref, idempotency_key)
    )`);
    raw.prepare(`INSERT INTO plugin_digest_receipts (account_ref, idempotency_key, state) VALUES ('account-a', 'mail-1', 'accepted')`).run();
    const db = {
      exec(sql: string) {
        if (sql.startsWith('CREATE TABLE plugin_digest_receipts (')) throw new Error('interrupted');
        raw.exec(sql);
      },
      prepare(sql: string) {
        return raw.prepare(sql);
      },
    };
    expect(ensurePluginDigestReceipts(db)).toBe('unavailable');
    expect(raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugin_digest_receipts_unscoped'`).all()).toEqual([]);
    expect(raw.prepare('SELECT account_ref, idempotency_key, state FROM plugin_digest_receipts').get()).toEqual({
      account_ref: 'account-a', idempotency_key: 'mail-1', state: 'accepted',
    });
    const columns = raw.prepare('PRAGMA table_info(plugin_digest_receipts)').all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === 'plugin_id')).toBe(false);
    raw.close();
  });

  it.each([false, true])('enforces one absolute provider deadline after dispatch=%s', async (dispatch) => {
    vi.useFakeTimers();
    try {
      let late: ProviderContext | undefined;
      const begin = vi.fn(() => 'ready' as const);
      const pending = sendProvider({ id: 'http', send: async (context) => {
        late = context;
        if (dispatch) context.beginDispatch();
        await new Promise<void>(() => {});
        return { status: 'accepted', message_ids: [], retryable: false };
      } }, {
        delivery_id: 'deadline', channel_id: 'mail', category: 'work_complete', text: 'Done',
        idempotency_key: 'deadline', expires_at: new Date(Date.now() + 10).toISOString(),
        instance: { provider_id: 'http', enabled: true, revision: 'v1', options: {} }, target: {},
        canDispatch: () => 'ready', beginDispatch: begin, resolveCredential: () => secret,
      }, signal());
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toMatchObject({ status: dispatch ? 'unknown' : 'failed',
        diagnostic_code: dispatch ? 'send_outcome_unknown' : 'delivery_expired' });
      expect(late!.beginDispatch()).toBe('stale');
      expect(() => late!.resolveCredential('bearer')).toThrow('credential_scope_violation');
      expect(begin).toHaveBeenCalledTimes(dispatch ? 1 : 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform === 'win32')('refuses a group-readable outbox before the runtime opens', async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-plugin-im-'));
    stored = undefined;
    await mkdir(join(home, 'notifications'), { recursive: true });
    const path = join(home, 'notifications', 'outbox.sqlite');
    const seeded = new DatabaseSync(path);
    seeded.close();
    await chmod(path, 0o644);
    await expect(boot(errors, true)).rejects.toThrow('insecure_store_permissions');
    expect(transport.posts).toEqual([]);
    expect(errors).toEqual([]);
  });
});
