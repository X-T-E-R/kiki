import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface DaemonConnection {
  readonly url: string;
  readonly token: string;
}

interface EnsureDaemonOptions {
  readonly homeDir?: string;
  readonly workspacePath?: string;
  readonly spawn?: typeof spawn;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 130_000;
const MAX_CONNECTION_BYTES = 64 * 1024;

export function resolveDaemonHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["KIKI_HOME"] ?? join(homedir(), ".kiki");
}

export function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<DaemonConnection> {
  const homeDir = options.homeDir ?? resolveDaemonHome();
  const args = ["serve", "--ensure", "--json", "--home", homeDir];
  if (options.workspacePath !== undefined) args.push("--workspace", options.workspacePath);
  const spawnImpl = options.spawn ?? spawn;
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    let outputBytes = 0;
    const finish = (error?: Error, connection?: DaemonConnection): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(connection!);
    };
    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for kiki serve --ensure after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms. The shared daemon was not stopped.`));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const command = process.platform === "win32" ? resolveWindowsKikiPath() : "kiki";
      const batch = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
      const child = spawnImpl(batch ? process.env["ComSpec"] ?? "cmd.exe" : command, batch
        ? ["/d", "/s", "/c", `"${escapeCmd(command)} ${args.map(quoteCmdArgument).join(" ")}"`]
        : args, {
        detached: false,
        shell: false,
        windowsVerbatimArguments: batch ? true : undefined,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      child.once("error", (error) => { finish(error); });
      if (child.stdout === null) {
        finish(new Error("kiki serve --ensure did not provide a connection output stream."));
        return;
      }
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (settled) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_CONNECTION_BYTES) {
          finish(new Error("kiki serve --ensure returned an oversized connection response."));
          return;
        }
        output += chunk;
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        if (code !== 0) {
          finish(new Error(`kiki serve --ensure failed (${signal ?? code ?? "unknown exit"}).`));
          return;
        }
        try {
          finish(undefined, parseConnection(output));
        } catch {
          finish(new Error("kiki serve --ensure returned an invalid local connection response."));
        }
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Could not start kiki serve --ensure."));
    }
  });
}

// Follow the CLI PATH resolver's PATHEXT and workspace-shadowing rules locally;
// the extension must not import the CLI application or bootstrap its runtime.
function resolveWindowsKikiPath(): string {
  const extensions = (process.env["PATHEXT"] || ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim()).filter(Boolean);
  for (const dir of (process.env["PATH"] ?? "").split(";")) {
    if (dir === "") continue;
    for (const ext of extensions) {
      const candidate = resolve(dir, `kiki${ext}`);
      try {
        if (!statSync(candidate).isFile()) continue;
      } catch { continue; }
      const rel = relative(resolve(process.cwd()).toLowerCase(), candidate.toLowerCase());
      if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) break;
      return candidate;
    }
  }
  throw new Error("spawn kiki ENOENT");
}

function escapeCmd(value: string): string {
  return value.replaceAll(/([()%!^"<>&|;, *?])/g, "^$1");
}

function quoteCmdArgument(value: string): string {
  const quoted = `"${value.replaceAll(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  // npm's batch shim forwards %*: escape once for cmd and once for the shim.
  return escapeCmd(escapeCmd(quoted));
}

function parseConnection(output: string): DaemonConnection {
  const value = JSON.parse(output.trim()) as Record<string, unknown>;
  if (typeof value["url"] !== "string" || typeof value["token"] !== "string" || value["token"].trim() === "" ||
      typeof value["serverId"] !== "string" || value["serverId"] === "") {
    throw new Error("Invalid connection fields");
  }
  const url = new URL(value["url"]);
  const local = url.hostname === "localhost" || url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (!local || url.protocol !== "http:" || url.port === "" || url.username !== "" || url.password !== "" ||
      url.search !== "" || url.hash !== "" || url.pathname !== "/") {
    throw new Error("Invalid local endpoint");
  }
  return { url: url.origin, token: value["token"].trim() };
}
