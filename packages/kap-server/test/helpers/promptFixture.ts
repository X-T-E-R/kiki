import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentLifecycleService,
  IAgentLLMRequesterService,
  IAgentLoopService,
  IAgentProfileService,
  ISessionContext,
  getLiveSessionById,
} from '@kiki/agent-core-v2';
import { createHooks } from '@kiki/agent-core-v2/hooks';
import { afterEach, beforeEach, expect, vi } from 'vitest';

import { type RunningServer, startServer } from '../../src/start';
import { TEST_HOST_IDENTITY } from './hostIdentity';
import { authHeaders } from './auth';

export interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

export interface PromptItemWire {
  prompt_id: string;
  user_message_id: string;
  status: 'running' | 'queued';
  origin?: unknown;
  content: unknown;
  created_at: string;
}

export type PromptContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { kind: 'base64'; media_type: string; data: string };
    };

export const PROMPT_TOML = [
  'default_model = "stub"',
  '',
  '[providers.stub]',
  'type = "openai"',
  'base_url = "http://127.0.0.1:9999"',
  'api_key = "stub"',
  '',
  '[models.stub]',
  'provider = "stub"',
  'model = "stub"',
  'max_context_size = 1000',
  'capabilities = ["thinking"]',
  'support_efforts = ["low", "high"]',
  'default_effort = "high"',
  '',
  '[models.stub-alt]',
  'provider = "stub"',
  'model = "stub-alt"',
  'max_context_size = 1000',
  'capabilities = ["thinking"]',
  'support_efforts = ["low", "high"]',
  'default_effort = "high"',
  '',
  '[search]',
  'enabled = false',
  '',
  '[cron]',
  'manualTick = true',
  '',
].join('\n');

export function promiseGate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export async function readFileEventually(path: string): Promise<Buffer> {
  return vi.waitFor(() => readFile(path));
}

export function sessionMediaDir(server: RunningServer, sessionId: string): string {
  const session = getLiveSessionById(server.core.accessor, sessionId);
  return join(session!.accessor.get(ISessionContext).sessionDir, 'media');
}

export async function expectSessionMedia(
  server: RunningServer,
  sessionId: string,
  name: string,
  bytes: Buffer,
): Promise<string> {
  const path = join(sessionMediaDir(server, sessionId), name);
  expect(await readFileEventually(path)).toEqual(bytes);
  return path;
}

let configTomlSeq = 0;

export async function writeConfigToml(dir: string, content: string): Promise<void> {
  configTomlSeq += 1;
  const tmpPath = join(dir, `config.toml.${process.pid}.${configTomlSeq}.tmp`);
  const configPath = join(dir, 'config.toml');
  await writeFile(tmpPath, content, 'utf-8');
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmpPath, configPath);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 40) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
}

export function holdExternalSession(): { readonly session: {
  run: () => Promise<{ agentId: string; completion: Promise<{ summary: string }>; turn: { id: number; signal: AbortSignal; ready: Promise<void>; result: Promise<unknown>; cancel: () => boolean } }>;
  status: () => { state: 'idle' | 'running' };
  cancel: () => boolean;
  settled: () => Promise<void>;
  shutdown: () => Promise<void>;
  updateBinding: () => void;
  hooks: ReturnType<typeof createHooks>;
}; readonly finish: () => void } {
  const pending: Array<() => void> = [];
  let state: 'idle' | 'running' = 'idle';
  const finish = (): void => {
    state = 'idle';
    for (const release of pending.splice(0)) release();
  };
  return {
    finish,
    session: {
      run: async () => {
        state = 'running';
        const controller = new AbortController();
        let release = (): void => {};
        const result = new Promise((resolve) => {
          release = () => resolve({ type: 'cancelled', steps: 0 });
        });
        pending.push(() => { state = 'idle'; release(); });
        return {
          agentId: 'main',
          completion: result.then(() => ({ summary: '' })),
          turn: {
            id: 1,
            signal: controller.signal,
            ready: Promise.resolve(),
            result,
            cancel: () => { controller.abort(); state = 'idle'; release(); return true; },
          },
        };
      },
      status: () => ({ state }),
      cancel: () => { finish(); return true; },
      settled: async () => {},
      shutdown: async () => { finish(); },
      updateBinding: () => {},
      hooks: createHooks(['onWillRun']),
    },
  };
}

