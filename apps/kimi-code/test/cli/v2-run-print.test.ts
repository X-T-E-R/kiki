import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentTaskService,
  IAuthSummaryService,
  IBootstrapService,
  IConfigService,
  IEventBus,
  IEventDispatcher,
  ISessionCronService,
  ISessionIndex,
  ISessionManager,
  ISessionMetadata,
  IAgentLoopService,
  type BootstrapInput,
  type Event2,
} from '@kiki/agent-core-v2';

import { runV2Print } from '../../src/cli/v2/run-v2-print';

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  ensureMainAgent: vi.fn(),
  createKimiDefaultHeaders: vi.fn(() => ({})),
  resolveKikiHome: vi.fn((homeDir?: string) => homeDir ?? '/tmp/kimi-code-test-home'),
  createKimiDeviceId: vi.fn(() => 'device-1'),
}));

vi.mock('@kiki/agent-core-v2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kiki/agent-core-v2')>();
  return {
    ...actual,
    bootstrap: mocks.bootstrap,
    ensureMainAgent: mocks.ensureMainAgent,
  };
});

vi.mock('@kiki/agent-core-v2/session/agentLifecycle/mainAgent', () => ({ ensureMainAgent: mocks.ensureMainAgent }));

vi.mock('@kiki/oauth', async () => {
  const actual = await vi.importActual<typeof import('@kiki/oauth')>(
    '@kiki/oauth',
  );
  return {
    ...actual,
    createKimiDefaultHeaders: mocks.createKimiDefaultHeaders,
    createKimiDeviceId: mocks.createKimiDeviceId,
  };
});

vi.mock('@kiki/node-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kiki/node-sdk')>();
  return {
    ...actual,
    resolveKikiHome: mocks.resolveKikiHome,
  };
});

interface FakeScope {
  readonly id: string;
  readonly accessor: { readonly get: (token: unknown) => unknown };
  readonly dispose: ReturnType<typeof vi.fn>;
}

function fakeScope(id: string, services: Map<unknown, unknown>): FakeScope {
  return {
    id,
    accessor: {
      get: (token: unknown) => {
        if (!services.has(token)) throw new Error(`unexpected service request: ${String(token)}`);
        return services.get(token);
      },
    },
    dispose: vi.fn(),
  };
}

function writer() {
  let text = '';
  return {
    write: vi.fn((chunk: string) => {
      text += chunk;
      return true;
    }),
    text: () => text,
  };
}

function opts(overrides: Record<string, unknown> = {}) {
  return {
    session: undefined,
    continue: false,
    yolo: false,
    auto: false,
    plan: false,
    model: undefined,
    outputFormat: undefined,
    prompt: 'say hello',
    skillsDirs: [],
    agent: undefined,
    agentFiles: [],
    addDirs: [],
    ...overrides,
  } as const;
}

