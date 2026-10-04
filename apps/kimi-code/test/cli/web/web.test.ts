import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWebCommand } from '#/cli/sub/web';
import { handleWebCommand, type WebCommandDeps } from '#/cli/sub/web/run';
import type { Klient } from '@kiki/klient';

vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn() }));
function makeProgram(): Command { const program = new Command('kimi').exitOverride(); registerWebCommand(program); return program; }
function fake() {
  const status = { enabled: true, mode: 'temporary', url: 'http://127.0.0.1:58627', expiresAt: 1, host: '127.0.0.1', port: 58627, insecure: false, sessions: [] };
  const web = { enable: vi.fn().mockResolvedValue(status), status: vi.fn().mockResolvedValue(status), disable: vi.fn().mockResolvedValue({ ...status, enabled: false }), revoke: vi.fn().mockResolvedValue(status), issueLink: vi.fn().mockResolvedValue({ url: status.url + '#access=ONE_TIME_CODE', expiresAt: 1 }) };
  const close = vi.fn().mockResolvedValue(undefined); let out = '';
  const connection = { url: status.url, token: 'PRIVATE_LOCAL_OWNER', serverId: 'test-server' };
  const ensureServer = vi.fn().mockResolvedValue(connection); const findServer = vi.fn().mockResolvedValue(connection);
  const createKlient = vi.fn().mockReturnValue({ rest: { webAccess: web }, close } as unknown as Klient);
  const deps: WebCommandDeps = { ensureServer, findServer, createKlient, openUrl: vi.fn(), stdout: { write: (chunk) => { out += String(chunk); return true; } }, stderr: { write: () => true } };
  return { deps, web, ensureServer, findServer, createKlient, close, output: () => out };
}