export function avifBytes(): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(24, 0);
  buf.write('ftyp', 4, 'latin1');
  buf.write('avif', 8, 'latin1');
  buf.write('avif', 16, 'latin1');
  return buf;
}

export function heicBytes(): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(24, 0);
  buf.write('ftyp', 4, 'latin1');
  buf.write('heic', 8, 'latin1');
  buf.write('heic', 16, 'latin1');
  return buf;
}

export function attachedPathFrom(notice: string): string {
  const match = /bytes\): (.+) — open it with the Read tool$/.exec(notice);
  expect(match).not.toBeNull();
  return match![1]!;
}

export function usePromptFixture() {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-prompts-'));
    await mkdir(join(home, '.git'));
    await writeConfigToml(home, PROMPT_TOML);
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  async function call<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    arg?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const headers = authHeaders(
      server as RunningServer,
      arg === undefined ? {} : { 'content-type': 'application/json' },
    );
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers,
    };
    if (arg !== undefined) {
      init.body = JSON.stringify(arg);
    }
    const res = await fetch(`${base}${path}`, init as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(cwd: string, pinPermissionMode = true): Promise<string> {
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        metadata: { cwd },
        ...(pinPermissionMode ? { agent_config: { permission_mode: 'manual' } } : {}),
      }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function createMainAgent(sessionId: string): Promise<void> {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
  }

  async function createHeldMainAgent(sessionId: string, firstStep?: Promise<void>): Promise<void> {
    await createMainAgent(sessionId);
    const main = getLiveSessionById(server!.core.accessor, sessionId)!.accessor.get(IAgentLifecycleService).get('main')!;
    await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub' });
    if (firstStep !== undefined) {
      vi.spyOn(main.accessor.get(IAgentLLMRequesterService), 'start').mockReturnValue({
        trace: { traceId: 'fixture-safe-boundary' },
        result: Promise.resolve({
          message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], toolCalls: [] },
          usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
          providerFinishReason: 'completed',
        }),
      });
    }
    main.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-test-turn', async (ctx) => {
      const aborted = new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await (ctx.step === 1 && firstStep !== undefined ? Promise.race([firstStep, aborted]) : aborted);
      ctx.signal.throwIfAborted();
    }, { before: 'context-injector' });
  }

  async function createHeldChild(sessionId: string, firstStep?: Promise<void>) {
    await createMainAgent(sessionId);
    const lifecycle = getLiveSessionById(server!.core.accessor, sessionId)!.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.create({ binding: { profile: 'agent', model: 'stub', thinking: 'high' } });
    child.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-retry-child-turn', async (ctx) => {
      const aborted = new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await (ctx.step === 1 && firstStep !== undefined ? Promise.race([firstStep, aborted]) : aborted);
      ctx.signal.throwIfAborted();
    }, { before: 'context-injector' });
    return child;
  }

  async function uploadFile(
    bytes: Buffer,
    mediaType: string,
    name: string,
  ): Promise<{ id: string; size: number }> {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(bytes)], { type: mediaType }), name);
    const uploadRes = await fetch(`${base}/api/files`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
      body: form,
    } as never);
    const uploaded = (await uploadRes.json()) as Envelope<{ id: string; size: number }>;
    expect(uploaded.code).toBe(0);
    return uploaded.data;
  }

  return {
    call,
    createSession,
    createMainAgent,
    createHeldMainAgent,
    createHeldChild,
    uploadFile,
    get server() { return server; },
    set server(value: RunningServer | undefined) { server = value; },
    get home() { return home; },
    set home(value: string | undefined) { home = value; },
    get base() { return base; },
    set base(value: string) { base = value; },
  };
}
