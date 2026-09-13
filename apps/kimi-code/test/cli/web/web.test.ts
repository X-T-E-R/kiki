/**
 * Tests for the `kimi web` Commander wiring and its subcommands.
 *
 * These tests don't actually start the server — the foreground runner is
 * injected, so they verify option parsing, the ready banner / one-line ready
 * output, browser opening, and the rotate-token subcommand against fake deps.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import chalk, { Chalk } from 'chalk';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetCapabilitiesCache, setCapabilities } from '@kiki/pi-tui';

import { registerWebCommand } from '#/cli/sub/web';
import type { WebCommandDeps } from '#/cli/sub/web/run';
import type { ParsedServerOptions } from '#/cli/sub/web/shared';
import { darkColors } from '#/tui/theme/colors';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

function stripAnsi(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

function makeProgram(): Command {
  // `commander` exitOverride avoids killing the test runner when --help/error fires.
  const program = new Command('kimi').exitOverride();
  registerWebCommand(program);
  return program;
}

type ForegroundRunner = NonNullable<WebCommandDeps['startServerForeground']>;

/**
 * Fake foreground runner: records the parsed options and fires `onReady` with
 * a fixed origin, then returns (the real runner blocks until SIGINT/SIGTERM).
 */
function makeRunner(origin = 'http://127.0.0.1:58627'): {
  runner: ForegroundRunner;
  calls: { options: ParsedServerOptions | undefined };
} {
  const calls: { options: ParsedServerOptions | undefined } = { options: undefined };
  const runner: ForegroundRunner = async (options, hooks) => {
    calls.options = options;
    await hooks?.onReady?.(origin);
    return undefined as never;
  };
  return { runner, calls };
}

/** Capturing stdout/stderr pair for `WebCommandDeps`. */
function makeIo(): {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  readStdout(): string;
} {
  let out = '';
  return {
    stdout: {
      write(chunk: string | Uint8Array) {
        out += String(chunk);
        return true;
      },
    },
    stderr: {
      write() {
        return true;
      },
    },
    readStdout: () => out,
  };
}

describe('kimi web', () => {
  it('registers the `web` command with only the rotate-token subcommand', () => {
    const program = makeProgram();
    const web = program.commands.find((c) => c.name() === 'web');
    expect(web).toBeDefined();
    const subs = web?.commands.map((c) => c.name()).toSorted();
    // Foreground servers stop with Ctrl+C, so there is no kill/ps.
    expect(subs).toEqual(['rotate-token']);
  });

  it('exposes the foreground server options on `web` itself', () => {
    const program = makeProgram();
    const web = program.commands.find((c) => c.name() === 'web');
    expect(web).toBeDefined();
    const longs = web!.options.map((o) => o.long).filter(Boolean);
    expect(longs).toContain('--port');
    expect(longs).toContain('--host');
    expect(longs).toContain('--allowed-host');
    expect(longs).toContain('--insecure-no-tls');
    expect(longs).toContain('--allow-remote-shutdown');
    expect(longs).toContain('--dangerous-bypass-auth');
    expect(longs).toContain('--log-level');
    expect(longs).toContain('--debug-endpoints');
    expect(longs).toContain('--web-title');
    // web opens the browser by default → the option is the negative --no-open.
    expect(longs).toContain('--no-open');
    // The background/daemon era flags are gone: the server always runs in the
    // foreground.
    expect(longs).not.toContain('--foreground');
    expect(longs).not.toContain('--keep-alive');
    expect(longs).not.toContain('--daemon');
    expect(longs).not.toContain('--idle-grace-ms');
    expect(longs).not.toContain('--allow-remote-terminals');
  });

});

