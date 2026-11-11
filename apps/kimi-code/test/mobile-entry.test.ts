import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { MessageChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';

import {
  configureBundledMobileAssets,
  createMessagePortControlChannel,
  createStdioControlChannel,
  ensureDefaultMobileOperatorProfile,
  ensureManagedMobileMcp,
  normalizeMobileHostPlatform,
  startMobileHost,
} from '../src/mobile-entry';
import * as androidEntry from '../src/android-entry';

describe('mobile-entry and android-entry compatibility', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeTempHome(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it('re-exports mobile host APIs from android-entry without triggering side-effect boot on import', () => {
    expect(androidEntry.startMobileHost).toBe(startMobileHost);
    expect(androidEntry.createMessagePortControlChannel).toBe(createMessagePortControlChannel);
    expect(typeof androidEntry.runAndroidHost).toBe('function');
    expect(normalizeMobileHostPlatform('ios')).toBe('ios');
    expect(normalizeMobileHostPlatform('ANDROID')).toBe('android');
    expect(normalizeMobileHostPlatform(undefined, 'ios')).toBe('ios');
  });

  it('writes platform-specific phone MCP and default operator profile for Android and iOS', async () => {
    const androidHome = await makeTempHome('kiki-mobile-android-');
    ensureManagedMobileMcp(androidHome, 'android', 'http://127.0.0.1:19100/mcp', 'android-tok');
    ensureDefaultMobileOperatorProfile(androidHome, 'android');

    const androidMcp = JSON.parse(await readFile(join(androidHome, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { url: string; headers: { Authorization: string } }>;
    };
    expect(androidMcp.mcpServers['android-phone']).toMatchObject({
      url: 'http://127.0.0.1:19100/mcp',
      headers: { Authorization: 'Bearer android-tok' },
    });
    expect(await readFile(join(androidHome, 'agents', 'android-operator.md'), 'utf8')).toContain('name: android-operator');

    const iosHome = await makeTempHome('kiki-mobile-ios-');
    ensureManagedMobileMcp(iosHome, 'ios', 'http://127.0.0.1:19200/mcp', 'ios-tok');
    ensureDefaultMobileOperatorProfile(iosHome, 'ios');

    const iosMcp = JSON.parse(await readFile(join(iosHome, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { url: string; headers: { Authorization: string } }>;
    };
    expect(iosMcp.mcpServers['ios-phone']).toMatchObject({
      url: 'http://127.0.0.1:19200/mcp',
      headers: { Authorization: 'Bearer ios-tok' },
    });
    expect(await readFile(join(iosHome, 'agents', 'ios-operator.md'), 'utf8')).toContain('name: ios-operator');

    const iosEnv: NodeJS.ProcessEnv = {};
    configureBundledMobileAssets(iosHome, 'ios', iosEnv);
    expect(iosEnv['KIKI_PLATFORM']).toBe('ios');
    expect(iosEnv['KIKI_RUNTIME_PROFILE']).toBe('mobile');
    expect(iosEnv['KIKI_PTY']).toBe('off');
  });

  it('parses stdio bootstrap and control frames and emits @@kiki lines', async () => {
    const input = new PassThrough();
    const outputChunks: string[] = [];
    const output = new PassThrough();
    output.on('data', (chunk) => outputChunks.push(String(chunk)));

    const channel = createStdioControlChannel({ input, output, requireBootstrapFrame: true });
    input.write('{"type":"bootstrap","platform":"android","preferredPort":0}\n');
    const bootstrap = await channel.readBootstrap();
    expect(bootstrap).toMatchObject({ type: 'bootstrap', platform: 'android', preferredPort: 0 });

    input.write('{"type":"ping","seq":7}\n{"type":"shutdown","graceMs":500}\n');
    input.end();

    const received = [];
    for await (const frame of channel.frames()) {
      received.push(frame);
    }
    expect(received).toEqual([
      { type: 'ping', seq: 7 },
      { type: 'shutdown', graceMs: 500 },
    ]);

    channel.emit({ type: 'pong', seq: 7 });
    expect(outputChunks.join('')).toBe('@@kiki {"type":"pong","seq":7}\n');
    await channel.close?.();
  });

  it('boots an in-process iOS mobile host over MessagePort with memoryBudgetMb and mobile-broker env', async () => {
    const homeDir = await makeTempHome('kiki-ios-host-');
    const bundleDir = await makeTempHome('kiki-ios-bundle-');
    const { port1: hostSide, port2: engineSide } = new MessageChannel();
    const receivedFrames: Record<string, unknown>[] = [];
    hostSide.on('message', (msg) => {
      if (msg && typeof msg === 'object') {
        receivedFrames.push(msg as Record<string, unknown>);
      }
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KIKI_SEARCH_DISABLED: '1',
    };

    const channel = createMessagePortControlChannel(engineSide, { requireBootstrapFrame: true });
    hostSide.postMessage({
      v: 1,
      type: 'bootstrap',
      platform: 'ios',
      homeDir,
      localOwnerToken: 'ios-owner-secret-token',
      preferredPort: 0,
      memoryBudgetMb: 256,
      gateway: {
        url: 'http://127.0.0.1:9',
        secretToken: 'ios-broker-token',
        mcpUrl: 'http://127.0.0.1:9/mcp',
        mcpToken: 'ios-mcp-token',
      },
    });

    const handle = await startMobileHost({
      argv: ['node', 'mobile-entry.ts'],
      env,
      bundleDir,
      controlChannel: channel,
      exitOnShutdown: false,
      registerSignalHandlers: false,
    });

    try {
      expect(handle.platform).toBe('ios');
      expect(handle.port).toBeGreaterThan(0);
      expect(env['KIKI_PLATFORM']).toBe('ios');
      expect(env['KIKI_MOBILE_MEMORY_BUDGET_MB']).toBe('256');
      expect(env['KIKI_SECRET_BACKEND']).toBe('mobile-broker');

      const waitForFrame = async (predicate: (frame: Record<string, unknown>) => boolean, label: string) => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const hit = receivedFrames.find(predicate);
          if (hit !== undefined) return hit;
          await new Promise((r) => setTimeout(r, 15));
        }
        throw new Error(`Timed out waiting for MessagePort frame: ${label}`);
      };

      const readyFrame = await waitForFrame((frame) => frame['type'] === 'ready', 'ready');
      expect(readyFrame).toMatchObject({
        type: 'ready',
        platform: 'ios',
        port: handle.port,
      });

      const configRes = await fetch(`http://127.0.0.1:${handle.port}/api/config`, {
        headers: { authorization: 'Bearer ios-owner-secret-token' },
      });
      expect(configRes.status).toBe(200);
      const configEnvelope = (await configRes.json()) as {
        code: number;
        data: {
          browser_control: { enabled: boolean; enabledSource: string };
          computer_control: { enabled: boolean; enabledSource: string };
        };
      };
      expect(configEnvelope.code).toBe(0);
      expect(configEnvelope.data.browser_control).toMatchObject({ enabled: false, enabledSource: 'default' });
      expect(configEnvelope.data.computer_control).toMatchObject({ enabled: false, enabledSource: 'default' });

      hostSide.postMessage({ type: 'ping', seq: 42 });
      await waitForFrame((frame) => frame['type'] === 'pong' && frame['seq'] === 42, 'pong');

      hostSide.postMessage({ type: 'shutdown', graceMs: 3_000 });
      await handle.closed;
    } finally {
      await handle.shutdown(1_000).catch(() => undefined);
      hostSide.close();
      engineSide.close();
    }
  }, 30_000);
});
