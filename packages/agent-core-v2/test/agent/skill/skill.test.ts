import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createControlledPromise } from '@antfu/utils';
import { Event } from '#/_base/event';
import { Error2, ErrorCodes } from '#/errors';
import type { ILogService } from '#/_base/log/log';
import { RuntimeSkillDiscovery } from '#/workspace/workspaceSkillCatalog/runtimeSkillDiscovery';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { Runtime } from '#/runtime/runtime';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { SkillToolInput } from '#/agent/tools/skill/skill';
import { stubWorkspaceContext } from '../../session/workspaceContext/stub-workspace-context';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentSkillService } from '#/agent/skill/skill';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import { parseSkillText } from '#/app/skillCatalog/parser';
import { summarizeSkill } from '#/app/skillCatalog/types';
import type { generate as kosongGenerate } from '#/kosong/contract/generate';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IEventService } from '#/app/event/event';
import { AgentSkillService } from '#/agent/skill/skillService';
import {
  MAX_SKILL_QUERY_DEPTH,
  NestedSkillTooDeepError,
  SkillToolInputSchema,
} from '#/agent/tools/skill/skill';
import { SkillTool } from '#/agent/tools/skill/skillTool';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { Turn } from '#/agent/loop/loop';
import { executeTool } from '../../tools/fixtures/execute-tool';
import { stubSkill } from '../../app/skillCatalog/stubs';
import { registerTestAgentWireServices } from '../../wire/stubs';
import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  skillServices,
  type TestAgentContext,
} from '../../harness';

type GenerateFn = typeof kosongGenerate;

const COMMIT_SKILL = stubSkill('commit', {
  description: 'commit changes',
  path: '/skills/commit/SKILL.md',
  dir: '/skills/commit',
  content: '# Commit',
  metadata: {},
  source: 'user',
});

function stubSessionContext(sessionId = 'test-session'): ISessionContext {
  return {
    _serviceBrand: undefined,
    sessionId,
    workspaceId: 'test-workspace',
    sessionDir: '/sessions/test',
    metaScope: 'sessions/test',
    cwd: '/sessions/test',
    scope: (subKey?: string) => (subKey ? `sessions/test/${subKey}` : 'sessions/test'),
  };
}

function fakeTurn(): Turn {
  return {
    id: 1,
    signal: new AbortController().signal,
    ready: Promise.resolve(),
    result: Promise.resolve({ type: 'completed', steps: 0, truncated: false }),
    cancel: () => true,
  };
}

