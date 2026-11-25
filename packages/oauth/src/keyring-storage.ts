/**
 * Keychain-backed OAuth token storage with coexistence with the legacy file store.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { readFile as readFileAsync, stat as statAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { LRUCache } from 'lru-cache';
import { parse as parseCredentialsStoreConfig } from 'smol-toml';

import { assertValidTokenName, FileTokenStorage } from './storage';
import type { FileTokenInspection, TokenStorage } from './storage';
import { classifyToken } from './token-state';
import type { TokenInfo, TokenInfoWire } from './types';
import { tokenFromWire, tokenToWire } from './types';
import { isRecord } from './utils';

export class OAuthStorageUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OAuthStorageUnavailableError';
  }
}

export const KEYRING_SERVICE = 'kimi-code';
export const KEYRING_PROBE_SERVICE = 'kimi-code-keyring-probe';

export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deleteCredential(): boolean;
}

export interface AsyncKeyringEntry {
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

export interface KeyringApi {
  createEntry(service: string, account: string): KeyringEntry;
  findAccounts(service: string): string[];
  createAsyncEntry?(service: string, account: string): Promise<AsyncKeyringEntry> | AsyncKeyringEntry;
  findAccountsAsync?(service: string): Promise<string[]>;
  readonly preferAsync?: boolean;
}

export type KeyringOperation = 'load' | 'save' | 'remove' | 'list';

export interface KeyringStorageObserver {
  onBackendSelected?(backend: 'keyring' | 'file', reason?: string): void;
  onKeyringDegraded?(operation: KeyringOperation, message: string): void;
  onMigrated?(name: string): void;
}

export interface RegisteredKeyringBackend {
  readonly api: KeyringApi;
  readonly observer?: KeyringStorageObserver;
}

let registeredBackend: RegisteredKeyringBackend | undefined;
let keyringDegraded = false;
let keyringDegradationError: unknown;

export function registerKeyringBackend(api: KeyringApi, observer?: KeyringStorageObserver): void {
  registeredBackend = { api, observer };
  keyringDegraded = false;
  keyringDegradationError = undefined;
}

export function unregisterKeyringBackend(): void {
  registeredBackend = undefined;
  keyringDegraded = false;
  keyringDegradationError = undefined;
}

export function getRegisteredKeyringBackend(): RegisteredKeyringBackend | undefined {
  return registeredBackend;
}

export function isKeyringDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['KIMI_DISABLE_KEYRING'] === '1';
}

export interface KeyringTokenStorageOptions {
  readonly keyring: KeyringApi;
  readonly legacy: FileTokenStorage;
  readonly service?: string;
  readonly observer?: KeyringStorageObserver;
  readonly coexist?: boolean;
}

export class KeyringTokenStorage implements TokenStorage {
  private readonly keyring: KeyringApi;
  private readonly legacy: FileTokenStorage;
  private readonly service: string;
  private readonly observer: KeyringStorageObserver | undefined;
  private readonly coexist: boolean;

  constructor(options: KeyringTokenStorageOptions) {
    this.keyring = options.keyring;
    this.legacy = options.legacy;
    this.service = options.service ?? KEYRING_SERVICE;
    this.observer = options.observer;
    this.coexist = options.coexist ?? false;
  }

  private serialize(token: TokenInfo): string {
    return JSON.stringify(tokenToWire(token));
  }

  private deserialize(raw: string): TokenInfo | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isRecord(parsed)) return undefined;
    return tokenFromWire(parsed as Partial<TokenInfoWire>);
  }

  private async getPassword(name: string): Promise<string | null> {
    if (this.keyring.createAsyncEntry !== undefined) {
      const entry = await this.keyring.createAsyncEntry(this.service, name);
      return (await entry.getPassword()) ?? null;
    }
    return this.keyring.createEntry(this.service, name).getPassword();
  }

  private async setPassword(name: string, value: string): Promise<void> {
    if (this.keyring.createAsyncEntry !== undefined) {
      const entry = await this.keyring.createAsyncEntry(this.service, name);
      await entry.setPassword(value);
      return;
    }
    this.keyring.createEntry(this.service, name).setPassword(value);
  }

  private async deleteCredential(name: string): Promise<boolean> {
    if (this.keyring.createAsyncEntry !== undefined) {
      const entry = await this.keyring.createAsyncEntry(this.service, name);
      return entry.deleteCredential();
    }
    return this.keyring.createEntry(this.service, name).deleteCredential();
  }

  private async findAccounts(): Promise<string[]> {
    if (this.keyring.findAccountsAsync !== undefined) {
      return this.keyring.findAccountsAsync(this.service);
    }
    return this.keyring.findAccounts(this.service);
  }

  private async tryKeyring<T>(
    operation: KeyringOperation,
    fn: () => Promise<T> | T,
  ): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }> {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      keyringDegraded = true;
      keyringDegradationError = error;
      this.observer?.onKeyringDegraded?.(
        operation,
        error instanceof Error ? error.message : String(error),
      );
      return { ok: false, error };
    }
  }

  async load(name: string): Promise<TokenInfo | undefined> {
    assertValidTokenName(name);
    return this.legacy.withTokenLock(name, async (access) => {
      if (keyringDegraded) {
        const fallback = await access.load();
        if (fallback !== undefined) return fallback;
        throw new OAuthStorageUnavailableError(`keyring unavailable while loading credential "${name}"`, {
          cause: keyringDegradationError,
        });
      }

      if (access.isRemovalMarked()) {
        if (access.isFileChangedSinceRemoval()) {
          access.clearRemoval();
        } else {
          const removed = await this.tryKeyring('remove', async () => {
            const deleted = await this.deleteCredential(name);
            if (!deleted && (await this.findAccounts()).includes(name)) {
              throw new Error(`failed to delete keyring credential "${name}"`);
            }
          });
          if (!removed.ok) {
            throw new OAuthStorageUnavailableError(`keyring unavailable while loading credential "${name}"`, {
              cause: removed.error,
            });
          }
          return undefined;
        }
      }

      const read = await this.tryKeyring('load', () => this.getPassword(name));
      if (!read.ok) {
        const fallback = await access.load();
        if (fallback !== undefined) return fallback;
        throw new OAuthStorageUnavailableError(`keyring unavailable while loading credential "${name}"`, {
          cause: read.error,
        });
      }

      if (read.value !== null) {
        return this.coexist
          ? this.reconcileOnHitCoexist(name, read.value, access)
          : this.reconcileOnHitStrict(name, read.value, access);
      }

      const listing = await this.tryKeyring('load', () => this.findAccounts());
      if (!listing.ok || listing.value.includes(name)) {
        const fallback = await access.load();
        if (fallback !== undefined) return fallback;
        throw new OAuthStorageUnavailableError(`keyring unavailable while loading credential "${name}"`, {
          cause: listing.ok ? undefined : listing.error,
        });
      }

      const first = await access.load();
      if (first === undefined) return undefined;
      if (this.coexist) {
        const migrated = await this.tryKeyring('save', () =>
          this.setPassword(name, this.serialize(first)),
        );
        if (migrated.ok) this.observer?.onMigrated?.(name);
        return first;
      }

      let serialized = this.serialize(first);
      let latest = first;
      const initial = await this.tryKeyring('save', () =>
        this.setPassword(name, serialized),
      );
      if (!initial.ok) return latest;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await access.load();
        if (current === undefined) {
          this.observer?.onMigrated?.(name);
          return latest;
        }
        const currentSerialized = this.serialize(current);
        if (currentSerialized === serialized) {
          if (await access.removeIfMatches(serialized)) this.observer?.onMigrated?.(name);
          return latest;
        }
        const rewrite = await this.tryKeyring('load', () =>
          this.setPassword(name, currentSerialized),
        );
        if (!rewrite.ok) return current;
        serialized = currentSerialized;
        latest = current;
      }
      return latest;
    });
  }

  private async reconcileOnHitStrict(
    name: string,
    raw: string,
    access: import('./storage').FileTokenAccess,
  ): Promise<TokenInfo | undefined> {
    const keyringToken = this.deserialize(raw);
    const fileToken = await access.load();
    if (fileToken === undefined) return keyringToken;

    if (keyringToken === undefined) {
      const fileSerialized = this.serialize(fileToken);
      const write = await this.tryKeyring('load', () =>
        this.setPassword(name, fileSerialized),
      );
      if (!write.ok) return fileToken;
      if (await access.removeIfMatches(fileSerialized)) this.observer?.onMigrated?.(name);
      return fileToken;
    }

    if (
      classifyToken(keyringToken).kind === 'valid' &&
      classifyToken(fileToken).kind === 'valid' &&
      issuedAt(fileToken) > issuedAt(keyringToken)
    ) {
      const fileSerialized = this.serialize(fileToken);
      const write = await this.tryKeyring('load', () =>
        this.setPassword(name, fileSerialized),
      );
      if (!write.ok) return fileToken;
      if (await access.removeIfMatches(fileSerialized)) this.observer?.onMigrated?.(name);
      return fileToken;
    }

    if (this.serialize(fileToken) === raw) await access.removeIfMatches(raw);
    return keyringToken;
  }

  private async reconcileOnHitCoexist(
    name: string,
    raw: string,
    access: import('./storage').FileTokenAccess,
  ): Promise<TokenInfo | undefined> {
    const keyringToken = this.deserialize(raw);
    const fileToken = await access.load();
    if (keyringToken === undefined) {
      if (fileToken === undefined) return undefined;
      await this.tryKeyring('load', () =>
        this.setPassword(name, this.serialize(fileToken)),
      );
      return fileToken;
    }
    if (
      fileToken !== undefined &&
      classifyToken(keyringToken).kind === 'valid' &&
      classifyToken(fileToken).kind === 'valid' &&
      issuedAt(fileToken) > issuedAt(keyringToken)
    ) {
      await this.tryKeyring('load', () =>
        this.setPassword(name, this.serialize(fileToken)),
      );
      return fileToken;
    }
    const stale =
      fileToken === undefined ||
      (classifyToken(keyringToken).kind === 'valid' &&
        classifyToken(fileToken).kind === 'valid' &&
        this.serialize(fileToken) !== raw);
    if (stale) {
      try {
        await access.save(keyringToken);
      } catch {
      }
    }
    return keyringToken;
  }

  async save(name: string, token: TokenInfo): Promise<void> {
    assertValidTokenName(name);
    await this.legacy.withTokenLock(name, async (access) => {
      if (this.coexist) {
        await access.save(token);
        if (!keyringDegraded) {
          await this.tryKeyring('save', () =>
            this.setPassword(name, this.serialize(token)),
          );
        }
        return;
      }
      if (keyringDegraded) {
        if (classifyToken(token).kind === 'revoked') {
          throw new OAuthStorageUnavailableError(`keyring unavailable while saving revoked credential "${name}"`, {
            cause: keyringDegradationError,
          });
        }
        await access.save(token);
        return;
      }
      const write = await this.tryKeyring('save', () =>
        this.setPassword(name, this.serialize(token)),
      );
      if (!write.ok) {
        if (classifyToken(token).kind === 'revoked') {
          throw new OAuthStorageUnavailableError(`keyring unavailable while saving revoked credential "${name}"`, {
            cause: write.error,
          });
        }
        await access.save(token);
        return;
      }
      try {
        await access.removeFile();
        access.clearRemoval();
      } catch (error) {
        const rollback = await this.tryKeyring('remove', async () => {
          const deleted = await this.deleteCredential(name);
          if (!deleted && (await this.findAccounts()).includes(name)) {
            throw new Error(`failed to roll back keyring credential "${name}"`, { cause: error });
          }
        });
        if (!rollback.ok) {
          throw new Error(`failed to finalize keyring credential "${name}"`, {
            cause: rollback.error,
          });
        }
        throw new Error(`failed to finalize credential "${name}"`, { cause: error });
      }
    });
  }

  async remove(name: string): Promise<void> {
    assertValidTokenName(name);
    const gone = await this.legacy.withTokenLock(name, async (access) => {
      access.markRemoved();
      const result = await this.tryKeyring('remove', async () => {
        const deleted = await this.deleteCredential(name);
        if (deleted) return true;
        return !(await this.findAccounts()).includes(name);
      });
      await access.remove();
      return result;
    });
    if (!gone.ok) throw new Error(`failed to delete keyring credential "${name}"`, { cause: gone.error });
    if (!gone.value) throw new Error(`failed to delete keyring credential "${name}"`);
  }

  async list(): Promise<string[]> {
    if (keyringDegraded) return this.legacy.list();
    const accounts = await this.tryKeyring('list', () => this.findAccounts());
    if (!accounts.ok) return this.legacy.list();
    return [...new Set([...accounts.value, ...(await this.legacy.list())])];
  }
}

function issuedAt(token: TokenInfo): number {
  return token.expiresAt - token.expiresIn;
}

export function probeKeyringBackend(keyring: KeyringApi): boolean {
  const account = `probe-${process.pid}-${randomBytes(8).toString('hex')}`;
  const sentinel = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let entry: KeyringEntry | undefined;
  try {
    entry = keyring.createEntry(KEYRING_PROBE_SERVICE, account);
    entry.setPassword(sentinel);
    if (entry.getPassword() !== sentinel) return false;
    entry.deleteCredential();
    return !keyring.findAccounts(KEYRING_PROBE_SERVICE).includes(account);
  } catch {
    return false;
  } finally {
    try {
      entry?.deleteCredential();
    } catch {
    }
  }
}

export async function probeKeyringBackendAsync(keyring: KeyringApi): Promise<boolean> {
  if (keyring.createAsyncEntry === undefined) {
    return probeKeyringBackend(keyring);
  }
  const account = `probe-${process.pid}-${randomBytes(8).toString('hex')}`;
  const sentinel = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let entry: AsyncKeyringEntry | undefined;
  try {
    entry = await keyring.createAsyncEntry(KEYRING_PROBE_SERVICE, account);
    await entry.setPassword(sentinel);
    if ((await entry.getPassword()) !== sentinel) return false;
    await entry.deleteCredential();
    const accounts = keyring.findAccountsAsync !== undefined
      ? await keyring.findAccountsAsync(KEYRING_PROBE_SERVICE)
      : keyring.findAccounts(KEYRING_PROBE_SERVICE);
    return !accounts.includes(account);
  } catch {
    return false;
  } finally {
    try {
      await entry?.deleteCredential();
    } catch {
    }
  }
}

export function keyringServiceForCredentialsDir(credentialsDir: string): string {
  const resolved = resolve(credentialsDir);
  const standard = resolve(join(homedir(), '.kimi-code', 'credentials'));
  if (resolved === standard) return KEYRING_SERVICE;
  return `kimi-code-${createHash('sha256').update(resolved).digest('hex').slice(0, 16)}`;
}

export const CREDENTIALS_STORE_CONFIG_KEY = 'credentials_store';
export type CredentialsStoreMode = 'file' | 'keyring' | 'auto';
const CREDENTIALS_STORE_MODES: readonly CredentialsStoreMode[] = ['file', 'keyring', 'auto'];

type ConfigParser = (text: string) => unknown;

interface CredentialsStoreModeCacheEntry {
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly size: number;
  readonly ino: number;
  readonly mode: CredentialsStoreMode;
}

const MAX_CONFIG_MODE_CACHE_ENTRIES = 64;
const credentialsStoreModeCache = new WeakMap<ConfigParser, LRUCache<string, CredentialsStoreModeCacheEntry>>();

function getModeCacheForParser(parser: ConfigParser): LRUCache<string, CredentialsStoreModeCacheEntry> {
  let cache = credentialsStoreModeCache.get(parser);
  if (cache === undefined) {
    cache = new LRUCache({ max: MAX_CONFIG_MODE_CACHE_ENTRIES });
    credentialsStoreModeCache.set(parser, cache);
  }
  return cache;
}

function parseModeFromText(parser: ConfigParser, text: string): CredentialsStoreMode {
  try {
    const parsed = parser(text);
    const raw = isRecord(parsed) ? parsed[CREDENTIALS_STORE_CONFIG_KEY] : undefined;
    return typeof raw === 'string' && (CREDENTIALS_STORE_MODES as readonly string[]).includes(raw)
      ? raw as CredentialsStoreMode
      : 'auto';
  } catch {
    return 'auto';
  }
}

export interface ResolveCredentialsStoreModeDeps {
  mode?: CredentialsStoreMode;
  configPath?: string;
  parseConfig?: ConfigParser;
}


export function resolveCredentialsStoreMode(
  credentialsDir: string,
  deps: ResolveCredentialsStoreModeDeps = {},
): CredentialsStoreMode {
  if (deps.mode !== undefined) return deps.mode;
  const configPath = deps.configPath ?? join(dirname(resolve(credentialsDir)), 'config.toml');
  const parser = deps.parseConfig ?? parseCredentialsStoreConfig;
  const cache = getModeCacheForParser(parser);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(configPath);
  } catch {
    cache.delete(configPath);
    return 'auto';
  }
  const cached = cache.get(configPath);
  if (
    cached !== undefined &&
    cached.mtimeMs === st.mtimeMs &&
    cached.ctimeMs === st.ctimeMs &&
    cached.size === st.size &&
    cached.ino === st.ino
  ) {
    return cached.mode;
  }
  let text: string;
  try {
    text = readFileSync(configPath, 'utf-8');
  } catch {
    cache.delete(configPath);
    return 'auto';
  }
  const mode = parseModeFromText(parser, text);
  cache.set(configPath, {
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    size: st.size,
    ino: st.ino,
    mode,
  });
  return mode;
}

async function resolveCredentialsStoreModeAsync(
  credentialsDir: string,
  deps: ResolveCredentialsStoreModeDeps = {},
): Promise<CredentialsStoreMode> {
  if (deps.mode !== undefined) return deps.mode;
  const configPath = deps.configPath ?? join(dirname(resolve(credentialsDir)), 'config.toml');
  const parser = deps.parseConfig ?? parseCredentialsStoreConfig;
  const cache = getModeCacheForParser(parser);
  let st;
  try {
    st = await statAsync(configPath);
  } catch {
    cache.delete(configPath);
    return 'auto';
  }
  const cached = cache.get(configPath);
  if (
    cached !== undefined &&
    cached.mtimeMs === st.mtimeMs &&
    cached.ctimeMs === st.ctimeMs &&
    cached.size === st.size &&
    cached.ino === st.ino
  ) {
    return cached.mode;
  }
  let text: string;
  try {
    text = await readFileAsync(configPath, 'utf-8');
  } catch {
    cache.delete(configPath);
    return 'auto';
  }
  const mode = parseModeFromText(parser, text);
  cache.set(configPath, {
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    size: st.size,
    ino: st.ino,
    mode,
  });
  return mode;
}

export interface ResolveTokenStorageDeps extends ResolveCredentialsStoreModeDeps {
  loadKeyring?: () => KeyringApi | undefined;
  observer?: KeyringStorageObserver;
}

export function resolveTokenStorage(
  credentialsDir: string,
  deps: ResolveTokenStorageDeps = {},
): TokenStorage {
  const legacy = new FileTokenStorage(credentialsDir);
  const observer = deps.observer ?? registeredBackend?.observer;
  if (isKeyringDisabledByEnv()) {
    observer?.onBackendSelected?.('file', 'disabled');
    return legacy;
  }
  const mode = resolveCredentialsStoreMode(credentialsDir, deps);
  if (mode === 'file') {
    observer?.onBackendSelected?.('file', 'mode-file');
    return legacy;
  }
  const keyring = (deps.loadKeyring ?? (() => registeredBackend?.api))();
  if (keyring === undefined) {
    if (mode === 'keyring') throw unavailable('keyring backend is unavailable');
    observer?.onBackendSelected?.('file', 'no-backend');
    return legacy;
  }
  if (keyring.preferAsync !== true && !probeKeyringBackend(keyring)) {
    if (mode === 'keyring') throw unavailable('keyring backend probe failed');
    observer?.onBackendSelected?.('file', 'probe-failed');
    return legacy;
  }
  const service = keyringServiceForCredentialsDir(credentialsDir);
  observer?.onBackendSelected?.('keyring', mode);
  return new KeyringTokenStorage({ keyring, legacy, service, observer, coexist: mode === 'auto' });
}

export interface InspectTokenStorageResult {
  readonly backend: 'file' | 'keyring';
  readonly token?: TokenInfo;
}

function unavailable(message: string, cause?: unknown): OAuthStorageUnavailableError {
  return new OAuthStorageUnavailableError(message, cause === undefined ? undefined : { cause });
}

async function inspectFileAsync(legacy: FileTokenStorage, name: string): Promise<FileTokenInspection> {
  return legacy.readOnlyAsync(name);
}

interface KeyringInspection {
  readonly kind: 'missing' | 'valid' | 'unreadable';
  readonly token?: TokenInfo;
  readonly error?: unknown;
}

async function inspectKeyring(keyring: KeyringApi, service: string, name: string): Promise<KeyringInspection> {
  let raw: string | null;
  try {
    if (keyring.createAsyncEntry !== undefined) {
      const entry = await keyring.createAsyncEntry(service, name);
      raw = (await entry.getPassword()) ?? null;
    } else {
      raw = keyring.createEntry(service, name).getPassword();
    }
  } catch (error) {
    return { kind: 'unreadable', error };
  }
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { kind: 'unreadable', error };
    }
    if (!isRecord(parsed)) return { kind: 'unreadable', error: new TypeError('Keyring token is not an object') };
    return { kind: 'valid', token: tokenFromWire(parsed as Partial<TokenInfoWire>) };
  }
  try {
    const accounts = keyring.findAccountsAsync !== undefined
      ? await keyring.findAccountsAsync(service)
      : keyring.findAccounts(service);
    return accounts.includes(name)
      ? { kind: 'unreadable', error: new Error('Keyring credential could not be read') }
      : { kind: 'missing' };
  } catch (error) {
    return { kind: 'unreadable', error };
  }
}

export async function inspectTokenStorage(
  credentialsDir: string,
  name: string,
  deps: ResolveTokenStorageDeps = {},
): Promise<InspectTokenStorageResult> {
  assertValidTokenName(name);
  const legacy = new FileTokenStorage(credentialsDir);
  const mode = isKeyringDisabledByEnv() ? 'file' : await resolveCredentialsStoreModeAsync(credentialsDir, deps);
  const file = async (): Promise<InspectTokenStorageResult> => {
    const inspected = await inspectFileAsync(legacy, name);
    if (inspected.kind === 'unreadable') {
      throw unavailable(`file credential "${name}" is unreadable`, inspected.error);
    }
    return { backend: 'file', token: inspected.kind === 'valid' ? inspected.token : undefined };
  };
  if (mode === 'file') return file();

  const keyring = (deps.loadKeyring ?? (() => registeredBackend?.api))();
  if (keyring === undefined) {
    if (mode === 'keyring') {
      throw unavailable(`keyring backend is unavailable while inspecting credential "${name}"`);
    }
    return file();
  }

  const keyringResult = await inspectKeyring(keyring, keyringServiceForCredentialsDir(credentialsDir), name);
  if (keyringResult.kind === 'unreadable') {
    if (mode === 'keyring') {
      throw unavailable(`keyring credential "${name}" is unavailable`, keyringResult.error);
    }
    const fallback = await file();
    if (fallback.token !== undefined) return fallback;
    throw unavailable(`keyring credential "${name}" is unavailable`, keyringResult.error);
  }
  if (keyringResult.kind === 'missing') {
    const fallback = await inspectFileAsync(legacy, name);
    if (fallback.kind === 'unreadable') {
      throw unavailable(`file credential "${name}" is unreadable`, fallback.error);
    }
    return { backend: 'keyring', token: fallback.kind === 'valid' ? fallback.token : undefined };
  }

  const fallback = await inspectFileAsync(legacy, name);
  if (
    fallback.kind === 'valid' &&
    classifyToken(keyringResult.token as TokenInfo).kind === 'valid' &&
    classifyToken(fallback.token).kind === 'valid' &&
    issuedAt(fallback.token) > issuedAt(keyringResult.token as TokenInfo)
  ) {
    return { backend: 'keyring', token: fallback.token };
  }
  return { backend: 'keyring', token: keyringResult.token };
}