describe('`kimi web` ready banner', () => {
  it('prints the TUI-style ready panel once listening', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    // The runner reports the actual bound origin — the banner must take the
    // port from it, not from the requested --port.
    const { runner } = makeRunner('http://127.0.0.1:58628');
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { port: '58627', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok',
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const plain = stripAnsi(readStdout());
    expect(plain).toContain('Kimi server ready');
    expect(plain).toContain('Local:');
    expect(plain).toContain('http://127.0.0.1:58628/#token=tok');
    expect(plain).toContain('Token:');
    // Loopback bind shows a Network hint for enabling network access.
    expect(plain).toContain('Network:');
    expect(plain).toContain('use --host to enable');
    expect(plain).toContain('Logs:');
    expect(plain).toContain('off');
    expect(plain).toContain('Stop:');
    expect(plain).toContain('Ctrl+C');
    // No bordered panel (the token URL must print in full for copying), but
    // the Kimi sprite stays next to the title.
    expect(plain).not.toContain('╭');
    expect(plain).not.toContain('╰');
    expect(plain).toContain('▐█▛█▛█▌');
    expect(plain).toContain('▐█████▌');
    expect(plain).not.toContain('Kimi server:');

    // Title is above the URLs; Logs/Stop are at the bottom.
    expect(plain.indexOf('Kimi server ready')).toBeLessThan(plain.indexOf('Local:'));
    expect(plain.indexOf('Logs:')).toBeLessThan(plain.indexOf('Stop:'));
  });

  it('uses the TUI dark palette for the ready banner', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr, readStdout } = makeIo();
    const previousChalkLevel = chalk.level;
    chalk.level = 3;

    try {
      await handleWebCommand(
        { port: '58627', host: '127.0.0.1', open: false },
        { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
      );
    } finally {
      chalk.level = previousChalkLevel;
    }

    const out = readStdout();
    const color = new Chalk({ level: 3 });
    expect(out).toContain(color.hex(darkColors.primary)('▐█▛█▛█▌'));
    expect(out).toContain(color.bold.hex(darkColors.primary)('Kimi server ready'));
    expect(out).toContain(color.hex(darkColors.accent)('http://127.0.0.1:58627/'));
    expect(out).toContain(color.bold.hex(darkColors.textDim)('Local:    '));
    expect(out).toContain(color.hex(darkColors.textMuted)('off'));
  });

  it('renders the bypass danger notice in the error color', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr, readStdout } = makeIo();
    const previousChalkLevel = chalk.level;
    chalk.level = 3;

    try {
      await handleWebCommand(
        { port: '58627', dangerousBypassAuth: true, open: false },
        { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
      );
    } finally {
      chalk.level = previousChalkLevel;
    }

    const color = new Chalk({ level: 3 });
    expect(readStdout()).toContain(
      color.bold.hex(darkColors.error)(
        '⚠ DANGER: authentication is DISABLED (--dangerous-bypass-auth).',
      ),
    );
  });

  it('prints the danger notice and suppresses the token when auth is bypassed', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr, readStdout } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { port: '58627', host: '127.0.0.1', dangerousBypassAuth: true, open: true },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok',
        openUrl,
        stdout,
        stderr,
      },
    );

    const plain = stripAnsi(readStdout());
    // Red, impossible-to-miss danger notice.
    expect(plain).toContain('DANGER: authentication is DISABLED');
    expect(plain).toContain('--dangerous-bypass-auth');
    expect(plain).toContain('Ctrl+C');
    // The token is irrelevant when bypassed — neither printed nor carried in
    // any URL (so it cannot leak via copy/paste of the banner).
    expect(plain).not.toContain('tok');
    expect(plain).not.toContain('#token=');
    // The opened browser URL carries no token fragment either.
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627');
  });
});

describe('ready banner reflects the bind class', () => {
  it('lists Local + Network addresses for a 0.0.0.0 bind (Vite-style)', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://0.0.0.0:58627');
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { host: '0.0.0.0', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok-xyz',
        networkAddresses: [
          { address: '192.0.2.66', family: 'IPv4' },
          { address: '198.51.100.216', family: 'IPv4' },
        ],
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const raw = stripAnsi(readStdout());
    expect(raw).toContain('Kimi server ready');
    expect(raw).toContain('Local:');
    expect(raw).toContain('Network:');
    // Full token-bearing URLs are printed plainly (no box, no truncation) so
    // they are easy to copy.
    expect(raw).toContain('http://localhost:58627/#token=tok-xyz');
    expect(raw).toContain('http://192.0.2.66:58627/#token=tok-xyz');
    expect(raw).toContain('http://198.51.100.216:58627/#token=tok-xyz');
    expect(raw).toContain('Token:');
    expect(raw).toContain('tok-xyz');
    expect(raw).not.toContain('╭');
  });

  it('lists only the Local URL for a 127.0.0.1 bind', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://127.0.0.1:58627');
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { host: '127.0.0.1', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok-loop',
        // Injected interface addresses must NOT leak into a loopback banner.
        networkAddresses: [{ address: '192.0.2.66', family: 'IPv4' }],
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const raw = stripAnsi(readStdout());
    expect(raw).toContain('Kimi server ready');
    expect(raw).toContain('Local:');
    expect(raw).toContain('http://127.0.0.1:58627/#token=tok-loop');
    expect(raw).toContain('Token:');
    expect(raw).toContain('tok-loop');
    // No network URLs on a loopback bind — just the "off" hint.
    expect(raw).toContain('use --host to enable');
    expect(raw).not.toContain('Network:  http');
    expect(raw).not.toContain('192.0.2.66');
    expect(raw).not.toContain('╭');
  });
});