describe('AgentSkillService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let prompted: ContextMessage[];
  let skills: InMemorySkillCatalog;

  beforeEach(() => {
    disposables = new DisposableStore();
    prompted = [];
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IAgentPromptService, {
          enqueue: ({ message }: { message: ContextMessage }) => { prompted.push(message); return Promise.resolve({ launched: Promise.resolve(fakeTurn()) } as never); },
          inject: (message: ContextMessage) => { prompted.push(message); return Promise.resolve(fakeTurn()); },
          retry: () => Promise.resolve(undefined),
          clear: () => {},
        });
        reg.definePartialInstance(IAgentLoopService, {
          status: () => ({ state: 'idle', activeTurnId: undefined, pendingTurnIds: [], hasPendingRequests: false, activeTraceId: undefined }),
        });
        registerTestAgentWireServices(reg, 'wire/skill-test');
        reg.definePartialInstance(ITelemetryService, { track: () => {}, track2: () => {} });
        reg.definePartialInstance(IAgentToolRegistryService, {
          register: () => ({ dispose: () => {} }),
        });
        reg.definePartialInstance(ISessionMetadata, {
          read: async () => ({ id: 'test-session', createdAt: 0, updatedAt: 0, archived: false }),
          update: async () => {},
        });
        reg.definePartialInstance(IEventService, { publish: () => {} });
        reg.defineInstance(ISessionContext, stubSessionContext());
        reg.defineInstance(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: '' }));
      },
    });
    skills = new InMemorySkillCatalog();
    skills.register(COMMIT_SKILL);
    const skillCatalog: ISessionSkillCatalog = {
      _serviceBrand: undefined,
      catalog: skills,
      ready: Promise.resolve(),
      onDidChange: () => ({ dispose: () => {} }),
      load: async () => {},
      reload: async () => {},
      list: async () => skills.listSkills().map(summarizeSkill),
    };
    ix.set(ISessionSkillCatalog, skillCatalog);
    ix.set(IAgentSkillService, new SyncDescriptor(AgentSkillService));
  });
  afterEach(() => disposables.dispose());

  it('activate prompts with the rendered skill for a known skill', async () => {
    const svc = ix.get(IAgentSkillService);
    const turn = await svc.activate({ name: 'commit' });

    expect(turn).toBeDefined();
    expect(prompted).toHaveLength(1);
    expect(prompted[0]!.role).toBe('user');
    expect(prompted[0]!.origin).toMatchObject({
      kind: 'skill_activation',
      skillName: 'commit',
    });
  });

  it('loads a user command once with arguments and retains attachment content', async () => {
    skills.register(parseSkillText({
      skillMdPath: '/home/commands/brainstorm.md', skillDirName: 'brainstorm', source: 'user',
      text: 'Discuss $ARGUMENTS. Do not create files.',
    }));
    await ix.get(IAgentSkillService).activate({
      name: 'brainstorm', args: 'menu options', content: [{ type: 'text', text: 'Attached note' }],
    });
    expect(prompted).toHaveLength(1);
    expect(prompted[0]?.origin).toMatchObject({ trigger: 'user-slash', skillType: 'prompt' });
    const text = prompted[0]?.content[0];
    expect(text?.type).toBe('text');
    if (text?.type === 'text') {
      expect(text.text.match(/Discuss menu options\./g)).toHaveLength(1);
      expect(text.text).not.toContain('$ARGUMENTS');
    }
    expect(prompted[0]?.content[1]).toEqual({ type: 'text', text: 'Attached note' });
    expect(skills.getModelSkillListing()).not.toContain('brainstorm');
  });

  it('activate throws for an unknown skill', async () => {
    const svc = ix.get(IAgentSkillService);
    await expect(svc.activate({ name: 'missing' })).rejects.toThrow(/not found/i);
  });

  it('activate waits for the catalog to be ready before resolving', async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const skills = new InMemorySkillCatalog();
    skills.register(COMMIT_SKILL);
    ix.set(ISessionSkillCatalog, {
      _serviceBrand: undefined,
      catalog: skills,
      ready,
      onDidChange: () => ({ dispose: () => {} }),
      load: async () => {},
      reload: async () => {},
      list: async () => skills.listSkills().map(summarizeSkill),
    } satisfies ISessionSkillCatalog);
    ix.set(IAgentSkillService, new SyncDescriptor(AgentSkillService));

    const svc = ix.get(IAgentSkillService);
    let finished = false;
    const activation = svc.activate({ name: 'commit' }).then(() => {
      finished = true;
    });

    await Promise.resolve();
    expect(finished).toBe(false);

    resolveReady();
    await activation;

    expect(finished).toBe(true);
    expect(prompted).toHaveLength(1);
  });
});

