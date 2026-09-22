import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

import {
  IAgentTitlePromptSource,
  IAgentGoalService,
  IAgentLoopService,
  IAgentSwarmService,
  IAgentContextMemoryService,
  IAgentExecutionService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentTaskService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentToolPolicyService,
  IEventBus,
  IEventDispatcher,
  IBootstrapService,
  PromptEnqueued,
  IFileService,
  ISessionContext,
  ISessionMetadata,
  ISessionDispatchService,
  closeSessionById,
  getLiveSessionById,
  resumeSessionById,
} from '@kiki/agent-core-v2';
import { createKlient as createMemoryKlient } from '@kiki/klient/memory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import {
  PROMPT_BODY_LIMIT_BYTES,
  projectPromptSnapshot,
  watchPromptSettlements,
} from '../src/routes/prompts';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface PromptItemWire {
  prompt_id: string;
  user_message_id: string;
  status: 'running' | 'queued';
  content: unknown;
  created_at: string;
}

type PromptContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { kind: 'base64'; media_type: string; data: string };
    };

const PROMPT_TOML = [
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
  '',
  '[models.stub-alt]',
  'provider = "stub"',
  'model = "stub-alt"',
  'max_context_size = 1000',
  'capabilities = ["thinking"]',
  'support_efforts = ["low", "high"]',
  '',
].join('\n');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC32_TABLE = makeCrc32Table();

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function solidPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x++) {
    const offset = 1 + x * 4;
    row[offset] = 0x33;
    row[offset + 1] = 0x66;
    row[offset + 2] = 0xcc;
    row[offset + 3] = 0xff;
  }
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) {
    row.copy(raw, y * row.length);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('expected PNG data');
  }
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('expected IHDR as first PNG chunk');
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function paddedPng(extraBytes: number, marker: number): Buffer {
  const keyword = Buffer.from(`kiki-${String(marker)}`, 'ascii');
  const text = Buffer.concat([keyword, Buffer.from([0]), Buffer.alloc(extraBytes, 0x41 + marker)]);
  const base = solidPng(10, 10);
  const iend = base.subarray(base.length - 12);
  return Buffer.concat([base.subarray(0, base.length - 12), pngChunk('tEXt', text), iend]);
}

async function readFileEventually(path: string): Promise<Buffer> {
  return vi.waitFor(() => readFile(path));
}

function sessionMediaDir(server: RunningServer, sessionId: string): string {
  const session = getLiveSessionById(server.core.accessor, sessionId);
  return join(session!.accessor.get(ISessionContext).sessionDir, 'media');
}

async function expectSessionMedia(
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

async function writeConfigToml(dir: string, content: string): Promise<void> {
  configTomlSeq += 1;
  const tmpPath = join(dir, `config.toml.${process.pid}.${configTomlSeq}.tmp`);
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, join(dir, 'config.toml'));
}

