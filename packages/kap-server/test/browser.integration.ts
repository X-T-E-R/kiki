import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { browserControlListSchema, browserStatusSchema, ErrorCode } from '@kiki/protocol';
import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

describe('browser REST persisted configuration and explicit secret access', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  afterEach(async () => {
    await server?.close();
    if (home !== undefined) await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  async function request(method: string, path: string, body?: unknown) {
    const res = await fetch(`http://127.0.0.1:${server!.port}/api${path}`, { method,
      headers: authHeaders(server!, body === undefined ? {} : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body) });
    return await res.json() as { code: number; msg: string; data: unknown };
  }
  it('rejects missing preparation consent and unknown guided actions without installing plugins', async () => {
    const { IPluginService } = await import('@kiki/agent-core-v2');
    const { browserSetupStatusSchema } = await import('@kiki/protocol');
    home = await mkdtemp(join(tmpdir(), 'kiki-browser-guided-rest-'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, env: { ...process.env, KIKI_EXPERIMENTAL_SEARCH_WORKER: 'false' }, logLevel: 'silent' });
    expect(browserSetupStatusSchema.parse((await request('GET', '/browser/setup/codex-browser')).data)).toMatchObject({ state: 'external_only', supported: false, controlSurface: 'external-app' });
    for (const path of ['/browser/setup/kimi-webbridge:prepare', '/browser/setup/unknown:prepare', '/browser/setup/kimi-webbridge:unknown']) {
      expect(await request('POST', path, {})).toMatchObject({ code: ErrorCode.VALIDATION_FAILED, data: null, details: { code: 'browser.invalid' } });
    }
    expect((await request('POST', '/browser/setup/independent-browser:connect', { setDefault: 'true' })).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(await server.core.accessor.get(IPluginService).listPlugins()).toEqual([]);
    expect(browserControlListSchema.parse((await request('GET', '/browser/connections')).data).connections).toEqual([]);
  }, 30_000);
  it.each([undefined, 'false'])('prepares independent control through persisted config while respecting forced env=%s', async (forced) => {
    const { vi } = await import('vitest');
    const { ICapabilityService, IConfigService, IFlagService } = await import('@kiki/agent-core-v2');
    const { browserSetupStatusSchema } = await import('@kiki/protocol');
    home = await mkdtemp(join(tmpdir(), 'kiki-browser-enable-rest-'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, env: { ...process.env, KIKI_EXPERIMENTAL_NATIVE_BROWSER: forced, KIKI_EXPERIMENTAL_SEARCH_WORKER: 'false' }, logLevel: 'silent' });
    const config = server.core.accessor.get(IConfigService);
    await config.set('experimental', { native_browser: false, fixture_other: false });
    const capability = server.core.accessor.get(ICapabilityService);
    let missing = true;
    const get = vi.spyOn(capability, 'getCapability').mockImplementation(async () => ({ id: 'kiki-browser', displayName: 'Fixture', description: 'fixture', supported: true, state: missing ? 'not_installed' : 'ready', steps: [{ id: 'driver', state: missing ? 'missing' : 'ok' }, { id: 'chrome', state: missing ? 'missing' : 'ok' }], install: { running: false } }));
    const install = vi.spyOn(capability, 'installCapability').mockImplementation(async () => { missing = false; return get('kiki-browser'); });
    try {
      expect(server.core.accessor.get(IFlagService).enabled('native_browser')).toBe(false);
      expect((await request('POST', '/browser/setup/independent-browser:prepare', {})).code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(install).not.toHaveBeenCalled();
      expect((await request('POST', '/browser/setup/independent-browser:prepare', { consent: true })).code).toBe(0);
      await vi.waitFor(async () => {
        const status = browserSetupStatusSchema.parse((await request('GET', '/browser/setup/independent-browser')).data);
        expect(status.state).toBe(forced === undefined ? 'ready' : 'needs_user_action');
        if (forced !== undefined) {
          expect(status.reason).toBe('feature_forced_off');
          expect(status.steps.find((step) => step.id === 'feature')?.detail).toContain('KIKI_EXPERIMENTAL_NATIVE_BROWSER');
          expect(status.actions).toEqual([]);
        }
      });
      expect(server.core.accessor.get(IFlagService).enabled('native_browser')).toBe(forced === undefined);
      expect(config.get('experimental')).toEqual({ native_browser: forced === undefined, fixture_other: false });
      expect(await readFile(join(home, 'config.toml'), 'utf8')).toContain(`native_browser = ${forced === undefined}`);
      expect(install).toHaveBeenCalledTimes(forced === undefined ? 1 : 0);
      expect(browserControlListSchema.parse((await request('GET', '/browser/connections')).data).connections).toEqual([]);
      if (forced === undefined) {
        await config.set('experimental', { native_browser: false });
        await request('POST', '/browser/setup/independent-browser:prepare', { consent: true });
        await vi.waitFor(() => expect(server!.core.accessor.get(IFlagService).enabled('native_browser')).toBe(true));
        expect(install).toHaveBeenCalledOnce();
      }
    } finally { get.mockRestore(); install.mockRestore(); }
  }, 30_000);
  it('creates A/B, edits/reveals a secret only explicitly, persists default, deletes and retains honest idle state', async () => {
    home = await mkdtemp(join(tmpdir(), 'kiki-browser-rest-'));
    const start = (nativeBrowser = false) => startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home!, env: { ...process.env, KIKI_EXPERIMENTAL_NATIVE_BROWSER: String(nativeBrowser) }, logLevel: 'silent' });
    server = await start();
    const endpoint = 'wss://cdp.example.test/credential-path?token=fixture-secret';
    expect((await request('PUT', '/browser/connections/a', { type: 'agent-browser-profile', name: 'Same', enabled: true, headed: true })).code).toBe(0);
    expect((await request('PUT', '/browser/connections/b', { type: 'agent-browser-cdp', name: 'Same', enabled: true, endpoint: { action: 'set', value: endpoint } })).code).toBe(0);
    expect((await request('PUT', '/browser/default', { browser: 'b' })).code).toBe(0);
    const listed = await request('GET', '/browser/connections');
    const list = browserControlListSchema.parse(listed.data);
    expect(list.defaultBrowser).toBe('b');
    expect(list.connections[0]?.headed).toBe(true);
    expect(list.connections.map((connection) => connection.status.state)).toEqual(['idle', 'idle']);
    expect(JSON.stringify(list)).not.toContain('fixture-secret');
    expect(list.connections[1]?.endpointDisplay).toBe('wss://cdp.example.test');
    expect((await request('POST', '/secrets:reveal', { ref: { kind: 'browser_endpoint', browser_id: 'b' } })).data).toMatchObject({ value: endpoint });
    expect((await request('PUT', '/browser/connections/b', { type: 'agent-browser-cdp', name: 'Updated', enabled: true, endpoint: { action: 'keep' } })).code).toBe(0);
    expect(await readFile(join(home, 'config.toml'), 'utf8')).not.toContain('fixture-secret');
    await server.close();
    server = await start();
    expect(browserControlListSchema.parse((await request('GET', '/browser/connections')).data).defaultBrowser).toBe('b');
    expect(browserStatusSchema.parse((await request('GET', '/browser/connections/b:status')).data).state).toBe('idle');
    expect(await request('GET', '/browser/connections/missing:status')).toMatchObject({ code: ErrorCode.VALIDATION_FAILED, details: { code: 'browser.not_found' } });
    expect(await request('GET', '/browser/connections/a:tabs')).toMatchObject({ code: ErrorCode.VALIDATION_FAILED, data: null, details: { code: 'browser.disconnected' } });
    expect(await request('POST', '/browser/connections/a:connect', {})).toMatchObject({ code: ErrorCode.VALIDATION_FAILED, details: { code: 'browser.disabled', reason: 'feature_disabled' } });
    expect(await request('GET', '/browser/connections/a:catalog')).toMatchObject({ code: ErrorCode.INTERNAL_ERROR, data: null, details: { code: 'browser.version' } });
    expect((await request('PUT', '/browser/connections/a', { type: 'agent-browser-profile', name: 'Disabled', enabled: false })).code).toBe(0);
    await server.close();
    server = await start(true);
    expect(await request('POST', '/browser/connections/a:connect', {})).toMatchObject({ code: ErrorCode.VALIDATION_FAILED, details: { code: 'browser.disabled', reason: 'connection_disabled' } });
    expect(await request('POST', '/browser/connections/b:unknown', {})).toMatchObject({ code: ErrorCode.VALIDATION_FAILED, details: { code: 'browser.invalid' } });
    expect((await request('DELETE', '/browser/connections/b')).data).toEqual({ removed: true });
    const remaining = browserControlListSchema.parse((await request('GET', '/browser/connections')).data);
    expect(remaining.defaultBrowser).toBeUndefined();
    expect(remaining.connections.map((connection) => connection.id)).toEqual(['a']);
    expect((await request('POST', '/secrets:reveal', { ref: { kind: 'browser_endpoint', browser_id: 'b' } })).code).toBe(ErrorCode.VALIDATION_FAILED);
  }, 30_000);
});


describe.skipIf(process.env['KIKI_BROWSER_TEST_DRIVER'] === undefined || process.env['KIKI_BROWSER_TEST_CHROME'] === undefined)('real isolated Chromium browser control, localhost pages only', () => {
  it('runs managed form/ref/screenshot and preserves an explicitly owned borrowed CDP browser after disconnect', async () => {
    const { createServer } = await import('node:http');
    const { spawn } = await import('node:child_process');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { vi } = await import('vitest');
    const { IBrowserControlService } = await import('@kiki/agent-core-v2');
    const { browserTabsResponseSchema, browserCatalogResponseSchema } = await import('@kiki/protocol');
    const tmp = fileURLToPath(new URL('../../../.tmp/', import.meta.url));
    await mkdir(tmp, { recursive: true });
    const root = await mkdtemp(join(tmp, 'browser-chromium-'));
    const home = join(root, 'home');
    const borrowedProfile = join(root, 'borrowed-profile');
    const page = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><title>Local browser proof</title><h1>Local form</h1><label>Name <input id="name" aria-label="Name"></label><button onclick="document.querySelector(\'#result\').textContent=\'Hello \'+document.querySelector(\'#name\').value">Save</button><p id="result" role="status">Not saved</p>');
    });
    await new Promise<void>((done, fail) => { page.once('error', fail); page.listen(0, '127.0.0.1', done); });
    const pageAddress = page.address();
    if (pageAddress === null || typeof pageAddress === 'string') throw new Error('No local fixture address');
    const url = `http://127.0.0.1:${pageAddress.port}`;
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home,
      env: { ...process.env, KIKI_EXPERIMENTAL_NATIVE_BROWSER: 'true', KIKI_EXPERIMENTAL_SEARCH_WORKER: 'false' }, logLevel: 'silent' });
    const control = server.core.accessor.get(IBrowserControlService);
    const caller = { sessionId: 'isolated-proof', agentId: 'main' };
    let borrowed: ReturnType<typeof spawn> | undefined;
    let borrowedEndpoint: string | undefined;
    async function api(path: string, body?: unknown) {
      console.log('Chromium proof API', path);
      const result = await fetch(`http://127.0.0.1:${server.port}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: authHeaders(server, { 'content-type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      const data = await result.json() as { code: number; data: unknown; details?: unknown };
      console.log('Chromium proof API result', path, data.code);
      return data;
    }
    async function invoke(browser: string, tab: string, tool: string, args: Record<string, unknown>) {
      console.log('Chromium proof invoke', browser, tool);
      const result = await control.invoke({ browser, tab, tool, args, caller });
      console.log('Chromium proof invoke returned', browser, tool);
      const response = (result.result.structuredContent as { response?: { success?: boolean; data?: Record<string, unknown>; error?: string } })?.response;
      expect(response?.success, JSON.stringify(response)).toBe(true);
      return response?.data ?? {};
    }
    async function closeOwnedBrowser(endpoint: string) {
      const version = await (await fetch(`${endpoint}/json/version`)).json() as { webSocketDebuggerUrl: string };
      const socket = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise<void>((done, fail) => { socket.addEventListener('open', () => done(), { once: true }); socket.addEventListener('error', () => fail(new Error('Owned browser close socket failed')), { once: true }); });
      socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      await new Promise<void>((done) => { socket.addEventListener('close', () => done(), { once: true }); });
    }
    try {
      await control.upsert('managed', { type: 'agent-browser-profile', name: 'Managed', enabled: true, executablePath: process.env['KIKI_BROWSER_TEST_CHROME'], profilePath: join(root, 'managed-profile') });
      expect((await control.list()).connections[0]?.status.state).toBe('idle');
      expect((await control.check('managed')).failure?.code).toBe('browser.version');
      const { installBrowserDriver, BROWSER_DRIVER_FILES } = await import('@kiki/agent-core-v2/app/capability/entries/browserResourceStore');
      const source: typeof fetch = async (input) => {
        const name = Object.entries(BROWSER_DRIVER_FILES).find(([, artifact]) => artifact.url === String(input))?.[0];
        if (name === undefined) throw new Error('Unexpected fixture resource');
        const bytes = await readFile(name === 'agent-browser.exe' ? process.env['KIKI_BROWSER_TEST_DRIVER']! : fileURLToPath(new URL(`../../agent-core-v2/src/app/browser/donor/${name}`, import.meta.url)));
        return new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length) } });
      };
      await installBrowserDriver(home, () => {}, source);
      expect(await control.check('managed')).toMatchObject({ state: 'idle', driverVersion: '0.38.2', error: undefined });
      const catalog = browserCatalogResponseSchema.parse((await api('/browser/connections/managed:catalog')).data);
      expect(catalog.status.state).toBe('idle');
      expect(catalog.backendToolCount).toBe(156);
      expect(catalog.capabilities.every((tool) => tool.inputSchema === undefined)).toBe(true);
      expect(browserCatalogResponseSchema.parse((await api('/browser/connections/managed:catalog?includeSchema=true')).data).capabilities.find((tool) => tool.name === 'agent_browser_fill')?.inputSchema).toMatchObject({ required: expect.arrayContaining(['selector', 'text']) });
      expect(await api('/browser/connections/managed:tabs')).toMatchObject({ code: ErrorCode.VALIDATION_FAILED, details: { code: 'browser.disconnected' } });
      console.log('Chromium proof managed connect');
      const { browserSetupStatusSchema } = await import('@kiki/protocol');
      const guided = browserSetupStatusSchema.parse((await api('/browser/setup/independent-browser:connect', { connectionId: 'managed' })).data);
      expect(guided.state).toBe('connected');
      const connected = guided.connection!;
      console.log('Chromium proof managed connected', JSON.stringify(connected));
      expect(connected.state).toBe('ready');
      const tabs = browserTabsResponseSchema.parse((await api('/browser/connections/managed:tabs')).data);
      const tab = tabs.tabs[0]!.targetId;
      await invoke('managed', tab, 'agent_browser_open', { url });
      const snapshot = await invoke('managed', tab, 'agent_browser_snapshot', {});
      const refs = snapshot['refs'] as Record<string, { name?: string; role?: string }>;
      expect(Object.values(refs).some((ref) => ref.name === 'Name')).toBe(true);
      const input = Object.entries(refs).find(([, ref]) => ref.name === 'Name')![0];
      await invoke('managed', tab, 'agent_browser_fill', { selector: `@${input}`, text: 'Fixture' });
      const refreshed = await invoke('managed', tab, 'agent_browser_snapshot', {});
      const save = Object.entries(refreshed['refs'] as Record<string, { name?: string }>).find(([, ref]) => ref.name === 'Save')![0];
      await invoke('managed', tab, 'agent_browser_click', { selector: `@${save}` });
      const result = await invoke('managed', tab, 'agent_browser_eval', { script: 'document.querySelector("#result").textContent' });
      expect(JSON.stringify(result)).toContain('Hello Fixture');
      const screenshot = resolve(root, 'managed-form.png');
      const artifact = await invoke('managed', tab, 'agent_browser_screenshot', { path: screenshot });
      expect(artifact['path']).toBe(screenshot);
      expect((await readFile(screenshot)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect((await control.disconnect('managed')).state).toBe('disconnected');
      borrowed = spawn(process.env['KIKI_BROWSER_TEST_CHROME']!, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${borrowedProfile}`, '--no-proxy-server', '--no-first-run', '--disable-background-networking', '--disable-sync', '--disable-component-update', 'about:blank'], { stdio: 'ignore', windowsHide: true });
      borrowed.on('error', () => undefined);
      await vi.waitFor(async () => {
        expect(borrowed!.exitCode).toBeNull();
        const port = (await readFile(join(borrowedProfile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]!;
        borrowedEndpoint = `http://127.0.0.1:${Number(port)}`;
        expect((await fetch(`${borrowedEndpoint}/json/version`)).ok).toBe(true);
      }, { timeout: 20_000, interval: 100 });
      await control.upsert('borrowed', { type: 'agent-browser-cdp', name: 'Borrowed', enabled: true, endpoint: { action: 'set', value: borrowedEndpoint! } });
      expect((await control.connect('borrowed')).state).toBe('ready');
      const borrowedTab = (await control.tabs('borrowed'))[0]!.targetId;
      await invoke('borrowed', borrowedTab, 'agent_browser_open', { url });
      expect(JSON.stringify(await invoke('borrowed', borrowedTab, 'agent_browser_snapshot', {}))).toContain('Name');
      expect((await control.disconnect('borrowed')).state).toBe('disconnected');
      expect(borrowed.exitCode).toBeNull();
      expect((await fetch(`${borrowedEndpoint}/json/version`)).ok).toBe(true);
      await closeOwnedBrowser(borrowedEndpoint!);
      await vi.waitFor(() => { expect(borrowed!.exitCode).toBe(0); }, { timeout: 10_000, interval: 100 });
      await writeFile(join(root, 'evidence.json'), JSON.stringify({ managed: 'form/ref/screenshot/disconnected', borrowed: 'CDP disconnected; browser remained alive; owner closed normally', screenshot, catalogTools: catalog.backendToolCount }, null, 2));
      console.log('Real isolated Chromium evidence', root);
    } finally {
      for (const id of ['managed', 'borrowed']) { try { await control.disconnect(id); } catch {} }
      if (borrowed !== undefined && borrowed.exitCode === null) {
        if (borrowedEndpoint !== undefined) { try { await closeOwnedBrowser(borrowedEndpoint); } catch {} }
        if (borrowed.exitCode === null) borrowed.kill();
        await vi.waitFor(() => { expect(borrowed!.exitCode).not.toBeNull(); }, { timeout: 10_000, interval: 100 });
      }
      await server.close();
      await new Promise<void>((done) => { page.close(() => done()); });
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(borrowedProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(join(root, 'managed-profile'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 120_000);
});


describe.skipIf(process.env['KIKI_WEBBRIDGE_SETUP_PROOF'] !== 'true')('guided Kimi setup with the existing browser extension', () => {
  it('installs the official skill in an isolated home, detects and connects, then controls only its own localhost tab group', async () => {
    const { createServer } = await import('node:http');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { vi } = await import('vitest');
    const { browserSetupStatusSchema } = await import('@kiki/protocol');
    const { IPluginService } = await import('@kiki/agent-core-v2');
    const root = await mkdtemp(join(fileURLToPath(new URL('../../../.tmp/', import.meta.url)), 'browser-guided-live-'));
    const home = join(root, 'home');
    await mkdir(home);
    const page = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><title>Kiki guided setup proof</title><h1>Browser connection proof</h1><label>Name <input id="name" aria-label="Name"></label><button onclick="document.querySelector(\'#result\').textContent=\'Hello \'+document.querySelector(\'#name\').value">Save</button><p id="result" role="status">Not saved</p>');
    });
    await new Promise<void>((done) => page.listen(0, '127.0.0.1', done));
    const address = page.address();
    if (address === null || typeof address === 'string') throw new Error('Missing proof page port');
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent', env: { ...process.env, KIKI_EXPERIMENTAL_SEARCH_WORKER: 'false' } });
    const receipts: unknown[] = [];
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api${path}`, { method, headers: authHeaders(server, { 'content-type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body) });
      const envelope = await response.json() as { code: number; msg: string; data: unknown };
      receipts.push({ method, path, envelope });
      expect(envelope.code, envelope.msg).toBe(0);
      return browserSetupStatusSchema.parse(envelope.data);
    };
    const command = async (action: string, args: unknown) => {
      const response = await fetch('http://127.0.0.1:10086/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, args, session: 'kiki-guided-setup-20261006-proof' }), signal: AbortSignal.timeout(20_000) });
      const envelope = await response.json() as { ok: boolean; data: Record<string, unknown> };
      expect(envelope.ok).toBe(true);
      receipts.push({ action, data: envelope.data });
      return envelope.data;
    };
    try {
      const before = await request('GET', '/browser/setup/kimi-webbridge');
      expect(before.state).not.toBe('connected');
      await request('POST', '/browser/setup/kimi-webbridge:prepare', { consent: true });
      await vi.waitFor(async () => {
        const status = await request('GET', '/browser/setup/kimi-webbridge');
        if (status.state === 'failed') throw new Error(status.error);
        expect(status.state).toBe('ready');
      }, { timeout: 90_000, interval: 500 });
      const connected = await request('POST', '/browser/setup/kimi-webbridge:connect', {});
      expect(connected.state).toBe('connected');
      const plugin = (await server.core.accessor.get(IPluginService).listPlugins()).find((item) => item.id === 'kimi-webbridge');
      expect(plugin).toMatchObject({ enabled: true, state: 'ok' });
      expect((await server.core.accessor.get(IPluginService).pluginSkillRoots()).some((skill) => skill.path.includes('kimi-webbridge'))).toBe(true);
      expect(await command('navigate', { url: `http://127.0.0.1:${address.port}`, newTab: true, group_title: '浏览器引导验证' })).toMatchObject({ success: true });
      expect(await command('snapshot', {})).toMatchObject({ title: 'Kiki guided setup proof' });
      expect(await command('fill', { selector: '#name', value: 'Fixture' })).toMatchObject({ success: true });
      expect(await command('click', { selector: 'button' })).toMatchObject({ success: true });
      expect(await command('evaluate', { code: "document.querySelector('#result').textContent" })).toMatchObject({ value: 'Hello Fixture' });
      expect(await command('screenshot', { path: join(root, 'webbridge-form.png') })).toMatchObject({ path: join(root, 'webbridge-form.png') });
      await writeFile(join(root, 'evidence.json'), JSON.stringify({ home, plugin: { id: plugin!.id, version: plugin!.version, enabled: plugin!.enabled }, receipts }, null, 2));
      console.log('Guided browser live evidence', root);
    } finally {
      await server.close();
      await new Promise<void>((done) => page.close(() => done()));
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 120_000);
});