describe('kiki web on the shared daemon', () => {
  it('exposes Web lifecycle and explicit network options without engine/debug/auth-bypass startup flags', () => {
    const web = makeProgram().commands.find((c) => c.name() === 'web')!;
    expect(web.commands.map((c) => c.name())).toEqual(['rotate-token']);
    const flags = web.options.map((o) => o.long);
    for (const flag of ['--home', '--persistent', '--temporary', '--status', '--off', '--revoke', '--host', '--port', '--public-url', '--insecure-no-tls', '--json', '--no-open']) expect(flags).toContain(flag);
    for (const flag of ['--dangerous-bypass-auth', '--debug-endpoints', '--allow-remote-shutdown', '--foreground']) expect(flags).not.toContain(flag);
  });
  it('ensures one shared daemon, signs a one-time link, prints no root credential and does not block the CLI', async () => {
    const f = fake(); await handleWebCommand({ home: '/isolated/home' }, f.deps);
    expect(f.ensureServer).toHaveBeenCalledWith({ homeDir: expect.any(String), idleExit: '0ms' });
    expect(f.findServer).not.toHaveBeenCalled();
    expect(f.web.enable).toHaveBeenCalledWith({ mode: 'temporary', host: undefined, port: undefined, publicUrl: undefined, insecureNoTls: undefined });
    expect(f.deps.openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627#access=ONE_TIME_CODE');
    expect(f.output()).toContain('full Web use'); expect(f.output()).not.toContain('PRIVATE_LOCAL_OWNER'); expect(f.output()).not.toContain('#token='); expect(f.close).toHaveBeenCalledOnce();
  });
  it('passes persistent/network configuration and does not open when requested', async () => {
    const f = fake(); await handleWebCommand({ persistent: true, host: true, port: '0', publicUrl: 'https://example.test', insecureNoTls: true, open: false, json: true }, f.deps);
    expect(f.web.enable).toHaveBeenCalledWith({ mode: 'persistent', host: '0.0.0.0', port: 0, publicUrl: 'https://example.test', insecureNoTls: true });
    expect(f.deps.openUrl).not.toHaveBeenCalled(); expect(JSON.parse(f.output()).link.url).toContain('#access=');
  });
  it('queries, closes and revokes only through the existing daemon without spawning it', async () => {
    for (const opts of [{ status: true }, { off: true }, { revoke: true }, { revoke: 'browser-id' }]) {
      const f = fake(); await handleWebCommand(opts, f.deps); expect(f.ensureServer).not.toHaveBeenCalled(); expect(f.findServer).toHaveBeenCalledOnce();
      if ('off' in opts) expect(f.web.disable).toHaveBeenCalledOnce();
      if ('revoke' in opts) expect(f.web.revoke).toHaveBeenCalledWith(opts.revoke === true ? undefined : opts.revoke);
      expect(f.web.issueLink).not.toHaveBeenCalled(); expect(f.deps.openUrl).not.toHaveBeenCalled();
    }
  });
  it('reports a stopped daemon and rejects conflicting actions before discovery', async () => {
    const f = fake(); f.findServer.mockResolvedValue(undefined); await handleWebCommand({ status: true, json: true }, f.deps); expect(JSON.parse(f.output())).toEqual({ enabled: false, running: false });
    await expect(handleWebCommand({ persistent: true, temporary: true }, f.deps)).rejects.toThrow('Choose one');
    await expect(handleWebCommand({ off: true, status: true }, f.deps)).rejects.toThrow('Choose one');
    expect(f.ensureServer).not.toHaveBeenCalled();
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
    expect(parseLogLevel(undefined)).toBe('info'); expect(parseLogLevel('debug')).toBe('debug');
  });
});

describe('Kiki MCP catalog source', () => {
  it('accepts only complete absolute read-only source bindings', async () => {
    const { externalCatalogSourceFromEnv } = await import('#/cli/sub/web/run');
    expect(externalCatalogSourceFromEnv({})).toBeUndefined();
    expect(externalCatalogSourceFromEnv({ KIKI_MCP_CONFIG_PATH: '/active/config.toml', KIKI_MCP_AGENT_PROFILE_HOME: '/active', KIKI_MCP_CONFIG_READ_ONLY: '1' })).toEqual({ configPath: '/active/config.toml', configReadOnly: true, userAgentProfileHomeDir: '/active' });
    expect(() => externalCatalogSourceFromEnv({ KIKI_MCP_CONFIG_PATH: '/active/config.toml', KIKI_MCP_AGENT_PROFILE_HOME: '/active' })).toThrow(/KIKI_MCP_CONFIG_READ_ONLY must be '1'/);
    expect(() => externalCatalogSourceFromEnv({ KIKI_MCP_CONFIG_PATH: 'config.toml', KIKI_MCP_AGENT_PROFILE_HOME: 'agents', KIKI_MCP_CONFIG_READ_ONLY: '1' })).toThrow(/must be an absolute path/);
    expect(() => externalCatalogSourceFromEnv({ KIKI_MCP_CONFIG_PATH: '/active/config.toml', KIKI_MCP_AGENT_PROFILE_HOME: '/active', KIKI_MCP_CONFIG_READ_ONLY: '0' })).toThrow(/KIKI_MCP_CONFIG_READ_ONLY must be '1'/);
  });
});

describe('Kiki desktop inheritance source', () => {
  it('accepts only absolute shared OAuth Home and Kiki skill inputs', async () => {
    const { desktopInheritanceSourceFromEnv } = await import('#/cli/sub/web/run');
    expect(desktopInheritanceSourceFromEnv({})).toBeUndefined();
    expect(desktopInheritanceSourceFromEnv({ KIKI_DESKTOP_OAUTH_HOME: '/kimi-home', KIKI_DESKTOP_USER_SKILL_DIR: '/kiki-home/skills' })).toEqual({ oauthHomeDir: '/kimi-home', userSkillDir: '/kiki-home/skills' });
    expect(desktopInheritanceSourceFromEnv({ KIKI_DESKTOP_USER_SKILL_DIR: '/skills' })).toEqual({ oauthHomeDir: undefined, userSkillDir: '/skills' });
    expect(() => desktopInheritanceSourceFromEnv({ KIKI_DESKTOP_OAUTH_HOME: 'kimi-home' })).toThrow(/must be an absolute path/);
    expect(desktopInheritanceSourceFromEnv({ KIKI_DESKTOP_CONFIG_PATH: '/compat/config.toml', KIKI_DESKTOP_MODEL_ACCOUNT_HOME: '/compat' })).toBeUndefined();
  });
});

describe('server web asset directory resolution', () => {
  it('uses extracted SEA web assets when available', async () => { const { resolveServerWebAssetsDir } = await import('#/cli/sub/web/run'); expect(resolveServerWebAssetsDir('/cache/kimi/dist/web')).toBe('/cache/kimi/dist/web'); });
  it('falls back to package dist/web outside SEA mode', async () => { const { resolveServerWebAssetsDir } = await import('#/cli/sub/web/run'); expect(resolveServerWebAssetsDir(null)).toMatch(/[/\\]dist[/\\]web$/); });
  it('returns the assets dir when it is built, dev mode or not', async () => {
    const { serverWebAssetsDir } = await import('#/cli/sub/web/run'); const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-'));
    try { writeFileSync(join(dir, 'index.html'), '<html></html>'); expect(serverWebAssetsDir({}, dir)).toBe(dir); expect(serverWebAssetsDir({ KIKI_DEV_SERVER: '1' }, dir)).toBe(dir); }
    finally { rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });
  it('requires built assets outside dev mode', async () => {
    const { serverWebAssetsDir } = await import('#/cli/sub/web/run'); const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-'));
    try { expect(serverWebAssetsDir({}, dir)).toBe(dir); } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });
  it('tolerates missing assets in dev mode (API-only server)', async () => {
    const { serverWebAssetsDir } = await import('#/cli/sub/web/run'); const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-'));
    try { expect(serverWebAssetsDir({ KIKI_DEV_SERVER: '1' }, dir)).toBeUndefined(); } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  });
});

describe('resolveServerToken', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kimi-server-token-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  it('reads the token from <homeDir>/server.token', async () => { const { resolveServerToken } = await import('#/cli/sub/web/shared'); writeFileSync(join(dir, 'server.token'), 'secret-token\n'); expect(resolveServerToken(dir)).toBe('secret-token'); });
  it('trims surrounding whitespace', async () => { const { resolveServerToken } = await import('#/cli/sub/web/shared'); writeFileSync(join(dir, 'server.token'), '  tok  \n'); expect(resolveServerToken(dir)).toBe('tok'); });
  it('throws a clear error when the token file is missing', async () => { const { resolveServerToken } = await import('#/cli/sub/web/shared'); expect(() => resolveServerToken(dir)).toThrow(/unable to read server token/); });
});

describe('authHeaders', () => { it('builds a Bearer Authorization header', async () => { const { authHeaders } = await import('#/cli/sub/web/shared'); expect(authHeaders('abc')).toEqual({ Authorization: 'Bearer abc' }); }); });

describe('buildWebUrl', () => {
  it('carries the legacy token in the URL fragment (not path or query)', async () => {
    const { buildWebUrl } = await import('#/cli/sub/web/run'); const url = buildWebUrl('http://127.0.0.1:58627', 'abc123');
    expect(url).toBe('http://127.0.0.1:58627/#token=abc123'); const parsed = new URL(url); expect(parsed.hash).toBe('#token=abc123'); expect(parsed.pathname).not.toContain('abc123'); expect(parsed.search).not.toContain('abc123');
  });
  it('normalizes a trailing slash', async () => { const { buildWebUrl } = await import('#/cli/sub/web/run'); expect(buildWebUrl('http://127.0.0.1:58627/', 't')).toBe('http://127.0.0.1:58627/#token=t'); });
});

describe('accessUrlLines', () => {
  it('returns Local + Network lines for a wildcard bind', async () => { const { accessUrlLines } = await import('#/cli/sub/web/access-urls'); expect(accessUrlLines('0.0.0.0', 58627, 'tok', [{ address: '192.168.1.5', family: 'IPv4' }])).toEqual([{ label: 'Local:    ', url: 'http://localhost:58627/#token=tok' }, { label: 'Network:  ', url: 'http://192.168.1.5:58627/#token=tok' }]); });
  it('returns a single Local line for a loopback bind', async () => { const { accessUrlLines } = await import('#/cli/sub/web/access-urls'); expect(accessUrlLines('127.0.0.1', 58627, 'tok')).toEqual([{ label: 'Local:    ', url: 'http://127.0.0.1:58627/#token=tok' }]); });
  it('returns a single URL line for a specific host (no token)', async () => { const { accessUrlLines } = await import('#/cli/sub/web/access-urls'); expect(accessUrlLines('192.168.1.5', 58627, undefined)).toEqual([{ label: 'URL:      ', url: 'http://192.168.1.5:58627/' }]); });
  it('splitTokenFragment splits off the #token= fragment', async () => { const { splitTokenFragment } = await import('#/cli/sub/web/access-urls'); expect(splitTokenFragment('http://h:1/#token=abc')).toEqual(['http://h:1/', '#token=abc']); expect(splitTokenFragment('http://h:1/')).toEqual(['http://h:1/', '']); });
});

describe('browserOpenOrigin', () => {
  it('rewrites wildcard bind hosts to localhost on the same port', async () => { const { browserOpenOrigin } = await import('#/cli/sub/web/access-urls'); expect(browserOpenOrigin('http://0.0.0.0:58627')).toBe('http://localhost:58627'); expect(browserOpenOrigin('http://:::58627')).toBe('http://localhost:58627'); });
  it('keeps navigable origins unchanged', async () => { const { browserOpenOrigin } = await import('#/cli/sub/web/access-urls'); expect(browserOpenOrigin('http://127.0.0.1:58627')).toBe('http://127.0.0.1:58627'); expect(browserOpenOrigin('http://192.168.1.5:58627')).toBe('http://192.168.1.5:58627'); expect(browserOpenOrigin('http://[::1]:58627')).toBe('http://[::1]:58627'); });
});

describe('`kimi web rotate-token`', () => {
  let dir: string; let prevHome: string | undefined;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kimi-rotate-')); prevHome = process.env['KIKI_HOME']; process.env['KIKI_HOME'] = dir; vi.resetModules(); });
  afterEach(() => { if (prevHome === undefined) delete process.env['KIKI_HOME']; else process.env['KIKI_HOME'] = prevHome; rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  it('writes a new token to server.token and prints it', async () => {
    const { registerWebCommand } = await import('#/cli/sub/web'); const program = new Command('kimi').exitOverride(); registerWebCommand(program); let stdout = '';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true; });
    await program.parseAsync(['node', 'kimi', 'web', 'rotate-token']); writeSpy.mockRestore(); const token = readFileSync(join(dir, 'server.token'), 'utf8').trim();
    expect(token.length).toBeGreaterThan(20); expect(stdout).toContain('New server token'); expect(stdout).toContain(token);
  });
  it('re-prints the access links with the new token when a server is running', async () => {
    const { registerWebCommand } = await import('#/cli/sub/web'); const { mkdirSync, writeFileSync: writeSync } = await import('node:fs');
    mkdirSync(join(dir, 'server', 'instances'), { recursive: true });
    writeSync(join(dir, 'server', 'instances', '01JTEST0000000000000000000.json'), JSON.stringify({ server_id: '01JTEST0000000000000000000', pid: process.pid, host: '127.0.0.1', port: 58627, started_at: Date.now(), heartbeat_at: Date.now() }));
    const program = new Command('kimi').exitOverride(); registerWebCommand(program); let stdout = '';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true; });
    await program.parseAsync(['node', 'kimi', 'web', 'rotate-token']); writeSpy.mockRestore(); const token = readFileSync(join(dir, 'server.token'), 'utf8').trim();
    expect(stdout).toContain('New server token'); expect(stdout).toContain(`http://127.0.0.1:58627/#token=${token}`);
    expect(stdout.indexOf('picks up the new token')).toBeLessThan(stdout.indexOf('New server token')); expect(stdout.indexOf('New server token')).toBeLessThan(stdout.indexOf(`http://127.0.0.1:58627/#token=${token}`));
  });
});