describe('server-v2 /api prompts', () => {
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
    method: 'GET' | 'POST',
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

  async function createSession(cwd: string): Promise<string> {
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd } }),
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

  async function createHeldMainAgent(sessionId: string): Promise<void> {
    await createMainAgent(sessionId);
    const main = getLiveSessionById(server!.core.accessor, sessionId)!.accessor.get(IAgentLifecycleService).get('main')!;
    await main.accessor.get(IAgentProfileService).bind({ profile: 'agent', model: 'stub' });
    main.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-test-turn', async (ctx) => {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      ctx.signal.throwIfAborted();
    }, { before: 'context-injector' });
  }

  it.each([undefined, 'stub-alt'])('authenticates the session or requested model rather than an unrelated default: %s', async (model) => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    await writeConfigToml(home as string, PROMPT_TOML.replace('default_model = "stub"', 'default_model = "kimi-unavailable"') + [
      '', '[providers."managed:kimi-code"]', 'type = "kimi"',
      '[providers."managed:kimi-code".oauth]', 'storage = "file"', 'key = "oauth/kimi-code"',
      '[models.kimi-unavailable]', 'provider = "managed:kimi-code"', 'model = "kimi-unavailable"', 'max_context_size = 1000', '',
    ].join('\n'));
    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Use the selected model, not the global default.' }], model,
    });
    expect(submitted.body.code, submitted.body.msg).toBe(0);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    expect(main.accessor.get(IAgentProfileService).getModel()).toBe(model ?? 'stub');
    main.accessor.get(IAgentPromptService).abort(submitted.body.data.prompt_id);
  });

  it('rejects a credentialless requested model even when the current model is authenticated', async () => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    await writeConfigToml(home as string, PROMPT_TOML + [
      '', '[providers."managed:kimi-code"]', 'type = "kimi"',
      '[providers."managed:kimi-code".oauth]', 'storage = "file"', 'key = "oauth/kimi-code"',
      '[models.kimi-unavailable]', 'provider = "managed:kimi-code"', 'model = "kimi-unavailable"', 'max_context_size = 1000', '',
    ].join('\n'));
    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'This model needs its own credential.' }], model: 'kimi-unavailable',
    });
    expect(submitted.body.code, submitted.body.msg).toBe(40111);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    expect(main.accessor.get(IAgentPromptService).list().active).toBeUndefined();
    expect(main.accessor.get(IAgentProfileService).getModel()).toBe('stub');
  });

  it.each([false, true])('applies prompt-bound plan and swarm controls with skills=%s', async (skills) => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const plan = main.accessor.get(IAgentPlanService);
    const swarm = main.accessor.get(IAgentSwarmService);
    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'plan this work' }],
      skills: skills ? [{ name: 'kiki-ops' }] : undefined,
      plan_mode: true, swarm_mode: true,
    });
    expect(submitted.body.code, submitted.body.msg).toBe(0);
    expect(submitted.body.data.status).toBe('running');
    expect(await plan.status()).not.toBeNull();
    expect(swarm.isActive).toBe(true);
    const prompt = main.accessor.get(IAgentPromptService);
    const queued = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'execute later' }], plan_mode: false, swarm_mode: false,
    });
    expect(queued.body.data.status).toBe('queued');
    expect(await plan.status()).not.toBeNull();
    expect(swarm.isActive).toBe(true);
    const steer = await call('POST', `/api/sessions/${id}/prompts/${queued.body.data.prompt_id}:steer`);
    expect(steer.body.code).toBe(40001);
    prompt.abort(submitted.body.data.prompt_id);
    await vi.waitFor(async () => {
      expect(await plan.status()).toBeNull();
      expect(swarm.isActive).toBe(false);
    });
  });

  it.each([true, false])('allows Send now for the actual GUI mode and same-objective echo: %s', async (enabled) => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const goal = main.accessor.get(IAgentGoalService);
    await goal.createGoal({ objective: 'same objective' });
    await goal.pauseGoal({});
    const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'active mode' }], plan_mode: enabled, swarm_mode: enabled,
    });
    expect(active.body.code, active.body.msg).toBe(0);
    const followUp = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'ordinary follow-up' }], permission_mode: 'manual',
      plan_mode: enabled, swarm_mode: enabled, goal_objective: 'same objective',
    });
    expect(followUp.body.code, followUp.body.msg).toBe(0);
    expect(followUp.body.data.status).toBe('queued');
    const sentNow = await call('POST', `/api/sessions/${id}/prompts/${followUp.body.data.prompt_id}:steer`);
    expect(sentNow.body.code, sentNow.body.msg).toBe(0);
    expect(main.accessor.get(IAgentPromptService).list().pending).toHaveLength(0);
    expect((await main.accessor.get(IAgentPlanService).status()) !== null).toBe(enabled);
    expect(main.accessor.get(IAgentSwarmService).isActive).toBe(enabled);
    expect(goal.getGoal().goal?.status).toBe('paused');
  });

  it.each(['pause', 'resume', 'cancel'] as const)('applies prompt-bound goal %s without autonomous resume', async (control) => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const goal = main.accessor.get(IAgentGoalService);
    const initial = await goal.createGoal({ objective: 'finish the example' });
    if (control === 'resume') await goal.pauseGoal({});
    const resume = vi.spyOn(goal, 'resumeGoal');
    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'user directed step' }],
      goal_objective: 'finish the example', goal_control: control,
    });
    expect(submitted.body.code, submitted.body.msg).toBe(0);
    expect(submitted.body.data.status).toBe('running');
    if (control === 'cancel') expect(goal.getGoal().goal).toBeNull();
    else {
      expect(goal.getGoal().goal).toMatchObject({ goalId: initial.goalId, status: control === 'pause' ? 'paused' : 'active' });
      if (control === 'resume') {
        expect(resume).toHaveBeenCalledWith({});
        await goal.pauseGoal({});
      }
    }
    main.accessor.get(IAgentPromptService).abort(submitted.body.data.prompt_id);
    resume.mockRestore();
  });

  it('creates a goal from the prompt and does not recreate it on repeated submissions', async () => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const goal = main.accessor.get(IAgentGoalService);
    const prompt = main.accessor.get(IAgentPromptService);
    const first = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'begin' }], goal_objective: 'finish the example', goal_control: 'pause',
    });
    expect(first.body.code, first.body.msg).toBe(0);
    const goalId = goal.getGoal().goal!.goalId;
    const later = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'next' }], goal_objective: 'finish the example',
    });
    expect(later.body.code).toBe(0);
    prompt.abort(first.body.data.prompt_id);
    await vi.waitFor(() => expect(prompt.list().active?.id).toBe(later.body.data.prompt_id));
    expect(goal.getGoal().goal).toMatchObject({ goalId, status: 'paused' });
  });

  it('keeps cancelled queued controls and duplicate submissions free of runtime side effects', async () => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const prompt = main.accessor.get(IAgentPromptService);
    const goal = main.accessor.get(IAgentGoalService);
    await goal.createGoal({ objective: 'existing goal' });
    await goal.pauseGoal({});
    const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      prompt_id: 'stable-active', content: [{ type: 'text', text: 'active' }],
    });
    expect(active.body.code).toBe(0);
    const duplicate = await call('POST', `/api/sessions/${id}/prompts`, {
      prompt_id: 'stable-active', content: [{ type: 'text', text: 'duplicate' }],
      plan_mode: true, swarm_mode: true, goal_control: 'cancel',
    });
    expect(duplicate.body.code).toBe(40938);
    const queued = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'cancel me' }],
      plan_mode: true, swarm_mode: true, goal_control: 'cancel',
    });
    expect(queued.body.code).toBe(0);
    expect(queued.body.data.status).toBe('queued');
    prompt.abort(queued.body.data.prompt_id);
    expect(await main.accessor.get(IAgentPlanService).status()).toBeNull();
    expect(main.accessor.get(IAgentSwarmService).isActive).toBe(false);
    expect(goal.getGoal().goal).toMatchObject({ objective: 'existing goal', status: 'paused' });
  });

  it('rejects invalid goal controls before permission, plan and swarm side effects', async () => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const mode = main.accessor.get(IAgentPermissionModeService).mode;
    for (const invalid of [{ goal_objective: '   ' }, { goal_objective: 'a'.repeat(4001) }, { goal_control: 'resume' }]) {
      const result = await call('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text: 'invalid' }], ...invalid,
        permission_mode: 'yolo', plan_mode: true, swarm_mode: true,
      });
      expect(result.body.code, result.body.msg).toBe(40001);
    }
    expect(main.accessor.get(IAgentPermissionModeService).mode).toBe(mode);
    expect(await main.accessor.get(IAgentPlanService).status()).toBeNull();
    expect(main.accessor.get(IAgentSwarmService).isActive).toBe(false);
    expect(main.accessor.get(IAgentGoalService).getGoal().goal).toBeNull();
  });

  it('rejects child-agent runtime controls rather than ignoring them', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id)!;
    const child = await session.accessor.get(IAgentLifecycleService).fork('main');
    for (const control of [{ plan_mode: true }, { swarm_mode: true }, { goal_objective: 'child goal' }, { goal_control: 'pause' }]) {
      const result = await call('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text: 'not supported' }], agent_id: child.id, ...control,
      });
      expect(result.body.code, result.body.msg).toBe(40001);
    }
  });

  it.each([false, true])('does not apply runtime controls when the submit hook blocks, skills=%s', async (skills) => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const hook = main.accessor.get(IAgentPromptService).hooks.onBeforeSubmitPrompt.register('block-controls', async (ctx, next) => {
      ctx.block = true; await next();
    });
    const submitted = await call<{ status: string }>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'blocked' }], plan_mode: true, swarm_mode: true, goal_objective: 'blocked goal',
      skills: skills ? [{ name: 'kiki-ops' }] : undefined,
    });
    expect(submitted.body.code, submitted.body.msg).toBe(0);
    expect(submitted.body.data.status).toBe('blocked');
    expect(await main.accessor.get(IAgentPlanService).status()).toBeNull();
    expect(main.accessor.get(IAgentSwarmService).isActive).toBe(false);
    expect(main.accessor.get(IAgentGoalService).getGoal().goal).toBeNull();
    hook.dispose();
  });

  it.each([false, true])('reports failed launch consistently, skills=%s', async (skills) => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const bind = vi.spyOn(main.accessor.get(IAgentProfileService), 'setModel').mockRejectedValueOnce(new Error('model unavailable'));
    const submitted = await call('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'failed' }], model: 'stub-alt',
      plan_mode: true, swarm_mode: true, goal_objective: 'failed goal',
      skills: skills ? [{ name: 'kiki-ops' }] : undefined,
    });
    expect(submitted.body.code, submitted.body.msg).toBe(50001);
    expect(await main.accessor.get(IAgentPlanService).status()).toBeNull();
    expect(main.accessor.get(IAgentSwarmService).isActive).toBe(false);
    expect(main.accessor.get(IAgentGoalService).getGoal().goal).toBeNull();
    bind.mockRestore();
  });

  it('submits a prompt and lists it as active', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(submitted.body.code).toBe(0);
    expect(submitted.body.data.prompt_id).toMatch(/^msg_/);
    expect(submitted.body.data.status).toBe('running');
    expect(submitted.body.data.user_message_id).toBe(submitted.body.data.prompt_id);

    const list = await call<{ active: PromptItemWire | null; queued: PromptItemWire[] }>(
      'GET',
      `/api/sessions/${id}/prompts`,
    );
    expect(list.body.code).toBe(0);
    if (list.body.data.active !== null) {
      expect(list.body.data.active.prompt_id).toBe(submitted.body.data.prompt_id);
    }
    expect(Array.isArray(list.body.data.queued)).toBe(true);
  });

  it('projects a replay-restored recovery hold through the prompt list', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id)!;
    const main = session.accessor.get(IAgentLifecycleService).get('main')!;
    const dispatcher = main.accessor.get(IEventDispatcher);
    await dispatcher.dispatch(new PromptEnqueued({
      schemaVersion: 1,
      promptId: 'recovered-prompt',
      userMessageId: 'recovered-prompt',
      createdAt: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'recover me' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      alreadyMaterialized: false,
      appendTiming: 'agent_idle',
      revision: 0,
      queueIndex: 0,
    }));
    await dispatcher.hooks.onDidRestore.run({});

    const list = await call<{
      active: PromptItemWire | null;
      queued: PromptItemWire[];
      recovery_hold?: { reason: 'recovery'; count: number };
    }>('GET', `/api/sessions/${id}/prompts`);

    expect(list.body.code).toBe(0);
    expect(list.body.data.queued.map((prompt) => prompt.prompt_id)).toEqual(['recovered-prompt']);
    expect(list.body.data.recovery_hold).toEqual({ reason: 'recovery', count: 1 });
  });

  it.each([false, true])('sends a selected held prompt after cold resume without releasing the rest (bulk=%s)', async (bulk) => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id)!;
    const dispatcher = session.accessor.get(IAgentLifecycleService).get('main')!.accessor.get(IEventDispatcher);
    for (const [queueIndex, promptId] of ['held-first', 'send-now'].entries()) {
      await dispatcher.dispatch(new PromptEnqueued({
        schemaVersion: 1,
        promptId,
        userMessageId: promptId,
        createdAt: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: promptId }], toolCalls: [], origin: { kind: 'user' } },
        alreadyMaterialized: false,
        appendTiming: 'agent_idle',
        revision: 0,
        queueIndex,
      }));
    }
    await closeSessionById(server!.core.accessor, id);
    await resumeSessionById(server!.core.accessor, id);
    await createHeldMainAgent(id);
    const main = getLiveSessionById(server!.core.accessor, id)!.accessor.get(IAgentLifecycleService).get('main')!;
    const prompt = main.accessor.get(IAgentPromptService);
    expect(prompt.list().hold).toEqual({ reason: 'recovery', count: 2 });
    expect(main.accessor.get(IAgentLoopService).status().activeTurnId).toBeUndefined();

    const sent = bulk
      ? await call('POST', `/api/sessions/${id}/prompts:steer`, { prompt_ids: ['send-now'] })
      : await call('POST', `/api/sessions/${id}/prompts/send-now:steer`, {});
    expect(sent.body.code, sent.body.msg).toBe(0);
    await vi.waitFor(() => expect(prompt.list().active?.id).toBe('send-now'));
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['held-first']);
    expect(prompt.list().hold).toEqual({ reason: 'recovery', count: 1 });
    prompt.abort('send-now');
    await main.accessor.get(IAgentLoopService).settled();
    expect(prompt.list().hold).toEqual({ reason: 'recovery', count: 1 });
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['held-first']);
  });

  it('applies an optional plan_gate override before prompt execution', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'plan with approval' }],
      plan_gate: 'gated',
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
    const main = session!.accessor.get(IAgentLifecycleService).get('main');
    expect(main!.accessor.get(IAgentPlanService).planGate).toBe('gated');
  });

  it('moves a queued prompt to an exact final index', async () => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'active' }],
    });
    expect(active.body.code, active.body.msg).toBe(0);
    const queued: PromptItemWire[] = [];
    for (const text of ['one', 'two', 'three']) {
      const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text }],
      });
      expect(submitted.body.code, submitted.body.msg).toBe(0);
      queued.push(submitted.body.data);
    }

    const moved = await call<{
      moved: true;
      prompt_id: string;
      target_index: number;
      queued_prompt_ids: string[];
    }>(
      'POST',
      `/api/sessions/${id}/prompts/${queued[2]!.prompt_id}:move`,
      { target_index: 0 },
    );

    expect(moved.body.code, moved.body.msg).toBe(0);
    expect(moved.body.data).toEqual({
      moved: true,
      prompt_id: queued[2]!.prompt_id,
      target_index: 0,
      queued_prompt_ids: [queued[2]!.prompt_id, queued[0]!.prompt_id, queued[1]!.prompt_id],
    });
    const listed = await call<{ active: PromptItemWire | null; queued: PromptItemWire[] }>(
      'GET',
      `/api/sessions/${id}/prompts`,
    );
    expect(listed.body.data.queued.map((prompt) => prompt.prompt_id)).toEqual(
      moved.body.data.queued_prompt_ids,
    );
    await getLiveSessionById(server!.core.accessor, id)!
      .accessor.get(IAgentLifecycleService)
      .get('main')!
      .accessor.get(IAgentPromptService)
      .drain();
  });

  it('steers a queued prompt with model and thinking bindings without rebinding the active turn', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'active' }],
      model: 'stub',
      thinking: 'low',
    });
    expect(active.body.code).toBe(0);
    expect(active.body.data.status).toBe('running');

    const session = getLiveSessionById(server!.core.accessor, id);
    const main = session!.accessor.get(IAgentLifecycleService).get('main');
    const prompt = main!.accessor.get(IAgentPromptService);
    const profile = main!.accessor.get(IAgentProfileService);
    const activeBinding = profile.data();
    const queued = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'append now' }],
      model: 'stub-alt',
      thinking: 'high',
    });
    expect(queued.body.code).toBe(0);
    expect(queued.body.data.status).toBe('queued');
    expect(profile.data()).toEqual(activeBinding);

    const steered = await call<{ steered: true; prompt_ids: string[] }>(
      'POST',
      `/api/sessions/${id}/prompts/${queued.body.data.prompt_id}:steer`,
    );

    expect(steered.body.code, JSON.stringify(steered.body)).toBe(0);
    expect(steered.body.data).toEqual({
      steered: true,
      prompt_ids: [queued.body.data.prompt_id],
    });
    expect(profile.data()).toEqual(activeBinding);
    expect(prompt.list().pending.map((item) => item.id)).not.toContain(queued.body.data.prompt_id);
    prompt.abort(active.body.data.prompt_id);
  });

  it('submits a bundled skill prompt through the skills field', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      skills: [{ name: 'kiki-ops' }, { name: 'kiki-profile' }],
    });
    expect(submitted.body.code).toBe(0);
    expect(submitted.body.data.prompt_id).toMatch(/^msg_/);
    expect(['running', 'queued']).toContain(submitted.body.data.status);
    expect(submitted.body.data.content).toEqual([{ type: 'text', text: 'Review this change.' }]);

    const session = getLiveSessionById(server!.core.accessor, id);
    const agent = session!.accessor.get(IAgentLifecycleService).get('main');
    const history = agent!.accessor.get(IAgentContextMemoryService).get();
    const bundled = history.find((message) => message.origin?.kind === 'user');
    expect(bundled?.origin).toMatchObject({
      kind: 'user',
      skillActivations: [{ skillName: 'kiki-ops' }, { skillName: 'kiki-profile' }],
    });
    const texts = bundled?.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text);
    expect(texts?.[texts.length - 1]).toBe('Review this change.');

    const projected = projectPromptSnapshot({
      id: 'msg_1',
      userMessageId: 'msg_1',
      createdAt: '2026-01-01T00:00:00.000Z',
      state: 'running',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'rendered skill block' },
          { type: 'text', text: 'Review this change.' },
        ],
        toolCalls: [],
        origin: {
          kind: 'user',
          skillActivations: [{ activationId: 'a1', skillName: 'kiki-ops' }],
        },
      },
    });
    expect(projected.content).toEqual([{ type: 'text', text: 'Review this change.' }]);
    expect(projected.append_timing).toBe('agent_idle');
    expect(projected.revision).toBe(0);
    const plain = projectPromptSnapshot({
      id: 'msg_2',
      userMessageId: 'msg_2',
      createdAt: '2026-01-01T00:00:00.000Z',
      state: 'pending',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'plain question' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    expect(plain.content).toEqual([{ type: 'text', text: 'plain question' }]);
    expect(plain.append_timing).toBe('agent_idle');
    expect(plain.revision).toBe(0);
  });

  it('projects the effective scheduling revision captured on the prompt snapshot', () => {
    const scheduled = projectPromptSnapshot({
      id: 'msg_3',
      userMessageId: 'msg_3',
      createdAt: '2026-01-01T00:00:00.000Z',
      state: 'pending',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'wait for tasks' }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      appendTiming: 'tasks_done',
      revision: 5,
    } as unknown as Parameters<typeof projectPromptSnapshot>[0]);
    expect(scheduled.append_timing).toBe('tasks_done');
    expect(scheduled.revision).toBe(5);
  });

  it('rejects an unknown append_timing on the timing action with 40001', async () => {
    const id = await createSession(home as string);
    await createHeldMainAgent(id);
    const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'active' }],
    });
    expect(active.body.code, active.body.msg).toBe(0);
    const queued = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'queued' }],
    });
    expect(queued.body.code, queued.body.msg).toBe(0);

    const rejected = await call<unknown>(
      'POST',
      `/api/sessions/${id}/prompts/${queued.body.data.prompt_id}:timing`,
      { append_timing: 'later' },
    );
    expect(rejected.body.code).toBe(40001);
    await getLiveSessionById(server!.core.accessor, id)!
      .accessor.get(IAgentLifecycleService)
      .get('main')!
      .accessor.get(IAgentPromptService)
      .drain();
  });

  it('honors a client-chosen prompt_id on submit', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      prompt_id: 'submission-1',
    });
    expect(submitted.body.code).toBe(0);
    expect(submitted.body.data.prompt_id).toBe('submission-1');
    expect(submitted.body.data.user_message_id).toBe('submission-1');
  });

  it('updates session metadata for a bundled prompt routed to a non-main agent', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const child = await session.accessor.get(IAgentLifecycleService).fork('main');

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'bundled side question' }],
      agent_id: child.id,
      skills: [{ name: 'kiki-ops' }],
    });
    expect(submitted.body.code).toBe(0);

    expect((await session.accessor.get(ISessionMetadata).read()).lastPrompt).toBe(
      'bundled side question',
    );
  });

  it('rejects a reused prompt_id live and after cold resume without changing metadata', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const first = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'first prompt' }],
      prompt_id: 'submission-1',
    });
    expect(first.body.code).toBe(0);

    const duplicate = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'must not become metadata' }],
      prompt_id: 'submission-1',
    });
    expect(duplicate.body.code).toBe(40938);

    const session = getLiveSessionById(server!.core.accessor, id);
    expect((await session!.accessor.get(ISessionMetadata).read()).lastPrompt).toBe('first prompt');

    await closeSessionById(server!.core.accessor, id);
    expect(getLiveSessionById(server!.core.accessor, id)).toBeUndefined();

    const afterResume = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'must not survive a cold resume' }],
      prompt_id: 'submission-1',
    });
    expect(afterResume.body.code).toBe(40938);
    const resumed = getLiveSessionById(server!.core.accessor, id);
    expect((await resumed!.accessor.get(ISessionMetadata).read()).lastPrompt).toBe('first prompt');
  });

  it('rejects a bundled submission with an unknown skill and records nothing', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      skills: [{ name: 'does-not-exist' }],
    });
    expect(submitted.body.code).toBe(40415);

    const session = getLiveSessionById(server!.core.accessor, id);
    const agent = session!.accessor.get(IAgentLifecycleService).get('main');
    const history = agent!.accessor.get(IAgentContextMemoryService).get();
    expect(history.filter((message) => message.origin?.kind === 'user')).toHaveLength(0);
  });

  it('rejects an unknown bundled skill before any control override binds', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      permission_mode: 'yolo',
      plan_gate: 'gated',
      skills: [{ name: 'does-not-exist' }],
    });
    expect(submitted.body.code).toBe(40415);

    const session = getLiveSessionById(server!.core.accessor, id);
    const agent = session!.accessor.get(IAgentLifecycleService).get('main');
    expect(agent!.accessor.get(IAgentPermissionModeService).mode).toBe('manual');
    expect(agent!.accessor.get(IAgentPlanService).planGate).toBe('free');
    const history = agent!.accessor.get(IAgentContextMemoryService).get();
    expect(history.filter((message) => message.origin?.kind === 'user')).toHaveLength(0);
  });

  it('rejects an unknown bundled skill without materializing the main agent', async () => {
    const id = await createSession(home as string);

    const submitted = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      skills: [{ name: 'does-not-exist' }],
    });
    expect(submitted.body.code).toBe(40415);

    const session = getLiveSessionById(server!.core.accessor, id);
    expect(session!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
  });

  it('rejects a bundled prompt_id combination before any override or agent materialization', async () => {
    const id = await createSession(home as string);

    const submitted = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'Review this change.' }],
      permission_mode: 'yolo',
      prompt_id: 'submission-1',
      skills: [{ name: 'kiki-ops' }],
    });
    expect(submitted.body.code).toBe(40001);

    const session = getLiveSessionById(server!.core.accessor, id);
    expect(session!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
  });

  it('cleans bundled staging through the settlement tracker', async () => {
    const handlers: Array<(event: { type: string; promptId?: string; promptIds?: string[]; activePromptId?: string }) => void> = [];
    const events = {
      subscribe(
        handler: (event: { type: string; promptId?: string; promptIds?: string[]; activePromptId?: string }) => void,
      ) {
        handlers.push(handler);
        return { dispose: vi.fn() };
      },
    };

    const discard = vi.fn();
    const tracker = watchPromptSettlements(events as never);
    tracker.settle('msg_1', discard);
    handlers[0]!({ type: 'prompt.completed', promptId: 'msg_other' });
    handlers[0]!({ type: 'turn.started' });
    expect(discard).not.toHaveBeenCalled();
    handlers[0]!({ type: 'prompt.completed', promptId: 'msg_1' });
    expect(discard).toHaveBeenCalledTimes(1);

    const blockedDiscard = vi.fn();
    const blockedTracker = watchPromptSettlements(events as never);
    handlers[1]!({ type: 'prompt.completed', promptId: 'msg_blocked' });
    blockedTracker.settle('msg_blocked', blockedDiscard);
    expect(blockedDiscard).toHaveBeenCalledTimes(1);

    const steered = vi.fn();
    const steeredTracker = watchPromptSettlements(events as never);
    steeredTracker.settle('msg_3', steered);
    handlers[2]!({ type: 'prompt.steered', promptIds: ['msg_3'], activePromptId: 'msg_parent' });
    expect(steered).not.toHaveBeenCalled();
    handlers[2]!({ type: 'prompt.completed', promptId: 'msg_other' });
    expect(steered).not.toHaveBeenCalled();
    handlers[2]!({ type: 'prompt.completed', promptId: 'msg_parent' });
    expect(steered).toHaveBeenCalledTimes(1);

    const aborted = vi.fn();
    const abortedTracker = watchPromptSettlements(events as never);
    abortedTracker.settle('msg_4', aborted);
    handlers[3]!({ type: 'prompt.aborted', promptId: 'msg_4' });
    expect(aborted).toHaveBeenCalledTimes(1);

    const rejected = vi.fn();
    const rejectedTracker = watchPromptSettlements(events as never);
    rejectedTracker.settle('msg_5', rejected);
    rejectedTracker.dispose();
    handlers[4]!({ type: 'prompt.completed', promptId: 'msg_5' });
    expect(rejected).not.toHaveBeenCalled();
  });

  it('makes the first three REST prompts available to title generation', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const prompts = ['先搭一个 Vite 项目', '加上路由', '现在配一下 ESLint'];
    for (const text of prompts) {
      const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text }],
      });
      expect(submitted.body.code).toBe(0);
    }

    const session = getLiveSessionById(server!.core.accessor, id);
    const agent = session?.accessor.get(IAgentLifecycleService).get('main');
    const source = agent?.accessor.get(IAgentTitlePromptSource);
    expect(source).toBeDefined();
    await expect(source!.firstUserPrompts(3)).resolves.toEqual(prompts);
  });

  it('rejects a stale file reference without creating the agent or mutating the model', async () => {
    const id = await createSession(home as string);
    const session = getLiveSessionById(server!.core.accessor, id);

    const { body } = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      model: 'stub',
      content: [
        { type: 'text', text: 'look' },
        { type: 'video', source: { kind: 'file', file_id: 'f_does_not_exist' } },
      ],
    });
    expect(body.code).toBe(40407);

    expect(session!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
  });

  it('rejects a mis-kinded file reference without creating the agent', async () => {
    const id = await createSession(home as string);
    const session = getLiveSessionById(server!.core.accessor, id);

    const form = new FormData();
    form.set('file', new Blob([Buffer.from('%PDF-1.4 fake')], { type: 'application/pdf' }), 'spec.pdf');
    const uploadRes = await fetch(`${base}/api/files`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
      body: form,
    } as never);
    const uploaded = (await uploadRes.json()) as Envelope<{ id: string }>;
    expect(uploaded.code).toBe(0);

    const { body } = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      model: 'stub',
      content: [
        { type: 'text', text: 'watch this' },
        { type: 'video', source: { kind: 'file', file_id: uploaded.data.id } },
      ],
    });
    expect(body.code).toBe(40001);
    expect(session!.accessor.get(IAgentLifecycleService).get('main')).toBeUndefined();
  });

  it('carries an uploaded video into the prompt as an internal kimi-file reference', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const videoBytes = Buffer.from('tiny fake mp4 bytes');
    const form = new FormData();
    form.set('file', new Blob([videoBytes], { type: 'video/mp4' }), 'clip.mp4');
    const uploadRes = await fetch(`${base}/api/files`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
      body: form,
    } as never);
    const uploaded = (await uploadRes.json()) as Envelope<{ id: string }>;
    expect(uploaded.code).toBe(0);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        { type: 'text', text: 'what happens in this video?' },
        { type: 'video', source: { kind: 'file', file_id: uploaded.data.id } },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'what happens in this video?' });
    expect(content[1]).toEqual({
      type: 'video',
      source: { kind: 'session_media', file_id: uploaded.data.id },
      name: 'clip.mp4',
    });

    await expectSessionMedia(server!, id, `${uploaded.data.id}.mp4`, videoBytes);
  });

  it('carries a compressed uploaded image into the prompt as an internal kimi-file reference', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const bigPng = solidPng(3600, 1800);
    const uploaded = await uploadFile(bigPng, 'image/png', 'big.png');
    expect(uploaded.size).toBe(bigPng.length);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    const caption = content[0] as { type: string; text: string };
    expect(caption.type).toBe('text');
    expect(caption.text).toContain('Image compressed');
    expect(caption.text).toContain('3600x1800');
    const pathMatch = /saved at "([^"]+)"/.exec(caption.text);
    expect(pathMatch).not.toBeNull();
    expect(pathMatch![1]!.replaceAll('\\', '/')).toContain('/media-originals/');
    expect(await readFile(pathMatch![1]!)).toEqual(bigPng);

    const image = content[1] as { type: string; source: { kind: string; file_id: string } };
    expect(image.type).toBe('image');
    expect(image.source.kind).toBe('session_media');
    const finalFileId = image.source.file_id;
    expect(finalFileId).not.toBe(uploaded.id);

    const mediaPath = join(sessionMediaDir(server!, id), `${finalFileId}.png`);
    expect(pngDimensions(await readFileEventually(mediaPath))).toEqual({ width: 2000, height: 1000 });
    expect(JSON.stringify(content)).not.toContain(mediaPath);

    const original = await server!.core.accessor.get(IFileService).get(uploaded.id);
    expect(original.meta.size).toBe(bigPng.length);

    const files = server!.core.accessor.get(IFileService);
    await vi.waitFor(async () => {
      const result = await files.get(finalFileId).catch((error: unknown) => error);
      expect(result).toMatchObject({ code: 'file.not_found' });
    });

    expect(JSON.stringify(content)).not.toContain('kimi-file://');

    const session = getLiveSessionById(server!.core.accessor, id);
    const main = session!.accessor.get(IAgentLifecycleService).get('main')!;
    const memory = main.accessor.get(IAgentContextMemoryService).get();
    const reminder = memory.find((m) => m.origin?.kind === 'injection');
    const reminderText = reminder?.content[0];
    expect(reminderText?.type).toBe('text');
    expect((reminderText as { type: 'text'; text: string }).text).toContain('<system-reminder>');
    expect((reminderText as { type: 'text'; text: string }).text).toContain('Image compressed');
  });

  it('rolls back a compressed upload when a later prompt part fails to resolve', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const first = await uploadFile(solidPng(3600, 1800), 'image/png', 'big.png');
    const second = await uploadFile(solidPng(10, 10), 'image/png', 'small.png');
    const files = server!.core.accessor.get(IFileService);
    const originalGet = files.get.bind(files);
    const originalSave = files.save.bind(files);
    let secondGets = 0;
    let compressedFileId: string | undefined;
    const getSpy = vi.spyOn(files, 'get').mockImplementation(async (fileId) => {
      if (fileId === second.id && ++secondGets === 2) {
        throw new Error('injected second-part failure');
      }
      return originalGet(fileId);
    });
    const saveSpy = vi.spyOn(files, 'save').mockImplementation(async (...args) => {
      const saved = await originalSave(...args);
      compressedFileId = saved.id;
      return saved;
    });

    try {
      const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [
          { type: 'image', source: { kind: 'file', file_id: first.id } },
          { type: 'image', source: { kind: 'file', file_id: second.id } },
        ],
      });

      expect(submitted.body.code).not.toBe(0);
      expect(compressedFileId).toBeDefined();
      if (compressedFileId === undefined) throw new Error('expected a compressed upload');
      await expect(originalGet(compressedFileId)).rejects.toMatchObject({
        code: 'file.not_found',
      });
    } finally {
      getSpy.mockRestore();
      saveSpy.mockRestore();
    }
  });

  it('carries an uncompressed uploaded image into the prompt as an internal kimi-file reference', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const smallPng = solidPng(10, 10);
    const uploaded = await uploadFile(smallPng, 'image/png', 'small.png');

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<Record<string, unknown>>;
    expect(content).toEqual([
      { type: 'image', source: { kind: 'session_media', file_id: uploaded.id }, name: 'small.png' },
    ]);

    const mediaPath = await expectSessionMedia(server!, id, `${uploaded.id}.png`, smallPng);
    expect(JSON.stringify(content)).not.toContain(mediaPath);

    expect(JSON.stringify(content)).not.toContain('kimi-file://');
  });

  it('resolves a queued uploaded image to a data URL when its provider turn starts', async () => {
    const requests: unknown[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const provider = createHttpServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      if (body.length === 0) return;
      requests.push(JSON.parse(body) as unknown);
      if (requests.length === 1) await firstGate;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        `data: ${JSON.stringify({
          id: `chatcmpl-${String(requests.length)}`,
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    if (address === null || typeof address === 'string') throw new Error('provider did not bind');

    await server!.close();
    server = undefined;
    await writeConfigToml(
      home as string,
      PROMPT_TOML
        .replace('http://127.0.0.1:9999', `http://127.0.0.1:${String(address.port)}/v1`)
        .replaceAll('max_context_size = 1000', 'max_context_size = 100000')
        .replaceAll('capabilities = ["thinking"]', 'capabilities = ["thinking", "image_in"]'),
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home as string,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;

    try {
      const id = await createSession(home as string);
      const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'text', text: 'active turn' }],
        model: 'stub',
      });
      expect(active.body.data.status).toBe('running');
      await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 5_000 });

      const image = solidPng(10, 10);
      const uploaded = await uploadFile(image, 'image/png', 'queued.png');
      const queued = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
      });
      expect(queued.body.data.status).toBe('queued');
      await expect(server.core.accessor.get(IFileService).get(uploaded.id)).resolves.toBeDefined();

      releaseFirst();
      await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 5_000 });
      expect(JSON.stringify(requests[1])).toContain(
        `data:image/png;base64,${image.toString('base64')}`,
      );
    } finally {
      releaseFirst();
      await new Promise<void>((resolve, reject) => {
        provider.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });

  it('accepts a stored session-media reference after the transient upload is deleted', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const smallPng = solidPng(10, 10);
    const uploaded = await uploadFile(smallPng, 'image/png', 'small.png');

    const first = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
    });
    expect(first.body.code).toBe(0);
    await expectSessionMedia(server!, id, `${uploaded.id}.png`, smallPng);
    await server!.core.accessor.get(IFileService).delete(uploaded.id);

    const replayed = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        { type: 'text', text: 'replay the stored image' },
        { type: 'image', source: { kind: 'session_media', file_id: uploaded.id } },
      ],
    });

    expect(replayed.body.code).toBe(0);
    expect(replayed.body.data.content).toEqual([
      { type: 'text', text: 'replay the stored image' },
      { type: 'image', source: { kind: 'session_media', file_id: uploaded.id }, name: 'small.png' },
    ]);

    const session = getLiveSessionById(server!.core.accessor, id);
    const main = session!.accessor.get(IAgentLifecycleService).get('main')!;
    await vi.waitFor(() => {
      const replayedMessage = main.accessor
        .get(IAgentContextMemoryService)
        .get()
        .find(
          (message) =>
            message.role === 'user' &&
            message.content.some(
              (part) => part.type === 'text' && part.text === 'replay the stored image',
            ),
        );
      expect(replayedMessage).toBeDefined();
      expect(replayedMessage!.content).toContainEqual({
        type: 'image_url',
        imageUrl: {
          url: `kimi-file://${uploaded.id}`,
          id: uploaded.id,
          name: 'small.png',
        },
      });
    });
  });

  it('keeps the upload-backed reference when the session media dir is not writable', async () => {
    if (process.getuid?.() === 0) return;
    const id = await createSession(home as string);
    await createMainAgent(id);
    const smallPng = solidPng(10, 10);
    const uploaded = await uploadFile(smallPng, 'image/png', 'small.png');

    const mediaDir = sessionMediaDir(server!, id);
    await mkdir(mediaDir, { recursive: true });
    await chmod(mediaDir, 0o555);
    try {
      const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
      });
      expect(submitted.body.code).toBe(0);

      const session = getLiveSessionById(server!.core.accessor, id);
      const main = session!.accessor.get(IAgentLifecycleService).get('main')!;
      await vi.waitFor(() => {
        const message = main.accessor
          .get(IAgentContextMemoryService)
          .get()
          .find((m) => m.role === 'user' && m.content.some((part) => part.type === 'image_url'));
        expect(message).toBeDefined();
        expect(message!.content).toContainEqual({
          type: 'image_url',
          imageUrl: { url: `kimi-file://${uploaded.id}`, name: 'small.png' },
        });
      });

      const cacheDir = server!.core.accessor.get(IBootstrapService).cacheDir;
      await expect(readFile(join(cacheDir, `${uploaded.id}.png`))).rejects.toThrow();
    } finally {
      await chmod(mediaDir, 0o755);
    }
  });

  it('accepts three inline images whose JSON exceeds Fastify default bodyLimit and keeps all attachments', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const images = [1, 2, 3].map((marker) => paddedPng(300 * 1024, marker));
    const content = images.map((image) => ({
      type: 'image' as const,
      source: { kind: 'base64' as const, media_type: 'image/png', data: image.toString('base64') },
    }));
    expect(Buffer.byteLength(JSON.stringify({ content }), 'utf8')).toBeGreaterThan(1 << 20);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, { content });
    expect(submitted.body.code, submitted.body.msg).toBe(0);
    const returned = submitted.body.data.content as Array<{ type: string }>;
    expect(returned.filter((part) => part.type === 'image')).toHaveLength(3);

    const session = getLiveSessionById(server!.core.accessor, id)!;
    const main = session.accessor.get(IAgentLifecycleService).get('main')!;
    await vi.waitFor(() => {
      const message = main.accessor.get(IAgentContextMemoryService).get()
        .find((item) => item.role === 'user' && item.content.filter((part) => part.type === 'image_url').length === 3);
      expect(message).toBeDefined();
    });
  });

  it('reports an oversized prompt body as a validation error without creating a prompt', async () => {
    const id = await createSession(home as string);
    const payload = JSON.stringify({
      content: [{ type: 'text', text: 'x'.repeat(PROMPT_BODY_LIMIT_BYTES) }],
    });
    const response = await server!.app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/prompts`,
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      payload,
    });
    const submitted = JSON.parse(response.body) as Envelope<PromptItemWire>;
    expect(response.statusCode).toBe(413);
    expect(submitted.code).toBe(40001);
    expect(submitted.msg).toContain('request body exceeds');
    const listed = await call<{ active: PromptItemWire | null; queued: PromptItemWire[] }>(
      'GET',
      `/api/sessions/${id}/prompts`,
    );
    expect(listed.body.code).toBe(0);
    expect(listed.body.data.active).toBeNull();
    expect(listed.body.data.queued).toHaveLength(0);
  });

  it('compresses inline base64 image prompts into session media-originals', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const bigPng = solidPng(3600, 1800);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/png',
            data: bigPng.toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(2);
    const caption = content[0];
    if (caption?.type !== 'text') throw new Error('expected compression caption');
    const pathMatch = /saved at "([^"]+)"/.exec(caption.text);
    expect(pathMatch).not.toBeNull();
    expect(pathMatch![1]!.replaceAll('\\', '/')).toContain('/media-originals/');
    expect((await realpath(pathMatch![1]!)).startsWith(await realpath(home as string))).toBe(true);
    expect(await readFile(pathMatch![1]!)).toEqual(bigPng);

    const image = content[1];
    if (image?.type !== 'image' || image.source.kind !== 'base64') {
      throw new Error('expected resolved base64 image');
    }
    expect(pngDimensions(Buffer.from(image.source.data, 'base64'))).toEqual({
      width: 2000,
      height: 1000,
    });
  });

  function avifBytes(): Buffer {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(24, 0);
    buf.write('ftyp', 4, 'latin1');
    buf.write('avif', 8, 'latin1');
    buf.write('avif', 16, 'latin1');
    return buf;
  }

  function heicBytes(): Buffer {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(24, 0);
    buf.write('ftyp', 4, 'latin1');
    buf.write('heic', 8, 'latin1');
    buf.write('heic', 16, 'latin1');
    return buf;
  }

  it('materializes an unsupported inline image as a model-independent file reference', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/png',
            data: avifBytes().toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { kind: 'session_media' },
    });
  });

  it('accepts a HEIC image against the configured default model before any model binds', async () => {
    await writeConfigToml(home as string, PROMPT_TOML.replace('default_model = "stub"', 'default_model = "stub-kimi"') + [
      '', '[providers.kimi-stub]', 'type = "kimi"', 'base_url = "http://127.0.0.1:9999"', 'api_key = "stub"',
      '', '[models.stub-kimi]', 'provider = "kimi-stub"', 'model = "kimi-k2"', 'max_context_size = 1000',
      'capabilities = ["thinking", "image_in"]', '',
    ].join('\n'));
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/heic',
            data: heicBytes().toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code, submitted.body.msg).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('image');
  });

  it('materializes HEIC when the default model does not accept it directly', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/heic',
            data: heicBytes().toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code, submitted.body.msg).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { kind: 'session_media' },
    });
  });

  it('preserves an uploaded unsupported image as a file reference', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const form = new FormData();
    form.set('file', new Blob([avifBytes()], { type: 'image/avif' }), 'photo.avif');
    const uploadRes = await fetch(`${base}/api/files`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
      body: form,
    } as never);
    const uploaded = (await uploadRes.json()) as Envelope<{ id: string }>;
    expect(uploaded.code).toBe(0);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.data.id } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { kind: 'session_media' },
      name: 'photo.avif',
    });
  });

  it('preserves a remote image URL for request-time policy handling', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'url', url: 'https://example.com/pic.avif' } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({
      type: 'image',
      source: { kind: 'url', url: 'https://example.com/pic.avif' },
    });
  });

  async function uploadFile(
    bytes: Buffer,
    mediaType: string,
    name: string,
  ): Promise<{ id: string; size: number }> {
    const form = new FormData();
    form.set('file', new Blob([bytes], { type: mediaType }), name);
    const uploadRes = await fetch(`${base}/api/files`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
      body: form,
    } as never);
    const uploaded = (await uploadRes.json()) as Envelope<{ id: string; size: number }>;
    expect(uploaded.code).toBe(0);
    return uploaded.data;
  }

  function attachedPathFrom(notice: string): string {
    const match = /bytes\): (.+) — open it with the Read tool$/.exec(notice);
    expect(match).not.toBeNull();
    return match![1]!;
  }

  it('materializes an arbitrary file attachment into the session attachments dir', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const pdfBytes = Buffer.from('%PDF-1.4 fake pdf bytes');
    const uploaded = await uploadFile(pdfBytes, 'application/pdf', 'report.pdf');

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        { type: 'text', text: 'summarize this' },
        { type: 'file', file_id: uploaded.id, name: 'report.pdf', media_type: 'application/pdf', size: pdfBytes.length },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'summarize this' });
    const notice = content[1];
    expect(notice?.type).toBe('text');
    expect(notice?.text).toContain('Attached file "report.pdf"');
    expect(notice?.text).toContain('application/pdf');
    expect(notice?.text).toContain(`${pdfBytes.length} bytes`);
    const attachedPath = attachedPathFrom(notice?.text ?? '');
    expect(attachedPath.replaceAll('\\', '/')).toContain('/attachments/');
    expect(attachedPath.endsWith(`${uploaded.id}-report.pdf`)).toBe(true);
    expect((await realpath(attachedPath)).startsWith(await realpath(home as string))).toBe(true);
    expect(await readFile(attachedPath)).toEqual(pdfBytes);
  });

  it('preserves an uploaded SVG image as a file reference', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    const uploaded = await uploadFile(svgBytes, 'image/svg+xml', 'vector.svg');

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'image', source: { kind: 'file', file_id: uploaded.id } }],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { kind: 'session_media' },
      name: 'vector.svg',
    });
  });

  it('persists an unsupported inline image as a file reference', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const data = avifBytes();

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        {
          type: 'image',
          source: {
            kind: 'base64',
            media_type: 'image/avif',
            data: data.toString('base64'),
          },
        },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as PromptContentPart[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { kind: 'session_media' },
    });
  });

  it('sanitizes an attachment file name before materializing it', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const scriptBytes = Buffer.from('#!/bin/sh\necho hi');
    const uploaded = await uploadFile(scriptBytes, 'text/plain', '../../etc/evil.sh');

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [
        { type: 'file', file_id: uploaded.id, name: '../../etc/evil.sh', media_type: 'text/plain', size: scriptBytes.length },
      ],
    });
    expect(submitted.body.code).toBe(0);

    const content = submitted.body.data.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    const attachedPath = attachedPathFrom(content[0]?.text ?? '');
    expect(dirname(attachedPath).replaceAll('\\', '/').endsWith('/attachments')).toBe(true);
    expect((await realpath(attachedPath)).startsWith(await realpath(home as string))).toBe(true);
    expect(await readFile(attachedPath)).toEqual(scriptBytes);
  });

  it('replaces a queued prompt in place while preserving identity, order, and attachments', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id);
    const main = session!.accessor.get(IAgentLifecycleService).get('main');
    const prompt = main!.accessor.get(IAgentPromptService);
    const first = {
      id: 'prompt-first',
      userMessageId: 'prompt-first',
      createdAt: '2026-01-01T00:00:01.000Z',
      state: 'pending' as const,
      message: {
        id: 'prompt-first',
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'old text' },
          { type: 'image_url' as const, imageUrl: { url: 'https://example.com/queued.png' } },
        ],
        toolCalls: [],
        origin: { kind: 'user' as const },
      },
      launched: Promise.resolve(undefined),
      completion: new Promise<never>(() => undefined),
    };
    const second = {
      id: 'prompt-second',
      userMessageId: 'prompt-second',
      createdAt: '2026-01-01T00:00:02.000Z',
      state: 'pending' as const,
      message: {
        id: 'prompt-second',
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'second queued' }],
        toolCalls: [],
        origin: { kind: 'user' as const },
      },
    };
    vi.spyOn(prompt, 'list').mockImplementation(() => ({ active: undefined, pending: [first, second] }));
    const replace = vi.spyOn(prompt, 'replace').mockImplementation((promptId, content) => {
      expect(promptId).toBe(first.id);
      expect(content).toEqual([{ type: 'text', text: 'new text' }]);
      first.message.content = [
        ...content,
        { type: 'image_url', imageUrl: { url: 'https://example.com/queued.png' } },
      ] as never;
      return first;
    });
    const abort = vi.spyOn(prompt, 'abort');

    const replaced = await call<PromptItemWire>(
      'POST',
      `/api/sessions/${id}/prompts/${first.id}:replace`,
      { content: [{ type: 'text', text: 'new text' }] },
    );
    expect(replaced.body.code).toBe(0);
    expect(replaced.body.data).toMatchObject({
      prompt_id: first.id,
      user_message_id: first.userMessageId,
      status: 'queued',
      created_at: first.createdAt,
    });
    expect(replaced.body.data.content).toEqual([
      { type: 'text', text: 'new text' },
      { type: 'image', source: { kind: 'url', url: 'https://example.com/queued.png' } },
    ]);
    expect(replace).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(prompt.list().pending.map((item) => item.id)).toEqual([first.id, second.id]);

    const list = await call<{ active: PromptItemWire | null; queued: PromptItemWire[] }>(
      'GET',
      `/api/sessions/${id}/prompts`,
    );
    expect(list.body.data.queued[0]).toEqual(replaced.body.data);
  });

  it('rejects replacement of a non-queued prompt without aborting or changing it', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id);
    const main = session!.accessor.get(IAgentLifecycleService).get('main');
    const prompt = main!.accessor.get(IAgentPromptService);
    const active = {
      id: 'prompt-active',
      userMessageId: 'prompt-active',
      createdAt: '2026-01-01T00:00:00.000Z',
      state: 'running' as const,
      message: {
        id: 'prompt-active',
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'active text' }],
        toolCalls: [],
        origin: { kind: 'user' as const },
      },
    };
    vi.spyOn(prompt, 'list').mockImplementation(() => ({ active, pending: [] }));
    const abort = vi.spyOn(prompt, 'abort');

    const replaced = await call<null>(
      'POST',
      `/api/sessions/${id}/prompts/${active.id}:replace`,
      { content: [{ type: 'text', text: 'must not apply' }] },
    );

    expect(replaced.body.code).toBe(40402);
    expect(abort).not.toHaveBeenCalled();
    expect(prompt.list().active).toEqual(active);
    expect(prompt.list().active?.message.content).toEqual([
      { type: 'text', text: 'active text' },
    ]);
  });

  it('returns 40402 when aborting a prompt that already settled', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
    });
    const promptId = submitted.body.data.prompt_id;

    const aborted = await call<{ aborted: boolean }>(
      'POST',
      `/api/sessions/${id}/prompts/${promptId}:abort`,
    );
    expect(aborted.body.code).toBe(40402);
  });

  it('returns 40402 when aborting an unknown prompt', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const { body } = await call<null>(
      'POST',
      `/api/sessions/${id}/prompts/prompt_does_not_exist:abort`,
    );
    expect(body.code).toBe(40402);
  });

  it('returns 40401 for an unknown session', async () => {
    const { body } = await call<null>('POST', '/api/sessions/nope/prompts', {
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(body.code).toBe(40401);
  });

  it('lists prompts for a persisted session with no live handle (cold resume)', async () => {
    const id = await createSession(home as string);
    await closeSessionById(server!.core.accessor, id);
    expect(getLiveSessionById(server!.core.accessor, id)).toBeUndefined();

    const list = await call<{ active: PromptItemWire | null; queued: PromptItemWire[] }>(
      'GET',
      `/api/sessions/${id}/prompts`,
    );
    expect(list.body.code).toBe(0);
    expect(list.body.data.active).toBeNull();
    expect(list.body.data.queued).toEqual([]);
  });

  it.each([
    ['live-terminal', false],
    ['set-model', false],
    ['second-restored', true],
  ] as const)('registers every prompt run after %s (skills=%s)', async (mode, skills) => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    let child = await lifecycle.create({ binding: { profile: 'agent', model: 'stub', thinking: 'high' } });
    const childId = child.id;
    const blockInitial = (handle: typeof child): void => {
      handle.accessor.get(IAgentPromptService).hooks.onBeforeSubmitPrompt.register('block-initial-run', (context) => {
        if (context.promptMessage.content.some((part) => part.type === 'text' && part.text === 'initial run')) context.block = true;
      });
    };
    blockInitial(child);
    const initialSubscription = lifecycle.onDidCreate((handle) => { if (handle.id === childId) blockInitial(handle); });
    if (mode !== 'live-terminal') await lifecycle.remove(childId);
    if (mode === 'set-model') {
      const klient = createMemoryKlient({ scope: server!.core });
      await klient.session(id).agent(childId).setModel('stub-alt');
      await klient.close();
    } else {
      const initial = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        agent_id: childId, content: [{ type: 'text', text: 'initial run' }],
      });
      expect(initial.body.code, initial.body.msg).toBe(0);
      await lifecycle.get(childId)!.accessor.get(IAgentExecutionService).settled();
    }
    child = lifecycle.get(childId)!;
    initialSubscription.dispose();
    child.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-prompt-runs', async (context) => {
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      context.signal.throwIfAborted();
    }, { before: 'context-injector' });
    const tasks = lifecycle.get('main')!.accessor.get(IAgentTaskService);
    const seen = new Set<string>();
    for (let run = 0; run < 2; run++) {
      const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        agent_id: childId, content: [{ type: 'text', text: `managed run ${run}` }],
        skills: skills ? [{ name: 'kiki-ops' }] : undefined,
      });
      expect(submitted.body.code, submitted.body.msg).toBe(0);
      const task = await vi.waitFor(() => {
        const found = tasks.list(true).filter((item) => item.kind === 'agent' && item.agentId === childId);
        expect(found).toHaveLength(1);
        return found[0]!;
      });
      expect(seen.has(task.taskId)).toBe(false);
      seen.add(task.taskId);
      expect(child.accessor.get(IAgentExecutionService).status().state).toBe('running');
      await tasks.stopByUser(task.taskId);
      await vi.waitFor(() => expect(tasks.getTask(task.taskId)?.status).toBe('killed'));
      await child.accessor.get(IAgentExecutionService).settled();
      expect(child.accessor.get(IAgentPromptService).list().active).toBeUndefined();
    }
  });

  it.each([false, true])('admits the parent before submitting a child prompt (skills=%s)', async (skills) => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const parent = await lifecycle.create({ binding: { profile: 'agent', model: 'stub', thinking: 'high' } });
    const child = await lifecycle.create({
      delegator: { kind: 'agent', agentId: parent.id },
      binding: { profile: 'agent', model: 'stub', thinking: 'high' },
    });
    await lifecycle.remove(parent.id);
    const create = lifecycle.create.bind(lifecycle);
    vi.spyOn(lifecycle, 'create').mockImplementation((options) => {
      if (options?.agentId === parent.id) throw new Error('parent restore failed');
      return create(options);
    });
    const enqueue = vi.spyOn(child.accessor.get(IAgentPromptService), 'enqueue');
    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      agent_id: child.id, content: [{ type: 'text', text: 'must not start' }],
      skills: skills ? [{ name: 'kiki-ops' }] : undefined,
    });
    expect(submitted.body.code).not.toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(child.accessor.get(IAgentExecutionService).status().state).toBe('idle');
    expect(child.accessor.get(IAgentPromptService).list().pending).toEqual([]);
  });

  it('does not submit a child when task admission fails', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.create({ binding: { profile: 'agent', model: 'stub', thinking: 'high' } });
    vi.spyOn(session.accessor.get(ISessionDispatchService), 'recordRun').mockRejectedValueOnce(new Error('run registration failed'));
    const enqueue = vi.spyOn(child.accessor.get(IAgentPromptService), 'enqueue');
    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      agent_id: child.id, content: [{ type: 'text', text: 'must not start' }],
    });
    expect(submitted.body.code).not.toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    await child.accessor.get(IAgentExecutionService).settled();
    expect(lifecycle.get('main')!.accessor.get(IAgentTaskService).list(true)).toEqual([]);
  });

  it('keeps the later cold prompt task running when the earlier task settles', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id)!;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.create({ binding: { profile: 'agent', model: 'stub', thinking: 'high' } });
    await lifecycle.remove(child.id);
    const parent = lifecycle.get('main')!;
    const runTasks: string[] = [];
    const subscription = parent.accessor.get(IEventBus).subscribe((event) => {
      if (event.type === 'subagent.started' && 'taskId' in event && typeof event.taskId === 'string') {
        runTasks.push(event.taskId);
      }
    });
    let creates = 0;
    const onCreate = lifecycle.onDidCreate((handle) => {
      if (handle.id !== child.id) return;
      creates++;
      handle.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-cold-prompts', async (context) => {
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        context.signal.throwIfAborted();
      }, { before: 'context-injector' });
    });
    await call('GET', `/api/sessions/${id}/transcript?agent_id=main`);
    const submitted = await Promise.all(['cold-a', 'cold-b'].map((promptId) =>
      call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
        agent_id: child.id, prompt_id: promptId, content: [{ type: 'text', text: promptId }],
      }),
    ));
    expect(submitted.map((response) => response.body.code)).toEqual([0, 0]);
    expect(creates).toBe(1);
    expect(new Set(runTasks).size).toBe(2);
    const tasks = parent.accessor.get(IAgentTaskService);
    await tasks.stopByUser(runTasks[0]!);
    await vi.waitFor(async () => {
      expect(tasks.getTask(runTasks[0]!)?.status).toBe('killed');
      expect(tasks.getTask(runTasks[1]!)?.status).toBe('running');
      const transcript = await call<{ tasks: { taskId: string; state: string }[] }>('GET', `/api/sessions/${id}/transcript?agent_id=main`);
      expect(transcript.body.data.tasks.find((task) => task.taskId === runTasks[1])).toMatchObject({ state: 'running' });
    });
    await tasks.stopByUser(runTasks[1]!);
    await lifecycle.get(child.id)!.accessor.get(IAgentExecutionService).settled();
    onCreate.dispose();
    subscription.dispose();
  });

  it('accepts a prompt for a live agent after its previous turn settled', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.fork('main');

    const first = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'first side question' }],
      agent_id: child.id,
    });
    expect(first.body.code).toBe(0);
    await child.accessor.get(IAgentExecutionService).settled();
    expect(child.accessor.get(IAgentExecutionService).status().state).toBe('idle');

    const second = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'follow-up side question' }],
      agent_id: child.id,
    });

    expect(second.body.code).toBe(0);
    expect(lifecycle.get(child.id)).toBe(child);
    expect(
      child.accessor.get(IAgentContextMemoryService).get().some(
        (message) => message.role === 'user' && message.content.some(
          (part) => part.type === 'text' && part.text === 'follow-up side question',
        ),
      ),
    ).toBe(true);
  });

  it('restores a disposed agent and starts the submitted prompt as a new turn', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const child = await lifecycle.fork('main');
    const first = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'before release' }],
      agent_id: child.id,
      profile: 'agent',
      model: 'stub',
      thinking: 'high',
    });
    expect(first.body.code).toBe(0);
    await child.accessor.get(IAgentExecutionService).settled();
    await lifecycle.remove(child.id);
    expect(lifecycle.get(child.id)).toBeUndefined();
    const parent = lifecycle.get('main')!;
    const observed: string[] = [];
    const eventSubscription = parent.accessor.get(IEventBus).subscribe((event) => {
      if (
        event.type === 'task.started' ||
        event.type === 'task.terminated' ||
        event.type === 'subagent.spawned' ||
        event.type === 'subagent.started' ||
        event.type === 'subagent.failed'
      ) observed.push(event.type);
    });
    const createSubscription = lifecycle.onDidCreate((handle) => {
      if (handle.id !== child.id) return;
      handle.accessor.get(IAgentLoopService).hooks.onWillBeginStep.register(
        'hold-restored-child-turn',
        async (context) => {
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            else context.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          context.signal.throwIfAborted();
        },
        { before: 'context-injector' },
      );
    });

    const resumed = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'after release' }],
      agent_id: child.id,
    });

    expect(resumed.body.code, resumed.body.msg).toBe(0);
    const restored = lifecycle.get(child.id);
    expect(restored).toBeDefined();
    expect(restored).not.toBe(child);
    expect(
      restored!.accessor.get(IAgentContextMemoryService).get().some(
        (message) => message.role === 'user' && message.content.some(
          (part) => part.type === 'text' && part.text === 'after release',
        ),
      ),
    ).toBe(true);
    const tasks = parent.accessor.get(IAgentTaskService);
    const task = await vi.waitFor(() => {
      const found = tasks.list(true).find((item) => item.kind === 'agent' && item.agentId === child.id);
      expect(found).toBeDefined();
      return found!;
    });
    await vi.waitFor(() => {
      expect(observed).toEqual(expect.arrayContaining([
        'task.started',
        'subagent.spawned',
        'subagent.started',
      ]));
    });
    await tasks.stopByUser(task.taskId);
    await vi.waitFor(() => {
      expect(tasks.getTask(task.taskId)?.status).toBe('killed');
      expect(observed).toEqual(expect.arrayContaining(['task.terminated', 'subagent.failed']));
    });
    createSubscription.dispose();
    eventSubscription.dispose();
  });

  it('reports incomplete persisted binding metadata for a known disposed agent', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    await session.accessor.get(ISessionMetadata).registerAgent('agent-incomplete', {
      type: 'sub',
      parentAgentId: 'main',
      labels: { profileName: 'explore' },
      model: 'stub',
    });

    const { body } = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'resume me' }],
      agent_id: 'agent-incomplete',
    });

    expect(body.code).toBe(40001);
    expect(body.msg).toContain('Persisted binding metadata');
    expect(body.msg).toContain('thinkingEffort');
  });

  it('returns 40401 when agent_id names an unknown agent', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const { body } = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      agent_id: 'agent_does_not_exist',
    });
    expect(body.code).toBe(40401);
  });

  it('rejects an unknown agent profile with 40001', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const { body } = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      profile: 'agent_does_not_exist',
      model: 'stub',
    });
    expect(body.code).toBe(40001);
    expect(body.msg).toContain('agent_does_not_exist');
  });

  it('rejects a queued profile switch while the active binding is route-locked', async () => {
    await mkdir(join(home as string, 'agents'), { recursive: true });
    await writeFile(
      join(home as string, 'agents', 'coder.md'),
      ['---', 'name: coder', 'description: test profile for the route-lock rejection', '---', '', 'You are a test coder.', ''].join('\n'),
      'utf-8',
    );
    const id = await createSession(home as string);
    await createMainAgent(id);
    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const main = session.accessor.get(IAgentLifecycleService).get('main');
    if (main === undefined) throw new Error('main agent not found');
    const profile = main.accessor.get(IAgentProfileService);
    await profile.bind({ profile: 'agent', model: 'stub' });
    const binding = profile.data();
    profile.applyBindingSnapshot({
      modelAlias: binding.modelAlias,
      profileName: binding.profileName,
      routeId: 'agent.locked',
      lockedModelAlias: binding.modelAlias,
      thinkingLevel: binding.thinkingLevel,
      systemPrompt: binding.systemPrompt,
      activeToolNames: binding.activeToolNames,
      toolAllowPolicies: binding.toolAllowPolicies,
      disallowedTools: binding.disallowedTools,
      subagents: binding.subagents,
      subagentLeases: binding.subagentLeases,
      spawnPolicy: binding.spawnPolicy,
    });

    const active = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'active' }],
    });
    expect(active.body.code).toBe(0);
    const prompt = main.accessor.get(IAgentPromptService);
    expect(prompt.list().active?.id).toBe(active.body.data.prompt_id);

    const rejected = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'queued' }],
      profile: 'coder',
    });
    expect(rejected.body.code).toBe(40001);
    expect(rejected.body.msg).toContain('agent.locked');
    expect(profile.data()).toMatchObject({
      profileName: 'agent',
      routeId: 'agent.locked',
      modelAlias: 'stub',
    });
    expect(prompt.list().pending).toEqual([]);
    prompt.abort(active.body.data.prompt_id);
  });

  it('binds a discovered custom agent profile on the first prompt', async () => {
    await mkdir(join(home as string, 'agents'), { recursive: true });
    await writeFile(
      join(home as string, 'agents', 'route-reviewer.md'),
      [
        '---',
        'name: route-reviewer',
        'description: reviewer defined by a user-level agent file',
        '---',
        '',
        'You are a route-test reviewer.',
        '',
      ].join('\n'),
      'utf-8',
    );
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      profile: 'route-reviewer',
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const main = session.accessor.get(IAgentLifecycleService).get('main');
    expect(main?.accessor.get(IAgentProfileService).data().profileName).toBe('route-reviewer');

    const again = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'again' }],
      profile: 'route-reviewer',
    });
    expect(again.body.code).toBe(0);
  });

  it('rebinds the main profile, applies pins and overrides, and survives resume', async () => {
    await mkdir(join(home as string, 'agents'), { recursive: true });
    await writeFile(
      join(home as string, 'agents', 'pinned-profile.md'),
      [
        '---',
        'name: pinned-profile',
        'description: Uses the pinned model and effort',
        'model_alias: stub-alt',
        'thinking_effort: low',
        '---',
        '',
        'Pinned profile.',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(home as string, 'agents', 'override-profile.md'),
      [
        '---',
        'name: override-profile',
        'description: Allows explicit request overrides',
        'model_alias: stub-alt',
        'thinking_effort: low',
        '---',
        '',
        'Override profile.',
        '',
      ].join('\n'),
      'utf-8',
    );
    await (server as RunningServer).close();
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home as string,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;

    const id = await createSession(home as string);
    await createMainAgent(id);

    const first = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      profile: 'agent',
      model: 'stub',
      thinking: 'high',
    });
    expect(first.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const main = session.accessor.get(IAgentLifecycleService).get('main');
    if (main === undefined) throw new Error('main agent not found');
    const prompt = main.accessor.get(IAgentPromptService);
    expect(prompt.abort(first.body.data.prompt_id)).toBe(true);
    await vi.waitFor(() => expect(prompt.list().active).toBeUndefined(), { timeout: 10_000 });

    const rebound = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'use the pinned profile' }],
      profile: 'pinned-profile',
    });
    expect(rebound.body.code, JSON.stringify(rebound.body)).toBe(0);

    const profile = main.accessor.get(IAgentProfileService);
    expect(profile?.data()).toMatchObject({
      profileName: 'pinned-profile',
      modelAlias: 'stub-alt',
      thinkingLevel: 'low',
    });
    expect((await session.accessor.get(ISessionMetadata).read()).agents?.['main']).toMatchObject({
      displayName: 'pinned-profile',
      model: 'stub-alt',
      thinkingEffort: 'low',
    });
    const currentSession = await call<{ agent_config: { model: string; profile?: string } }>(
      'GET',
      `/api/sessions/${id}`,
    );
    expect(currentSession.body.data.agent_config).toEqual({
      model: 'stub-alt',
      profile: 'pinned-profile',
    });

    await closeSessionById(server!.core.accessor, id);
    const resumed = await resumeSessionById(server!.core.accessor, id);
    const resumedProfile = resumed?.accessor
      .get(IAgentLifecycleService)
      .get('main')
      ?.accessor.get(IAgentProfileService);
    expect(resumedProfile?.data()).toMatchObject({
      profileName: 'pinned-profile',
      modelAlias: 'stub-alt',
      thinkingLevel: 'low',
    });

    const overridden = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'override the new pin' }],
      profile: 'override-profile',
      model: 'stub',
      thinking: 'high',
    });
    expect(overridden.body.code).toBe(0);
    const overriddenProfile = getLiveSessionById(server!.core.accessor, id)?.accessor
      .get(IAgentLifecycleService)
      .get('main')
      ?.accessor.get(IAgentProfileService);
    expect(overriddenProfile?.data()).toMatchObject({
      profileName: 'override-profile',
      modelAlias: 'stub',
      thinkingLevel: 'high',
    });
  });

  it('applies a requested thinking effort together with the profile bind', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      profile: 'agent',
      model: 'stub',
      thinking: 'high',
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const main = session.accessor.get(IAgentLifecycleService).get('main');
    const profile = main?.accessor.get(IAgentProfileService);
    expect(profile?.data().profileName).toBe('agent');
    expect(profile?.data().thinkingLevel).toBe('high');
  });

  it('applies disabled_tools on the first prompt and replaces them on later prompts', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      model: 'stub',
      disabled_tools: ['Bash'],
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const toolPolicy = session.accessor.get(IAgentLifecycleService).get('main')?.accessor
      .get(IAgentToolPolicyService);
    expect(toolPolicy?.isToolActive('Bash')).toBe(false);
    expect(toolPolicy?.isToolActive('Read')).toBe(true);

    const replaced = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'again' }],
      disabled_tools: ['Write'],
    });
    expect(replaced.body.code).toBe(0);
    expect(toolPolicy?.isToolActive('Bash')).toBe(true);
    expect(toolPolicy?.isToolActive('Write')).toBe(false);

    const cleared = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'once more' }],
      disabled_tools: [],
    });
    expect(cleared.body.code).toBe(0);
    expect(toolPolicy?.isToolActive('Write')).toBe(true);
  });

  it('shares disabled_tools with agents created after the request', async () => {
    await mkdir(join(home as string, 'agents'), { recursive: true });
    await writeFile(
      join(home as string, 'agents', 'coder.md'),
      ['---', 'name: coder', 'description: test profile for the tool-policy inheritance', '---', '', 'You are a test coder.', ''].join('\n'),
      'utf-8',
    );
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      model: 'stub',
      disabled_tools: ['Bash'],
    });
    expect(submitted.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const child = await session.accessor.get(IAgentLifecycleService).create({
      binding: {
        profile: 'coder',
        model: 'stub',
      },
    });

    const childToolPolicy = child.accessor.get(IAgentToolPolicyService);
    expect(childToolPolicy.isToolActive('Bash')).toBe(false);
    expect(childToolPolicy.isToolActive('Read')).toBe(true);
  });

  it('rejects disabled_tools before the agent profile is bound', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const { body } = await call<null>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      disabled_tools: ['Bash'],
    });
    expect(body.code).toBe(40001);
  });

  it('persists disabled_tools across a cold resume', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const submitted = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'hello' }],
      model: 'stub',
      disabled_tools: ['Bash'],
    });
    expect(submitted.body.code).toBe(0);

    await closeSessionById(server!.core.accessor, id);
    expect(getLiveSessionById(server!.core.accessor, id)).toBeUndefined();

    const again = await call<PromptItemWire>('POST', `/api/sessions/${id}/prompts`, {
      content: [{ type: 'text', text: 'again' }],
    });
    expect(again.body.code).toBe(0);

    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not found`);
    const toolPolicy = session.accessor.get(IAgentLifecycleService).get('main')?.accessor
      .get(IAgentToolPolicyService);
    expect(toolPolicy?.isToolActive('Bash')).toBe(false);
    expect(toolPolicy?.isToolActive('Read')).toBe(true);
  });
});
