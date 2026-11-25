import { createServer, type Socket } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { PluginHost } from '#/app/plugin/host';
import { PanelStream } from '#/app/plugin/panelStream';

const entry = fileURLToPath(new URL('../../fixtures/plugin-host/panel-stream.mjs', import.meta.url));

it('streams immediate frames, metadata, binary views, text and close through a real runner without an idle timer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'panel-stream-'));
  const closedPath = join(root, 'closed.json');
  const host = new PluginHost('stream-fixture', entry, []);
  try {
    const stream = await host.openPanelStream('screen', 'video', { closedPath }, {}, { sessionId: 'session-fixture', workspaceId: 'workspace-fixture' });
    const binary: Buffer[] = [];
    const text: string[] = [];
    const closed = vi.fn();
    stream.onBinary((chunk) => binary.push(chunk));
    stream.onText((chunk) => text.push(chunk));
    stream.onClose(closed);
    expect(stream.result).toEqual({ protocol: 'h264-scrcpy-v1', width: 1080, height: 1920, panelId: 'screen', sessionId: 'session-fixture', workspaceId: 'workspace-fixture' });
    await vi.waitFor(() => { expect(binary).toEqual([Buffer.from([0, 255, 2, 3])]); expect(text).toEqual(['{"hello":"video"}']); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await vi.advanceTimersByTimeAsync(90_001);
    expect(host.running).toBe(true);
    vi.useRealTimers();
    const input = Buffer.alloc(512 * 1024, 0xa5);
    input[0] = 0; input[input.length - 1] = 255;
    stream.sendBinary(input.subarray(1, input.length - 1));
    stream.sendText('touch 世界');
    await vi.waitFor(() => { expect(binary[1]).toEqual(input.subarray(1, input.length - 1)); expect(text[1]).toBe('touch 世界'); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stream.sendText('close');
    await vi.waitFor(() => expect(closed).toHaveBeenCalledExactlyOnceWith('Plugin finished'));
    expect(JSON.parse(await readFile(closedPath, 'utf8'))).toEqual({ reason: 'Plugin finished', aborted: true });
    stream.close();
    await vi.advanceTimersByTimeAsync(90_001);
    expect(host.running).toBe(false);
  } finally {
    vi.useRealTimers();
    await host.stopAndWait();
    await rm(root, { recursive: true, force: true });
  }
});

it('accepts returned handlers and tears down every stream on stopAndWait', async () => {
  const host = new PluginHost('stream-fixture', entry, []);
  try {
    const streams = await Promise.all(['handlers', 'video'].map((name) => host.openPanelStream('screen', name, {}, {}, {})));
    const closed = streams.map(() => vi.fn());
    streams.forEach((stream, index) => stream.onClose(closed[index]!));
    expect(streams[0]!.result).toEqual({ protocol: 'h264-scrcpy-v1' });
    const echoed = new Promise<Buffer>((resolve) => streams[0]!.onBinary((chunk) => { if (chunk[0] === 42) resolve(chunk); }));
    streams[0]!.sendBinary(new Uint8Array([42, 7]).buffer);
    expect(await echoed).toEqual(Buffer.from([42, 7]));
    await host.stopAndWait();
    expect(host.running).toBe(false);
    for (const listener of closed) expect(listener).toHaveBeenCalledOnce();
    expect(streams[0]!.sendText('late')).toBe(false);
  } finally { await host.stopAndWait(); }
});

it('supports registered and default-exported stream backends and propagates open errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'panel-stream-register-'));
  try {
    for (const source of [
      'export default { openPanelStream() { return { protocol: "default" }; } };',
      'export function register(api) { api.registerPanelStream(() => ({ protocol: "registered" })); }',
    ]) {
      const file = join(root, `entry-${source.includes('register') ? 'registered' : 'default'}.mjs`);
      await writeFile(file, source);
      const host = new PluginHost('stream-fixture', file, []);
      try {
        const stream = await host.openPanelStream('screen', 'video', {}, {}, {});
        expect(stream.result).toEqual({ protocol: source.includes('register') ? 'registered' : 'default' });
        stream.close();
      } finally { await host.stopAndWait(); }
    }
    const host = new PluginHost('stream-fixture', entry, []);
    try {
      await expect(host.openPanelStream('screen', 'invalid/name', {}, {}, {})).rejects.toThrow('Invalid panel stream name');
      await expect(host.openPanelStream('screen', 'fail', {}, {}, {})).rejects.toThrow('Stream fixture failure');
    } finally { await host.stopAndWait(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('accepts an exact 16 MiB payload and closes on an oversized frame', async () => {
  const host = new PluginHost('stream-fixture', entry, []);
  try {
    const stream = await host.openPanelStream('screen', 'video', {}, {}, {});
    const max = Buffer.alloc(16 * 1024 * 1024, 0xa5);
    const received = new Promise<Buffer>((resolve) => stream.onBinary((chunk) => { if (chunk.length === max.length) resolve(chunk); }));
    stream.sendBinary(max);
    expect((await received).equals(max)).toBe(true);
    const closed = vi.fn();
    stream.onClose(closed);
    expect(stream.sendBinary(Buffer.alloc(max.length + 1))).toBe(false);
    expect(closed).toHaveBeenCalledExactlyOnceWith('Plugin stream buffer limit exceeded');
  } finally { await host.stopAndWait(); }
});

it('closes active streams when the plugin child exits', async () => {
  const host = new PluginHost('stream-fixture', entry, []);
  try {
    const stream = await host.openPanelStream('screen', 'video', {}, {}, {});
    const closed = vi.fn();
    stream.onClose(closed);
    stream.sendText('exit');
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(host.running).toBe(false));
    expect(stream.sendText('late')).toBe(false);
  } finally { await host.stopAndWait(); }
});

it('cancels pending stream startup without waiting for the plugin open result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'panel-stream-cancel-'));
  const host = new PluginHost('stream-fixture', entry, []);
  try {
    const cancelled = new AbortController();
    cancelled.abort(new Error('Startup cancelled'));
    await expect(host.openPanelStream('screen', 'slow', {}, {}, { signal: cancelled.signal })).rejects.toThrow('Startup cancelled');
    expect(host.running).toBe(false);
    const args = { startedPath: join(root, 'started'), abortedPath: join(root, 'aborted'), completedPath: join(root, 'completed') };
    const controller = new AbortController();
    const opening = host.openPanelStream('screen', 'slow', args, {}, { signal: controller.signal });
    const rejected = expect(opening).rejects.toThrow('Startup cancelled');
    await vi.waitFor(async () => expect(await readFile(args.startedPath, 'utf8')).toBe('started'));
    controller.abort(new Error('Startup cancelled'));
    await rejected;
    await vi.waitFor(async () => expect(await readFile(args.abortedPath, 'utf8')).toBe('aborted'), { timeout: 1000, interval: 10 });
    await expect(readFile(args.completedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const recovered = await host.openPanelStream('screen', 'video', {}, {}, {});
    expect(recovered.result).toMatchObject({ protocol: 'h264-scrcpy-v1' });
    recovered.close();
  } finally {
    await host.stopAndWait();
    await rm(root, { recursive: true, force: true });
  }
});

it('buffers initial binary and text frames sent before listeners attach and enforces the pre-listener buffer limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'panel-stream-prelistener-'));
  const file = join(root, 'prelistener-entry.mjs');
  await writeFile(
    file,
    [
      'export async function openPanelStream(name, _args, session) {',
      '  if (name === "overflow") {',
      '    session.onText(() => session.sendBinary(Buffer.alloc(9 * 1024 * 1024, 0x11)));',
      '    return { protocol: "overflow" };',
      '  }',
      '  session.sendBinary(new Uint8Array([0, 0, 0, 1, 0x67, 0x42]));',
      '  session.sendBinary(new Uint8Array([0, 0, 0, 1, 0x68, 0xce]));',
      '  session.sendBinary(new Uint8Array([0, 0, 0, 1, 0x65, 0x88]));',
      '  session.sendText({ seq: 1, kind: "codec" });',
      '  session.sendText({ seq: 2, kind: "rotation" });',
      '  session.onText((text) => session.sendText(`echo:${text}`));',
      '  return { protocol: "h264-scrcpy-v1", keyframeBuffered: true };',
      '}',
      '',
    ].join('\n'),
  );
  const host = new PluginHost('stream-prelistener', file, []);
  try {
    const stream = await host.openPanelStream('screen', 'keyframe', {}, {}, {});
    expect(stream.result).toEqual({ protocol: 'h264-scrcpy-v1', keyframeBuffered: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const binary: Buffer[] = [];
    const text: string[] = [];
    stream.onBinary((chunk) => binary.push(Buffer.from(chunk)));
    stream.onText((chunk) => text.push(chunk));

    expect(binary).toEqual([
      Buffer.from([0, 0, 0, 1, 0x67, 0x42]),
      Buffer.from([0, 0, 0, 1, 0x68, 0xce]),
      Buffer.from([0, 0, 0, 1, 0x65, 0x88]),
    ]);
    expect(text).toEqual([
      '{"seq":1,"kind":"codec"}',
      '{"seq":2,"kind":"rotation"}',
    ]);

    stream.sendText('live');
    await vi.waitFor(() => expect(text[2]).toBe('echo:live'));
    stream.close();

    const closingStream = await host.openPanelStream('screen', 'keyframe', {}, {}, {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const deliveredBeforeClose: Buffer[] = [];
    closingStream.onBinary((chunk) => {
      deliveredBeforeClose.push(Buffer.from(chunk));
      closingStream.close('stop-mid-flush');
    });
    expect(deliveredBeforeClose).toEqual([Buffer.from([0, 0, 0, 1, 0x67, 0x42])]);

    const overflow = await host.openPanelStream('screen', 'overflow', {}, {}, {});
    const overflowClosed = vi.fn();
    overflow.onClose(overflowClosed);
    overflow.sendText('push-1');
    await new Promise((resolve) => setTimeout(resolve, 30));
    overflow.sendText('push-2');
    await vi.waitFor(() => expect(overflowClosed).toHaveBeenCalledExactlyOnceWith('Plugin stream buffer limit exceeded'));
  } finally {
    await host.stopAndWait();
    await rm(root, { recursive: true, force: true });
  }
});

it('absorbs synchronous broken-pipe socket.write throws in PanelStream.sendText and sendTextAsync and tears down cleanly', async () => {
  const accepted = new Set<Socket>();
  const server = createServer((socket) => {
    accepted.add(socket);
    socket.on('error', () => {});
    socket.resume();
    socket.once('close', () => accepted.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP port');
  try {
    for (const code of ['EPIPE', 'ECONNRESET', 'EOF', 'ERR_STREAM_DESTROYED'] as const) {
      const onEnd = vi.fn();
      const closed = vi.fn();
      const stream = new PanelStream({ ok: true }, address.port, '00'.repeat(32), onEnd);
      stream.onClose(closed);
      await stream.connected();
      const socket = (stream as unknown as { socket: Socket }).socket;
      socket.write = (() => {
        throw Object.assign(new Error(`write ${code}`), { code });
      }) as typeof socket.write;

      expect(() => expect(stream.sendText('ping')).toBe(false)).not.toThrow();
      expect(socket.destroyed).toBe(true);
      expect(onEnd).toHaveBeenCalledOnce();
      expect(closed).toHaveBeenCalledWith(`write ${code}`);
    }

    const onEndAsync = vi.fn();
    const closedAsync = vi.fn();
    const asyncStream = new PanelStream({ ok: true }, address.port, '00'.repeat(32), onEndAsync);
    asyncStream.onClose(closedAsync);
    await asyncStream.connected();
    const asyncSocket = (asyncStream as unknown as { socket: Socket }).socket;
    asyncSocket.write = (() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    }) as typeof asyncSocket.write;

    await expect(asyncStream.sendTextAsync('ping')).rejects.toThrow('write EPIPE');
    expect(asyncSocket.destroyed).toBe(true);
    expect(onEndAsync).toHaveBeenCalledOnce();
    expect(closedAsync).toHaveBeenCalledWith('write EPIPE');
  } finally {
    for (const sock of accepted) sock.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