function makeFakeHarness() {
  const eventListeners = new Set<(event: Event2<any>) => void>();
  const profileState: { profileName: string | undefined } = { profileName: undefined };
  const agentServices = new Map<unknown, unknown>([
    [IAgentProfileService, {
      bind: vi.fn(async () => {}), setModel: vi.fn(async () => ({ model: 'k2' })),
      setThinking: vi.fn(), getModel: () => 'k2', data: () => ({ profileName: profileState.profileName }),
    }],
    [IAgentPermissionModeService, { mode: 'auto', setMode: vi.fn() }],
    [IAgentLoopService, { cancelFromUser: vi.fn() }],
    [IEventBus, {
      subscribe: vi.fn((handler: (event: Event2<any>) => void) => {
        eventListeners.add(handler);
        return { dispose: () => eventListeners.delete(handler) };
      }),
    }],
    [IAgentPromptService, {
      submitAndWait: vi.fn(async () => {
        for (const listener of [...eventListeners]) {
          listener({ type: 'assistant.delta', turnId: 1, delta: 'hello world' } as unknown as Event2<any>);
        }
        return { promptId: 'print-example', turnId: 1, state: 'completed', result: { type: 'completed', steps: 1, truncated: false } };
      }),
    }],
    [IAgentGoalService, { createGoal: vi.fn(), getGoal: vi.fn(() => ({ goal: null })) }],
    [IEventDispatcher, { flush: vi.fn(async () => {}) }],
  ]);
  const agent = fakeScope('main', agentServices);
  const sessionServices = new Map<unknown, unknown>([
    [IAgentLifecycleService, {
      countPendingBackgroundTasks: vi.fn(() => 0),
      drainBackgroundTasks: vi.fn(async () => {}),
      list: vi.fn(() => [agent]),
    }],
    [ISessionCronService, { getNextFireTime: vi.fn(() => null) }],
    [ISessionMetadata, { read: vi.fn(async () => ({ id: 'ses_v2', createdAt: 1, updatedAt: 1, archived: false })) }],
  ]);
  const session = { ...fakeScope('ses_v2', sessionServices), kind: 'session' };
  const appServices = new Map<unknown, unknown>([
    [IConfigService, {
      ready: Promise.resolve(),
      get: vi.fn((section: string) => (section === 'defaultModel' ? 'k2' : undefined)),
      inspect: vi.fn(() => ({ value: {} })), set: vi.fn(async () => {}), diagnostics: vi.fn(() => []),
    }],
    [IAuthSummaryService, { ensureReady: vi.fn(async () => {}) }],
    [ISessionManager, {
      create: vi.fn(async () => session), resume: vi.fn(async () => session),
      get: vi.fn(() => session), list: vi.fn(() => [session]), close: vi.fn(async () => {}),
    }],
    [ISessionIndex, { prepare: vi.fn(async () => {}), get: vi.fn(async () => undefined), listRecent: vi.fn(async () => ({ items: [] })) }],
    [IBootstrapService, { osHomeDir: '/home/test' }],
  ]);
  const app = fakeScope('app', appServices);
  return { app, agent, session, agentServices, appServices, profileState };
}

