import type { ConnectionIdentity } from '@kiki/protocol';
import { ensureServer, findReachableServer } from '#/kiki/serve';
import { resolveKikiHome } from '#/kiki/home';

export interface DaemonConnection {
  readonly url: string;
  readonly token: string;
  readonly serverId?: string;
  readonly identity?: ConnectionIdentity;
  readonly localOwner?: boolean;
}

export interface EnsureDaemonOptions {
  readonly homeDir?: string;
  readonly workspacePath?: string;
}

export function resolveDaemonHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolveKikiHome(undefined, env);
}

export async function discoverDaemon(
  homeDir: string,
  workspacePath?: string,
): Promise<DaemonConnection | null> {
  const connection = await findReachableServer(homeDir, workspacePath);
  return connection === undefined ? null : { ...connection, localOwner: true };
}

export async function ensureDaemon(options: EnsureDaemonOptions): Promise<DaemonConnection> {
  const connection = await ensureServer({
    homeDir: options.homeDir ?? resolveDaemonHome(),
    workspace: options.workspacePath,
  });
  return { ...connection, localOwner: true };
}