describe('SkillTool', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let prompted: ContextMessage[];
  let skills: InMemorySkillCatalog;

  beforeEach(() => {
    disposables = new DisposableStore();
    prompted = [];
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IAgentPromptService, {
          enqueue: ({ message }: { message: ContextMessage }) => { prompted.push(message); return Promise.resolve({ launched: Promise.resolve(fakeTurn()) } as never); },
          inject: (message: ContextMessage) => { prompted.push(message); return Promise.resolve(fakeTurn()); },
          retry: () => Promise.resolve(undefined),
          clear: () => {},
        });
        reg.definePartialInstance(IAgentLoopService, {
          status: () => ({ state: 'idle', activeTurnId: undefined, pendingTurnIds: [], hasPendingRequests: false, activeTraceId: undefined }),
        });
        registerTestAgentWireServices(reg, 'wire/skill-test');
        reg.definePartialInstance(ITelemetryService, { track: () => {}, track2: () => {} });
        reg.definePartialInstance(IAgentToolRegistryService, {
          register: () => ({ dispose: () => {} }),
        });
        reg.definePartialInstance(ISessionMetadata, {
          read: async () => ({ id: 'test-session', createdAt: 0, updatedAt: 0, archived: false }),
          update: async () => {},
        });
        reg.definePartialInstance(IEventService, { publish: () => {} });
        reg.defineInstance(ISessionContext, stubSessionContext());
        reg.defineInstance(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: '' }));
      },
    });
    skills = new InMemorySkillCatalog();
    skills.register(COMMIT_SKILL);
    ix.set(ISessionSkillCatalog, {
      _serviceBrand: undefined,
      catalog: skills,
      ready: Promise.resolve(),
      onDidChange: () => ({ dispose: () => {} }),
      load: async () => {},
      reload: async () => {},
      list: async () => skills.listSkills().map(summarizeSkill),
    } satisfies ISessionSkillCatalog);
    ix.set(IAgentSkillService, new SyncDescriptor(AgentSkillService));
  });
  afterEach(() => disposables.dispose());

  function toolContext(args: SkillToolInput) {
    return {
      turnId: 0,
      toolCallId: 'call_skill',
      args,
      signal: new AbortController().signal,
    };
  }

  function stubSkillService(): IAgentSkillService {
    return {
      _serviceBrand: undefined,
      activate: () => Promise.reject(new Error('not implemented')),
      promptWithSkills: () => Promise.reject(new Error('not implemented')),
      recordModelToolActivation: () => {},
    };
  }

  function makeTool(ix: TestInstantiationService, depth?: number, text = '# Explicit $ARGUMENTS', fs: Partial<IHostFileSystem> = {}): SkillTool {
    const fake = new FakeRuntime({ workspaceId: 'test', runtimeId: 'test', generation: '1' });
    Object.defineProperty(fake, 'fs', { value: {
      realpath: async (path: string) => path,
      readText: async () => text,
      ...fs,
    } as unknown as IHostFileSystem });
    const runtime: Runtime = fake;
    const tool = new SkillTool(
      ix.get(ISessionSkillCatalog),
      stubSkillService(),
      stubSessionContext(),
      {
        _serviceBrand: undefined,
        onDidChange: Event.None as Event<void>,
        inspect: () => runtime,
        isAvailable: () => true,
        acquire: () => ({ runtime, dispose: () => {}, track: (value) => value }),
      },
      stubWorkspaceContext('/workspace'),
    );
    return depth === undefined ? tool : tool.withInitialQueryDepth(depth);
  }

  it('exposes metadata and schema for model-invoked skills', () => {
    const tool = makeTool(ix);

    expect(tool.name).toBe('Skill');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        skill: { type: 'string' },
        args: { type: 'string' },
      },
    });
    expect(SkillToolInputSchema.safeParse({ skill: 'commit' }).success).toBe(true);
    expect(SkillToolInputSchema.safeParse({ skill: 'commit', args: '-m fix' }).success).toBe(true);
    expect(SkillToolInputSchema.safeParse({}).success).toBe(false);
    expect(SkillToolInputSchema.safeParse({ path: 'review.md' }).success).toBe(true);
    expect(SkillToolInputSchema.safeParse({ path: 'review.md', skill: 'commit' }).success).toBe(false);
  });

  it('loads an explicit file with args, provenance and resource root without replacing the catalog', async () => {
    const tool = makeTool(ix, undefined, '---\nname: commit\narguments: [target]\n---\nReview $target');
    const result = await executeTool(tool, toolContext({ path: 'skills/review.md', args: 'staged' }));
    expect(result.isError).not.toBe(true);
    expect(result.delivery).toMatchObject({ kind: 'steer', message: {
      origin: { skillName: 'commit', skillArgs: 'staged', skillPath: '/workspace/skills/review.md', skillSource: 'extra' },
    } });
    expect(JSON.stringify(result.delivery)).toContain('Review staged');
    expect(JSON.stringify(result.delivery)).toContain('/workspace/skills');
    expect(skills.getSkill('commit')).toEqual(COMMIT_SKILL);
    expect(skills.listSkills()).toHaveLength(1);
  });

  it('enforces user-only and inline restrictions for explicit paths', async () => {
    for (const metadata of ['disable-model-invocation: true', 'type: flow']) {
      const result = await executeTool(makeTool(ix, undefined, `---\nname: private\n${metadata}\n---\nSecret`), toolContext({ path: 'private.md' }));
      expect(result.isError).toBe(true);
      expect(result.delivery).toBeUndefined();
    }
  });

  it('rejects a plain user command both by name and by explicit model path', async () => {
    skills.register(parseSkillText({
      skillMdPath: '/workspace/.kiki/commands/brainstorm.md', skillDirName: 'brainstorm',
      source: 'project', text: 'Discuss options.',
    }));
    for (const input of [{ skill: 'brainstorm' }, { path: '.kiki/commands/brainstorm.md' }]) {
      const result = await executeTool(makeTool(ix, undefined, 'Discuss options.'), toolContext(input));
      expect(result.isError).toBe(true);
      expect(result.delivery).toBeUndefined();
      expect(result.output).toContain('only be triggered by the user');
    }
  });

  it.each(['file', 'directory'])('rejects physical aliases of a discovered command %s symlink', async (linkKind) => {
    const root = '/workspace/.kiki/commands';
    const target = '/workspace/prompts/review.md';
    const fs = {
      realpath: async (path: string) => path === `${root}/review.md` || path === '/workspace/alias.md' ? target : path,
      readText: async () => 'Review the current changes.',
      readdir: async () => [{ name: 'review.md', isFile: linkKind !== 'file', isDirectory: false, isSymbolicLink: linkKind === 'file' }],
      stat: async () => ({ isFile: true, isDirectory: false }),
    } as unknown as IHostFileSystem;
    const discovery = new RuntimeSkillDiscovery({ warn: vi.fn() } as unknown as ILogService, fs);
    const discovered = await discovery.discover([{ path: root, source: 'project', scanMode: 'commands' }]);
    expect(discovered.skills).toHaveLength(1);
    expect(discovered.skills[0]!.metadata.promptCommand).toBe(true);
    for (const skill of discovered.skills) skills.register(skill);
    const tool = makeTool(ix, undefined, '', fs);
    for (const path of [target, '/workspace/alias.md']) {
      const result = await executeTool(tool, toolContext({ path }));
      expect(result.isError).toBe(true);
      expect(result.delivery).toBeUndefined();
      expect(result.output).toContain('only be triggered by the user');
    }
    const ordinary = await executeTool(tool, toolContext({ path: '/workspace/independent.md' }));
    expect(ordinary.isError).not.toBe(true);
    expect(ordinary.delivery).toBeDefined();
  });

  it.each([ErrorCodes.OS_FS_NOT_FOUND, ErrorCodes.OS_FS_NOT_DIRECTORY])('ignores a vanished command with %s without losing live command protection', async (code) => {
    const root = '/workspace/.kiki/commands';
    let vanished = false;
    const fs = {
      realpath: async (path: string) => {
        if (path === `${root}/gone.md` && vanished) throw new Error2(code, 'Command path no longer exists');
        if (path === `${root}/live.md` || path === '/workspace/alias.md') return '/workspace/live.md';
        return path;
      },
      readText: async () => '# Instructions',
      readdir: async () => ['gone.md', 'live.md'].map((name) => ({ name, isFile: true, isDirectory: false })),
      stat: async () => ({ isFile: true, isDirectory: false }),
    } as unknown as IHostFileSystem;
    const discovered = await new RuntimeSkillDiscovery({ warn: vi.fn() } as unknown as ILogService, fs)
      .discover([{ path: root, source: 'project', scanMode: 'commands' }]);
    expect(discovered.skills).toHaveLength(2);
    for (const skill of discovered.skills) skills.register(skill);
    vanished = true;
    const tool = makeTool(ix, undefined, '', fs);
    const ordinary = await executeTool(tool, toolContext({ path: '/workspace/independent.md' }));
    expect(ordinary.isError).not.toBe(true);
    expect(ordinary.delivery).toBeDefined();
    for (const path of ['/workspace/live.md', '/workspace/alias.md']) {
      const result = await executeTool(tool, toolContext({ path }));
      expect(result.isError).toBe(true);
      expect(result.delivery).toBeUndefined();
      expect(result.output).toContain('only be triggered by the user');
    }
  });

  it.each([ErrorCodes.OS_FS_PERMISSION_DENIED, ErrorCodes.OS_FS_UNKNOWN])('does not ignore unresolved command identity errors with %s', async (code) => {
    const commandPath = '/workspace/.kiki/commands/private.md';
    skills.register(parseSkillText({ skillMdPath: commandPath, skillDirName: 'private', source: 'project', text: '# Private' }));
    const failure = new Error2(code, 'Cannot resolve command identity');
    const readText = vi.fn(async () => '# Independent');
    const tool = makeTool(ix, undefined, '', {
      realpath: async (path) => { if (path === commandPath) throw failure; return path; },
      readText,
    });
    await expect(executeTool(tool, toolContext({ path: '/workspace/independent.md' }))).rejects.toBe(failure);
    expect(readText).not.toHaveBeenCalled();
  });

  it('does not resolve a built-in command URI as a host file when checking command aliases', async () => {
    skills.register(stubSkill('built-in-command', {
      source: 'builtin',
      path: 'builtin://built-in-command',
      dir: 'builtin://built-in-command',
      metadata: { promptCommand: true, disableModelInvocation: true },
    }));
    const realpath = vi.fn(async (path: string) => {
      if (path.startsWith('builtin://')) throw new Error2(ErrorCodes.OS_FS_UNKNOWN, 'Not a host path');
      return path;
    });
    const result = await executeTool(
      makeTool(ix, undefined, '# Independent', { realpath }),
      toolContext({ path: '/workspace/independent.md' }),
    );
    expect(result.isError).not.toBe(true);
    expect(realpath).not.toHaveBeenCalledWith('builtin://built-in-command');
  });

  it('does not read outside an isolated runtime workspace', async () => {
    await expect(makeTool(ix).resolveExecution({ path: '/outside/skill.md' })).rejects.toThrow();
  });

  it('declares a sensitive canonical symlink target before reading skill content', async () => {
    const readText = vi.fn(async () => '# forbidden');
    const tool = makeTool(ix, undefined, '', { realpath: async () => '/workspace/.env', readText });
    const resolved = await tool.resolveExecution({ path: 'safe.md' });
    expect(resolved).toMatchObject({ accesses: [{ path: '/workspace/.env' }] });
    expect(readText).not.toHaveBeenCalled();
  });

  it.each([
    ['commands/review.md', '/workspace/ordinary.md'],
    ['ordinary.md', '/workspace/commands/review.md'],
  ])('keeps user-only command policy across a symlink from %s', async (path, target) => {
    const tool = makeTool(ix, undefined, '# user-only command', { realpath: async () => target });
    const result = await executeTool(tool, toolContext({ path }));
    expect(result.isError).toBe(true);
    expect(result.delivery).toBeUndefined();
    expect(result.output).toContain('only be triggered by the user');
  });

  it('uses the canonical path for admission and provenance without reading during preparation', async () => {
    const readText = vi.fn(async () => '# approved file');
    const tool = makeTool(ix, undefined, '', { realpath: async () => '/workspace/actual.md', readText });
    const execution = await tool.resolveExecution({ path: 'link.md' });
    expect(execution).toMatchObject({ display: { kind: 'skill_call', skill_name: '/workspace/actual.md' } });
    expect(readText).not.toHaveBeenCalled();
    const result = await executeTool(tool, toolContext({ path: 'link.md' }));
    expect(result.delivery).toMatchObject({ message: { origin: { skillPath: '/workspace/actual.md' } } });
    expect(readText).toHaveBeenCalledWith('/workspace/actual.md');
  });

  it('returns a tool error when the skill is unknown', async () => {
    const result = await executeTool(
      makeTool(ix),
      toolContext({ skill: 'missing' }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'Skill "missing" not found in the current skill listing.',
    });
  });

  it('rejects skills that disable model invocation', async () => {
    skills.register(stubSkill('private', { metadata: { disableModelInvocation: true } }));

    const result = await executeTool(
      makeTool(ix),
      toolContext({ skill: 'private' }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'Skill "private" can only be triggered by the user (model invocation is disabled).',
    });
  });

  it('rejects non-inline skill types in the current v1 runtime', async () => {
    skills.register(stubSkill('flow-only', { metadata: { type: 'flow' } }));

    const result = await executeTool(
      makeTool(ix),
      toolContext({ skill: 'flow-only' }),
    );

    expect(result).toMatchObject({
      isError: true,
      output: 'Skill "flow-only" is not an inline skill and cannot be invoked by the model in v1.',
    });
  });

  it('loads inline skills through the model-tool wrapper without exposing the body in output', async () => {
    const result = await executeTool(
      makeTool(ix),
      toolContext({ skill: 'commit', args: 'src/app.ts' }),
    );

    expect(result).toMatchObject({
      output: 'Skill "commit" loaded.',
    });
    expect(result.output).not.toContain('# Commit');
    expect(prompted).toHaveLength(0);
    expect(result.delivery?.kind).toBe('steer');
    expect(result.delivery?.message.origin).toMatchObject({
      kind: 'skill_activation',
      skillName: 'commit',
      trigger: 'model-tool',
    });
    expect(result.delivery?.message.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining(
        '<skill-loaded name="commit" trigger="model-tool" source="user" dir="/skills/commit" args="src/app.ts">',
      ),
    });
    expect(result.delivery?.message.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('ARGUMENTS: src/app.ts'),
    });
  });

  it('honors initialQueryDepth as an alias for queryDepth', async () => {
    const nested = await executeTool(
      makeTool(ix, 2),
      toolContext({ skill: 'commit' }),
    );
    const root = await executeTool(
      makeTool(ix, 0),
      toolContext({ skill: 'commit' }),
    );

    expect(prompted).toHaveLength(0);
    expect(nested.delivery?.message.origin).toMatchObject({
      kind: 'skill_activation',
      trigger: 'nested-skill',
    });
    expect(root.delivery?.message.origin).toMatchObject({
      kind: 'skill_activation',
      trigger: 'model-tool',
    });
  });

  it('throws a structured recursion error when nested skill invocation is too deep', async () => {
    await expect(
      executeTool(
        makeTool(ix, MAX_SKILL_QUERY_DEPTH),
        toolContext({ skill: 'commit' }),
      ),
    ).rejects.toBeInstanceOf(NestedSkillTooDeepError);
    expect(prompted).toHaveLength(0);
  });
});