describe('runV2Print', () => {
  beforeEach(() => {
    vi.stubEnv('KIKI_EXPERIMENTAL_FLAG', '1');
    vi.stubEnv('KIKI_MODEL_OUTPUT_FORMAT', '');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    { label: 'profile pin beats global default', defaultModel: 'fallback', profileModel: 'example', explicitModel: undefined, expectedModel: 'gpt-4o-mini' },
    { label: 'profile pin works without global default', defaultModel: undefined, profileModel: 'example', explicitModel: undefined, expectedModel: 'gpt-4o-mini' },
    { label: 'explicit CLI model beats profile pin', defaultModel: 'fallback', profileModel: 'example', explicitModel: 'fallback', expectedModel: 'gpt-4o-fallback' },
    { label: 'global default fills an unpinned profile', defaultModel: 'fallback', profileModel: undefined, explicitModel: undefined, expectedModel: 'gpt-4o-fallback' },
  ])('runs the real print host with engine model resolution: $label', async ({ defaultModel, profileModel, explicitModel, expectedModel }) => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-print-live-'));
    const homeDir = join(root, 'home');
    const workDir = join(root, 'work');
    await mkdir(homeDir); await mkdir(workDir);
    const requests: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        requests.push(body);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const base = { id: 'print-local', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini' };
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'LOCAL_PRINT_OK' }, finish_reason: null }] })}\n\n`);
        res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('local provider did not bind');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(workDir);
    try {
      await writeFile(join(homeDir, 'config.toml'), [
        defaultModel === undefined ? '' : `default_model = "${defaultModel}"`,
        '[providers.example]', 'type = "openai"', `base_url = "http://127.0.0.1:${address.port}/v1"`, 'api_key = "test-only"',
        '[models.example]', 'provider = "example"', 'model = "gpt-4o-mini"', 'protocol = "openai"',
        'max_context_size = 32000', 'max_output_size = 128', 'capabilities = ["tool_use"]',
        '[models.fallback]', 'provider = "example"', 'model = "gpt-4o-fallback"', 'protocol = "openai"',
        'max_context_size = 32000', 'max_output_size = 128', 'capabilities = ["tool_use"]',
        '[task]', 'print_background_mode = "exit"',
      ].join('\n'));
      await writeFile(join(homeDir, 'SYSTEM.md'), profileModel === undefined
        ? 'You are a test agent.'
        : `---\nmodel_alias: ${profileModel}\n---\nYou are a test agent.`);
      const actual = await vi.importActual<typeof import('@kiki/agent-core-v2')>('@kiki/agent-core-v2');
      const main = await vi.importActual<typeof import('@kiki/agent-core-v2/session/agentLifecycle/mainAgent')>('@kiki/agent-core-v2/session/agentLifecycle/mainAgent');
      mocks.bootstrap.mockImplementation(actual.bootstrap);
      mocks.ensureMainAgent.mockImplementation(main.ensureMainAgent);
      mocks.resolveKikiHome.mockReturnValue(homeDir);
      const stdout = writer(); const stderr = writer();
      await runV2Print(opts({ model: explicitModel }) as never, 'test', { stdout, stderr });
      expect(stdout.text()).toContain('LOCAL_PRINT_OK');
      expect(requests).toHaveLength(1);
      expect(JSON.parse(requests[0]!).model).toBe(expectedModel);
      expect(JSON.parse(requests[0]!).messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user' })]));
      expect(stderr.text()).not.toContain('print event delivery failed');
    } finally {
      cwd.mockRestore();
      mocks.resolveKikiHome.mockImplementation((home?: string) => home ?? '/tmp/kimi-code-test-home');
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 60_000);

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('cancels and restores a resumed agent once on %s', async (signal) => {
    const { app, agent, agentServices, appServices } = makeFakeHarness();
    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue(agent);
    const index = appServices.get(ISessionIndex) as { get: ReturnType<typeof vi.fn> };
    index.get.mockResolvedValue({ id: 'ses_v2', cwd: process.cwd(), workspaceId: 'example', createdAt: 1, updatedAt: 1, archived: false });
    const permission = agentServices.get(IAgentPermissionModeService) as { mode: string; setMode: ReturnType<typeof vi.fn> };
    permission.mode = 'manual';
    const prompts = agentServices.get(IAgentPromptService) as { submitAndWait: Mock<IAgentPromptService['submitAndWait']> };
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    prompts.submitAndWait.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => { finish = resolve; });
      return { promptId: 'cancel-example', turnId: 1, state: 'cancelled', result: {
        type: 'cancelled', steps: 1, reason: { code: 'internal', message: 'cancelled', retryable: false },
      } };
    });
    const loop = agentServices.get(IAgentLoopService) as { cancelFromUser: ReturnType<typeof vi.fn> };
    loop.cancelFromUser.mockImplementation(() => finish());
    const handlers = new Map<NodeJS.Signals, () => Promise<void>>();
    const exit = vi.fn();
    const run = runV2Print(opts({ session: 'ses_v2' }) as never, 'test', {
      stdout: writer(), stderr: writer(),
      process: { once: (name, fn) => handlers.set(name, fn), off: (name) => handlers.delete(name), exit },
    });
    const rejected = expect(run).rejects.toThrow('cancelled');
    await entered;
    const terminate = handlers.get(signal)!;
    await Promise.all([terminate(), terminate()]);
    await rejected;
    expect(exit).toHaveBeenCalledExactlyOnceWith(signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143);
    expect(permission.setMode.mock.calls).toEqual([['auto'], ['manual']]);
    expect(loop.cancelFromUser).toHaveBeenCalledOnce();
    expect(app.dispose).toHaveBeenCalledOnce();
    expect(handlers.size).toBe(0);
  });

  it.each(['blocked', 'failed'] as const)('finishes and disposes a %s terminal prompt', async (state) => {
    const { app, agent, agentServices } = makeFakeHarness();
    mocks.bootstrap.mockReturnValue({ app }); mocks.ensureMainAgent.mockResolvedValue(agent);
    const prompts = agentServices.get(IAgentPromptService) as { submitAndWait: Mock<IAgentPromptService['submitAndWait']> };
    prompts.submitAndWait.mockResolvedValueOnce(state === 'blocked'
      ? { promptId: 'blocked', state }
      : { promptId: 'failed', turnId: 1, state, result: { type: 'failed', steps: 1, error: { code: 'provider.filtered', message: 'filtered', retryable: false } } });
    await expect(runV2Print(opts() as never, 'test', { stdout: writer(), stderr: writer() })).rejects.toThrow(state === 'blocked' ? 'Prompt hook blocked' : 'Provider safety policy blocked');
    expect(app.dispose).toHaveBeenCalledOnce();
  });

  it('submits a prompt through the shared client and terminal receipt', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent, agentServices } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue(agent);

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    const promptService = agentServices.get(IAgentPromptService) as { submitAndWait: Mock<IAgentPromptService['submitAndWait']> };
    expect(promptService.submitAndWait).toHaveBeenCalledWith({ input: [{ type: 'text', text: 'say hello' }] }, undefined);
    expect(stderr.write).toHaveBeenNthCalledWith(1, 'kimi version 1.2.3-test\n');
    expect(stdout.text()).toContain('hello world');
    expect(app.dispose).toHaveBeenCalled();
  });

  it('flushes every session agent wire journal before closing the session', async () => {
    const order: string[] = [];
    const { app, agent, appServices, agentServices } = makeFakeHarness();
    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue(agent);

    const dispatcher = agentServices.get(IEventDispatcher) as { flush: Mock<IEventDispatcher['flush']> };
    dispatcher.flush.mockImplementation(async () => {
      order.push('flush');
    });
    const sessions = appServices.get(ISessionManager) as { close: Mock<ISessionManager['close']> };
    sessions.close.mockImplementation(async () => {
      order.push('close');
    });
    (app.dispose as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('dispose');
    });

    await runV2Print(opts() as never, '1.2.3-test', { stdout: writer(), stderr: writer() });

    expect(dispatcher.flush).toHaveBeenCalledOnce();
    expect(sessions.close).toHaveBeenCalledOnce();
    expect(order).toEqual(['flush', 'close', 'dispose']);
  });

  it('passes explicit skill dirs from --skillsDir into bootstrap args', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue(agent);

    await runV2Print(opts({ skillsDirs: ['/skills'] }) as never, '1.2.3-test', {
      stdout,
      stderr,
    });

    const input = mocks.bootstrap.mock.calls[0]?.[0] as BootstrapInput;
    expect(input.args?.skillDirs).toEqual(['/skills']);
  });

  it('leaves the skill dirs arg unset when --skillsDir is empty', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue(agent);

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    const input = mocks.bootstrap.mock.calls[0]?.[0] as BootstrapInput;
    expect(input.args?.skillDirs ?? []).toEqual([]);
  });

  it('seeds explicit agent files from --agentFile and binds the --agent profile', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent, appServices, agentServices } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue(agent);

    await runV2Print(
      opts({ agent: 'reviewer', agentFiles: ['/agents/reviewer.md'] }) as never,
      '1.2.3-test',
      { stdout, stderr },
    );

    const input = mocks.bootstrap.mock.calls[0]?.[0] as BootstrapInput;
    expect(input.args?.agentFiles).toEqual(['/agents/reviewer.md']);

    const sessions = appServices.get(ISessionManager) as { create: ReturnType<typeof vi.fn> };
    expect(sessions.create).toHaveBeenCalledWith({
      workDir: process.cwd(),
      additionalDirs: undefined,
      mainAgentBinding: { profile: 'reviewer', model: undefined },
    });
    const profile = agentServices.get(IAgentProfileService) as { bind: ReturnType<typeof vi.fn> };
    expect(profile.bind).not.toHaveBeenCalled();
  });

  it('binds the profile named by --agent-file when --agent is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-agent-file-'));
    const agentFile = join(dir, 'reviewer.md');
    await writeFile(
      agentFile,
      '---\nname: file-reviewer\ndescription: Reviews code.\n---\n\nYou review code.\n',
    );
    const stdout = writer();
    const stderr = writer();
    const { app, agent, appServices, agentServices } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue(agent);

    await runV2Print(opts({ agentFiles: [agentFile] }) as never, '1.2.3-test', {
      stdout,
      stderr,
    });

    const input = mocks.bootstrap.mock.calls[0]?.[0] as BootstrapInput;
    expect(input.args?.agentFiles).toEqual([agentFile]);

    const sessions = appServices.get(ISessionManager) as { create: ReturnType<typeof vi.fn> };
    expect(sessions.create).toHaveBeenCalledWith({
      workDir: process.cwd(),
      additionalDirs: undefined,
      mainAgentBinding: { profile: 'file-reviewer', model: undefined },
    });
    const profile = agentServices.get(IAgentProfileService) as { bind: ReturnType<typeof vi.fn> };
    expect(profile.bind).not.toHaveBeenCalled();
  });

  it('does not materialize a main agent after fresh profile binding fails', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, appServices } = makeFakeHarness();
    const sessions = appServices.get(ISessionManager) as { create: ReturnType<typeof vi.fn> };
    sessions.create.mockRejectedValueOnce(new Error('Unknown agent profile'));
    mocks.bootstrap.mockReturnValue({ app });

    await expect(
      runV2Print(opts({ agent: 'missing' }) as never, '1.2.3-test', { stdout, stderr }),
    ).rejects.toThrow('Unknown agent profile');

    expect(mocks.ensureMainAgent).not.toHaveBeenCalled();
  });

  it('fails before any turn when --agent-file is invalid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-agent-file-'));
    const agentFile = join(dir, 'broken.md');
    await writeFile(agentFile, '---\nname: broken\n---\n\nbody\n');
    const stdout = writer();
    const stderr = writer();
    const { app, agent, agentServices } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue(agent);

    await expect(
      runV2Print(opts({ agentFiles: [agentFile] }) as never, '1.2.3-test', { stdout, stderr }),
    ).rejects.toThrow(/Invalid agent file/);

    const profile = agentServices.get(IAgentProfileService) as {
      bind: ReturnType<typeof vi.fn>;
    };
    expect(profile.bind).not.toHaveBeenCalled();
  });

  it('leaves the agent files arg unset when --agentFile is empty', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue(agent);

    await runV2Print(opts() as never, '1.2.3-test', { stdout, stderr });

    const input = mocks.bootstrap.mock.calls[0]?.[0] as BootstrapInput;
    expect(input.args?.agentFiles ?? []).toEqual([]);
  });

  it('passes --agent-file paths through unresolved so the engine can expand ~', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent } = makeFakeHarness();

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue(agent);

    await runV2Print(
      opts({ agent: 'reviewer', agentFiles: ['~/agents/reviewer.md'] }) as never,
      '1.2.3-test',
      { stdout, stderr },
    );

    const input = mocks.bootstrap.mock.calls[0]?.[0] as BootstrapInput;
    expect(input.args?.agentFiles).toEqual(['~/agents/reviewer.md']);
  });

  it('treats re-selecting the already-bound profile on resume as a no-op', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent, agentServices, appServices, profileState } = makeFakeHarness();
    profileState.profileName = 'reviewer';

    const index = appServices.get(ISessionIndex) as { get: ReturnType<typeof vi.fn> };
    index.get.mockResolvedValue({ id: 'ses_1', cwd: process.cwd(), workspaceId: 'example', createdAt: 1, updatedAt: 1, archived: false });

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue(agent);

    await runV2Print(opts({ session: 'ses_1', agent: 'reviewer' }) as never, '1.2.3-test', {
      stdout,
      stderr,
    });

    const profile = agentServices.get(IAgentProfileService) as {
      bind: ReturnType<typeof vi.fn>;
      setModel: ReturnType<typeof vi.fn>;
    };
    expect(profile.bind).not.toHaveBeenCalled();
    expect(profile.setModel).not.toHaveBeenCalled();
  });

  it('switches the model when resuming with the already-bound profile and an explicit model', async () => {
    const stdout = writer();
    const stderr = writer();
    const { app, agent, agentServices, appServices, profileState } = makeFakeHarness();
    profileState.profileName = 'reviewer';

    const index = appServices.get(ISessionIndex) as { get: ReturnType<typeof vi.fn> };
    index.get.mockResolvedValue({ id: 'ses_1', cwd: process.cwd(), workspaceId: 'example', createdAt: 1, updatedAt: 1, archived: false });

    mocks.bootstrap.mockReturnValue({ app });
    mocks.ensureMainAgent.mockResolvedValue(agent);

    await runV2Print(
      opts({ session: 'ses_1', agent: 'reviewer', model: 'new-model' }) as never,
      '1.2.3-test',
      { stdout, stderr },
    );

    const profile = agentServices.get(IAgentProfileService) as {
      bind: ReturnType<typeof vi.fn>;
      setModel: ReturnType<typeof vi.fn>;
    };
    expect(profile.bind).not.toHaveBeenCalled();
    expect(profile.setModel).toHaveBeenCalledWith('new-model');
  });
});
