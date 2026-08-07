/**
 * Local kap-server detection — a dev/preview middleware answering
 * `GET /__kiki/local-server` with the first live kap-server on this machine
 * plus the home bearer token, so the connect screen can offer one-click
 * "detect local server" instead of making the user paste
 * `~/.kimi-code/server.token` by hand.
 *
 * Same approach as apps/kimi-inspect's serverDiscovery (deliberately
 * reimplemented: no server-side deps). kap-server self-registers under
 * `<kimi home>/server/instances/<serverId>.json` and keeps the token at
 * `<kimi home>/server.token`.
 *
 * Security: dev/preview only, bound to loopback by Vite defaults; hands out
 * exactly the credential the local user already owns.
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Plugin } from 'vite';

export const LOCAL_SERVER_ENDPOINT = '/__kiki/local-server';

interface ServerInstanceDisk {
  server_id?: string;
  pid?: number;
  host?: string;
  port?: number;
  started_at?: number;
}

export interface LocalServerPayload {
  readonly url?: string;
  readonly token?: string;
  readonly home: string;
}

function kimiHomeDir(): string {
  const fromEnv = process.env['KIMI_CODE_HOME'];
  return fromEnv !== undefined && fromEnv.length > 0
    ? fromEnv
    : join(homedir(), '.kimi-code');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function normalizeHost(host: string | undefined): string {
  if (host === undefined || host === '' || host === '0.0.0.0' || host === '::' || host === '[::]') {
    return '127.0.0.1';
  }
  return host;
}

/** Newest live registered instance, else undefined. */
async function findLiveInstance(home: string): Promise<string | undefined> {
  const instancesDir = join(home, 'server', 'instances');
  let names: string[];
  try {
    names = await readdir(instancesDir);
  } catch {
    return undefined;
  }
  let best: { startedAt: number; url: string } | undefined;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let disk: ServerInstanceDisk;
    try {
      disk = JSON.parse(await readFile(join(instancesDir, name), 'utf8')) as ServerInstanceDisk;
    } catch {
      continue;
    }
    if (typeof disk.pid !== 'number' || typeof disk.port !== 'number' || !pidAlive(disk.pid)) {
      continue;
    }
    const startedAt = typeof disk.started_at === 'number' ? disk.started_at : 0;
    const url = `http://${normalizeHost(disk.host)}:${disk.port}`;
    if (best === undefined || startedAt > best.startedAt) best = { startedAt, url };
  }
  return best?.url;
}

async function readToken(home: string): Promise<string | undefined> {
  try {
    const token = (await readFile(join(home, 'server.token'), 'utf8')).trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export async function detectLocalServer(proxyTarget: string): Promise<LocalServerPayload> {
  const home = kimiHomeDir();
  const [instanceUrl, token] = await Promise.all([findLiveInstance(home), readToken(home)]);
  // Fall back to the dev-proxy target: it is a kap-server URL by construction.
  return { url: instanceUrl ?? proxyTarget, token, home };
}

export function localServerPlugin(options: { proxyTarget: string }): Plugin {
  const handler = (
    _req: unknown,
    res: { setHeader(name: string, value: string): void; end(data: string): void },
  ): void => {
    void detectLocalServer(options.proxyTarget)
      .then((payload) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      })
      .catch((error: unknown) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: String(error) }));
      });
  };
  return {
    name: 'kiki-local-server',
    configureServer(server) {
      server.middlewares.use(LOCAL_SERVER_ENDPOINT, handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(LOCAL_SERVER_ENDPOINT, handler);
    },
  };
}
