import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DaemonConnection {
  readonly url: string;
  readonly token: string;
}

export interface DaemonInstance {
  readonly serverId?: string;
  readonly url: string;
  readonly startedAt: number;
  readonly heartbeatAt: number;
  readonly workspaces: readonly string[];
}

interface EnsureDaemonOptions {
  readonly homeDir?: string;
  readonly workspacePath?: string;
  readonly fetch?: typeof fetch;
  readonly spawn?: typeof spawn;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

export function resolveDaemonHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["KIMI_CODE_HOME"] ?? join(homedir(), ".kiki");
}

export function parseDaemonInstance(raw: string): DaemonInstance | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const serverId = parsed["serverId"] ?? parsed["server_id"];
    const startedAt = parsed["startedAt"] ?? parsed["started_at"];
    const heartbeatAt = parsed["heartbeatAt"] ?? parsed["heartbeat_at"];
    const workspaces = parsed["workspaces"] ?? [];
    if (
      (serverId !== undefined && typeof serverId !== "string") ||
      typeof startedAt !== "number" ||
      (heartbeatAt !== undefined && typeof heartbeatAt !== "number") ||
      !Array.isArray(workspaces) ||
      !workspaces.every((value) => typeof value === "string")
    ) {
      return null;
    }

    const url = resolveInstanceUrl(parsed);
    if (url === null) return null;
    return {
      serverId,
      url,
      startedAt,
      heartbeatAt: Math.max(heartbeatAt ?? 0, startedAt),
      workspaces,
    };
  } catch {
    return null;
  }
}

export function rankDaemonInstances(
  instances: readonly DaemonInstance[],
  workspacePath?: string,
): readonly DaemonInstance[] {
  return instances.toSorted((left, right) => {
    const workspaceOrder = Number(workspaceMatches(right, workspacePath)) - Number(workspaceMatches(left, workspacePath));
    return workspaceOrder || right.heartbeatAt - left.heartbeatAt || right.startedAt - left.startedAt;
  });
}

export function daemonRegistryDirectories(homeDir: string): readonly string[] {
  return [join(homeDir, "server", "instances"), join(homeDir, "instances")];
}

function resolveInstanceUrl(parsed: Record<string, unknown>): string | null {
  if (typeof parsed["url"] === "string") {
    const url = new URL(parsed["url"]);
    if (url.protocol !== "http:" || !isLocalHost(url.hostname) || url.port === "") return null;
    return `http://127.0.0.1:${url.port}`;
  }
  const host = parsed["host"];
  const port = parsed["port"];
  if (typeof host !== "string" || typeof port !== "number" || port <= 0 || !isLocalHost(host)) {
    return null;
  }
  return `http://127.0.0.1:${port}`;
}

function isLocalHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[(.*)]$/, "$1");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "::" ||
    normalized === "0.0.0.0" ||
    normalized === "*" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function workspaceMatches(instance: DaemonInstance, currentWorkspace?: string): boolean {
  if (currentWorkspace === undefined) return false;
  const current = normalizeWorkspacePath(currentWorkspace);
  return instance.workspaces.some((workspace) => {
    const root = normalizeWorkspacePath(workspace);
    return current === root || current.startsWith(`${root}/`);
  });
}

function normalizeWorkspacePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

export async function discoverDaemon(
  homeDir: string,
  workspacePath?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DaemonConnection | null> {
  const token = await readToken(homeDir);
  if (token === null) return null;

  const instances = (
    await Promise.all(daemonRegistryDirectories(homeDir).map(readDaemonRegistryDirectory))
  ).flat();

  for (const instance of rankDaemonInstances(instances, workspacePath)) {
    try {
      const response = await fetchImpl(`${instance.url}/api/v1/meta`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return { url: instance.url, token };
    } catch {
    }
  }
  return null;
}

async function readDaemonRegistryDirectory(instancesDir: string): Promise<readonly DaemonInstance[]> {
  let names: string[];
  try {
    names = await readdir(instancesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          return parseDaemonInstance(await readFile(join(instancesDir, name), "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      }),
  );
  return records.filter((record): record is DaemonInstance => record !== null);
}

export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<DaemonConnection> {
  const homeDir = options.homeDir ?? resolveDaemonHome();
  const existing = await discoverDaemon(homeDir, options.workspacePath, options.fetch);
  if (existing !== null) return existing;

  const spawnImpl = options.spawn ?? spawn;
  const child = spawnImpl("kimi", ["web", "--no-open", "--port", "0", "--log-level", "warn"], {
    detached: true,
    env: { ...process.env, KIMI_CODE_HOME: homeDir },
    stdio: "ignore",
    windowsHide: true,
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.unref();

  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (spawnError !== undefined) throw spawnError;
    const connection = await discoverDaemon(homeDir, options.workspacePath, options.fetch);
    if (connection !== null) return connection;
    if (child.exitCode !== null) {
      throw new Error(`kimi web exited before the daemon became ready (${child.exitCode}).`);
    }
  }
  throw new Error(`Timed out waiting for kimi web after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`);
}

async function readToken(homeDir: string): Promise<string | null> {
  try {
    const token = (await readFile(join(homeDir, "server.token"), "utf8")).trim();
    return token === "" ? null : token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
