import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  daemonRegistryDirectories,
  discoverDaemon,
  ensureDaemon,
  parseDaemonInstance,
  rankDaemonInstances,
  resolveDaemonHome,
} from "../src/daemon";

const roots: string[] = [];

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "kiki-vscode-daemon-"));
  roots.push(home);
  await mkdir(join(home, "server", "instances"), { recursive: true });
  return home;
}

async function writeInstance(
  home: string,
  name: string,
  values: {
    readonly serverId: string;
    readonly host: string;
    readonly port: number;
    readonly startedAt: number;
    readonly heartbeatAt?: number;
    readonly workspaces?: readonly string[];
  },
  legacy = false,
): Promise<void> {
  const directory = legacy ? join(home, "instances") : join(home, "server", "instances");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${name}.json`),
    JSON.stringify({
      server_id: values.serverId,
      pid: 123,
      host: values.host,
      port: values.port,
      started_at: values.startedAt,
      heartbeat_at: values.heartbeatAt ?? values.startedAt,
      workspaces: values.workspaces,
    }),
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("daemon registry discovery", () => {
  it("uses the dedicated Kiki home unless KIMI_CODE_HOME is set", () => {
    expect(resolveDaemonHome({ KIMI_CODE_HOME: "C:/kiki-home" })).toBe("C:/kiki-home");
    expect(resolveDaemonHome({ HOME: "C:/users/example" })).toMatch(/[\\/]\.kiki$/);
  });

  it("parses both registry shapes and normalizes wildcard hosts", () => {
    expect(
      parseDaemonInstance(
        JSON.stringify({
          server_id: "server-1",
          host: "0.0.0.0",
          port: 8123,
          started_at: 42,
          heartbeat_at: 45,
          workspaces: ["C:/workspace"],
        }),
      ),
    ).toEqual({
      serverId: "server-1",
      url: "http://127.0.0.1:8123",
      startedAt: 42,
      heartbeatAt: 45,
      workspaces: ["C:/workspace"],
    });
    expect(
      parseDaemonInstance(
        JSON.stringify({
          serverId: "server-2",
          url: "http://localhost:8124",
          startedAt: 50,
          heartbeatAt: 55,
        }),
      ),
    ).toEqual({
      serverId: "server-2",
      url: "http://127.0.0.1:8124",
      startedAt: 50,
      heartbeatAt: 55,
      workspaces: [],
    });
    expect(parseDaemonInstance('{"url":"http://example.test:8125","startedAt":50}')).toBeNull();
  });

  it("prefers normalized workspace coverage, heartbeat, then start time", () => {
    const ranked = rankDaemonInstances(
      [
        { serverId: "other", url: "http://127.0.0.1:3", startedAt: 30, heartbeatAt: 90, workspaces: ["C:/other"] },
        { serverId: "workspace-old", url: "http://127.0.0.1:1", startedAt: 10, heartbeatAt: 20, workspaces: ["C:\\Repo"] },
        { serverId: "workspace-new", url: "http://127.0.0.1:2", startedAt: 20, heartbeatAt: 30, workspaces: ["c:/repo"] },
      ],
      "C:/REPO/worktree",
    );

    expect(ranked.map((instance) => instance.serverId)).toEqual([
      "workspace-new",
      "workspace-old",
      "other",
    ]);
  });

  it("reads current and historical registry directories", () => {
    expect(daemonRegistryDirectories("C:/home")).toEqual([
      join("C:/home", "server", "instances"),
      join("C:/home", "instances"),
    ]);
  });

  it("returns the first registry instance with an authenticated meta endpoint", async () => {
    const home = await createHome();
    await writeFile(join(home, "server.token"), "secret-token\n");
    await writeInstance(
      home,
      "old",
      {
        serverId: "old",
        host: "127.0.0.1",
        port: 7001,
        startedAt: 10,
        heartbeatAt: 30,
        workspaces: ["C:/repo"],
      },
      true,
    );
    await writeInstance(home, "new", {
      serverId: "new",
      host: "127.0.0.1",
      port: 7002,
      startedAt: 20,
      heartbeatAt: 40,
      workspaces: ["C:/repo"],
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: "Bearer secret-token" });
      return new Response(null, { status: String(url).includes(":7002/") ? 503 : 200 });
    });

    await expect(discoverDaemon(home, "C:/repo", fetchImpl)).resolves.toEqual({
      url: "http://127.0.0.1:7001",
      token: "secret-token",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("daemon startup", () => {
  it("spawns kimi web once and waits for its registry entry", async () => {
    const home = await createHome();
    const child = { exitCode: null, once: vi.fn(), unref: vi.fn() };
    const spawnImpl = vi.fn(() => child);
    let polls = 0;
    const sleep = vi.fn(async () => {
      polls += 1;
      if (polls === 1) {
        await writeFile(join(home, "server.token"), "spawned-token");
        await writeInstance(home, "spawned", {
          serverId: "spawned",
          host: "127.0.0.1",
          port: 8124,
          startedAt: 100,
        });
      }
    });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    await expect(
      ensureDaemon({
        homeDir: home,
        fetch: fetchImpl,
        spawn: spawnImpl as never,
        sleep,
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({ url: "http://127.0.0.1:8124", token: "spawned-token" });
    expect(spawnImpl).toHaveBeenCalledWith(
      "kimi",
      ["web", "--no-open", "--port", "0", "--log-level", "warn"],
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({ KIMI_CODE_HOME: home }),
        stdio: "ignore",
        windowsHide: true,
      }),
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("surfaces a missing kimi executable", async () => {
    const home = await createHome();
    let onError: ((error: Error) => void) | undefined;
    const child = {
      exitCode: null,
      once: vi.fn((_event: string, listener: (error: Error) => void) => {
        onError = listener;
        return child;
      }),
      unref: vi.fn(),
    };
    const missing = new Error("spawn kimi ENOENT");

    await expect(
      ensureDaemon({
        homeDir: home,
        spawn: vi.fn(() => child) as never,
        sleep: async () => onError?.(missing),
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("spawn kimi ENOENT");
  });
});
