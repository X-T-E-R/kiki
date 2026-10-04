import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { LocalOriginalOAuthBackend, OriginalOAuthKeyring, OriginalOAuthNative } from './local-original-types';
import { isRecord } from './utils';

const MAX_AUTH_BYTES = 2 * 1024 * 1024;
const AUTH_SECRET_KEY = 'global/CODEX_AUTH';

export class OriginalStorageError extends Error {
  constructor(readonly state: 'unreadable' | 'unsupported', message: string) {
    super(message);
    this.name = 'OriginalStorageError';
  }
}

export interface OriginalCredentialSnapshot {
  readonly auth: Record<string, unknown>;
  readonly stamp: string;
  readonly container?: Record<string, unknown>;
  readonly passphrase?: string;
}

export interface OriginalCredentialStore {
  readonly backend: LocalOriginalOAuthBackend;
  readonly authFile: string;
  read(): Promise<OriginalCredentialSnapshot | undefined>;
  compareAndSave(before: OriginalCredentialSnapshot, auth: Record<string, unknown>, isCurrent?: () => boolean): Promise<boolean>;
}

export interface OriginalStorageRuntime {
  readonly keyring: OriginalOAuthKeyring;
  readonly native: OriginalOAuthNative;
}

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseObject(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > MAX_AUTH_BYTES) throw new OriginalStorageError('unsupported', 'Original credentials exceed the supported size.');
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new OriginalStorageError('unreadable', 'Original credentials are not readable JSON.');
  }
}

async function fileBytes(path: string): Promise<Buffer | undefined> {
  try {
    if ((await stat(path)).size > MAX_AUTH_BYTES) throw new OriginalStorageError('unsupported', 'Original credentials exceed the supported size.');
    const bytes = await readFile(path);
    if (bytes.length > MAX_AUTH_BYTES) throw new OriginalStorageError('unsupported', 'Original credentials exceed the supported size.');
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof OriginalStorageError) throw error;
    throw new OriginalStorageError('unreadable', 'Original credential file could not be read.');
  }
}

async function writeAtomic(path: string, bytes: Uint8Array, isCurrent?: () => boolean): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    if (isCurrent !== undefined && !isCurrent()) throw new Error('credential lock changed');
    await rename(temporary, path);
  } catch {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw new OriginalStorageError('unreadable', 'Refreshed credentials could not be saved to their original file.');
  }
}

export function originalFileStore(authFile: string): OriginalCredentialStore {
  return {
    backend: 'file', authFile,
    async read() {
      const bytes = await fileBytes(authFile);
      if (bytes === undefined || bytes.toString('utf8').trim() === '') return undefined;
      return { auth: parseObject(bytes.toString('utf8')), stamp: digest(bytes) };
    },
    async compareAndSave(before, auth, isCurrent) {
      const current = await fileBytes(authFile);
      if (current === undefined || digest(current) !== before.stamp) return false;
      await writeAtomic(authFile, Buffer.from(JSON.stringify(auth, null, 2)), isCurrent);
      return true;
    },
  };
}

export function originalDirectKeyringStore(
  homeDir: string,
  canonicalHome: string,
  keyring: OriginalOAuthKeyring,
): OriginalCredentialStore {
  const account = `cli|${digest(canonicalHome).slice(0, 16)}`;
  return {
    backend: 'keyring', authFile: join(homeDir, 'auth.json'),
    async read() {
      try {
        const value = await keyring.load('Codex Auth', account);
        return value === undefined ? undefined : { auth: parseObject(value), stamp: digest(value) };
      } catch (error) {
        if (error instanceof OriginalStorageError) throw error;
        throw new OriginalStorageError('unreadable', 'The original Codex keyring entry could not be read.');
      }
    },
    async compareAndSave(before, auth, isCurrent) {
      try {
        const current = await keyring.load('Codex Auth', account);
        if (current === undefined || digest(current) !== before.stamp || isCurrent !== undefined && !isCurrent()) return false;
        await keyring.save('Codex Auth', account, JSON.stringify(auth));
        return true;
      } catch {
        throw new OriginalStorageError('unreadable', 'Refreshed credentials could not be saved to the original Codex keyring.');
      }
    },
  };
}

export function originalEncryptedStore(
  homeDir: string,
  canonicalHome: string,
  runtime: OriginalStorageRuntime,
): OriginalCredentialStore {
  const authFile = join(homeDir, 'secrets', 'codex_auth.age');
  const account = `secrets|${digest(canonicalHome).slice(0, 16)}`;
  return {
    backend: 'encrypted', authFile,
    async read() {
      const bytes = await fileBytes(authFile);
      if (bytes === undefined) return undefined;
      let passphrase: string | undefined;
      try {
        passphrase = await runtime.keyring.load('codex', account);
      } catch {
        throw new OriginalStorageError('unreadable', 'The original encrypted credential key could not be read.');
      }
      if (!passphrase) throw new OriginalStorageError('unreadable', 'The original encrypted credential key is missing.');
      let plaintext: Uint8Array;
      try {
        plaintext = await runtime.native.ageDecrypt(bytes, passphrase);
      } catch {
        throw new OriginalStorageError('unreadable', 'The original encrypted credentials could not be decrypted.');
      }
      const container = parseObject(Buffer.from(plaintext).toString('utf8'));
      if (typeof container['version'] !== 'number' || !Number.isInteger(container['version']) || container['version'] < 0 || container['version'] > 1 || !isRecord(container['secrets']) ||
        !Object.values(container['secrets']).every((value) => typeof value === 'string')) {
        throw new OriginalStorageError('unsupported', 'The original encrypted credential format is not supported.');
      }
      const value = container['secrets'][AUTH_SECRET_KEY];
      if (value === undefined) return undefined;
      if (typeof value !== 'string') throw new OriginalStorageError('unreadable', 'The original encrypted account entry is not readable.');
      return { auth: parseObject(value), container, passphrase, stamp: `${digest(bytes)}:${digest(passphrase)}` };
    },
    async compareAndSave(before, auth, isCurrent) {
      if (!before.container || !before.passphrase) throw new OriginalStorageError('unreadable', 'The original encrypted account is no longer available.');
      const current = await fileBytes(authFile);
      let passphrase: string | undefined;
      try { passphrase = await runtime.keyring.load('codex', account); } catch {
        throw new OriginalStorageError('unreadable', 'The original encrypted credential key could not be read.');
      }
      if (current === undefined || !passphrase || `${digest(current)}:${digest(passphrase)}` !== before.stamp) return false;
      const container = structuredClone(before.container);
      container['version'] = 1;
      container['secrets'] = { ...(container['secrets'] as Record<string, unknown>), [AUTH_SECRET_KEY]: JSON.stringify(auth) };
      let ciphertext: Uint8Array;
      try {
        ciphertext = await runtime.native.ageEncrypt(Buffer.from(JSON.stringify(container)), passphrase);
      } catch {
        throw new OriginalStorageError('unreadable', 'Refreshed credentials could not be encrypted for their original storage.');
      }
      const rechecked = await fileBytes(authFile);
      let recheckedPassphrase: string | undefined;
      try { recheckedPassphrase = await runtime.keyring.load('codex', account); } catch {
        throw new OriginalStorageError('unreadable', 'The original encrypted credential key could not be read.');
      }
      if (rechecked === undefined || digest(rechecked) !== digest(current) || recheckedPassphrase !== passphrase) return false;
      await writeAtomic(authFile, ciphertext, isCurrent);
      return true;
    },
  };
}
