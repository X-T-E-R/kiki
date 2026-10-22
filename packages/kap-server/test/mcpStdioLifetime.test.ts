import { spawn, type ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { retainUntilStdioClientEnds } from '../src/mcp/stdioLifetime';

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

function captureStderr(): { text: () => string; restore: () => void } {
  let text = '';
  const previous = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  return {
    text: () => text,
    restore: () => { process.stderr.write = previous; },
  };
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readWorkingSet(pid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const windows = process.platform === 'win32';
    const command = windows ? 'powershell.exe' : 'ps';
    const args = windows ? [
      '-NoProfile',
      '-Command',
      `try { (Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64 } catch { '' }`,
    ] : ['-o', 'rss=', '-p', String(pid)];
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.on('close', () => {
      const value = Number(out.trim()) * (windows ? 1 : 1024);
      resolve(Number.isFinite(value) && value > 0 ? value : undefined);
    });
    child.on('error', () => resolve(undefined));
  });
}

describe('stdio MCP client lifetime', () => {
  it('stays up while the caller is alive and exits once after stdin ends', async () => {
    const stdin = new PassThrough();
    let closes = 0;
    let code = -1;
    const done = retainUntilStdioClientEnds({
      stdin,
      parentPid: process.pid,
      pollMs: 20,
      closeBudgetMs: 50,
      close: async () => { closes += 1; },
      exit: (status) => { code = status; },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(code).toBe(-1);
    stdin.resume();
    stdin.end();
    await done;
    expect(closes).toBe(1);
    expect(code).toBe(0);
  });

  it('releases when the parent pid is gone even if stdin is still open', async () => {
    const stdin = new PassThrough();
    let code = -1;
    await retainUntilStdioClientEnds({
      stdin,
      parentPid: 2_147_483_646,
      pollMs: 20,
      closeBudgetMs: 50,
      close: async () => undefined,
      exit: (status) => { code = status; },
    });
    expect(code).toBe(0);
    expect(stdin.readableEnded).toBe(false);
  });

  it('does not treat a live or unqueryable parent as gone, including pid 0', async () => {
    const stdin = new PassThrough();
    let exits = 0;
    const done = retainUntilStdioClientEnds({
      stdin,
      parentPid: 0,
      pollMs: 20,
      close: async () => undefined,
      exit: () => { exits += 1; },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exits).toBe(0);
    stdin.resume();
    stdin.end();
    await done;
    expect(exits).toBe(1);
  });

  it('reports a close budget expiry on stderr and does not resolve successfully', async () => {
    const stdin = new PassThrough();
    let code = -1;
    const started = Date.now();
    const previousCode = process.exitCode;
    const diagnostic = captureStderr();
    try {
      const done = retainUntilStdioClientEnds({
        stdin,
        parentPid: process.pid,
        closeBudgetMs: 40,
        close: () => new Promise(() => undefined),
        exit: (status) => { code = status; },
      });
      stdin.resume();
      stdin.end();
      await expect(done).rejects.toThrow(/"reason":"timeout"/);
      expect(code).toBe(1);
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(diagnostic.text())).toEqual({
        event: 'stdio-cleanup',
        reason: 'timeout',
        closeBudgetMs: 40,
        exitCode: 1,
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    } finally {
      diagnostic.restore();
      process.exitCode = previousCode;
    }
  });

  it('captures a synchronous close throw and leaves another node process alive', async () => {
    const sentinel = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
    children.push(sentinel);
    const stdin = new PassThrough();
    let code = -1;
    const previousCode = process.exitCode;
    const diagnostic = captureStderr();
    try {
      const done = retainUntilStdioClientEnds({
        stdin,
        parentPid: process.pid,
        closeBudgetMs: 500,
        close: () => { throw new Error('sync-close'); },
        exit: (status) => { code = status; },
      });
      stdin.resume();
      stdin.end();
      await expect(done).rejects.toThrow(/"reason":"close-error"/);
      expect(code).toBe(1);
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(diagnostic.text())).toEqual({
        event: 'stdio-cleanup',
        reason: 'close-error',
        closeBudgetMs: 500,
        exitCode: 1,
        message: 'sync-close',
      });
      expect(alive(sentinel.pid)).toBe(true);
    } finally {
      diagnostic.restore();
      process.exitCode = previousCode;
    }
  });

  it('captures a rejected close and reports it instead of exiting successfully', async () => {
    const stdin = new PassThrough();
    let code = -1;
    const previousCode = process.exitCode;
    const diagnostic = captureStderr();
    try {
      const done = retainUntilStdioClientEnds({
        stdin,
        parentPid: process.pid,
        closeBudgetMs: 500,
        close: async () => { throw new Error('async-close'); },
        exit: (status) => { code = status; },
      });
      stdin.resume();
      stdin.end();
      await expect(done).rejects.toThrow(/"message":"async-close"/);
      expect(code).toBe(1);
      expect(JSON.parse(diagnostic.text()).message).toBe('async-close');
    } finally {
      diagnostic.restore();
      process.exitCode = previousCode;
    }
  });

  it('exits after the watched parent process exits while stdin stays open', async () => {
    const lifetimeUrl = new URL('../src/mcp/stdioLifetime.ts', import.meta.url).href;
    const childScript = [
      `import { retainUntilStdioClientEnds } from ${JSON.stringify(lifetimeUrl)};`,
      'void (async () => {',
      '  process.stdout.write(String(process.pid) + "\\n");',
      '  process.stdin.on("data", () => undefined);',
      '  await retainUntilStdioClientEnds({ parentPid: Number(process.env.WATCH_PID), pollMs: 40, closeBudgetMs: 50, close: async () => undefined });',
      '  process.exit(0);',
      '})();',
    ].join('\n');
    const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore', windowsHide: true });
    children.push(parent);
    let stderr = '';
    const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', childScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WATCH_PID: String(parent.pid) },
      windowsHide: true,
    });
    children.push(child);
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const banner = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('watched child did not start')), 15_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          clearTimeout(timer);
          resolve(buf.slice(0, nl));
        }
      });
    });
    expect(Number(banner)).toBe(child.pid);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(alive(child.pid)).toBe(true);
    expect(alive(parent.pid)).toBe(true);
    parent.kill();
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code, stderr).toBe(0);
    expect(alive(child.pid)).toBe(false);
  }, 20_000);

  it('exits the owned stdio bridge after the caller closes stdin and leaves another node process', async () => {
    const serverUrl = new URL('../src/mcp/stdioServer.ts', import.meta.url).href;
    const script = [
      `import { runKikiMcpStdio } from ${JSON.stringify(serverUrl)};`,
      'void (async () => {',
      '  const memory = process.memoryUsage();',
      '  process.stdout.write(JSON.stringify({ pid: process.pid, rss: memory.rss, heapUsed: memory.heapUsed }) + "\\n");',
      '  await runKikiMcpStdio({ endpoint: "http://127.0.0.1:9", delegationToken: "fixture", sessionId: "fixture" });',
      '  process.exit(0);',
      '})();',
    ].join('\n');
    const sentinel = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    children.push(sentinel);
    const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.push(child);
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const banner = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`bridge did not start stderr=${stderr}`)), 15_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          clearTimeout(timer);
          resolve(buf.slice(0, nl));
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`bridge exited ${code} before banner stderr=${stderr}`));
      });
    });
    const reported = JSON.parse(banner) as { pid: number; rss: number; heapUsed: number };
    expect(reported.pid).toBe(child.pid);
    expect(reported.rss).toBeGreaterThan(0);
    const before = await readWorkingSet(reported.pid);
    expect(before).toBeGreaterThan(0);
    expect(alive(sentinel.pid)).toBe(true);
    child.stdin?.end();
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(0);
    expect(alive(reported.pid)).toBe(false);
    expect(await readWorkingSet(reported.pid)).toBeUndefined();
    expect(alive(sentinel.pid)).toBe(true);
  }, 20_000);
});
