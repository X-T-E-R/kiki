import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
    readonly workspaces?: readonly string[];
  },
): Promise<void> {
  await writeFile(
    join(home, "server", "instances", `${name}.json`),
    JSON.stringify({
      server_id: values.serverId,
      pid: 123,
      host: values.host,
      port: values.port,
      started_at: values.startedAt,
      heartbeat_at: values.startedAt,
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

  it("parses optional workspace ownership", () => {
    expect(
      parseDaemonInstance(
        JSON.stringify({
          server_id: "server-1",
          host: "127.0.0.1",
          port: 8123,
          started_at: 42,
          workspaces: ["C:/workspace"],
        }),
      ),
    ).toEqual({
      serverId: "server-1",
      host: "127.0.0.1",
      port: 8123,
      startedAt: 42,
      workspaces: ["C:/workspace"],
    });
  });

  it("prefers a matching workspace and then the newest instance", () => {
    const ranked = rankDaemonInstances(
      [
        { serverId: "newest", host: "127.0.0.1", port: 3, startedAt: 30 },
        {
          serverId: "workspace-old",
          host: "127.0.0.1",
          port: 1,
          startedAt: 10,
          workspaces: ["C:/repo"],
        },
        {
          serverId: "workspace-new",
          host: "127.0.0.1",
          port: 2,
          startedAt: 20,
          workspaces: ["C:/repo"],
        },
      ],
      "C:/repo",
    );

    expect(ranked.map((instance) => instance.serverId)).toEqual([
      "workspace-new",
      "workspace-old",
      "newest",
    ]);
  });

  it("returns the first registry instance with an authenticated meta endpoint", async () => {
    const home = await createHome();
    await writeFile(join(home, "server.token"), "secret-token\n");
    await writeInstance(home, "old", {
      serverId: "old",
      host: "127.0.0.1",
      port: 7001,
      startedAt: 10,
      workspaces: ["C:/repo"],
    });
    await writeInstance(home, "new", {
      serverId: "new",
      host: "127.0.0.1",
      port: 7002,
      startedAt: 20,
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
    const child = { exitCode: null, unref: vi.fn() };
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
});