describe('`kimi web` opens the browser', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetCapabilitiesCache();
  });

  it('opens the Web UI URL with the #token= fragment by default', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { port: '58627', open: true },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok-xyz',
        openUrl,
        stdout,
        stderr,
      },
    );

    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627/#token=tok-xyz');
  });

  it('opens the plain origin when no token is resolvable', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { port: '58627', open: true },
      {
        startServerForeground: runner,
        resolveToken: () => undefined,
        openUrl,
        stdout,
        stderr,
      },
    );

    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627');
  });

  it('does not open the browser when open is false', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://127.0.0.1:9000');
    const { stdout, stderr } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { port: '58627', open: false },
      { startServerForeground: runner, openUrl, stdout, stderr },
    );

    expect(openUrl).not.toHaveBeenCalled();
  });

});

describe('`kimi web` option threading', () => {
  it('threads the CLI flags into the foreground runner options', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      {
        port: '59000',
        host: '0.0.0.0',
        insecureNoTls: true,
        allowedHost: ['.example.com'],
        dangerousBypassAuth: true,
        debugEndpoints: true,
        allowRemoteShutdown: true,
        open: false,
      },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toEqual({
      host: '0.0.0.0',
      port: 59000,
      logLevel: 'silent',
      debugEndpoints: true,
      insecureNoTls: true,
      allowRemoteShutdown: true,
      dangerousBypassAuth: true,
      allowedHosts: ['.example.com'],
    });
  });

  it('keeps the default loopback bind available without --insecure-no-tls', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toMatchObject({
      host: '127.0.0.1',
      insecureNoTls: false,
      logLevel: 'silent',
    });
  });

  it('refuses a bare --host without --insecure-no-tls', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { stdout, stderr } = makeIo();
    const dir = mkdtempSync(join(tmpdir(), 'kimi-web-non-loopback-'));
    const previousHome = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = dir;

    try {
      await expect(
        handleWebCommand(
          { port: '0', host: true, open: false },
          { openUrl: vi.fn(), stdout, stderr },
        ),
      ).rejects.toThrow(
        'Refusing to bind 0.0.0.0 (public) without TLS; terminate TLS at a reverse proxy or pass --insecure-no-tls.',
      );
    } finally {
      if (previousHome === undefined) delete process.env['KIMI_CODE_HOME'];
      else process.env['KIMI_CODE_HOME'] = previousHome;
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('allows a bare --host with --insecure-no-tls', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', host: true, insecureNoTls: true, open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toMatchObject({ host: '0.0.0.0', insecureNoTls: true });
  });

  it('passes --log-level through to the runner', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', logLevel: 'debug', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toMatchObject({ logLevel: 'debug' });
  });

  it('passes --web-title through to the runner', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', webTitle: 'My Dev Box', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toMatchObject({ webTitle: 'My Dev Box' });
  });

  it('leaves webTitle undefined when --web-title is not passed', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options?.webTitle).toBeUndefined();
  });

  it('rejects an invalid --log-level before calling the runner', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const startServerForeground = vi.fn(async () => undefined as never);
    const { stdout, stderr } = makeIo();

    await expect(
      handleWebCommand(
        { logLevel: 'shout', open: false },
        { startServerForeground, openUrl: vi.fn(), stdout, stderr },
      ),
    ).rejects.toThrow(/invalid --log-level/);
    expect(startServerForeground).not.toHaveBeenCalled();
  });

  it('prints the one-line ready line instead of the full banner with a non-default --log-level', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { port: '58627', logLevel: 'info', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok',
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const plain = stripAnsi(readStdout());
    expect(plain).toContain('Kimi server: http://127.0.0.1:58627/#token=tok');
    expect(plain).not.toContain('Kimi server ready');
    expect(plain).not.toContain('Local:');
  });

  it('parses comma-separated --allowed-host values', async () => {
    const { parseAllowedHostArgs } = await import('#/cli/sub/web/shared');
    expect(parseAllowedHostArgs(['.example.com, app.example.com'])).toEqual([
      '.example.com',
      'app.example.com',
    ]);
  });
});