describe('formatHostForUrl', () => { it('bracket-wraps IPv6 and leaves IPv4 as-is', async () => { const { formatHostForUrl } = await import('#/cli/sub/web/networks'); expect(formatHostForUrl('192.168.1.5', 'IPv4')).toBe('192.168.1.5'); expect(formatHostForUrl('fe80::1', 'IPv6')).toBe('[fe80::1]'); }); });

describe('filterDisplayAddresses', () => {
  it('drops IPv6 link-local, de-duplicates, and orders IPv4 before IPv6', async () => {
    const { filterDisplayAddresses } = await import('#/cli/sub/web/networks');
    const out = filterDisplayAddresses([{ address: 'fe80::ecf3:c2ff:fe9c:11c3', family: 'IPv6' }, { address: '192.168.1.5', family: 'IPv4' }, { address: 'fe80::ecf3:c2ff:fe9c:11c3', family: 'IPv6' }, { address: '10.0.0.1', family: 'IPv4' }, { address: 'fe80::1', family: 'IPv6' }, { address: '2001:db8::1', family: 'IPv6' }]);
    expect(out).toEqual([{ address: '192.168.1.5', family: 'IPv4' }, { address: '10.0.0.1', family: 'IPv4' }, { address: '2001:db8::1', family: 'IPv6' }]);
  });
});
