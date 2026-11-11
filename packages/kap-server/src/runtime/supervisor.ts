import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';
import { spawn, type SpawnOptions } from 'node:child_process';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { RuntimeController, runtimeReleaseSchema, type RuntimeDriver, type RuntimeRelease } from './controller';
import { installedRuntimeReleases, readInstalledRuntimeRelease, readRuntimeReleasePointer, releaseIdSchema, verifiedRuntimeRelease } from './releases';
import { RuntimeStore, type ManagedWriter } from './runtimeStore';
import { loadOrCreateLocalOwnerToken, matchesLocalOwner } from '../services/auth/localOwner';
import { writePrivateFile } from '../services/auth/privateFiles';

const controllerEndpointSchema = z.object({ pid: z.number().int().positive(), port: z.number().int().positive().max(65535), ownerId: z.string().uuid() });

export function runtimeChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) if (key.startsWith('KIKI_EXTERNAL_')) delete env[key];
  return env;
}

const runtimeLaunchSchema = z.object({ executable: z.string().min(1), args: z.array(z.string()), releaseRoot: z.string().optional(), initial: runtimeReleaseSchema });
export type RuntimeLaunch = z.infer<typeof runtimeLaunchSchema>;

export async function readRuntimeLaunch(homeDir: string): Promise<RuntimeLaunch | undefined> {
  try { return runtimeLaunchSchema.parse(JSON.parse(await readFile(join(homeDir, 'runtime', 'launch.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export function saveRuntimeLaunch(homeDir: string, launch: RuntimeLaunch): Promise<void> {
  return writePrivateFile(join(homeDir, 'runtime', 'launch.json'), JSON.stringify(runtimeLaunchSchema.parse(launch)));
}

export function runtimePidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function jsonResponse(response: Response): Promise<unknown> {
  return readBoundedJsonBody(response, 1024 * 1024);
}

export async function connectRuntimeSupervisor(homeDir: string): Promise<{ url: string; ownerId: string } | undefined> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(join(homeDir, 'runtime', 'controller.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const endpoint = controllerEndpointSchema.parse(raw);
  if (!runtimePidAlive(endpoint.pid)) return undefined;
  return { url: `http://127.0.0.1:${endpoint.port}`, ownerId: endpoint.ownerId };
}

export async function runtimeControllerRequest(homeDir: string, action: 'status' | 'ensure' | 'activate' | 'cancel', body?: object): Promise<unknown> {
  const endpoint = await connectRuntimeSupervisor(homeDir);
  if (endpoint === undefined) throw new Error('The managed runtime controller is not running. Start it before selecting a release.');
  const token = await loadOrCreateLocalOwnerToken(homeDir);
  const response = await fetch(`${endpoint.url}/${action}`, { method: action === 'status' ? 'GET' : 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-kiki-runtime-owner': endpoint.ownerId },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(65_000) });
  const payload = await jsonResponse(response) as { ownerId?: unknown; data?: unknown; error?: unknown };
  if (payload.ownerId !== endpoint.ownerId) throw new Error('The runtime controller identity changed. Reconnect before retrying.');
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'The runtime operation failed.');
  return payload.data;
}

export function createRuntimeProcessDriver(homeDir: string, options?: { readonly env?: NodeJS.ProcessEnv; readonly spawnOptions?: SpawnOptions }): RuntimeDriver {
  const token = loadOrCreateLocalOwnerToken(homeDir);
  const call = async (writer: ManagedWriter, body?: object): Promise<{ code?: number; data?: unknown }> => {
    if (!['127.0.0.1', 'localhost', '::1'].includes(writer.host)) throw new Error('The managed runtime writer must use loopback.');
    const url = `http://127.0.0.1:${writer.port}/api/${body === undefined ? 'meta' : 'runtime-switch'}`;
    const response = body === undefined
      ? await fetch(url, { method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${await token}` }, signal: AbortSignal.timeout(5000) })
      : await fetch(url, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${await token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`The managed server returned HTTP ${response.status}.`);
    return await jsonResponse(response) as { code?: number; data?: unknown };
  };
  return {
    alive: runtimePidAlive,
    probe: async writer => {
      try {
        const response = await call(writer);
        const meta = response.data as { server_id?: unknown; server_home_id?: unknown; server_version?: unknown; build_id?: unknown; build_channel?: unknown } | undefined;
        return response.code === 0 && meta?.server_id === writer.serverId && meta.server_home_id === writer.homeId &&
          meta.server_version === writer.serverVersion && meta.build_id === writer.buildId && meta.build_channel === writer.buildChannel;
      } catch { return false; }
    },
    prepare: async (writer, operationId, action) => {
      const result = await call(writer, { operationId, serverId: writer.serverId, action });
      if (result.code !== 0) throw new Error('The managed writer could not prepare or cancel the natural switch.');
    },
    start: async target => {
      const childEnv: NodeJS.ProcessEnv = { ...runtimeChildEnvironment(options?.env ?? process.env), KIKI_HOME: homeDir, KIKI_RUNTIME_MANAGED: '1' };
      if (target.buildId !== undefined) childEnv['KIKI_BUILD_ID'] = target.buildId;
      else delete childEnv['KIKI_BUILD_ID'];
      if (target.buildChannel !== undefined) childEnv['KIKI_BUILD_CHANNEL'] = target.buildChannel;
      else delete childEnv['KIKI_BUILD_CHANNEL'];
      const child = spawn(target.executable, [...target.args, 'serve', '--home', homeDir, '--idle-exit', target.idleExit ?? '0ms', '--port', String(target.port ?? 0), '--json'], {
        detached: true, stdio: 'ignore', windowsHide: true, ...options?.spawnOptions,
        env: childEnv,
      });
      let spawnError: Error | undefined;
      child.on('error', error => { spawnError = error; });
      child.unref();
      const store = new RuntimeStore(homeDir);
      try {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          if (spawnError !== undefined) throw spawnError;
          if (child.exitCode !== null || child.signalCode !== null) throw new Error('The candidate server exited during startup.');
          const writer = store.writer();
          if (writer !== undefined && child.pid !== undefined && writer.pid === child.pid && writer.phase === 'ready') return;
          await delay(100);
        }
        throw new Error('The candidate is still starting or unreachable. Its writer lease is retained; inspect diagnostics before recovery.');
      } finally { store.close(); }
    },
  };
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 1024 * 1024) throw new Error('The runtime request exceeds its size limit.');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function startRuntimeSupervisor(options: {
  readonly homeDir: string; readonly initial: RuntimeRelease; readonly driver?: RuntimeDriver;
  readonly releaseRoot?: string; readonly warn?: (error: unknown) => void;
}): Promise<{ readonly port: number; readonly controller: RuntimeController; close(): Promise<void> }> {
  const token = await loadOrCreateLocalOwnerToken(options.homeDir);
  const controller = new RuntimeController(options.homeDir, options.driver ?? createRuntimeProcessDriver(options.homeDir));
  const ownerId = randomUUID();
  let lastPublished: string | undefined;
  const status = async () => ({ ...controller.status(), installed: options.releaseRoot === undefined ? [] : await installedRuntimeReleases(options.releaseRoot) });
  const reconcile = async (): Promise<void> => {
    await controller.reconcile();
    if (options.releaseRoot === undefined) return;
    const state = controller.status();
    if (state.active !== undefined && lastPublished !== state.active.releaseId) {
      const manifest = await readInstalledRuntimeRelease(options.releaseRoot, state.active.releaseId);
      await writePrivateFile(join(options.releaseRoot, 'current.json'), JSON.stringify({
        ...manifest,
        promotedAtUtc: manifest.promotedAtUtc ?? manifest.installedAt,
      }));
      lastPublished = state.active.releaseId;
    }
    const selected = await readRuntimeReleasePointer(options.releaseRoot, 'installed');
    if (selected !== undefined && selected !== state.active?.releaseId && selected !== state.operation?.target.releaseId &&
        selected !== controller.store.read<string>('installed-consumed') &&
        (state.operation === undefined || ['completed', 'cancelled', 'failed'].includes(state.operation.phase))) {
      await controller.activate(await verifiedRuntimeRelease(options.releaseRoot, selected));
      controller.store.write('installed-consumed', selected);
    }
  };
  const server = createServer((request, response) => {
    const send = (statusCode: number, payload: object): void => { response.writeHead(statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ ownerId, ...payload })); };
    const readOnly = request.method === 'GET' && request.url === '/status';
    if (!matchesLocalOwner(request.headers.authorization?.replace(/^Bearer /, '') ?? '', token) ||
        (!readOnly && request.headers['x-kiki-runtime-owner'] !== ownerId)) { send(401, { error: 'Local runtime owner authentication is required.' }); return; }
    void (async () => {
      const path = request.url?.split('?', 1)[0];
      if (request.method === 'GET' && path === '/status') { send(200, { data: await status() }); return; }
      if (request.method !== 'POST') { send(404, { error: 'Unknown runtime operation.' }); return; }
      const body = await requestBody(request);
      if (path === '/activate') {
        const input = z.object({ releaseId: releaseIdSchema.optional(), reason: z.enum(['update', 'rollback', 'restart']).default('update') }).parse(body);
        const target = input.releaseId === undefined && input.reason === 'restart' ? controller.status().active :
          options.releaseRoot === undefined || input.releaseId === undefined ? undefined : await verifiedRuntimeRelease(options.releaseRoot, input.releaseId);
        if (target === undefined) throw new Error('Select an installed release from the configured runtime catalog.');
        await controller.activate(target, input.reason);
      } else if (path === '/cancel') await controller.cancel(z.object({ operationId: z.string() }).parse(body).operationId);
      else if (path === '/ensure') await controller.ensure(options.initial);
      else { send(404, { error: 'Unknown runtime operation.' }); return; }
      send(200, { data: await status() });
    })().catch(error => send(409, { error: error instanceof Error ? error.message : String(error) }));
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  let tick: Promise<void> | undefined;
  let lastError: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('The runtime controller did not bind.');
    await writePrivateFile(join(options.homeDir, 'runtime', 'controller.json'), JSON.stringify({ pid: process.pid, port: address.port, ownerId }));
    await controller.ensure(options.initial);
    timer = setInterval(() => {
      if (tick !== undefined) return;
      tick = reconcile().then(() => { lastError = undefined; }).catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        controller.store.write('controller-error', { message, observedAt: Date.now() });
        if (message !== lastError) options.warn?.(error);
        lastError = message;
      }).finally(() => { tick = undefined; });
    }, 250);
    return { port: address.port, controller, close: async () => {
      clearInterval(timer);
      await tick;
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
      await controller.close();
    } };
  } catch (error) {
    clearInterval(timer);
    await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
    await controller.close();
    throw error;
  }
}
