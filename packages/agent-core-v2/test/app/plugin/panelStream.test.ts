import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { PluginHost } from '#/app/plugin/host';

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
