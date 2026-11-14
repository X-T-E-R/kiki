import { once, type EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPluginHostService, IPluginService, IPluginUsageService, ISessionManager, IWorkspaceService } from '@kiki/agent-core-v2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket, { type RawData } from 'ws';
import { startServer, type RunningServer } from '../src/start';
import { WS_BEARER_PROTOCOL_PREFIX } from '../src/transport/ws/bearerProtocol';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

class Frames {
  readonly messages: Array<{ data: RawData; binary: boolean }> = [];
  private ended?: string;
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data, binary) => this.messages.push({ data, binary }));
    ws.on('close', (code, reason) => { this.ended = `${code} ${reason.toString()}`; });
  }
  async next(): Promise<{ data: RawData; binary: boolean }> {
    await vi.waitUntil(() => {
      if (this.messages.length > 0) return true;
      if (this.ended !== undefined) throw new Error(`Stream closed: ${this.ended}`);
      return false;
    });
    return this.messages.shift()!;
  }
  async json(): Promise<unknown> {
    const frame = await this.next();
    if (frame.binary) throw new Error('Expected a text frame');
    return JSON.parse(frame.data.toString());
  }
}

describe('plugin panel binary WebSocket', () => {
  let server: RunningServer;
  let home: string;
  let workspaceId: string;
  let sessionId: string;
  const sockets = new Set<WebSocket>();
  const url = (panel = 'screen') => `ws://127.0.0.1:${server.port}/api/plugins/stream-fixture/panels/${panel}/stream`;
  const connect = async (panel = 'screen', token?: string) => {
    const ws = new WebSocket(url(panel), `${WS_BEARER_PROTOCOL_PREFIX}${token ?? server.localOwnerToken}`);
    sockets.add(ws);
    ws.once('close', () => sockets.delete(ws));
    const frames = new Frames(ws);
    await once(ws, 'open');
    return frames;
  };
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'plugin-panel-ws-'));
    await writeFile(join(home, 'config.toml'), '[search]\nenabled = false\n');
    const source = join(home, 'source');
    await mkdir(source);
    await cp(join(import.meta.dirname, '../../agent-core-v2/test/fixtures/plugin-host/panel-stream.mjs'), join(source, 'entry.mjs'));
    await writeFile(join(source, 'panel.html'), '<!doctype html><title>Stream fixture</title>');
    await writeFile(join(source, 'kimi.plugin.json'), JSON.stringify({ name: 'stream-fixture', version: '1.0.0', 'x-kiki': {
      engines: { kiki: '^0.4.0' }, entry: './entry.mjs', permissions: { uiPanel: true },
      panels: ['screen', 'settings'].map((id) => ({ schemaVersion: 1, id, slot: id === 'settings' ? 'settings' : 'workspace', label: id, path: './panel.html' })),
    } }));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, homeDir: home, host: '127.0.0.1', port: 0, logLevel: 'silent' });
    const plugins = server.core.accessor.get(IPluginService);
    const plan = await plugins.previewPlugin({ source });
    await plugins.installPlugin({ source, fingerprint: plan.fingerprint, consent: true, defaultEnabled: true });
    const workspace = await server.core.accessor.get(IWorkspaceService).createOrTouch(home);
    workspaceId = workspace.id;
    const session = await server.core.accessor.get(ISessionManager).create({ workDir: home });
    sessionId = session.id;
  });
  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    await server?.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('rejects missing or invalid authentication before upgrading', async () => {
    await expect(connect('screen', 'invalid')).rejects.toThrow('401');
    const ws = new WebSocket(url());
    sockets.add(ws);
    await expect(once(ws, 'open')).rejects.toThrow('403');
  });

  it('checks plugin usage, session existence, settings isolation and stream names', async () => {
    const usage = server.core.accessor.get(IPluginUsageService);
    const allowed = vi.spyOn(usage, 'allows').mockResolvedValueOnce(false);
    const denied = await connect();
    const deniedClose = once(denied.ws, 'close');
    denied.ws.send(JSON.stringify({ type: 'open', stream: 'video', workspace_id: workspaceId }));
    expect(await denied.json()).toEqual({ type: 'ready', ok: false, error: 'Panel is not enabled in this workspace' });
    expect((await deniedClose)[0]).toBe(1008);
    expect(allowed).toHaveBeenCalledWith(workspaceId, 'stream-fixture', undefined);
    allowed.mockRestore();
    for (const [panel, input, error] of [
      ['screen', { session_id: 'missing-session' }, 'Session not found'],
      ['settings', { session_id: sessionId }, 'Settings panels cannot access a session'],
      ['missing', {}, 'Panel is not enabled'],
    ] as const) {
      const frames = await connect(panel);
      const ended = once(frames.ws, 'close');
      frames.ws.send(JSON.stringify({ type: 'open', stream: 'video', ...input }));
      expect(await frames.json()).toEqual({ type: 'ready', ok: false, error });
      expect((await ended)[0]).toBe(1008);
    }
    const invalid = await connect();
    const ended = once(invalid.ws, 'close');
    invalid.ws.send(JSON.stringify({ type: 'open', stream: '../video' }));
    expect(await invalid.json()).toMatchObject({ type: 'ready', ok: false });
    expect((await ended)[0]).toBe(1008);
  });

  it('cannot substitute an enabled workspace for the named session workspace', async () => {
    const usage = server.core.accessor.get(IPluginUsageService);
    const alternateRoot = join(home, 'alternate');
    await mkdir(alternateRoot);
    const alternate = await server.core.accessor.get(IWorkspaceService).createOrTouch(alternateRoot);
    await usage.set({ workspaceId, pluginId: 'stream-fixture', override: 'off' });
    await usage.set({ workspaceId: alternate.id, pluginId: 'stream-fixture', override: 'on' });
    try {
      for (const [workspace_id, error] of [[alternate.id, 'Session workspace does not match'], [workspaceId, 'Panel is not enabled in this workspace']] as const) {
        const frames = await connect();
        const ended = once(frames.ws, 'close');
        frames.ws.send(JSON.stringify({ type: 'open', stream: 'video', session_id: sessionId, workspace_id }));
        expect(await frames.json()).toEqual({ type: 'ready', ok: false, error });
        expect((await ended)[0]).toBe(1008);
      }
    } finally {
      await usage.set({ workspaceId, pluginId: 'stream-fixture', override: 'inherit' });
    }
  });

  it('passes result/context and streams raw binary/text in both directions, then aborts on client close', async () => {
    const frames = await connect();
    const closedPath = join(home, 'client-closed.json');
    frames.ws.send(JSON.stringify({ type: 'open', stream: 'video', args: { closedPath }, session_id: sessionId, workspace_id: workspaceId }));
    expect(await frames.json()).toEqual({ type: 'ready', ok: true, result: { protocol: 'h264-scrcpy-v1', width: 1080, height: 1920, panelId: 'screen', sessionId, workspaceId } });
    const initial = await frames.next();
    expect(initial.binary).toBe(true);
    expect(initial.data).toEqual(Buffer.from([0, 255, 2, 3]));
    expect(await frames.json()).toEqual({ hello: 'video' });
    const payload = Buffer.alloc(512 * 1024, 0x9a);
    frames.ws.send(payload, { binary: true });
    frames.ws.send('touch 世界', { binary: false });
    const echoed = await frames.next();
    expect(echoed.binary).toBe(true);
    expect(echoed.data).toEqual(payload);
    expect((await frames.next()).data.toString()).toBe('touch 世界');
    const ended = once(frames.ws, 'close');
    frames.ws.close();
    await ended;
    await vi.waitFor(async () => expect(JSON.parse(await readFile(closedPath, 'utf8'))).toMatchObject({ aborted: true }));
  });

  it('admits approved peer grants and closes their stream on revocation', async () => {
    const { code } = await server.admission.createPairCode({ allowBridge: false });
    const peer = await server.admission.claimPair(code, { homeId: '11111111-1111-4111-8111-111111111111', hostId: 'example-peer', protocol: 1 }, 'Example peer', false);
    const frames = await connect('screen', peer.peerToken);
    frames.ws.send(JSON.stringify({ type: 'open', stream: 'video' }));
    expect(await frames.json()).toMatchObject({ type: 'ready', ok: true });
    const ended = once(frames.ws, 'close');
    await server.admission.revoke(peer.grantId);
    await ended;
    expect(frames.ws.readyState).toBe(WebSocket.CLOSED);
    await expect(connect('screen', peer.peerToken)).rejects.toThrow('401');
  });

  it('admits browser cookies and closes the stream when the browser logs out', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const owner = async (path: string, method: string, body: unknown) => {
      const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${server.localOwnerToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return (await response.json() as { code: number; data: { url: string } }).data;
    };
    await owner('/api/web-access', 'PUT', { mode: 'temporary' });
    const link = await owner('/api/web-access/links', 'POST', {});
    const browser = new URL(link.url);
    const exchange = await fetch(browser.origin + '/api/web-access/exchange', { method: 'POST', headers: { origin: browser.origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: browser.hash.slice('#access='.length) }) });
    expect(exchange.status).toBe(200);
    const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!;
    const ws = new WebSocket(`${browser.origin.replace(/^http/, 'ws')}/api/plugins/stream-fixture/panels/settings/stream`, { headers: { cookie, origin: browser.origin } });
    sockets.add(ws);
    const frames = new Frames(ws);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'open', stream: 'video' }));
    expect(await frames.json()).toMatchObject({ type: 'ready', ok: true });
    const ended = once(ws, 'close');
    const logout = await fetch(browser.origin + '/api/web-access/logout', { method: 'POST', headers: { cookie, origin: browser.origin } });
    expect(logout.status).toBe(200);
    await ended;
  });

  it('aborts slow backend startup when the opening WebSocket disconnects', async () => {
    const args = { startedPath: join(home, 'opening-started'), abortedPath: join(home, 'opening-aborted'), completedPath: join(home, 'opening-completed') };
    const frames = await connect();
    frames.ws.send(JSON.stringify({ type: 'open', stream: 'slow', args }));
    await vi.waitFor(async () => expect(await readFile(args.startedPath, 'utf8')).toBe('started'));
    const ended = once(frames.ws, 'close');
    frames.ws.close();
    await ended;
    await vi.waitFor(async () => expect(await readFile(args.abortedPath, 'utf8')).toBe('aborted'), { timeout: 1000, interval: 10 });
    await expect(readFile(args.completedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('invalidates backend access immediately when a client withholds the credential-rotation close acknowledgement', async () => {
    const args = { abortedPath: join(home, 'rotation-aborted'), inputPath: join(home, 'rotation-input') };
    const frames = await connect();
    frames.ws.send(JSON.stringify({ type: 'open', stream: 'video', args }));
    expect(await frames.json()).toMatchObject({ type: 'ready', ok: true });
    await frames.next(); await frames.next();
    frames.ws.send('accepted');
    expect((await frames.next()).data.toString()).toBe('accepted');
    const receiver = (frames.ws as unknown as { _receiver: EventEmitter })._receiver;
    receiver.removeAllListeners('conclude');
    const closeSent = once(receiver, 'conclude');
    await writeFile(join(home, 'server.token'), 'B'.repeat(43));
    const [code, reason] = await closeSent;
    expect(code).toBe(4001);
    expect(reason.toString()).toBe('server authentication changed');
    expect(frames.ws.readyState).toBe(WebSocket.OPEN);
    frames.ws.send('late-text');
    frames.ws.send(Buffer.from([1, 2, 3]));
    await vi.waitFor(async () => expect(await readFile(args.abortedPath, 'utf8')).toBe('aborted'), { timeout: 1000, interval: 10 });
    await delay(100);
    expect(await readFile(args.inputPath, 'utf8')).toBe('accepted\n');
    frames.ws.terminate();
  });

  it('propagates plugin errors and close reasons and tears down active streams when hosts stop', async () => {
    const failed = await connect();
    const failedClose = once(failed.ws, 'close');
    failed.ws.send(JSON.stringify({ type: 'open', stream: 'fail' }));
    expect(await failed.json()).toMatchObject({ type: 'ready', ok: false, error: expect.stringContaining('Stream fixture failure') });
    expect((await failedClose)[0]).toBe(1011);
    const closing = await connect('settings');
    closing.ws.send(JSON.stringify({ type: 'open', stream: 'handlers' }));
    expect(await closing.json()).toEqual({ type: 'ready', ok: true, result: { protocol: 'h264-scrcpy-v1' } });
    await closing.next(); await closing.next();
    const pluginClosed = once(closing.ws, 'close');
    closing.ws.send('close');
    const [code, reason] = await pluginClosed;
    expect(code).toBe(1000); expect(reason.toString()).toBe('Plugin finished');
    const stopped = await connect();
    stopped.ws.send(JSON.stringify({ type: 'open', stream: 'video' }));
    expect(await stopped.json()).toMatchObject({ type: 'ready', ok: true });
    const stoppedClose = once(stopped.ws, 'close');
    await server.core.accessor.get(IPluginHostService).stopAll();
    expect((await stoppedClose)[0]).toBe(1000);
  });
});
