/**
 * Keychain-backed OAuth token storage with coexistence with the legacy file store.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

export interface KeyringApi {
  createEntry(service: string, account: string): KeyringEntry;
  findAccounts(service: string): string[];
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

  private tryKeyring<T>(
    operation: KeyringOperation,
    fn: () => T,
  ): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown } {
    try {
      return { ok: true, value: fn() };
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
          const removed = this.tryKeyring('remove', () => {
            const deleted = this.keyring.createEntry(this.service, name).deleteCredential();
            if (!deleted && this.keyring.findAccounts(this.service).includes(name)) {
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

      const read = this.tryKeyring('load', () => this.keyring.createEntry(this.service, name).getPassword());
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

      const listing = this.tryKeyring('load', () => this.keyring.findAccounts(this.service));
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
        const migrated = this.tryKeyring('save', () => {
          this.keyring.createEntry(this.service, name).setPassword(this.serialize(first));
        });
        if (migrated.ok) this.observer?.onMigrated?.(name);
        return first;
      }

      let serialized = this.serialize(first);
      let latest = first;
      const initial = this.tryKeyring('save', () => {
        this.keyring.createEntry(this.service, name).setPassword(serialized);
      });
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
        const rewrite = this.tryKeyring('load', () => {
          this.keyring.createEntry(this.service, name).setPassword(currentSerialized);
        });
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
      const write = this.tryKeyring('load', () => {
        this.keyring.createEntry(this.service, name).setPassword(fileSerialized);
      });
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
      const write = this.tryKeyring('load', () => {
        this.keyring.createEntry(this.service, name).setPassword(fileSerialized);
      });
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
      this.tryKeyring('load', () => {
        this.keyring.createEntry(this.service, name).setPassword(this.serialize(fileToken));
      });
      return fileToken;
    }
    if (
      fileToken !== undefined &&
      classifyToken(keyringToken).kind === 'valid' &&
      classifyToken(fileToken).kind === 'valid' &&
      issuedAt(fileToken) > issuedAt(keyringToken)
    ) {
      this.tryKeyring('load', () => {
        this.keyring.createEntry(this.service, name).setPassword(this.serialize(fileToken));
      });
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
          this.tryKeyring('save', () => {
            this.keyring.createEntry(this.service, name).setPassword(this.serialize(token));
          });
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
      const write = this.tryKeyring('save', () => {
        this.keyring.createEntry(this.service, name).setPassword(this.serialize(token));
      });
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
        const rollback = this.tryKeyring('remove', () => {
          const deleted = this.keyring.createEntry(this.service, name).deleteCredential();
          if (!deleted && this.keyring.findAccounts(this.service).includes(name)) {
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
      const result = this.tryKeyring('remove', () => {
        const deleted = this.keyring.createEntry(this.service, name).deleteCredential();
        if (deleted) return true;
        return !this.keyring.findAccounts(this.service).includes(name);
      });
      await access.remove();
      return result;
    });
    if (!gone.ok) throw new Error(`failed to delete keyring credential "${name}"`, { cause: gone.error });
    if (!gone.value) throw new Error(`failed to delete keyring credential "${name}"`);
  }

  async list(): Promise<string[]> {
    if (keyringDegraded) return this.legacy.list();
    const accounts = this.tryKeyring('list', () => this.keyring.findAccounts(this.service));
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
  let text: string;
  try {
    text = readFileSync(configPath, 'utf-8');
  } catch {
    return 'auto';
  }
  try {
    const parsed = (deps.parseConfig ?? parseCredentialsStoreConfig)(text);
    const raw = isRecord(parsed) ? parsed[CREDENTIALS_STORE_CONFIG_KEY] : undefined;
    return typeof raw === 'string' && (CREDENTIALS_STORE_MODES as readonly string[]).includes(raw)
      ? raw as CredentialsStoreMode
      : 'auto';
  } catch {
    return 'auto';
  }
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
  if (!probeKeyringBackend(keyring)) {
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

function inspectFile(legacy: FileTokenStorage, name: string): FileTokenInspection {
  return legacy.readOnly(name);
}

interface KeyringInspection {
  readonly kind: 'missing' | 'valid' | 'unreadable';
  readonly token?: TokenInfo;
  readonly error?: unknown;
}

function inspectKeyring(keyring: KeyringApi, service: string, name: string): KeyringInspection {
  let raw: string | null;
  try {
    raw = keyring.createEntry(service, name).getPassword();
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
    return keyring.findAccounts(service).includes(name)
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
  const mode = isKeyringDisabledByEnv() ? 'file' : resolveCredentialsStoreMode(credentialsDir, deps);
  const file = (): InspectTokenStorageResult => {
    const inspected = inspectFile(legacy, name);
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

  const keyringResult = inspectKeyring(keyring, keyringServiceForCredentialsDir(credentialsDir), name);
  if (keyringResult.kind === 'unreadable') {
    if (mode === 'keyring') {
      throw unavailable(`keyring credential "${name}" is unavailable`, keyringResult.error);
    }
    const fallback = file();
    if (fallback.token !== undefined) return fallback;
    throw unavailable(`keyring credential "${name}" is unavailable`, keyringResult.error);
  }
  if (keyringResult.kind === 'missing') {
    const fallback = inspectFile(legacy, name);
    if (fallback.kind === 'unreadable') {
      throw unavailable(`file credential "${name}" is unreadable`, fallback.error);
    }
    return { backend: 'keyring', token: fallback.kind === 'valid' ? fallback.token : undefined };
  }

  const fallback = inspectFile(legacy, name);
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
