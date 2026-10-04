import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalOriginalOAuthService } from '../src/local-original';
import type { OriginalOAuthNative } from '../src/local-original-types';

const SCOPE = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const now = Math.floor(Date.now() / 1000);
const homes: string[] = [];
function jwt(claims: Record<string, unknown>): string { return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`; }
function codexToken(exp = now + 60, account = 'account-a', suffix = ''): string {
  return jwt({ exp, iat: now - 3500, sub: 'user-a', nonce: suffix, 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_user_id: 'user-a' } });
}
function codex(exp = now + 60, account = 'account-a', refresh = 'refresh-a'): Record<string, unknown> {
  return { auth_mode: 'chatgpt', tokens: { access_token: codexToken(exp, account), refresh_token: refresh, id_token: jwt({ sub: 'user-a' }), account_id: account }, last_refresh: new Date((now - 3500) * 1000).toISOString(), unrelated: 'preserved' };
}
function grok(exp = now + 60): Record<string, unknown> {
  return { [SCOPE]: { key: jwt({ sub: 'user-a', exp }), auth_mode: 'oidc', refresh_token: 'refresh-a', user_id: 'user-a',
    expires_at: new Date(exp * 1000).toISOString(), create_time: new Date((now - 3500) * 1000).toISOString(), oidc_issuer: 'https://auth.x.ai',
    oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828', coding_data_retention_opt_out: true, future_metadata: { retained: true } },
    enterprise: { key: 'unrelated-entry' } };
}
async function home(auth: Record<string, unknown>): Promise<string> {
  const root = resolve('.tmp/original-oauth-fixtures');
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(join(root, 'home-'));
  homes.push(path);
  await writeFile(join(path, 'auth.json'), JSON.stringify(auth));
  return path;
}
function runtime(fetchImpl: typeof fetch, overrides: Partial<OriginalOAuthNative> = {}) {
  const values = new Map<string, string>();
  const release = vi.fn();
  const native: OriginalOAuthNative = {
    canonicalizeOriginalHome: async (value) => value,
    ageEncrypt: async (bytes, passphrase) => Buffer.from(`${passphrase}:${Buffer.from(bytes).toString('base64')}`),
    ageDecrypt: async (bytes, passphrase) => {
      const text = Buffer.from(bytes).toString();
      if (!text.startsWith(`${passphrase}:`)) throw new Error('bad passphrase');
      return Buffer.from(text.slice(passphrase.length + 1), 'base64');
    },
    acquireGrokAuthLock: async () => ({ release, isCurrent: () => true }),
    ...overrides,
  };
  const keyring = { load: vi.fn(async (service: string, account: string) => values.get(`${service}/${account}`)),
    save: vi.fn(async (service: string, account: string, value: string) => { values.set(`${service}/${account}`, value); }) };
  const make = () => new LocalOriginalOAuthService({ keyring, native, parseConfig: JSON.parse, fetchImpl, now: () => now, env: {}, platform: 'linux' });
  return { service: make(), make, native, keyring, values, release };
}
function refreshed(provider: 'openai-codex' | 'grok-build', extra: Record<string, unknown> = {}): Response {
  return Response.json({ access_token: provider === 'openai-codex' ? codexToken(now + 3600, 'account-a', 'new') : jwt({ sub: 'user-a', exp: now + 3600 }),
    refresh_token: 'rotated-refresh', id_token: jwt({ sub: 'user-a', revision: 'new' }), expires_in: 3600, ...extra });
}
afterEach(async () => { await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('original OAuth credentials', () => {
  it.each(['openai-codex', 'grok-build'] as const)('probes %s without a grant or writes, then rotates in place and reopens', async (provider) => {
    const dir = await home(provider === 'openai-codex' ? codex() : grok());
    const before = await readFile(join(dir, 'auth.json'), 'utf8');
    const fetchImpl = vi.fn<typeof fetch>(async () => refreshed(provider));
    const r = runtime(fetchImpl);
    const probe = await r.service.probe(provider, dir);
    expect(probe).toMatchObject({ state: 'refresh_required', storageBackend: 'file', canConnect: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readFile(join(dir, 'auth.json'), 'utf8')).toBe(before);
    const ref = await r.service.connect(provider, dir, provider === 'openai-codex' ? 'account-a' : 'user-a');
    expect(await r.make().getAccessToken(ref)).toBe(provider === 'openai-codex' ? codexToken(now + 3600, 'account-a', 'new') : jwt({ sub: 'user-a', exp: now + 3600 }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(String(init.body)).toContain('refresh-a');
    const saved = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'));
    if (provider === 'openai-codex') {
      expect(saved.tokens.refresh_token).toBe('rotated-refresh');
      expect(saved.tokens.id_token).toBe(jwt({ sub: 'user-a', revision: 'new' }));
      expect(saved.unrelated).toBe('preserved');
    } else {
      expect(saved[SCOPE].refresh_token).toBe('rotated-refresh');
      expect(saved[SCOPE].future_metadata).toEqual({ retained: true });
      expect(saved.enterprise).toEqual({ key: 'unrelated-entry' });
    }
    expect(r.release).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent requests and adopts a sibling rotation after acquiring the lock', async () => {
    const dir = await home(codex());
    const fetchImpl = vi.fn<typeof fetch>(async () => refreshed('openai-codex'));
    const r = runtime(fetchImpl, { acquireGrokAuthLock: async () => {
      await writeFile(join(dir, 'auth.json'), JSON.stringify(codex(now + 3600, 'account-a', 'sibling-refresh')));
      return { release: vi.fn(), isCurrent: () => true };
    } });
    const ref = (await r.service.probe('openai-codex', dir)).sourceRef!;
    const values = await Promise.all(Array.from({ length: 8 }, () => r.service.getAccessToken(ref, { force: true })));
    expect(new Set(values).size).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never changes account or silently falls back to a new storage source', async () => {
    const dir = await home(codex(now + 3600));
    const fetchImpl = vi.fn<typeof fetch>(async () => refreshed('openai-codex'));
    const r = runtime(fetchImpl);
    const ref = await r.service.connect('openai-codex', dir, 'account-a');
    await writeFile(join(dir, 'auth.json'), JSON.stringify(codex(now + 60, 'account-b')));
    await expect(r.service.getAccessToken(ref)).rejects.toMatchObject({ state: 'account_changed' });
    expect(fetchImpl).not.toHaveBeenCalled();
    await writeFile(join(dir, 'config.toml'), JSON.stringify({ cli_auth_credentials_store: 'keyring' }));
    await expect(r.service.getAccessToken(ref)).rejects.toMatchObject({ state: 'unsupported' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([400, 503])('does not destroy original credentials after HTTP %s and does not expose response secrets', async (status) => {
    const dir = await home(codex());
    const before = await readFile(join(dir, 'auth.json'), 'utf8');
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: status === 400 ? 'invalid_grant' : 'server_error', error_description: 'sensitive-canary' }, { status }));
    const r = runtime(fetchImpl);
    const ref = (await r.service.probe('openai-codex', dir)).sourceRef!;
    await expect(r.service.getAccessToken(ref)).rejects.not.toThrow('sensitive-canary');
    expect(await readFile(join(dir, 'auth.json'), 'utf8')).toBe(before);
    expect(r.release).toHaveBeenCalled();
  });

  it('keeps a pending rotated token after a write failure and saves it without reusing the old RT', async () => {
    const dir = await home(codex());
    await writeFile(join(dir, 'config.toml'), JSON.stringify({ cli_auth_credentials_store: 'keyring' }));
    const fetchImpl = vi.fn<typeof fetch>(async () => refreshed('openai-codex'));
    const r = runtime(fetchImpl);
    const account = `cli|${createHash('sha256').update(dir).digest('hex').slice(0, 16)}`;
    r.values.set(`Codex Auth/${account}`, JSON.stringify(codex()));
    const ref = (await r.service.probe('openai-codex', dir)).sourceRef!;
    const before = r.values.get(`Codex Auth/${account}`);
    r.keyring.save.mockRejectedValueOnce(new Error('keyring unavailable'));
    await expect(r.service.getAccessToken(ref)).rejects.toThrow('could not be saved');
    expect(r.values.get(`Codex Auth/${account}`)).toBe(before);
    expect(await r.service.getAccessToken(ref)).toBe(codexToken(now + 3600, 'account-a', 'new'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(r.values.get(`Codex Auth/${account}`)!).tokens.refresh_token).toBe('rotated-refresh');
  });

  it('rejects a lock replaced during grant and retains the pending rotation for recovery', async () => {
    const dir = await home(grok());
    let current = true;
    const fetchImpl = vi.fn<typeof fetch>(async () => { current = false; return refreshed('grok-build'); });
    const r = runtime(fetchImpl, { acquireGrokAuthLock: async () => ({ release: vi.fn(), isCurrent: () => current }) });
    const ref = (await r.service.probe('grok-build', dir)).sourceRef!;
    const before = await readFile(join(dir, 'auth.json'), 'utf8');
    await expect(r.service.getAccessToken(ref)).rejects.toMatchObject({ state: 'refresh_failed' });
    expect(await readFile(join(dir, 'auth.json'), 'utf8')).toBe(before);
    current = true;
    await expect(r.service.getAccessToken(ref)).resolves.toBe(jwt({ sub: 'user-a', exp: now + 3600 }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('preserves encrypted secret entries and uses original keyring names and canonical home bytes', async () => {
    const dir = await home(codex());
    await mkdir(join(dir, 'secrets'));
    await writeFile(join(dir, 'config.toml'), JSON.stringify({ cli_auth_credentials_store: 'keyring', features: { secret_auth_storage: true } }));
    const canonical = `canonical-home-${dir}`;
    const r = runtime(vi.fn<typeof fetch>(async () => refreshed('openai-codex')), { canonicalizeOriginalHome: async () => canonical });
    const account = `secrets|${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
    r.values.set(`codex/${account}`, 'existing-passphrase');
    const content = { version: 0, secrets: { 'global/CODEX_AUTH': JSON.stringify(codex()), 'other/key': 'preserved' } };
    const path = join(dir, 'secrets/codex_auth.age');
    await writeFile(path, await r.native.ageEncrypt(Buffer.from(JSON.stringify(content)), 'existing-passphrase'));
    const ref = await r.service.connect('openai-codex', dir, 'account-a');
    expect(ref.storageBackend).toBe('encrypted');
    const saved = JSON.parse(Buffer.from(await r.native.ageDecrypt(await readFile(path), 'existing-passphrase')).toString());
    expect(saved.version).toBe(1);
    expect(saved.secrets['other/key']).toBe('preserved');
    expect(JSON.parse(saved.secrets['global/CODEX_AUTH']).tokens.refresh_token).toBe('rotated-refresh');
    expect(r.keyring.save).not.toHaveBeenCalled();
    expect(r.keyring.load).toHaveBeenCalledWith('codex', account);
    expect((await r.make().probe('openai-codex', dir)).state).toBe('ready');
  });

  it('distinguishes ephemeral, unavailable encrypted password and unsupported formats from signed out', async () => {
    const dir = await home(codex());
    const r = runtime(vi.fn());
    await writeFile(join(dir, 'config.toml'), JSON.stringify({ cli_auth_credentials_store: 'ephemeral' }));
    expect(await r.service.probe('openai-codex', dir)).toMatchObject({ state: 'unsupported', storageBackend: 'ephemeral', canConnect: false });
    await writeFile(join(dir, 'config.toml'), JSON.stringify({ cli_auth_credentials_store: 'keyring', features: { secret_auth_storage: true } }));
    await mkdir(join(dir, 'secrets'));
    await writeFile(join(dir, 'secrets/codex_auth.age'), 'ciphertext');
    expect(await r.service.probe('openai-codex', dir)).toMatchObject({ state: 'unreadable', canConnect: false });
    expect(r.keyring.save).not.toHaveBeenCalled();
  });

  it('sends Grok team principal through the existing OAuth grant and retains attribution', async () => {
    const auth = grok();
    const entry = auth[SCOPE] as Record<string, unknown>;
    entry['user_id'] = 'team-a'; entry['principal_type'] = 'Team'; entry['principal_id'] = 'team-a'; entry['team_id'] = 'team-a';
    entry['key'] = jwt({ sub: 'user-a', exp: now + 60, principalType: 'Team', principalId: 'team-a' });
    const dir = await home(auth);
    const fetchImpl = vi.fn<typeof fetch>(async () => refreshed('grok-build', { access_token: jwt({ sub: 'user-a', exp: now + 3600, principalType: 'Team', principalId: 'team-a' }) }));
    const r = runtime(fetchImpl);
    await r.service.connect('grok-build', dir, 'team-a');
    const form = new URLSearchParams(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(form.get('principal_type')).toBe('Team'); expect(form.get('principal_id')).toBe('team-a');
    expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))[SCOPE].user_id).toBe('team-a');
  });
});