describe('AgentSkillService busy delivery (harness)', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    await ctx.dispose();
  });

  it('steers the activation into the running turn and launches a new one when idle', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(
      stubSkill('workflow', {
        content: 'Workflow: $ARGUMENTS',
        metadata: {},
      }),
    );

    const gate = createControlledPromise<void>();
    let generateCalls = 0;
    const generate: GenerateFn = async (_chat, _systemPrompt, _tools, _history, callbacks, options) => {
      generateCalls += 1;
      const n = generateCalls;
      options?.onRequestStart?.();
      if (n === 1) await gate;
      options?.signal?.throwIfAborted();
      const text = `response-${String(n)}`;
      await callbacks?.onMessagePart?.({ type: 'text', text });
      options?.onStreamEnd?.();
      return {
        id: `mock-${String(n)}`,
        message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
        usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
        traceId: null,
      };
    };

    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent(skillServices(catalog), { generate, persistence });

    const promptPromise = ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await vi.waitFor(() => {
      expect(generateCalls).toBe(1);
    });

    const busyActivation = ctx.get(IAgentSkillService).activate({ name: 'workflow', args: 'mission-1' });
    const busyResult = await busyActivation;
    expect(busyResult.turn_id).toBe(0);
    expect(generateCalls).toBe(1);

    gate.resolve();
    await promptPromise;
    await ctx.untilTurnEnd();

    const idleResult = await ctx.get(IAgentSkillService).activate({ name: 'workflow', args: 'mission-2' });
    expect(idleResult.turn_id).toBe(1);
    await ctx.untilTurnEnd();
    expect(generateCalls).toBe(3);

    const activations = ctx
      .contextData()
      .history.filter((m) => m.role === 'user' && m.origin?.kind === 'skill_activation');
    expect(activations.map((m) => (m.origin?.kind === 'skill_activation' ? m.origin.skillArgs : ''))).toEqual([
      'mission-1',
      'mission-2',
    ]);

    const types = persistence.records.map((record) => record.type);
    expect(types.filter((type) => type === 'turn.prompt')).toHaveLength(2);
    expect(types.filter((type) => type === 'turn.steer')).toHaveLength(1);
    const steer = persistence.records.find((record) => record.type === 'turn.steer');
    expect(steer).toMatchObject({ origin: { kind: 'skill_activation', skillArgs: 'mission-1' } });
  });
});