describe('shared parsers stay strict', () => {
  it('rejects out-of-range --port', async () => {
    const { parsePort } = await import('#/cli/sub/web/shared');
    expect(() => parsePort('99999', '--port', 58627)).toThrow(/invalid --port/);
    expect(() => parsePort('-1', '--port', 58627)).toThrow(/invalid --port/);
    expect(parsePort(undefined, '--port', 58627)).toBe(58627);
    expect(parsePort('8080', '--port', 58627)).toBe(8080);
  });

  it('rejects unknown --log-level values', async () => {
    const { parseLogLevel } = await import('#/cli/sub/web/shared');
    expect(() => parseLogLevel('shout')).toThrow(/invalid --log-level/);
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('debug')).toBe('debug');
  });
});

describe('Kiki MCP catalog source', () => {
  it('accepts only complete absolute read-only source bindings', async () => {
    const { externalCatalogSourceFromEnv } = await import('#/cli/sub/web/run');
    expect(externalCatalogSourceFromEnv({})).toBeUndefined();
    expect(
      externalCatalogSourceFromEnv({
        KIKI_MCP_CONFIG_PATH: '/active/config.toml',
        KIKI_MCP_AGENT_PROFILE_HOME: '/active',
        KIKI_MCP_CONFIG_READ_ONLY: '1',
      }),
    ).toEqual({
      configPath: '/active/config.toml',
      configReadOnly: true,
      userAgentProfileHomeDir: '/active',
    });
    expect(() =>
      externalCatalogSourceFromEnv({
        KIKI_MCP_CONFIG_PATH: '/active/config.toml',
        KIKI_MCP_AGENT_PROFILE_HOME: '/active',
      }),
    ).toThrow(/KIKI_MCP_CONFIG_READ_ONLY must be '1'/);
    expect(() =>
      externalCatalogSourceFromEnv({
        KIKI_MCP_CONFIG_PATH: 'config.toml',
        KIKI_MCP_AGENT_PROFILE_HOME: 'agents',
        KIKI_MCP_CONFIG_READ_ONLY: '1',
      }),
    ).toThrow(/must be an absolute path/);
    expect(() =>
      externalCatalogSourceFromEnv({
        KIKI_MCP_CONFIG_PATH: '/active/config.toml',
        KIKI_MCP_AGENT_PROFILE_HOME: '/active',
        KIKI_MCP_CONFIG_READ_ONLY: '0',
      }),
    ).toThrow(/KIKI_MCP_CONFIG_READ_ONLY must be '1'/);
  });
});

describe('Kiki desktop inheritance source', () => {
  it('accepts only absolute shared OAuth Home and Kiki skill inputs', async () => {
    const { desktopInheritanceSourceFromEnv } = await import('#/cli/sub/web/run');
    expect(desktopInheritanceSourceFromEnv({})).toBeUndefined();
    expect(desktopInheritanceSourceFromEnv({
      KIKI_DESKTOP_OAUTH_HOME: '/kimi-home',
      KIKI_DESKTOP_USER_SKILL_DIR: '/kiki-home/skills',
    })).toEqual({
      oauthHomeDir: '/kimi-home',
      userSkillDir: '/kiki-home/skills',
    });
    expect(desktopInheritanceSourceFromEnv({
      KIKI_DESKTOP_USER_SKILL_DIR: '/skills',
    })).toEqual({
      oauthHomeDir: undefined,
      userSkillDir: '/skills',
    });
    expect(() => desktopInheritanceSourceFromEnv({
      KIKI_DESKTOP_OAUTH_HOME: 'kimi-home',
    })).toThrow(/must be an absolute path/);
    expect(desktopInheritanceSourceFromEnv({
      KIKI_DESKTOP_CONFIG_PATH: '/compat/config.toml',
      KIKI_DESKTOP_MODEL_ACCOUNT_HOME: '/compat',
    })).toBeUndefined();
  });
});

