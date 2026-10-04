import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { OAuthError, OAuthUnauthorizedError } from './errors';
import { createOAuthDeviceMethod } from './oauth-device-methods';
import { decodeJwtPayload } from './oauth-method-types';
import { openaiCodexAccountId } from './openai-codex';
import type { BearerTokenProvider } from './toolkit';
import type { TokenInfo } from './types';
import { isRecord } from './utils';
import {
  OriginalStorageError, originalDirectKeyringStore, originalEncryptedStore, originalFileStore,
  type OriginalCredentialSnapshot, type OriginalCredentialStore,
} from './local-original-storage';
import type {
  LocalOriginalOAuthProbe, LocalOriginalOAuthProvider, LocalOriginalOAuthSourceRef,
  LocalOriginalOAuthState, OriginalOAuthKeyring, OriginalOAuthNative,
} from './local-original-types';

const GROK_ISSUER = 'https://auth.x.ai';
const GROK_CLIENT = 'b1a00492-073a-47ea-816f-4c329264a828';
const GROK_SCOPE = `${GROK_ISSUER}::${GROK_CLIENT}`;

export interface LocalOriginalOAuthOptions {
  readonly keyring: OriginalOAuthKeyring;
  readonly parseConfig: (content: string) => unknown;
  readonly native?: OriginalOAuthNative;
  readonly fetchImpl?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
}

export class LocalOriginalOAuthError extends OAuthError {
  constructor(readonly state: LocalOriginalOAuthState, message: string) {
    super(message);
    this.name = 'LocalOriginalOAuthError';
  }
}

interface OriginalAccount {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accountId: string;
  readonly userId?: string;
  readonly expiresAt: number;
  readonly expiresIn: number;
  readonly scope?: string;
}

interface LoadedOriginal {
  readonly store: OriginalCredentialStore;
  readonly snapshot: OriginalCredentialSnapshot;
  readonly account: OriginalAccount;
  readonly ref: LocalOriginalOAuthSourceRef;
}

interface PendingRotation {
  readonly refreshToken: string;
  readonly token: TokenInfo;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && !/[\u0000-\u001F\u007F]/u.test(value) ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value) / 1000;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nativeRuntime(): OriginalOAuthNative {
  try {
    return createRequire(import.meta.url)('@kiki/auth-native') as OriginalOAuthNative;
  } catch {
    throw new LocalOriginalOAuthError('unsupported', 'Native original-credential support is unavailable in this Kiki host.');
  }
}

export class LocalOriginalOAuthService {
  private readonly flights = new Map<string, Promise<string>>();
  private readonly disconnected = new Set<string>();
  private readonly pending = new Map<string, PendingRotation>();
  private readonly failures = new Map<string, { generation: string; message: string }>();
  private nativeInstance: OriginalOAuthNative | undefined;

  constructor(private readonly options: LocalOriginalOAuthOptions) {}

  private native(): OriginalOAuthNative {
    return this.nativeInstance ??= this.options.native ?? nativeRuntime();
  }

  private now(): number { return this.options.now?.() ?? Math.floor(Date.now() / 1000); }

  private home(provider: LocalOriginalOAuthProvider, requested?: string): string {
    const env = this.options.env ?? process.env;
    const selected = requested ?? env[provider === 'openai-codex' ? 'CODEX_HOME' : 'GROK_HOME'] ?? join(homedir(), provider === 'openai-codex' ? '.codex' : '.grok');
    if (!isAbsolute(selected)) throw new LocalOriginalOAuthError('unsupported', 'Select an absolute directory on the Kiki server.');
    return resolve(selected);
  }

