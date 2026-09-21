import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDaemon, resolveDaemonHome } from "../src/daemon";

function childProcess() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn(), unref: vi.fn() });
}

const connection = { url: "http://127.0.0.1:8124", token: "test-token", serverId: "server-example" };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("shared daemon ensure", () => {
  it("uses the existing home override", () => {
    expect(resolveDaemonHome({ KIKI_HOME: "C:/kiki-home" })).toBe("C:/kiki-home");
    expect(resolveDaemonHome({ KIKI_HOME: "C:/new-home" })).toBe("C:/new-home");
    expect(resolveDaemonHome({})).toMatch(/[\\/]\.kiki$/);
  });

  it("delegates discovery, locking and detached startup to kiki serve --ensure", async () => {
    const child = childProcess();
    const spawn = vi.fn(() => child);
    const pending = ensureDaemon({ homeDir: "C:/home with spaces", workspacePath: "C:/workspace with spaces", spawn: spawn as never });
    child.stdout.write(JSON.stringify(connection).slice(0, 20));
    child.stdout.write(`${JSON.stringify(connection).slice(20)}\n`);
    child.emit("close", 0, null);
    await expect(pending).resolves.toEqual({ url: connection.url, token: connection.token });
    expect(spawn).toHaveBeenCalledExactlyOnceWith("kiki", [
      "serve", "--ensure", "--json", "--home", "C:/home with spaces", "--workspace", "C:/workspace with spaces",
    ], { detached: false, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    expect(child.unref).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not add the retired web flags or invent a workspace", async () => {
    const child = childProcess();
    const spawn = vi.fn(() => child);
    const pending = ensureDaemon({ homeDir: "C:/home", spawn: spawn as never });
    child.stdout.write(JSON.stringify(connection));
    child.emit("close", 0, null);
    await pending;
    expect(spawn.mock.calls[0]).toEqual(["kiki", ["serve", "--ensure", "--json", "--home", "C:/home"], expect.any(Object)]);
  });

  it("surfaces a missing executable", async () => {
    const child = childProcess();
    const pending = ensureDaemon({ spawn: vi.fn(() => child) as never });
    child.emit("error", new Error("spawn kiki ENOENT"));
    await expect(pending).rejects.toThrow("spawn kiki ENOENT");
  });

  it("rejects nonzero helper exit even if stdout contains a connection", async () => {
    const child = childProcess();
    const pending = ensureDaemon({ spawn: vi.fn(() => child) as never });
    child.stdout.write(JSON.stringify(connection));
    child.emit("close", 1, null);
    await expect(pending).rejects.toThrow("kiki serve --ensure failed (1)");
  });

  it.each([
    "not JSON",
    JSON.stringify({ ...connection, url: "http://example.test:8124" }),
    JSON.stringify({ ...connection, url: "http://user:password@127.0.0.1:8124" }),
    JSON.stringify({ ...connection, url: "http://127.0.0.1:8124?token=secret" }),
    JSON.stringify({ ...connection, token: "" }),
    JSON.stringify({ ...connection, serverId: undefined }),
  ])("rejects invalid local connection output without echoing secrets: %s", async (output) => {
    const child = childProcess();
    const pending = ensureDaemon({ spawn: vi.fn(() => child) as never });
    child.stdout.write(output);
    child.emit("close", 0, null);
    await expect(pending).rejects.toThrow("kiki serve --ensure returned an invalid local connection response.");
  });

  it("bounds the connection output", async () => {
    const child = childProcess();
    const pending = ensureDaemon({ spawn: vi.fn(() => child) as never });
    child.stdout.write("x".repeat(65 * 1024));
    await expect(pending).rejects.toThrow("oversized connection response");
    child.emit("close", 0, null);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("times out the request without terminating the shared daemon or helper", async () => {
    vi.useFakeTimers();
    const child = childProcess();
    const pending = ensureDaemon({ timeoutMs: 10, spawn: vi.fn(() => child) as never });
    const rejected = expect(pending).rejects.toThrow("The shared daemon was not stopped");
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    child.stdout.write(JSON.stringify(connection));
    child.emit("close", 0, null);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