describe('server web asset directory resolution', () => {
  it('uses extracted SEA web assets when available', async () => {
    const { resolveServerWebAssetsDir } = await import('#/cli/sub/web/run');
    expect(resolveServerWebAssetsDir('/cache/kimi/dist/web')).toBe('/cache/kimi/dist/web');
  });

  it('falls back to package dist/web outside SEA mode', async () => {
    const { resolveServerWebAssetsDir } = await import('#/cli/sub/web/run');
    expect(resolveServerWebAssetsDir(null)).toMatch(/[/\\]dist[/\\]web$/);
  });

  it('returns the assets dir when it is built, dev mode or not', async () => {
    const { serverWebAssetsDir } = await import('#/cli/sub/web/run');
    const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-'));
    try {
      writeFileSync(join(dir, 'index.html'), '<html></html>');
      expect(serverWebAssetsDir({}, dir)).toBe(dir);
      expect(serverWebAssetsDir({ KIMI_CODE_DEV_SERVER: '1' }, dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('requires built assets outside dev mode', async () => {
    const { serverWebAssetsDir } = await import('#/cli/sub/web/run');
    const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-'));
    try {
      expect(serverWebAssetsDir({}, dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('tolerates missing assets in dev mode (API-only server)', async () => {
    const { serverWebAssetsDir } = await import('#/cli/sub/web/run');
    const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-'));
    try {
      expect(serverWebAssetsDir({ KIMI_CODE_DEV_SERVER: '1' }, dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});


describe('resolveServerToken', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-server-token-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('reads the token from <homeDir>/server.token', async () => {
    const { resolveServerToken } = await import('#/cli/sub/web/shared');
    writeFileSync(join(dir, 'server.token'), 'secret-token\n');
    expect(resolveServerToken(dir)).toBe('secret-token');
  });

  it('trims surrounding whitespace', async () => {
    const { resolveServerToken } = await import('#/cli/sub/web/shared');
    writeFileSync(join(dir, 'server.token'), '  tok  \n');
    expect(resolveServerToken(dir)).toBe('tok');
  });

  it('throws a clear error when the token file is missing', async () => {
    const { resolveServerToken } = await import('#/cli/sub/web/shared');
    expect(() => resolveServerToken(dir)).toThrow(/unable to read server token/);
  });
});

describe('authHeaders', () => {
  it('builds a Bearer Authorization header', async () => {
    const { authHeaders } = await import('#/cli/sub/web/shared');
    expect(authHeaders('abc')).toEqual({ Authorization: 'Bearer abc' });
  });
});

describe('buildWebUrl', () => {
  it('carries the token in the URL fragment (not path or query)', async () => {
    const { buildWebUrl } = await import('#/cli/sub/web/run');
    const url = buildWebUrl('http://127.0.0.1:58627', 'abc123');
    expect(url).toBe('http://127.0.0.1:58627/#token=abc123');
    const parsed = new URL(url);
    expect(parsed.hash).toBe('#token=abc123');
    // The token is client-side only: it must NOT appear in the path or query
    // (which WOULD be sent to the server and logged).
    expect(parsed.pathname).not.toContain('abc123');
    expect(parsed.search).not.toContain('abc123');
  });

  it('normalizes a trailing slash', async () => {
    const { buildWebUrl } = await import('#/cli/sub/web/run');
    expect(buildWebUrl('http://127.0.0.1:58627/', 't')).toBe(
      'http://127.0.0.1:58627/#token=t',
    );
  });
});

describe('accessUrlLines', () => {
  it('returns Local + Network lines for a wildcard bind', async () => {
    const { accessUrlLines } = await import('#/cli/sub/web/access-urls');
    const lines = accessUrlLines('0.0.0.0', 58627, 'tok', [
      { address: '192.168.1.5', family: 'IPv4' },
    ]);
    expect(lines).toEqual([
      { label: 'Local:    ', url: 'http://localhost:58627/#token=tok' },
      { label: 'Network:  ', url: 'http://192.168.1.5:58627/#token=tok' },
    ]);
  });

  it('returns a single Local line for a loopback bind', async () => {
    const { accessUrlLines } = await import('#/cli/sub/web/access-urls');
    const lines = accessUrlLines('127.0.0.1', 58627, 'tok');
    expect(lines).toEqual([
      { label: 'Local:    ', url: 'http://127.0.0.1:58627/#token=tok' },
    ]);
  });

  it('returns a single URL line for a specific host (no token)', async () => {
    const { accessUrlLines } = await import('#/cli/sub/web/access-urls');
    const lines = accessUrlLines('192.168.1.5', 58627, undefined);
    expect(lines).toEqual([{ label: 'URL:      ', url: 'http://192.168.1.5:58627/' }]);
  });

  it('splitTokenFragment splits off the #token= fragment', async () => {
    const { splitTokenFragment } = await import('#/cli/sub/web/access-urls');
    expect(splitTokenFragment('http://h:1/#token=abc')).toEqual(['http://h:1/', '#token=abc']);
    expect(splitTokenFragment('http://h:1/')).toEqual(['http://h:1/', '']);
  });
});

describe('`kimi web rotate-token`', () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-rotate-'));
    prevHome = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = dir;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env['KIMI_CODE_HOME'];
    } else {
      process.env['KIMI_CODE_HOME'] = prevHome;
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('writes a new token to server.token and prints it', async () => {
    const { registerWebCommand } = await import('#/cli/sub/web');
    const program = new Command('kimi').exitOverride();
    registerWebCommand(program);
    let stdout = '';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });

    await program.parseAsync(['node', 'kimi', 'web', 'rotate-token']);
    writeSpy.mockRestore();

    const token = readFileSync(join(dir, 'server.token'), 'utf8').trim();
    expect(token.length).toBeGreaterThan(20);
    expect(stdout).toContain('New server token');
    expect(stdout).toContain(token);
  });

  it('re-prints the access links with the new token when a server is running', async () => {
    const { registerWebCommand } = await import('#/cli/sub/web');
    const { mkdirSync, writeFileSync: writeSync } = await import('node:fs');
    // Fake a live instance-registry entry pointing at this (alive) process so
    // getLiveServerInstance() finds the running server and the command can
    // re-print its links.
    mkdirSync(join(dir, 'server', 'instances'), { recursive: true });
    writeSync(
      join(dir, 'server', 'instances', '01JTEST0000000000000000000.json'),
      JSON.stringify({
        server_id: '01JTEST0000000000000000000',
        pid: process.pid,
        host: '127.0.0.1',
        port: 58627,
        started_at: Date.now(),
        heartbeat_at: Date.now(),
      }),
    );

    const program = new Command('kimi').exitOverride();
    registerWebCommand(program);
    let stdout = '';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });

    await program.parseAsync(['node', 'kimi', 'web', 'rotate-token']);
    writeSpy.mockRestore();

    const token = readFileSync(join(dir, 'server.token'), 'utf8').trim();
    expect(stdout).toContain('New server token');
    expect(stdout).toContain(`http://127.0.0.1:58627/#token=${token}`);
    // Token line sits between the note and the links.
    expect(stdout.indexOf('picks up the new token')).toBeLessThan(
      stdout.indexOf('New server token'),
    );
    expect(stdout.indexOf('New server token')).toBeLessThan(
      stdout.indexOf(`http://127.0.0.1:58627/#token=${token}`),
    );
  });
});

describe('formatHostForUrl', () => {
  it('bracket-wraps IPv6 and leaves IPv4 as-is', async () => {
    const { formatHostForUrl } = await import('#/cli/sub/web/networks');
    expect(formatHostForUrl('192.168.1.5', 'IPv4')).toBe('192.168.1.5');
    expect(formatHostForUrl('fe80::1', 'IPv6')).toBe('[fe80::1]');
  });
});

describe('filterDisplayAddresses', () => {
  it('drops IPv6 link-local, de-duplicates, and orders IPv4 before IPv6', async () => {
    const { filterDisplayAddresses } = await import('#/cli/sub/web/networks');
    const out = filterDisplayAddresses([
      { address: 'fe80::ecf3:c2ff:fe9c:11c3', family: 'IPv6' },
      { address: '192.168.1.5', family: 'IPv4' },
      { address: 'fe80::ecf3:c2ff:fe9c:11c3', family: 'IPv6' },
      { address: '10.0.0.1', family: 'IPv4' },
      { address: 'fe80::1', family: 'IPv6' },
      { address: '2001:db8::1', family: 'IPv6' },
    ]);
    expect(out).toEqual([
      { address: '192.168.1.5', family: 'IPv4' },
      { address: '10.0.0.1', family: 'IPv4' },
      { address: '2001:db8::1', family: 'IPv6' },
    ]);
  });
});
