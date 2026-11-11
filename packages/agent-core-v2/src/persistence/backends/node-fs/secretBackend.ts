import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { dirname, join } from 'pathe';

export interface AsyncSecretEntry {
  setPassword(value: string): Promise<void>;
  getPassword(): Promise<string | null | undefined>;
  deleteCredential(): Promise<boolean>;
}

export interface SyncSecretEntry {
  setPassword(password: string): void;
  getPassword(): string | null;
  deleteCredential(): boolean;
}

export interface SecretBackendConfig {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

interface NativeKeyringModule {
  readonly Entry: new (service: string, account: string, options?: unknown) => SyncSecretEntry;
  readonly AsyncEntry: new (service: string, account: string, options?: unknown) => AsyncSecretEntry;
  readonly findCredentials: (service: string) => Array<{ readonly account: string }>;
}

interface BrokerEndpoints {
  readonly baseUrl: string;
  readonly token: string;
}

interface StoredSecretEnvelope {
  readonly account: string;
  readonly value: string;
}

const SYNC_HTTP_WORKER_CODE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', async ({ signal, payload, url, method, token, body }) => {
  const write = (result) => {
    const encoded = Buffer.from(JSON.stringify(result), 'utf8');
    const view = new Uint8Array(payload);
    const length = Math.min(encoded.byteLength, view.byteLength - 4);
    new DataView(payload).setInt32(0, encoded.byteLength > view.byteLength - 4 ? -encoded.byteLength : length, true);
    encoded.copy(view, 4, 0, length);
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0, 1);
  };
  try {
    const response = await fetch(url, {
      method,
      redirect: 'error',
      headers: {
        authorization: 'Bearer ' + token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    write({ ok: true, status: response.status, text });
  } catch (error) {
    write({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});
`;

let syncHttpWorker: Worker | undefined;

function getSyncHttpWorker(): Worker {
  if (syncHttpWorker !== undefined) return syncHttpWorker;
  const worker = new Worker(SYNC_HTTP_WORKER_CODE, { eval: true });
  worker.unref();
  worker.on('error', () => {
    if (syncHttpWorker === worker) syncHttpWorker = undefined;
  });
  worker.on('exit', () => {
    if (syncHttpWorker === worker) syncHttpWorker = undefined;
  });
  syncHttpWorker = worker;
  return worker;
}

function linuxKeyringOptions(): unknown {
  return process.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined;
}

function loadNativeKeyring(): NativeKeyringModule | undefined {
  try {
    return createRequire(import.meta.url)('@napi-rs/keyring') as NativeKeyringModule;
  } catch {
    return undefined;
  }
}

function resolveBrokerEndpoints(env: NodeJS.ProcessEnv): BrokerEndpoints | undefined {
  const rawUrl = env['KIKI_SECRET_BROKER_URL']?.trim();
  const token = env['KIKI_SECRET_BROKER_TOKEN']?.trim();
  if (!rawUrl || !token) return undefined;
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('KIKI_SECRET_BROKER_URL must use http or https');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1' && hostname !== '[::1]') {
    throw new Error('KIKI_SECRET_BROKER_URL must target a loopback host');
  }
  return { baseUrl: rawUrl.replace(/\/+$/, ''), token };
}

function resolveCredentialsHome(config: SecretBackendConfig): string {
  if (config.homeDir !== undefined && config.homeDir.trim().length > 0) return config.homeDir;
  const env = config.env ?? process.env;
  const kikiHome = env['KIKI_HOME']?.trim() || env['KIMI_CODE_HOME']?.trim();
  if (kikiHome) return kikiHome;
  return join(homedir(), '.kiki');
}

function serviceDirectory(homeDir: string, service: string): string {
  const digest = createHash('sha256').update(service).digest('hex').slice(0, 24);
  return join(homeDir, 'credentials', 'fallback-keyring', digest);
}

function accountFilePath(homeDir: string, service: string, account: string): string {
  const digest = createHash('sha256').update(account).digest('hex');
  return join(serviceDirectory(homeDir, service), `${digest}.secret.json`);
}

async function writeAtomicSecretFile(path: string, envelope: StoredSecretEnvelope): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(envelope), 'utf8');
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function writeAtomicSecretFileSync(path: string, envelope: StoredSecretEnvelope): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      chmodSync(temporary, 0o600);
    } catch {
    }
    writeSync(fd, JSON.stringify(envelope), undefined, 'utf8');
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
    }
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
    }
    throw error;
  }
}

async function readSecretFile(path: string, expectedAccount: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<StoredSecretEnvelope>;
  if (parsed.account !== expectedAccount || typeof parsed.value !== 'string') return undefined;
  return parsed.value;
}

function readSecretFileSync(path: string, expectedAccount: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<StoredSecretEnvelope>;
  if (parsed.account !== expectedAccount || typeof parsed.value !== 'string') return null;
  return parsed.value;
}

function listSecretAccountsSync(homeDir: string, service: string): string[] {
  const directory = serviceDirectory(homeDir, service);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const accounts: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.secret.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(directory, name), 'utf8')) as Partial<StoredSecretEnvelope>;
      if (typeof parsed.account === 'string' && typeof parsed.value === 'string') {
        accounts.push(parsed.account);
      }
    } catch {
    }
  }
  return accounts;
}

async function brokerRequestAsync(
  broker: BrokerEndpoints,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<{ readonly status: number; readonly text: string }> {
  const response = await fetch(`${broker.baseUrl}${path}`, {
    method,
    redirect: 'error',
    headers: {
      authorization: `Bearer ${broker.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, text: await response.text() };
}

function brokerRequestSync(
  broker: BrokerEndpoints,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): { readonly status: number; readonly text: string } {
  const signalBuffer = new SharedArrayBuffer(4);
  const signal = new Int32Array(signalBuffer);
  const payload = new SharedArrayBuffer(256 * 1024);
  const worker = getSyncHttpWorker();
  worker.postMessage({
    signal,
    payload,
    url: `${broker.baseUrl}${path}`,
    method,
    token: broker.token,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const waited = Atomics.wait(signal, 0, 0, 12_000);
  if (waited !== 'ok') {
    void worker.terminate().catch(() => undefined);
    if (syncHttpWorker === worker) syncHttpWorker = undefined;
    throw new Error('Secret broker synchronous request timed out');
  }
  const byteLength = new DataView(payload).getInt32(0, true);
  if (byteLength < 0) {
    throw new Error(`Secret broker response exceeded buffer (${-byteLength} bytes)`);
  }
  const raw = Buffer.from(payload, 4, byteLength).toString('utf8');
  const parsed = JSON.parse(raw) as { readonly ok: true; readonly status: number; readonly text: string } | { readonly ok: false; readonly message: string };
  if (!parsed.ok) throw new Error(parsed.message);
  return { status: parsed.status, text: parsed.text };
}

function parseSecretValueResponse(status: number, text: string): string | null {
  if (status === 404) return null;
  if (status < 200 || status >= 300) {
    throw new Error(`Secret broker get failed with status ${status}`);
  }
  const parsed = JSON.parse(text) as { readonly value?: unknown };
  if (parsed.value === null || parsed.value === undefined) return null;
  if (typeof parsed.value !== 'string') throw new Error('Secret broker returned invalid secret payload');
  return parsed.value;
}

function createBrokerAsyncEntry(broker: BrokerEndpoints, service: string, account: string): AsyncSecretEntry {
  return {
    async getPassword(): Promise<string | null> {
      const res = await brokerRequestAsync(broker, '/v1/secret/get', 'POST', { service, account });
      return parseSecretValueResponse(res.status, res.text);
    },
    async setPassword(value: string): Promise<void> {
      const res = await brokerRequestAsync(broker, '/v1/secret/put', 'POST', { service, account, value });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Secret broker put failed with status ${res.status}`);
      }
    },
    async deleteCredential(): Promise<boolean> {
      const res = await brokerRequestAsync(broker, '/v1/secret/delete', 'POST', { service, account });
      if (res.status === 404) return false;
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Secret broker delete failed with status ${res.status}`);
      }
      if (!res.text.trim()) return true;
      try {
        const parsed = JSON.parse(res.text) as { readonly deleted?: unknown };
        return typeof parsed.deleted === 'boolean' ? parsed.deleted : true;
      } catch {
        return true;
      }
    },
  };
}

function createBrokerSyncEntry(broker: BrokerEndpoints, service: string, account: string): SyncSecretEntry {
  return {
    getPassword(): string | null {
      const res = brokerRequestSync(broker, '/v1/secret/get', 'POST', { service, account });
      return parseSecretValueResponse(res.status, res.text);
    },
    setPassword(password: string): void {
      const res = brokerRequestSync(broker, '/v1/secret/put', 'POST', { service, account, value: password });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Secret broker put failed with status ${res.status}`);
      }
    },
    deleteCredential(): boolean {
      const res = brokerRequestSync(broker, '/v1/secret/delete', 'POST', { service, account });
      if (res.status === 404) return false;
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Secret broker delete failed with status ${res.status}`);
      }
      if (!res.text.trim()) return true;
      try {
        const parsed = JSON.parse(res.text) as { readonly deleted?: unknown };
        return typeof parsed.deleted === 'boolean' ? parsed.deleted : true;
      } catch {
        return true;
      }
    },
  };
}

function listBrokerAccountsSync(broker: BrokerEndpoints, service: string): string[] {
  const res = brokerRequestSync(broker, `/v1/secret/list?service=${encodeURIComponent(service)}`, 'GET');
  if (res.status === 404) return [];
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Secret broker list failed with status ${res.status}`);
  }
  const parsed = JSON.parse(res.text) as {
    readonly accounts?: unknown;
    readonly entries?: unknown;
  };
  if (Array.isArray(parsed.accounts) && parsed.accounts.every((item) => typeof item === 'string')) {
    return parsed.accounts;
  }
  if (
    Array.isArray(parsed.entries) &&
    parsed.entries.every(
      (item) => item && typeof item === 'object' && typeof (item as { account?: unknown }).account === 'string',
    )
  ) {
    return parsed.entries.map((item) => (item as { account: string }).account);
  }
  throw new Error('Secret broker returned invalid account list');
}

function createFileAsyncEntry(homeDir: string, service: string, account: string): AsyncSecretEntry {
  const path = accountFilePath(homeDir, service, account);
  return {
    async getPassword(): Promise<string | undefined> {
      return readSecretFile(path, account);
    },
    async setPassword(value: string): Promise<void> {
      await writeAtomicSecretFile(path, { account, value });
    },
    async deleteCredential(): Promise<boolean> {
      try {
        await unlink(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
  };
}

function createFileSyncEntry(homeDir: string, service: string, account: string): SyncSecretEntry {
  const path = accountFilePath(homeDir, service, account);
  return {
    getPassword(): string | null {
      return readSecretFileSync(path, account);
    },
    setPassword(password: string): void {
      writeAtomicSecretFileSync(path, { account, value: password });
    },
    deleteCredential(): boolean {
      try {
        rmSync(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
  };
}

export async function createAsyncSecretEntry(
  service: string,
  account: string,
  config: SecretBackendConfig = {},
): Promise<AsyncSecretEntry> {
  const env = config.env ?? process.env;
  const backendMode = env['KIKI_SECRET_BACKEND']?.trim();
  const broker = backendMode === 'file' ? undefined : resolveBrokerEndpoints(env);
  if (broker !== undefined) {
    return createBrokerAsyncEntry(broker, service, account);
  }
  if (backendMode !== 'android-broker' && backendMode !== 'file') {
    const native = loadNativeKeyring();
    if (native !== undefined) {
      return new native.AsyncEntry(service, account, linuxKeyringOptions());
    }
  }
  return createFileAsyncEntry(resolveCredentialsHome(config), service, account);
}

export async function createKeyringOrBrokerAsyncEntry(
  service: string,
  account: string,
  config: SecretBackendConfig = {},
): Promise<AsyncSecretEntry> {
  const env = config.env ?? process.env;
  const backendMode = env['KIKI_SECRET_BACKEND']?.trim();
  if (backendMode === 'file') {
    throw new Error('System keyring disabled by KIKI_SECRET_BACKEND=file');
  }
  const broker = resolveBrokerEndpoints(env);
  if (broker !== undefined) {
    return createBrokerAsyncEntry(broker, service, account);
  }
  if (backendMode === 'android-broker') {
    throw new Error('Android secret broker is not configured');
  }
  const native = loadNativeKeyring();
  if (native !== undefined) {
    return new native.AsyncEntry(service, account, linuxKeyringOptions());
  }
  throw new Error('Native system keyring is unavailable');
}

export function createSyncSecretEntry(
  service: string,
  account: string,
  config: SecretBackendConfig = {},
): SyncSecretEntry {
  const env = config.env ?? process.env;
  const backendMode = env['KIKI_SECRET_BACKEND']?.trim();
  const broker = backendMode === 'file' ? undefined : resolveBrokerEndpoints(env);
  if (broker !== undefined) {
    return createBrokerSyncEntry(broker, service, account);
  }
  if (backendMode !== 'android-broker' && backendMode !== 'file') {
    const native = loadNativeKeyring();
    if (native !== undefined) {
      return new native.Entry(service, account, linuxKeyringOptions());
    }
  }
  return createFileSyncEntry(resolveCredentialsHome(config), service, account);
}

export function listSyncSecretAccounts(
  service: string,
  config: SecretBackendConfig = {},
): string[] {
  const env = config.env ?? process.env;
  const backendMode = env['KIKI_SECRET_BACKEND']?.trim();
  const broker = backendMode === 'file' ? undefined : resolveBrokerEndpoints(env);
  if (broker !== undefined) {
    return listBrokerAccountsSync(broker, service);
  }
  if (backendMode !== 'android-broker' && backendMode !== 'file') {
    const native = loadNativeKeyring();
    if (native !== undefined) {
      return native.findCredentials(service).map(({ account }) => account);
    }
  }
  return listSecretAccountsSync(resolveCredentialsHome(config), service);
}

export async function clearFallbackSecretsForService(service: string, config: SecretBackendConfig = {}): Promise<void> {
  await rm(serviceDirectory(resolveCredentialsHome(config), service), { recursive: true, force: true });
}