describe('original OAuth production native consumer', () => {
  it('uses the real age/canonical/OS guard unit, rotates encrypted Codex in place and reopens it', async () => {
    const dir = await home(codex());
    await mkdir(join(dir, 'secrets'));
    await writeFile(join(dir, 'config.toml'), JSON.stringify({ cli_auth_credentials_store: 'keyring', features: { secret_auth_storage: true } }));
    const native = createRequire(import.meta.url)('@kiki/auth-native') as typeof import('@kiki/auth-native');
    const account = `secrets|${createHash('sha256').update(await native.canonicalizeOriginalHome(dir)).digest('hex').slice(0, 16)}`;
    const r = runtime(vi.fn<typeof fetch>(async () => refreshed('openai-codex')));
    r.values.set(`codex/${account}`, 'synthetic-only-password');
    const path = join(dir, 'secrets/codex_auth.age');
    await writeFile(path, await native.ageEncrypt(Buffer.from(JSON.stringify({ version: 1, secrets: { 'global/CODEX_AUTH': JSON.stringify(codex()), 'other/secret': 'preserved' } })), 'synthetic-only-password'));
    const make = () => new LocalOriginalOAuthService({ keyring: r.keyring, parseConfig: JSON.parse,
      fetchImpl: vi.fn<typeof fetch>(async () => refreshed('openai-codex')), env: {} });
    const source = await make().connect('openai-codex', dir, 'account-a');
    const saved = JSON.parse((await native.ageDecrypt(await readFile(path), 'synthetic-only-password')).toString());
    expect(saved.secrets['other/secret']).toBe('preserved');
    expect(JSON.parse(saved.secrets['global/CODEX_AUTH']).tokens.refresh_token).toBe('rotated-refresh');
    expect(await make().getAccessToken(source)).toBe(codexToken(now + 3600, 'account-a', 'new'));
    expect(r.keyring.save).not.toHaveBeenCalled();
  }, 120_000);

  it('selects Windows secrets by default and respects explicit direct override', async () => {
    const dir = await home(codex(now + 3600));
    await mkdir(join(dir, 'secrets'));
    const r = runtime(vi.fn());
    const hash = createHash('sha256').update(dir).digest('hex').slice(0, 16);
    r.values.set(`codex/secrets|${hash}`, 'password');
    r.values.set(`Codex Auth/cli|${hash}`, JSON.stringify(codex(now + 3600)));
    await writeFile(join(dir, 'secrets/codex_auth.age'), await r.native.ageEncrypt(Buffer.from(JSON.stringify({ version: 1, secrets: { 'global/CODEX_AUTH': JSON.stringify(codex(now + 3600)) } })), 'password'));
    const make = () => new LocalOriginalOAuthService({ keyring: r.keyring, native: r.native, parseConfig: JSON.parse, env: {}, platform: 'win32' });
    await writeFile(join(dir, 'config.toml'), JSON.stringify({ cli_auth_credentials_store: 'keyring' }));
    expect((await make().probe('openai-codex', dir)).storageBackend).toBe('encrypted');
    await writeFile(join(dir, 'config.toml'), JSON.stringify({ cli_auth_credentials_store: 'keyring', features: { secret_auth_storage: false } }));
    expect((await make().probe('openai-codex', dir)).storageBackend).toBe('keyring');
  });

  it('disconnect leaves original credentials unchanged and denies old Kiki token providers', async () => {
    const dir = await home(grok(now + 3600));
    const fetchImpl = vi.fn<typeof fetch>();
    const r = runtime(fetchImpl);
    const source = await r.service.connect('grok-build', dir, 'user-a');
    const tokenProvider = r.service.tokenProvider(source);
    const before = await readFile(join(dir, 'auth.json'), 'utf8');
    await r.service.disconnect(source);
    await expect(tokenProvider.getAccessToken()).rejects.toMatchObject({ state: 'signed_out' });
    expect(await readFile(join(dir, 'auth.json'), 'utf8')).toBe(before);
    await r.service.connect('grok-build', dir, 'user-a');
    await expect(tokenProvider.getAccessToken()).resolves.toBe(jwt({ sub: 'user-a', exp: now + 3600 }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

it('two independent consumers share the real Grok advisory guard and rotate one original RT only once', async () => {
  const dir = await home(grok());
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    await new Promise<void>((done) => { setTimeout(done, 25); });
    return refreshed('grok-build');
  });
  const options = { keyring: { load: async () => undefined, save: async () => {} }, parseConfig: JSON.parse, fetchImpl, env: {} };
  const a = new LocalOriginalOAuthService(options);
  const b = new LocalOriginalOAuthService(options);
  const source = (await a.probe('grok-build', dir)).sourceRef!;
  const result = await Promise.all([a.getAccessToken(source), b.getAccessToken(source)]);
  expect(result).toEqual([jwt({ sub: 'user-a', exp: now + 3600 }), jwt({ sub: 'user-a', exp: now + 3600 })]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))[SCOPE].refresh_token).toBe('rotated-refresh');
});

it('does not overwrite an account changed by an uncooperative writer while the OAuth grant is in flight', async () => {
  const dir = await home(codex());
  const replacement = JSON.stringify(codex(now + 3600, 'other-account', 'other-refresh'));
  const fetchImpl = vi.fn<typeof fetch>(async () => { await writeFile(join(dir, 'auth.json'), replacement); return refreshed('openai-codex'); });
  const r = runtime(fetchImpl);
  const source = (await r.service.probe('openai-codex', dir)).sourceRef!;
  await expect(r.service.getAccessToken(source)).rejects.toMatchObject({ state: 'account_changed' });
  expect(await readFile(join(dir, 'auth.json'), 'utf8')).toBe(replacement);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('adopts a concurrent rotation after invalid_grant instead of destroying the source', async () => {
  const dir = await home(codex());
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    await writeFile(join(dir, 'auth.json'), JSON.stringify(codex(now + 3600, 'account-a', 'sibling-rotated')));
    return Response.json({ error: 'invalid_grant' }, { status: 400 });
  });
  const r = runtime(fetchImpl);
  const source = (await r.service.probe('openai-codex', dir)).sourceRef!;
  await expect(r.service.getAccessToken(source)).resolves.toBe(codexToken(now + 3600));
  expect((await r.service.probe('openai-codex', dir, source)).state).toBe('ready');
  expect(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')).tokens.refresh_token).toBe('sibling-rotated');
});