  private async config(homeDir: string): Promise<Record<string, unknown>> {
    let content: string;
    try { content = await readFile(join(homeDir, 'config.toml'), 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new LocalOriginalOAuthError('unreadable', 'The original application configuration could not be read.');
    }
    try {
      const parsed = this.options.parseConfig(content);
      if (!isRecord(parsed)) throw new Error('not an object');
      return parsed;
    } catch {
      throw new LocalOriginalOAuthError('unreadable', 'The original application configuration is not readable TOML.');
    }
  }

  private async selectStore(provider: LocalOriginalOAuthProvider, homeDir: string): Promise<OriginalCredentialStore> {
    if (provider === 'grok-build') {
      const override = (this.options.env ?? process.env)['GROK_AUTH_PATH'];
      const path = override ? override : join(homeDir, 'auth.json');
      if (!isAbsolute(path)) throw new LocalOriginalOAuthError('unsupported', 'The original Grok credential path must be absolute on the Kiki server.');
      return originalFileStore(resolve(path));
    }
    const config = await this.config(homeDir);
    const mode = config['cli_auth_credentials_store'] ?? 'file';
    if (mode === 'ephemeral') throw new LocalOriginalOAuthError('unsupported', 'The original sign-in exists only inside its application process.');
    if (mode === 'file') return originalFileStore(join(homeDir, 'auth.json'));
    if (mode !== 'keyring' && mode !== 'auto') throw new LocalOriginalOAuthError('unsupported', 'The original credential storage mode is not supported.');
    const features = config['features'];
    const secret = isRecord(features) ? features['secret_auth_storage'] : undefined;
    if (secret !== undefined && typeof secret !== 'boolean') throw new LocalOriginalOAuthError('unsupported', 'The original encrypted-storage setting is not supported.');
    let store: OriginalCredentialStore;
    try {
      const canonicalHome = await this.native().canonicalizeOriginalHome(homeDir);
      store = (secret ?? (this.options.platform ?? process.platform) === 'win32')
        ? originalEncryptedStore(homeDir, canonicalHome, { keyring: this.options.keyring, native: this.native() })
        : originalDirectKeyringStore(homeDir, canonicalHome, this.options.keyring);
      if (mode === 'keyring' || await store.read() !== undefined) return store;
    } catch (error) {
      if (mode !== 'auto') throw error;
      const fallback = originalFileStore(join(homeDir, 'auth.json'));
      if (await fallback.read() === undefined) throw error;
      return fallback;
    }
    return originalFileStore(join(homeDir, 'auth.json'));
  }

  private account(provider: LocalOriginalOAuthProvider, auth: Record<string, unknown>): OriginalAccount {
    let entry: Record<string, unknown>;
    let accessToken: string | undefined;
    let refreshToken: string | undefined;
    let accountId: string | undefined;
    let userId: string | undefined;
    let expiresAt: number | undefined;
    let issuedAt: number | undefined;
    if (provider === 'openai-codex') {
      if (auth['auth_mode'] !== undefined && auth['auth_mode'] !== 'chatgpt' || string(auth['OPENAI_API_KEY'])) {
        throw new LocalOriginalOAuthError('unsupported', 'The original Codex sign-in is not a ChatGPT OAuth account.');
      }
      if (!isRecord(auth['tokens'])) throw new LocalOriginalOAuthError('signed_out', 'No original ChatGPT sign-in was found.');
      entry = auth['tokens'];
      accessToken = string(entry['access_token']);
      refreshToken = string(entry['refresh_token']);
      accountId = accessToken === undefined ? undefined : openaiCodexAccountId(accessToken);
      const idClaims = decodeJwtPayload(string(entry['id_token']) ?? '');
      const idAuth = idClaims?.['https://api.openai.com/auth'];
      if (isRecord(idAuth) && idAuth['chatgpt_account_is_fedramp'] === true) {
        throw new LocalOriginalOAuthError('unsupported', 'This original ChatGPT account requires a different service route.');
      }
      const claims = decodeJwtPayload(accessToken ?? '');
      const accountClaims = claims?.['https://api.openai.com/auth'];
      userId = isRecord(accountClaims) ? string(accountClaims['chatgpt_user_id']) : undefined;
      userId ??= isRecord(idAuth) ? string(idAuth['chatgpt_user_id']) : undefined;
      userId ??= string(claims?.['sub']);
      expiresAt = timestamp(claims?.['exp']);
      issuedAt = timestamp(claims?.['iat']) ?? timestamp(auth['last_refresh']);
      if (string(entry['account_id']) && entry['account_id'] !== accountId) throw new LocalOriginalOAuthError('account_changed', 'The original account identifiers no longer match.');
    } else {
      const value = auth[GROK_SCOPE];
      if (!isRecord(value)) throw new LocalOriginalOAuthError(Object.keys(auth).length === 0 ? 'signed_out' : 'unsupported', 'No supported original public Grok OAuth account was found.');
      entry = value;
      if (entry['auth_mode'] !== 'oidc' || string(entry['oidc_issuer']) && entry['oidc_issuer'] !== GROK_ISSUER ||
        string(entry['oidc_client_id']) && entry['oidc_client_id'] !== GROK_CLIENT) {
        throw new LocalOriginalOAuthError('unsupported', 'The original Grok account uses a different authentication method.');
      }
      accessToken = string(entry['key']);
      refreshToken = string(entry['refresh_token']);
      const claims = decodeJwtPayload(accessToken ?? '');
      userId = string(claims?.['sub']);
      const owner = string(entry['user_id']);
      accountId = owner;
      const principalId = string(claims?.['principal_id'] ?? claims?.['principalId']);
      const principalType = string(claims?.['principal_type'] ?? claims?.['principalType']);
      if (principalId && string(entry['principal_id']) && principalId !== entry['principal_id'] ||
        principalType && string(entry['principal_type']) && principalType !== entry['principal_type']) {
        throw new LocalOriginalOAuthError('account_changed', 'The original Grok principal identifiers no longer match.');
      }
      expiresAt = timestamp(entry['expires_at']) ?? timestamp(claims?.['exp']);
      issuedAt = timestamp(entry['create_time']);
    }
    if (!accessToken || !refreshToken || !accountId || expiresAt === undefined) throw new LocalOriginalOAuthError('unsupported', 'The original OAuth account lacks refreshable credentials or an expiration.');
    return { accessToken, refreshToken, accountId, userId, expiresAt,
      expiresIn: issuedAt === undefined ? 0 : Math.max(0, expiresAt - issuedAt), scope: provider === 'grok-build' ? GROK_SCOPE : undefined };
  }

  private async load(provider: LocalOriginalOAuthProvider, homeDir: string, pinned?: LocalOriginalOAuthSourceRef, selected?: (store: OriginalCredentialStore) => void): Promise<LoadedOriginal> {
    const store = await this.selectStore(provider, homeDir);
    selected?.(store);
    if (pinned && (store.backend !== pinned.storageBackend || pinned.authFile !== undefined && store.authFile !== pinned.authFile)) {
      throw new LocalOriginalOAuthError('unsupported', 'Original credential storage changed; reconnect this source explicitly.');
    }
    let snapshot: OriginalCredentialSnapshot | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        snapshot = await store.read();
        if (snapshot !== undefined || attempt === 2) break;
      } catch (error) {
        if (attempt === 2 || !(error instanceof OriginalStorageError) || error.state !== 'unreadable') throw error;
      }
      await new Promise<void>((done) => { setTimeout(done, 20); });
    }
    if (!snapshot) throw new LocalOriginalOAuthError('signed_out', 'No original sign-in was found at this server location.');
    const account = this.account(provider, snapshot.auth);
    if (pinned && (account.accountId !== pinned.accountId || account.userId !== pinned.userId || account.scope !== pinned.scope)) {
      throw new LocalOriginalOAuthError('account_changed', 'The original account changed; reconnect to confirm the account.');
    }
    const ref: LocalOriginalOAuthSourceRef = { kind: 'local_original', provider, homeDir,
      storageBackend: store.backend, authFile: store.authFile, accountId: account.accountId,
      userId: account.userId, scope: account.scope };
    return { store, snapshot, account, ref };
  }

  private key(ref: LocalOriginalOAuthSourceRef): string { return JSON.stringify(ref); }
  private generation(account: OriginalAccount): string { return createHash('sha256').update(`${account.accessToken}\0${account.refreshToken}\0${account.expiresAt}`).digest('hex'); }
  private refreshRequired(account: OriginalAccount): boolean { return account.expiresAt - this.now() <= 300; }

  async probe(provider: LocalOriginalOAuthProvider, requestedHome?: string, pinned?: LocalOriginalOAuthSourceRef): Promise<LocalOriginalOAuthProbe> {
    let homeDir = requestedHome ?? '';
    let backend: LocalOriginalOAuthProbe['storageBackend'] = pinned?.storageBackend ?? null;
    try {
      homeDir = this.home(provider, requestedHome);
      const loaded = await this.load(provider, homeDir, pinned, (store) => { backend = store.backend; });
      const failure = this.failures.get(this.key(loaded.ref));
      const state = this.pending.has(this.key(loaded.ref)) || failure?.generation === this.generation(loaded.account) ? 'refresh_failed'
        : this.refreshRequired(loaded.account) ? 'refresh_required' : 'ready';
      return { provider, homeDir, storageBackend: loaded.store.backend, state,
        account: { state: 'known', id: loaded.account.accountId }, canConnect: state !== 'refresh_failed',
        reason: state === 'refresh_failed' ? failure?.message ?? 'A refreshed credential is waiting to be saved to its original storage.' : undefined, sourceRef: loaded.ref };
    } catch (error) {
      const state = error instanceof LocalOriginalOAuthError || error instanceof OriginalStorageError ? error.state : 'unreadable';
      return { provider, homeDir, storageBackend: error instanceof LocalOriginalOAuthError && error.message.includes('application process') ? 'ephemeral' : backend,
        state, account: { state: 'unknown' }, canConnect: false,
        reason: error instanceof LocalOriginalOAuthError || error instanceof OriginalStorageError ? error.message : 'The original credentials could not be read.' };
    }
  }

  async connect(provider: LocalOriginalOAuthProvider, homeDir: string | undefined, expectedAccountId: string): Promise<LocalOriginalOAuthSourceRef> {
    const loaded = await this.load(provider, this.home(provider, homeDir));
    if (loaded.account.accountId !== expectedAccountId) throw new LocalOriginalOAuthError('account_changed', 'The original account changed before it was connected.');
    this.disconnected.delete(this.key(loaded.ref));
    await this.getAccessToken(loaded.ref);
    return loaded.ref;
  }

  async disconnect(ref: LocalOriginalOAuthSourceRef): Promise<void> {
    const key = this.key(ref);
    this.disconnected.add(key);
    await this.flights.get(key)?.catch(() => {});
  }

  tokenProvider(ref: LocalOriginalOAuthSourceRef): BearerTokenProvider {
    return { getAccessToken: (options) => this.getAccessToken(ref, options) };
  }

  async getCachedAccessToken(ref: LocalOriginalOAuthSourceRef): Promise<string | undefined> {
    try { return (await this.load(ref.provider, this.home(ref.provider, ref.homeDir), ref)).account.accessToken; } catch { return undefined; }
  }

  getAccessToken(ref: LocalOriginalOAuthSourceRef, options?: { readonly force?: boolean }): Promise<string> {
    const key = this.key(ref);
    if (this.disconnected.has(key)) return Promise.reject(new LocalOriginalOAuthError('signed_out', 'This original account source is disconnected from Kiki.'));
    const flight = this.flights.get(key);
    if (flight !== undefined) return flight;
    const run = this.ensureFresh(ref, options?.force === true);
    this.flights.set(key, run);
    run.finally(() => { if (this.flights.get(key) === run) this.flights.delete(key); }).catch(() => {});
    return run;
  }

  private updatedAuth(loaded: LoadedOriginal, token: TokenInfo): Record<string, unknown> {
    const auth = structuredClone(loaded.snapshot.auth);
    const now = new Date(this.now() * 1000).toISOString();
    if (loaded.ref.provider === 'openai-codex') {
      auth['tokens'] = { ...(auth['tokens'] as Record<string, unknown>), access_token: token.accessToken,
        refresh_token: token.refreshToken,
        id_token: token.idToken ?? (auth['tokens'] as Record<string, unknown>)['id_token'] };
      auth['last_refresh'] = now;
    } else {
      auth[GROK_SCOPE] = { ...(auth[GROK_SCOPE] as Record<string, unknown>), key: token.accessToken,
        refresh_token: token.refreshToken, expires_at: new Date(token.expiresAt * 1000).toISOString(), create_time: now };
    }
    const account = this.account(loaded.ref.provider, auth);
    if (account.accountId !== loaded.ref.accountId || account.userId !== loaded.ref.userId) {
      throw new LocalOriginalOAuthError('account_changed', 'The refreshed credential belongs to a different original account.');
    }
    return auth;
  }

  private async persistPending(ref: LocalOriginalOAuthSourceRef, loaded: LoadedOriginal, isCurrent: () => boolean): Promise<string | undefined> {
    const key = this.key(ref);
    const pending = this.pending.get(key);
    if (pending === undefined) return undefined;
    if (loaded.account.refreshToken !== pending.refreshToken) {
      this.pending.delete(key);
      if (!this.refreshRequired(loaded.account)) return loaded.account.accessToken;
      throw new LocalOriginalOAuthError('refresh_failed', 'Original credentials changed during refresh; retry after the original account settles.');
    }
    const auth = this.updatedAuth(loaded, pending.token);
    if (!await loaded.store.compareAndSave(loaded.snapshot, auth, isCurrent)) throw new LocalOriginalOAuthError('refresh_failed', 'Original credentials changed before refresh could be saved.');
    this.pending.delete(key);
    this.failures.delete(key);
    return pending.token.accessToken;
  }

  private async ensureFresh(ref: LocalOriginalOAuthSourceRef, force: boolean): Promise<string> {
    let loaded = await this.load(ref.provider, this.home(ref.provider, ref.homeDir), ref);
    const observed = this.generation(loaded.account);
    if (!force && !this.pending.has(this.key(ref)) && !this.refreshRequired(loaded.account)) return loaded.account.accessToken;
    const lockPath = ref.provider === 'grok-build' ? loaded.store.authFile : join(ref.homeDir, 'auth.json');
    const guard = await this.native().acquireGrokAuthLock(lockPath, { timeoutMs: 15_000 });
    try {
      if (!guard.isCurrent()) throw new LocalOriginalOAuthError('refresh_failed', 'The original credential lock changed before refresh.');
      loaded = await this.load(ref.provider, this.home(ref.provider, ref.homeDir), ref);
      const persisted = await this.persistPending(ref, loaded, () => guard.isCurrent());
      if (persisted !== undefined) return persisted;
      if (this.generation(loaded.account) !== observed && !this.refreshRequired(loaded.account) || !force && !this.refreshRequired(loaded.account)) return loaded.account.accessToken;
      const key = this.key(ref);
      const failure = this.failures.get(key);
      if (failure?.generation === this.generation(loaded.account)) throw new LocalOriginalOAuthError('refresh_failed', failure.message);
      const method = createOAuthDeviceMethod(ref.provider, this.options.fetchImpl);
      if (method === undefined) throw new LocalOriginalOAuthError('unsupported', 'The original account OAuth method is unavailable.');
      if (!guard.isCurrent()) throw new LocalOriginalOAuthError('refresh_failed', 'The original credential lock changed before the OAuth grant.');
      let token: TokenInfo;
      try {
        const entry = ref.provider === 'grok-build' ? loaded.snapshot.auth[GROK_SCOPE] : undefined;
        token = await method.refresh(loaded.account.refreshToken, isRecord(entry) ? {
          principalType: string(entry['principal_type']), principalId: string(entry['principal_id']),
        } : undefined);
      } catch (error) {
        const current = await this.load(ref.provider, this.home(ref.provider, ref.homeDir), ref);
        if (this.generation(current.account) !== this.generation(loaded.account) && !this.refreshRequired(current.account)) return current.account.accessToken;
        const message = error instanceof OAuthUnauthorizedError ? 'The original sign-in must be renewed in its account login.' : 'The original OAuth account could not be refreshed; retry later.';
        if (error instanceof OAuthUnauthorizedError) this.failures.set(key, { generation: this.generation(current.account), message });
        throw new LocalOriginalOAuthError('refresh_failed', message);
      }
      this.pending.set(key, { refreshToken: loaded.account.refreshToken, token });
      if (!guard.isCurrent()) throw new LocalOriginalOAuthError('refresh_failed', 'The original credential lock changed before refresh could be saved.');
      const current = await this.load(ref.provider, this.home(ref.provider, ref.homeDir), ref);
      return await this.persistPending(ref, current, () => guard.isCurrent()) ?? current.account.accessToken;
    } finally { guard.release(); }
  }
}
