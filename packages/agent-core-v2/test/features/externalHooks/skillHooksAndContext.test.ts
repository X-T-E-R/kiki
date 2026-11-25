import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createControlledPromise } from '@antfu/utils';
import { describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle, ISessionScopeHandle } from '#/_base/di/scope';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { AsyncEmitter, Emitter, Event, type IWaitUntil } from '#/_base/event';
import type { ILogService } from '#/_base/log/log';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { externalPromptHints } from '#/agent/execution/externalPromptHints';
import { IAgentFullCompactionService, type FullCompactionTask } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService, type AfterStepContext } from '#/agent/loop/loop';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBinding';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAgentSkillService } from '#/agent/skill/skill';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IAgentAgentsMdReminderService } from '#/agent/agentsMdReminder/agentsMdReminder';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { AgentToolExecutorService } from '#/agent/toolExecutor/toolExecutorService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { executeModelSkill } from '#/agent/tools/skill/skillTool';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IFlagService } from '#/app/flag/flag';
import { IPluginService } from '#/app/plugin/plugin';
import { IPluginUsageService } from '#/app/pluginUsage/pluginUsage';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { parseSkillText, resolveSkillHookCommand, SkillParseError } from '#/app/skillCatalog/parser';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import { IAgentExternalHooksService } from '#/features/externalHooks/agent/agentExternalHooks';
import { AgentExternalHooksService } from '#/features/externalHooks/agent/agentExternalHooksService';
import { IExternalHooksRunnerService } from '#/features/externalHooks/app/externalHooksRunner';
import { ExternalHooksRunnerService } from '#/features/externalHooks/app/externalHooksRunnerService';
import { HOOKS_SECTION } from '#/features/externalHooks/configSection';
import { ISessionHookWorkspace } from '#/features/externalHooks/session/hookRules';
import { ISessionExternalHooksService } from '#/features/externalHooks/session/sessionExternalHooks';
import { SessionExternalHooksService } from '#/features/externalHooks/session/sessionExternalHooksService';
import { SessionInitService } from '#/features/sessionInit/sessionInitService';
import { createHooks } from '#/hooks';
import { emptyUsage } from '#/kosong/contract/usage';
import { IModelService } from '#/kosong/model/model';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import type { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import {
  type AgentRunHandle,
  type AgentTaskHooks,
  type AgentTaskStopHookContext,
  ISessionSubagentService,
} from '#/session/subagent/subagent';
import { SessionSubagentService } from '#/session/subagent/subagentService';
import { observeAutonomousReceipts, type ReceiptDelivery } from '#/session/subagent/autonomousReceipt';
import { autonomousReceiptsKey, AutonomousReceiptDelivered } from '#/session/subagent/autonomousReceiptOps';
import { SubagentFailed, SubagentSpawned } from '#/session/subagent/mirrorAgentRun';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ToolAccesses } from '#/tool/toolContract';
import type { SessionCreatedEvent, SessionCreateSource } from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';

import { stubLoopWithHooks, stubToolExecutor } from '../../agent/loop/stubs';
import { stubBootstrap } from '../../app/bootstrap/stubs';
import { registerStateServices } from '../../state/stubs';
import { registerTestAgentWireServices } from '../../wire/stubs';
import { makeHookRunner, nodeCommand } from './runner-stub';

function stubContextMemory(): IAgentContextMemoryService & {
  readonly messages: ContextMessage[];
} {
  const messages: ContextMessage[] = [];
  return {
    _serviceBrand: undefined,
    get: () => [...messages],
    append: (...inserted) => {
      messages.push(...inserted);
    },
    appendObservable: (message) => {
      messages.push(message);
    },
    appendManaged: (message) => {
      messages.push(message);
    },
    appendLoopEvent: () => {},
    publishTrailingRemoval: () => false,
    hooks: { onDidClear: { register: () => ({ dispose() {} }), delete: () => false, run: async () => {} } },
    clear: async () => {
      messages.splice(0);
    },
    undo: () => ({ cutIndex: -1, removedCount: 0, stoppedAtCompaction: false }),
    undoAndReplace: async () => ({ cutIndex: -1, removedCount: 0, stoppedAtCompaction: false }),
    applyCompaction: () => ({
      summary: '',
      contextSummary: '',
      compactedCount: 0,
      tokensBefore: 0,
      tokensAfter: 0,
      keptUserMessageCount: 0,
    }),
    messages,
  };
}

function stubSessionContext(cwd: string): ISessionContext {
  return {
    _serviceBrand: undefined,
    sessionId: 'session-skill-hooks',
    workspaceId: 'workspace-skill-hooks',
    sessionDir: join(cwd, '.session'),
    metaScope: 'sessions/workspace-skill-hooks/session-skill-hooks',
    cwd,
    scope: (subKey?: string) =>
      subKey === undefined || subKey === ''
        ? 'sessions/workspace-skill-hooks/session-skill-hooks'
        : `sessions/workspace-skill-hooks/session-skill-hooks/${subKey}`,
  };
}

function stubSessionMetadata(initial?: Partial<SessionMeta>): ISessionMetadata & {
  readonly current: () => SessionMeta;
} {
  let state: SessionMeta = {
    id: 'session-skill-hooks',
    title: 'Skill Hooks Session',
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    ...initial,
  };
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeMetadata: Event.None,
    read: async () => structuredClone(state),
    getAgentExecutor: async () => undefined,
    update: async (patch: Partial<SessionMeta>) => {
      state = { ...state, ...patch };
    },
    setTitle: async () => {},
    setArchived: async () => {},
    registerAgent: async () => {},
    current: () => state,
  } as unknown as ISessionMetadata & { readonly current: () => SessionMeta };
}

function stubProfileCatalog(): ISessionAgentProfileCatalog {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    getDefault: () => ({ name: 'default' }),
    get: () => undefined,
  } as unknown as ISessionAgentProfileCatalog;
}

function stubModelService(): IModelService {
  return {
    _serviceBrand: undefined,
    getDefaultModel: () => 'kimi-test',
    resolveId: (alias: string) => alias,
  } as unknown as IModelService;
}

function stubSkillService(): IAgentSkillService {
  return {
    _serviceBrand: undefined,
    activate: async () => ({ turn_id: 0 }),
    promptWithSkills: async () => ({
      prompt_id: 'p1',
      created_at: new Date().toISOString(),
      state: 'running',
      append_timing: 'agent_idle',
      revision: 0,
    }),
    recordModelToolActivation: () => {},
  };
}

function makeAfterStep(signal: AbortSignal): AfterStepContext {
  return {
    turnId: 0,
    step: 1,
    firstStepOfTurn: true,
    signal,
    usage: emptyUsage(),
    finishReason: 'completed',
    stopTurn: false,
  };
}

function makeFakeAgentHandle(
  id: string,
  services: ReadonlyMap<unknown, unknown>,
): IAgentScopeHandle {
  return {
    id,
    kind: 'agent' as IAgentScopeHandle['kind'],
    accessor: {
      get: ((token: unknown) => {
        const value = services.get(token);
        if (value === undefined) throw new Error(`missing service ${String(token)}`);
        return value;
      }) as IAgentScopeHandle['accessor']['get'],
    },
    dispose: () => {},
  };
}

describe('skill frontmatter hooks, context injection, and fail-open Stop', () => {
  it('resolves relative ./ paths against skillDir and parses valid SKILL.md hooks frontmatter', () => {
    expect(resolveSkillHookCommand('node ./scripts/check.mjs --flag', '/skills/demo')).toBe(
      'node /skills/demo/scripts/check.mjs --flag',
    );
    expect(resolveSkillHookCommand('node "./scripts/my hook.mjs"', '/skills/my demo')).toBe(
      'node "/skills/my demo/scripts/my hook.mjs"',
    );
    expect(resolveSkillHookCommand("node './scripts/my hook.mjs'", '/skills/my demo')).toBe(
      "node '/skills/my demo/scripts/my hook.mjs'",
    );
    expect(resolveSkillHookCommand('python3 --script=./hooks/run.py', '/skills/demo')).toBe(
      'python3 --script=/skills/demo/hooks/run.py',
    );
    expect(resolveSkillHookCommand('echo foo./bar', '/skills/demo')).toBe('echo foo./bar');
    expect(resolveSkillHookCommand('node "${CLAUDE_SKILL_DIR}/check.mjs" "%VAR%"', '/skills/demo')).toBe(
      'node "${CLAUDE_SKILL_DIR}/check.mjs" "%VAR%"',
    );
    if (process.platform !== 'win32') {
      expect(resolveSkillHookCommand('./my\\ dir/check.sh --arg "%VAR%"', '/skills/demo')).toBe(
        "'/skills/demo/my dir/check.sh' --arg \"%VAR%\"",
      );
    }

    const skillDir = '/tmp/example-skill';
    const parsed = parseSkillText({
      skillMdPath: `${skillDir}/SKILL.md`,
      skillDirName: 'example-skill',
      source: 'user',
      text: [
        '---',
        'name: example-skill',
        'description: Skill with hooks',
        'hooks:',
        '  - event: SubagentStart',
        '    matcher: worker',
        '    command: node ./scripts/start.mjs',
        '    timeout: 10',
        '---',
        'Body',
      ].join('\n'),
    });
    expect(parsed.hooks).toEqual([
      {
        event: 'SubagentStart',
        matcher: 'worker',
        command: `node ${skillDir}/scripts/start.mjs`,
        timeout: 10,
        env: { KIKI_SKILL_DIR: skillDir, CLAUDE_SKILL_DIR: skillDir },
      },
    ]);

    const claudeParsed = parseSkillText({
      skillMdPath: `${skillDir}/SKILL.md`,
      skillDirName: 'example-skill',
      source: 'user',
      text: [
        '---',
        'name: claude-skill',
        'description: Claude Code hook groups',
        'hooks:',
        '  PreToolUse:',
        '    - matcher: Bash',
        '      hooks:',
        '        - type: command',
        '          command: node "${CLAUDE_SKILL_DIR}/guard.mjs"',
        '          timeout: 15',
        '  PostCompact:',
        '    - hooks:',
        '        - type: command',
        '          command: node ./scripts/post.mjs',
        '---',
        'Body',
      ].join('\n'),
    });
    expect(claudeParsed.hooks).toEqual([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command: 'node "${CLAUDE_SKILL_DIR}/guard.mjs"',
        timeout: 15,
        env: { KIKI_SKILL_DIR: skillDir, CLAUDE_SKILL_DIR: skillDir },
      },
      {
        event: 'PostCompact',
        command: `node ${skillDir}/scripts/post.mjs`,
        env: { KIKI_SKILL_DIR: skillDir, CLAUDE_SKILL_DIR: skillDir },
      },
    ]);

    expect(() =>
      parseSkillText({
        skillMdPath: `${skillDir}/SKILL.md`,
        skillDirName: 'example-skill',
        source: 'user',
        text: [
          '---',
          'name: broken-claude-skill',
          'description: Bad Claude hook',
          'hooks:',
          '  PreToolUse:',
          '    - hooks:',
          '        - type: prompt',
          '          command: echo hi',
          '---',
          'Body',
        ].join('\n'),
      }),
    ).toThrow(SkillParseError);

    expect(() =>
      parseSkillText({
        skillMdPath: `${skillDir}/SKILL.md`,
        skillDirName: 'example-skill',
        source: 'user',
        text: [
          '---',
          'name: broken-skill',
          'description: Bad hook',
          'hooks:',
          '  - event: NotARealEvent',
          '    command: echo hi',
          '---',
          'Body',
        ].join('\n'),
      }),
    ).toThrow(SkillParseError);
  });

  it('adds zero hook runs when loading a skill with no hooks', async () => {
    const disposables = new DisposableStore();
    const cwd = mkdtempSync(join(tmpdir(), 'skill-no-hooks-'));
    let ix: TestInstantiationService | undefined;
    try {
      const hostProcess = new HostProcessService();
      const spawnSpy = vi.spyOn(hostProcess, 'spawn');
      const catalog = new InMemorySkillCatalog();
      const plainSkill = parseSkillText({
        skillMdPath: join(cwd, 'plain', 'SKILL.md'),
        skillDirName: 'plain',
        source: 'user',
        text: [
          '---',
          'name: plain',
          'description: Plain skill with no hooks',
          '---',
          'Just instructions.',
        ].join('\n'),
      });
      expect(plainSkill.hooks).toBeUndefined();
      catalog.register(plainSkill);

      const sessionSkillCatalog: ISessionSkillCatalog = {
        _serviceBrand: undefined,
        catalog,
        ready: Promise.resolve(),
        onDidChange: Event.None as Event<string>,
        load: async () => {},
        reload: async () => {},
        list: async () => [],
      };
      const subagentHooks = createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']);

      ix = createServices(disposables, {
        strict: true,
        additionalServices: (reg) => {
          registerStateServices(reg);
          reg.defineInstance(ISessionContext, stubSessionContext(cwd));
          reg.definePartialInstance(ISessionManager, {
            onDidCreateSession: Event.None as ISessionManager['onDidCreateSession'],
            onWillCloseSession: Event.None as ISessionManager['onWillCloseSession'],
          });
          reg.defineInstance(ISessionMetadata, stubSessionMetadata());
          reg.defineInstance(ISessionAgentProfileCatalog, stubProfileCatalog());
          reg.defineInstance(IModelService, stubModelService());
          reg.definePartialInstance(ISessionSubagentService, {
            hooks: subagentHooks,
            onDidStopAgentTask: Event.None as Event<AgentTaskStopHookContext>,
          });
          reg.definePartialInstance(IConfigService, {
            ready: Promise.resolve(),
            get: <T = unknown>() => undefined as T,
          });
          reg.definePartialInstance(IPluginService, {
            enabledHooks: async () => [],
            onDidReload: Event.None as IPluginService['onDidReload'],
          });
          reg.defineInstance(IBootstrapService, stubBootstrap());
          reg.defineInstance(IHostProcessService, hostProcess);
          reg.definePartialInstance(ISessionIndex, { get: async () => undefined });
          reg.definePartialInstance(IPluginUsageService, { enabled: () => false });
        },
      });
      ix.set(IExternalHooksRunnerService, new SyncDescriptor(ExternalHooksRunnerService));
      ix.set(ISessionExternalHooksService, new SyncDescriptor(SessionExternalHooksService));
      const sessionHooks = ix.get(ISessionExternalHooksService);

      const result = await executeModelSkill(
        sessionSkillCatalog,
        stubSkillService(),
        { skill: 'plain' },
        0,
        'session-skill-hooks',
        undefined,
        sessionHooks,
      );
      expect(result.isError).toBeUndefined();
      expect(await sessionHooks.getSkillHooks()).toEqual([]);

      await subagentHooks.onWillStartAgentTask.run({
        agentName: 'worker',
        prompt: 'Do work',
        signal: new AbortController().signal,
      });
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      await ix?.dispose();
      await disposables.dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('loads skill hooks, enforces workspace trust, and injects SubagentStart, SessionStart, and PostCompact context', async () => {
    const disposables = new DisposableStore();
    const cwd = mkdtempSync(join(tmpdir(), 'skill-hooks-e2e-'));
    const childRoot = join(cwd, 'child-root');
    mkdirSync(childRoot);
    const skillDir = join(cwd, '.kiki', 'skills', 'session-skill');
    const scriptsDir = join(skillDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });

    const startScript = join(scriptsDir, 'subagent-start.mjs');
    writeFileSync(
      startScript,
      [
        'let raw = "";',
        'process.stdin.on("data", (c) => { raw += c; });',
        'process.stdin.on("end", () => {',
        '  const ev = JSON.parse(raw);',
        '  process.stdout.write(JSON.stringify({',
        '    hookSpecificOutput: {',
        '      hookEventName: "SubagentStart",',
        '      additionalContext: `child=${ev.agent_id} role=${ev.agent_role} profile=${ev.profile_name} parent=${ev.parent_agent_id} session=${ev.session_id} cwd=${ev.cwd} process=${process.cwd()}`,',
        '    },',
        '  }));',
        '});',
      ].join('\n'),
      'utf8',
    );

    const postCompactScript = join(scriptsDir, 'post-compact.mjs');
    writeFileSync(
      postCompactScript,
      [
        'let raw = "";',
        'process.stdin.on("data", (c) => { raw += c; });',
        'process.stdin.on("end", () => {',
        '  const ev = JSON.parse(raw);',
        '  process.stdout.write(`post-compact:${ev.trigger}:${ev.estimated_token_count}`);',
        '});',
      ].join('\n'),
      'utf8',
    );

    const skillText = [
      '---',
      'name: session-skill',
      'description: Skill with SubagentStart and PostCompact hooks',
      'hooks:',
      '  - event: SubagentStart',
      `    command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ./scripts/subagent-start.mjs`)}`,
      '    timeout: 5',
      '  - event: PostCompact',
      `    command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ./scripts/post-compact.mjs`)}`,
      '    timeout: 5',
      '---',
      'Skill instructions.',
    ].join('\n');

    let ix: TestInstantiationService | undefined;
    try {
      let workspaceTrusted = false;
      const trustEmitter = disposables.add(new Emitter<{ readonly trusted: boolean }>());
      const trust: IWorkspaceTrust = {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        get: async () => workspaceTrusted,
        isTrusted: () => workspaceTrusted,
        trust: async () => {
          workspaceTrusted = true;
          trustEmitter.fire({ trusted: true });
        },
        untrust: async () => {
          workspaceTrusted = false;
          trustEmitter.fire({ trusted: false });
        },
        onDidChange: trustEmitter.event,
      };

      const sessionCreated = new AsyncEmitter<SessionCreatedEvent & IWaitUntil>();
      const didCreateAgent = disposables.add(new Emitter<IAgentScopeHandle>());
      const agents = new Map<string, IAgentScopeHandle>();

      const mainContext = stubContextMemory();
      const childContext = stubContextMemory();
      const mainReminder = new AgentSystemReminderService(mainContext);
      const childReminder = new AgentSystemReminderService(childContext);
      const childEvents: string[] = [];

      const childExecution = {
        _serviceBrand: undefined,
        run: vi.fn(async () => {
          childEvents.push(`execution.run:messages=${childContext.messages.length}`);
          return {
            agentId: 'child-42',
            turn: { id: 1 } as AgentRunHandle['turn'],
            completion: Promise.resolve({ summary: 'done' }),
          };
        }),
      };

      const childHandle = makeFakeAgentHandle(
        'child-42',
        new Map<unknown, unknown>([
          [
            IAgentScopeContext,
            makeAgentScopeContext({
              agentId: 'child-42',
              agentScope: 'agents/child-42',
              parentAgentId: MAIN_AGENT_ID,
            }),
          ],
          [
            IAgentProfileService,
            {
              data: () => ({ profileName: 'implementer', executorId: 'native' }),
              getRecipeScriptHooks: async () => [],
            },
          ],
          [IAgentContextMemoryService, childContext],
          [IAgentSystemReminderService, childReminder],
          [IAgentExecutionService, childExecution],
          [IAgentRuntimeService, { workspaceRoots: () => ({ workDir: childRoot }) }],
        ]),
      );
      agents.set('child-42', childHandle);

      const compactionHooks = createHooks<{
        onWillCompact: FullCompactionTask;
        onDidCommit: FullCompactionTask;
      }, 'onWillCompact' | 'onDidCommit'>(['onWillCompact', 'onDidCommit']);

      ix = createServices(disposables, {
        strict: true,
        additionalServices: (reg) => {
          registerStateServices(reg);
          registerTestAgentWireServices(reg, 'wire/skill-hooks-context');
          reg.defineInstance(ISessionContext, stubSessionContext(cwd));
          reg.definePartialInstance(ISessionManager, {
            onDidCreateSession: sessionCreated.event,
            onWillCloseSession: Event.None as ISessionManager['onWillCloseSession'],
          });
          reg.defineInstance(ISessionMetadata, stubSessionMetadata());
          reg.defineInstance(ISessionAgentProfileCatalog, stubProfileCatalog());
          reg.defineInstance(IModelService, stubModelService());
          reg.defineInstance(ISessionHookWorkspace, {
            _serviceBrand: undefined,
            root: cwd,
            trust,
            runtime: {
              identity: { workspaceId: 'workspace-skill-hooks', runtimeId: 'local', generation: '1' },
            } as ISessionHookWorkspace['runtime'],
          });
          reg.definePartialInstance(IAgentLifecycleService, {
            onWillCreate: Event.None as Event<IAgentScopeHandle>,
            onDidCreate: didCreateAgent.event,
            onDidDispose: Event.None as Event<string>,
            get: (id: string) => agents.get(id),
          });
          reg.definePartialInstance(IFlagService, { enabled: () => false });
          reg.definePartialInstance(IAtomicDocumentStore, {});
          reg.definePartialInstance(IConfigService, {
            ready: Promise.resolve(),
            get: <T = unknown>(domain: string): T =>
              (domain === HOOKS_SECTION
                ? [
                  {
                    event: 'SessionStart' as const,
                    command: nodeCommand(
                      'process.stdout.write(JSON.stringify({ additionalContext: "session-boot-note" }));',
                    ),
                    timeout: 5,
                  },
                ]
                : undefined) as T,
          });
          reg.definePartialInstance(IPluginService, {
            enabledHooks: async () => [],
            onDidReload: Event.None as IPluginService['onDidReload'],
          });
          reg.defineInstance(IBootstrapService, stubBootstrap());
          reg.define(IHostProcessService, HostProcessService);
          reg.definePartialInstance(ISessionIndex, { get: async () => undefined });
          reg.definePartialInstance(IPluginUsageService, { enabled: () => false });
          reg.defineInstance(IAgentContextMemoryService, mainContext);
          reg.defineInstance(IAgentSystemReminderService, mainReminder);
          reg.defineInstance(IAgentLoopService, stubLoopWithHooks());
          reg.define(IEventBus, EventBusService);
          reg.definePartialInstance(IAgentPromptService, {
            hooks: createHooks(['onBeforeSubmitPrompt']),
          });
          reg.defineInstance(IAgentToolExecutorService, stubToolExecutor());
          reg.definePartialInstance(IAgentPermissionGate, {});
          reg.definePartialInstance(IAgentFullCompactionService, {
            hooks: compactionHooks,
          });
          reg.definePartialInstance(IAgentTaskService, {});
          reg.definePartialInstance(IAgentProfileService, {
            data: () => ({ profileName: 'default', executorId: 'native' } as ReturnType<IAgentProfileService['data']>),
            getRecipeScriptHooks: async () => [],
          });
        },
      });
      ix.set(IExternalHooksRunnerService, new SyncDescriptor(ExternalHooksRunnerService));
      ix.set(ISessionSubagentService, new SyncDescriptor(SessionSubagentService));
      ix.set(ISessionExternalHooksService, new SyncDescriptor(SessionExternalHooksService));
      ix.set(IAgentExternalHooksService, new SyncDescriptor(AgentExternalHooksService));

      const sessionHooks = ix.get(ISessionExternalHooksService);
      const subagents = ix.get(ISessionSubagentService);
      ix.get(IAgentExternalHooksService);

      await sessionCreated.fireAsync(
        {
          sessionId: 'session-skill-hooks',
          handle: {} as ISessionScopeHandle,
          source: 'startup' as SessionCreateSource,
        },
        new AbortController().signal,
      );
      expect(mainContext.messages).toHaveLength(0);

      const mainHandle = makeFakeAgentHandle(
        MAIN_AGENT_ID,
        new Map<unknown, unknown>([
          [IAgentContextMemoryService, mainContext],
          [IAgentSystemReminderService, mainReminder],
        ]),
      );
      agents.set(MAIN_AGENT_ID, mainHandle);
      didCreateAgent.fire(mainHandle);

      expect(mainContext.messages).toHaveLength(1);
      expect(mainContext.messages[0]).toMatchObject({
        role: 'user',
        origin: { kind: 'injection', variant: 'hook/SessionStart' },
        content: [{
          type: 'text',
          text: '<system-reminder>\n<hook_result hook_event="SessionStart">\nsession-boot-note\n</hook_result>\n</system-reminder>',
        }],
      });

      const projectSkill = parseSkillText({
        skillMdPath: join(skillDir, 'SKILL.md'),
        skillDirName: 'session-skill',
        source: 'project',
        text: skillText,
      });
      const catalog = new InMemorySkillCatalog();
      catalog.register({ ...projectSkill, hooks: projectSkill.hooks?.map((hook) => ({ ...hook, cwd: skillDir })) });
      const sessionSkillCatalog: ISessionSkillCatalog = {
        _serviceBrand: undefined,
        catalog,
        ready: Promise.resolve(),
        onDidChange: Event.None as Event<string>,
        load: async () => {},
        reload: async () => {},
        list: async () => [],
      };

      await executeModelSkill(
        sessionSkillCatalog,
        stubSkillService(),
        { skill: 'session-skill' },
        0,
        'session-skill-hooks',
        undefined,
        sessionHooks,
      );

      expect(await sessionHooks.getSkillHooks()).toEqual([]);

      await trust.trust();
      expect(await sessionHooks.getSkillHooks()).toHaveLength(2);

      await subagents.run(
        'child-42',
        { kind: 'prompt', prompt: 'Implement the seam' },
        { signal: new AbortController().signal },
      );

      expect(childEvents).toEqual(['execution.run:messages=1']);
      expect(childContext.messages).toHaveLength(1);
      expect(childContext.messages[0]).toMatchObject({
        role: 'user',
        origin: { kind: 'injection', variant: 'hook/SubagentStart' },
      });
      const childText = childContext.messages[0]?.content[0];
      expect(childText?.type === 'text' ? childText.text : '').toContain(
        `child=child-42 role=subagent profile=implementer parent=main session=session-skill-hooks cwd=${childRoot} process=${skillDir}`,
      );
      const externalHints = externalPromptHints(childContext.messages, new Set());
      expect(externalHints).toHaveLength(1);
      expect(externalHints[0]?.origin).toBe('injection:hook/SubagentStart');
      expect(externalHints[0]?.text).toContain('child=child-42');

      const compactTask: FullCompactionTask = {
        abortController: new AbortController(),
        promise: Promise.resolve({
          summary: 's',
          contextSummary: 's',
          compactedCount: 4,
          tokensBefore: 1000,
          tokensAfter: 321,
          keptUserMessageCount: 1,
        }),
        trigger: 'auto',
        tokenCount: 1000,
        committedStrategy: 'summarize',
        committedResult: {
          summary: 's',
          contextSummary: 's',
          compactedCount: 4,
          tokensBefore: 1000,
          tokensAfter: 321,
          keptUserMessageCount: 1,
        },
      };
      await compactionHooks.onDidCommit.run(compactTask);

      expect(mainContext.messages).toHaveLength(2);
      expect(mainContext.messages[1]).toMatchObject({
        role: 'user',
        origin: { kind: 'injection', variant: 'hook/PostCompact' },
        content: [{
          type: 'text',
          text: '<system-reminder>\n<hook_result hook_event="PostCompact">\npost-compact:auto:321\n</hook_result>\n</system-reminder>',
        }],
      });
    } finally {
      await ix?.dispose();
      await disposables.dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('blocks PreToolUse on exit 2 while crashing or timed-out Stop and SubagentStop hooks fail open with a warning', async () => {
    const warn = vi.fn();
    const log = {
      warn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as unknown as ILogService;

    const crashingStopRunner = makeHookRunner(
      [
        {
          event: 'PreToolUse',
          matcher: 'DangerTool',
          command: nodeCommand('process.stderr.write("blocked by policy"); process.exit(2);'),
          timeout: 5,
        },
        {
          event: 'Stop',
          command: nodeCommand('process.stderr.write("unexpected crash"); process.exit(1);'),
          timeout: 5,
        },
        {
          event: 'SubagentStop',
          command: nodeCommand('process.stderr.write("subagent script crash"); process.exit(1);'),
          timeout: 5,
        },
      ],
      { log },
    );

    const disposables = new DisposableStore();
    let ix: TestInstantiationService | undefined;
    try {
      const loop = stubLoopWithHooks();
      const context = stubContextMemory();

      ix = createServices(disposables, {
        strict: true,
        additionalServices: (reg) => {
          registerStateServices(reg);
          registerTestAgentWireServices(reg, 'wire/fail-open-stop');
          reg.defineInstance(IBootstrapService, stubBootstrap());
          reg.defineInstance(ISessionContext, stubSessionContext(process.cwd()));
          reg.defineInstance(ISessionMetadata, stubSessionMetadata());
          reg.definePartialInstance(IConfigService, {});
          reg.definePartialInstance(IPluginService, {});
          reg.defineInstance(IAgentContextMemoryService, context);
          reg.defineInstance(IAgentLoopService, loop);
          reg.define(IEventBus, EventBusService);
          reg.definePartialInstance(IAgentPromptService, {
            hooks: createHooks(['onBeforeSubmitPrompt']),
          });
          reg.define(IAgentToolExecutorService, AgentToolExecutorService);
          reg.define(IAgentToolRegistryService, AgentToolRegistryService);
          reg.definePartialInstance(IAgentToolResultTruncationService, {
            truncateForModel: async (input) => input.result,
          });
          reg.definePartialInstance(IAgentPermissionGate, {});
          reg.definePartialInstance(IAgentFullCompactionService, {
            hooks: createHooks(['onWillCompact', 'onDidCommit']),
          });
          reg.definePartialInstance(IAgentTaskService, {});
          reg.definePartialInstance(IAgentProfileService, { getRecipeScriptHooks: async () => [] });
        },
      });
      ix.set(IExternalHooksRunnerService, crashingStopRunner);
      ix.set(IAgentExternalHooksService, new SyncDescriptor(AgentExternalHooksService));
      ix.get(IAgentExternalHooksService);

      const executeSpy = vi.fn(async () => ({ output: 'ran' }));
      ix.get(IAgentToolRegistryService).register({
        name: 'DangerTool',
        foregroundPolicy: 'instant',
        description: 'Fixture',
        parameters: { type: 'object' },
        resolveExecution: () => ({
          approvalRule: 'DangerTool',
          accesses: ToolAccesses.none(),
          execute: executeSpy,
        }),
      });

      const executor = ix.get(IAgentToolExecutorService);
      const results: Array<{ readonly result: { readonly isError?: boolean; readonly output: unknown } }> = [];
      for await (const item of executor.execute(
        [{ id: 'call-1', name: 'DangerTool', type: 'function', arguments: '{}' }],
        { turnId: 0, signal: new AbortController().signal },
      )) {
        results.push(item);
      }
      expect(executeSpy).not.toHaveBeenCalled();
      expect(results[0]?.result.isError).toBe(true);
      expect(String(results[0]?.result.output)).toContain('blocked by policy');

      await loop.hooks.onDidFinishStep.run(makeAfterStep(new AbortController().signal));
      expect(loop.hasPendingRequests()).toBe(false);
      expect(context.messages).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        'Stop hook failed; failing open',
        expect.objectContaining({ event: 'Stop', exitCode: 1 }),
      );

      await expect(
        crashingStopRunner.triggerBlock('SubagentStop', { matcherValue: 'worker' }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        'SubagentStop hook failed; failing open',
        expect.objectContaining({ event: 'SubagentStop', exitCode: 1 }),
      );
    } finally {
      await ix?.dispose();
      await disposables.dispose();
      await crashingStopRunner.dispose();
    }

    const timeoutWarn = vi.fn();
    const timeoutRunner = makeHookRunner(
      [
        {
          event: 'Stop',
          command: nodeCommand('setTimeout(() => {}, 10000);'),
          timeout: 0.05,
        },
      ],
      { log: { warn: timeoutWarn } as unknown as ILogService },
    );
    try {
      await expect(timeoutRunner.triggerBlock('Stop', { inputData: { stopHookActive: false } })).resolves.toBeUndefined();
      expect(timeoutWarn).toHaveBeenCalledWith(
        'Stop hook failed; failing open',
        expect.objectContaining({ event: 'Stop', timedOut: true }),
      );
    } finally {
      await timeoutRunner.dispose();
    }

    const explicitStopRunner = makeHookRunner([
      {
        event: 'Stop',
        command: nodeCommand('process.stderr.write("must finish checks"); process.exit(2);'),
        timeout: 5,
      },
    ]);
    try {
      await expect(explicitStopRunner.triggerBlock('Stop', { inputData: { stopHookActive: false } })).resolves.toEqual({
        block: true,
        reason: 'must finish checks',
      });
    } finally {
      await explicitStopRunner.dispose();
    }
  });

  it('gates workspace-contained user skills on trust and revokes disabled plugin skill hooks immediately', async () => {
    const disposables = new DisposableStore();
    const cwd = mkdtempSync(join(tmpdir(), 'skill-hooks-trust-plugin-'));
    const containedSkillDir = join(cwd, 'custom-skills', 'local-hook');
    mkdirSync(containedSkillDir, { recursive: true });
    let ix: TestInstantiationService | undefined;
    try {
      let workspaceTrusted = false;
      let pluginGloballyEnabled = true;
      let pluginUsageAllowed = true;
      const trustEmitter = disposables.add(new Emitter<{ readonly trusted: boolean }>());
      const trust: IWorkspaceTrust = {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        get: async () => workspaceTrusted,
        isTrusted: () => workspaceTrusted,
        trust: async () => {
          workspaceTrusted = true;
          trustEmitter.fire({ trusted: true });
        },
        untrust: async () => {
          workspaceTrusted = false;
          trustEmitter.fire({ trusted: false });
        },
        onDidChange: trustEmitter.event,
      };
      const subagentHooks = createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']);

      ix = createServices(disposables, {
        strict: true,
        additionalServices: (reg) => {
          registerStateServices(reg);
          reg.defineInstance(ISessionContext, stubSessionContext(cwd));
          reg.definePartialInstance(ISessionManager, {
            onDidCreateSession: Event.None as ISessionManager['onDidCreateSession'],
            onWillCloseSession: Event.None as ISessionManager['onWillCloseSession'],
          });
          reg.defineInstance(ISessionMetadata, stubSessionMetadata());
          reg.defineInstance(ISessionAgentProfileCatalog, stubProfileCatalog());
          reg.defineInstance(IModelService, stubModelService());
          reg.definePartialInstance(ISessionSubagentService, {
            hooks: subagentHooks,
            onDidStopAgentTask: Event.None as Event<AgentTaskStopHookContext>,
          });
          reg.defineInstance(ISessionHookWorkspace, {
            _serviceBrand: undefined,
            root: cwd,
            trust,
            runtime: {
              identity: { workspaceId: 'workspace-skill-hooks', runtimeId: 'local', generation: '1' },
            } as ISessionHookWorkspace['runtime'],
          });
          reg.definePartialInstance(IConfigService, {
            ready: Promise.resolve(),
            get: <T = unknown>() => undefined as T,
          });
          reg.definePartialInstance(IPluginService, {
            enabledHooks: async () => [],
            onDidReload: Event.None as IPluginService['onDidReload'],
            hasLoadedSnapshot: () => true,
            pluginSkillRoots: async () => pluginGloballyEnabled
              ? [{ path: '/plugins/demo/skills', source: 'extra', plugin: { id: 'demo-plugin', name: 'Demo' } }]
              : [],
          });
          reg.defineInstance(IBootstrapService, stubBootstrap());
          reg.define(IHostProcessService, HostProcessService);
          reg.definePartialInstance(ISessionIndex, {
            get: async () => ({ workspaceId: 'workspace-skill-hooks' }) as Awaited<ReturnType<ISessionIndex['get']>>,
          });
          reg.definePartialInstance(IPluginUsageService, {
            enabled: () => true,
            allows: async () => pluginUsageAllowed,
          });
        },
      });
      ix.set(IExternalHooksRunnerService, new SyncDescriptor(ExternalHooksRunnerService));
      ix.set(ISessionExternalHooksService, new SyncDescriptor(SessionExternalHooksService));
      const runner = ix.get(IExternalHooksRunnerService);
      const sessionHooks = ix.get(ISessionExternalHooksService);

      sessionHooks.registerSkillHooks({
        skillName: 'local-hook',
        skillPath: join(containedSkillDir, 'SKILL.md'),
        skillDir: containedSkillDir,
        source: 'user',
        hooks: [{ event: 'PostCompact', command: nodeCommand('process.stdout.write("local-ok");'), timeout: 5 }],
      });
      expect(await sessionHooks.getSkillHooks()).toEqual([]);

      await trust.trust();
      expect(await sessionHooks.getSkillHooks()).toHaveLength(1);

      sessionHooks.registerSkillHooks({
        skillName: 'plugin-skill',
        skillPath: '/plugins/demo/skills/plugin-skill/SKILL.md',
        skillDir: '/plugins/demo/skills/plugin-skill',
        source: 'extra',
        pluginId: 'demo-plugin',
        hooks: [{ event: 'SessionStart', command: nodeCommand('process.stdout.write("plugin-ok");'), timeout: 5 }],
      });
      const allowedResults = await runner.trigger('SessionStart', {
        sessionId: 'session-skill-hooks',
        additionalHooks: () => sessionHooks.getSkillHooks(),
      });
      expect(allowedResults.map((r) => r.stdout?.trim())).toEqual(['plugin-ok']);

      pluginUsageAllowed = false;
      const usageRevoked = await runner.trigger('SessionStart', {
        sessionId: 'session-skill-hooks',
        additionalHooks: () => sessionHooks.getSkillHooks(),
      });
      expect(usageRevoked).toEqual([]);

      pluginUsageAllowed = true;
      pluginGloballyEnabled = false;
      const globallyRevoked = await runner.trigger('SessionStart', {
        sessionId: 'session-skill-hooks',
        additionalHooks: () => sessionHooks.getSkillHooks(),
      });
      expect(globallyRevoked).toEqual([]);
    } finally {
      await ix?.dispose();
      await disposables.dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('delivers PreToolUse and PostToolUse additionalContext as canonical system reminders', async () => {
    const disposables = new DisposableStore();
    const runner = makeHookRunner([
      {
        event: 'PreToolUse',
        matcher: 'EchoTool',
        command: nodeCommand(
          'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "pre-tool-note" } }));',
        ),
        timeout: 5,
      },
      {
        event: 'PostToolUse',
        matcher: 'EchoTool',
        command: nodeCommand(
          'process.stdout.write(JSON.stringify({ additionalContext: "post-tool-note" }));',
        ),
        timeout: 5,
      },
    ]);
    let ix: TestInstantiationService | undefined;
    try {
      const context = stubContextMemory();
      const reminder = new AgentSystemReminderService(context);
      ix = createServices(disposables, {
        strict: true,
        additionalServices: (reg) => {
          registerStateServices(reg);
          registerTestAgentWireServices(reg, 'wire/tool-hook-context');
          reg.defineInstance(IBootstrapService, stubBootstrap());
          reg.defineInstance(ISessionContext, stubSessionContext(process.cwd()));
          reg.defineInstance(ISessionMetadata, stubSessionMetadata());
          reg.definePartialInstance(IConfigService, {});
          reg.definePartialInstance(IPluginService, {});
          reg.defineInstance(IAgentContextMemoryService, context);
          reg.defineInstance(IAgentSystemReminderService, reminder);
          reg.defineInstance(IAgentLoopService, stubLoopWithHooks());
          reg.define(IEventBus, EventBusService);
          reg.definePartialInstance(IAgentPromptService, { hooks: createHooks(['onBeforeSubmitPrompt']) });
          reg.define(IAgentToolExecutorService, AgentToolExecutorService);
          reg.define(IAgentToolRegistryService, AgentToolRegistryService);
          reg.definePartialInstance(IAgentToolResultTruncationService, {
            truncateForModel: async (input) => input.result,
          });
          reg.definePartialInstance(IAgentPermissionGate, {});
          reg.definePartialInstance(IAgentFullCompactionService, {
            hooks: createHooks(['onWillCompact', 'onDidCommit']),
          });
          reg.definePartialInstance(IAgentTaskService, {});
          reg.definePartialInstance(IAgentProfileService, { getRecipeScriptHooks: async () => [] });
        },
      });
      ix.set(IExternalHooksRunnerService, runner);
      ix.set(IAgentExternalHooksService, new SyncDescriptor(AgentExternalHooksService));
      ix.get(IAgentExternalHooksService);

      ix.get(IAgentToolRegistryService).register({
        name: 'EchoTool',
        foregroundPolicy: 'instant',
        description: 'Fixture',
        parameters: { type: 'object' },
        resolveExecution: () => ({
          approvalRule: 'EchoTool',
          accesses: ToolAccesses.none(),
          execute: async () => ({ output: 'ok' }),
        }),
      });

      const executor = ix.get(IAgentToolExecutorService);
      for await (const _item of executor.execute(
        [{ id: 'call-echo', name: 'EchoTool', type: 'function', arguments: '{}' }],
        { turnId: 0, signal: new AbortController().signal },
      )) {
      }

      await vi.waitFor(() => {
        expect(context.messages).toHaveLength(2);
      });
      expect(context.messages[0]).toMatchObject({
        role: 'user',
        origin: { kind: 'injection', variant: 'hook/PreToolUse' },
        content: [{
          type: 'text',
          text: '<system-reminder>\n<hook_result hook_event="PreToolUse">\npre-tool-note\n</hook_result>\n</system-reminder>',
        }],
      });
      expect(context.messages[1]).toMatchObject({
        role: 'user',
        origin: { kind: 'injection', variant: 'hook/PostToolUse' },
        content: [{
          type: 'text',
          text: '<system-reminder>\n<hook_result hook_event="PostToolUse">\npost-tool-note\n</hook_result>\n</system-reminder>',
        }],
      });
    } finally {
      await ix?.dispose();
      await disposables.dispose();
      await runner.dispose();
    }
  });

  it.each(['local', 'ssh:fixture'] as const)('keeps the child root through a %s resume and dedupes the autonomous stop receipt', { timeout: 20_000 }, async (runtimeId) => {
    const disposables = new DisposableStore();
    const cwd = mkdtempSync(join(tmpdir(), 'skill-hooks-subagent-veto-'));
    const childRoot = runtimeId === 'local' ? join(cwd, 'child-root') : '/remote/child-root';
    if (runtimeId === 'local') mkdirSync(childRoot);
    const hookLog = join(cwd, 'hooks.jsonl');
    const script = join(cwd, 'record-hook.cjs');
    writeFileSync(script, [
      'let raw = "";',
      'process.stdin.on("data", (chunk) => { raw += chunk; });',
      'process.stdin.on("end", () => {',
      '  const { hook_event_name, cwd, work_dir } = JSON.parse(raw);',
      `  require('node:fs').appendFileSync(${JSON.stringify(hookLog)}, JSON.stringify({ hook_event_name, cwd, work_dir, processCwd: process.cwd() }) + '\\n');`,
      '  if (hook_event_name === "SubagentStart") process.stdout.write("route-matched-start");',
      '  if (hook_event_name === "SubagentStop") { process.stderr.write("finish child checks"); process.exitCode = 2; }',
      '});',
    ].join('\n'));
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    const readCalls = () => readFileSync(hookLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    let subagentStopCount = 0;
    let ix: TestInstantiationService | undefined;
    try {
      const childContext = stubContextMemory();
      childContext.append({
        role: 'assistant',
        content: [{ type: 'text', text: 'partial child answer' }],
        toolCalls: [],
      });
      const childReminder = new AgentSystemReminderService(childContext);
      const childLoop = stubLoopWithHooks();
      const agentId = 'child-route-1';
      const runtimeBinding = { current: { workspaceId: 'workspace-skill-hooks', runtimeId } };
      const fixtureRuntime = disposables.add(new FakeRuntime({ ...runtimeBinding.current, generation: '1' }, {
        mapWorkspaceRoots: () => ({ workDir: childRoot }),
      }));
      const runtime = {
        workspaceRoots: () => ({ workDir: runtimeId === 'local' ? childRoot : cwd }),
        inspect: () => fixtureRuntime,
      };
      const scope = makeAgentScopeContext({ agentId, agentScope: `agents/${agentId}`, parentAgentId: MAIN_AGENT_ID });
      const metadata = stubSessionMetadata();
      const receipt = { turnId: 0, startedAt: 10, endedAt: 12, summary: 'autonomous output' };
      const receiptWrite = createControlledPromise<void>();
      const recordCompletedTask = vi.fn(() => receiptWrite);
      const dispatchDurably = vi.fn(async () => {});
      const parentHandle = makeFakeAgentHandle(MAIN_AGENT_ID, new Map<unknown, unknown>([
        [IAgentTaskService, { recordCompletedTask }],
        [IEventDispatcher, { dispatchDurably }],
        [ISessionSubagentService, { notifyAgentTaskStopped: (ctx: AgentTaskStopHookContext) => ix!.get(ISessionSubagentService).notifyAgentTaskStopped(ctx) }],
      ]));
      const childExecution = {
        _serviceBrand: undefined,
        run: vi.fn(async () => ({
          agentId: 'child-route-1',
          turn: { id: 1 } as AgentRunHandle['turn'],
          completion: Promise.resolve({ summary: 'done' }),
        })),
      };
      const childHandle = makeFakeAgentHandle(
        agentId,
        new Map<unknown, unknown>([
          [IAgentScopeContext, scope],
          [IAgentRuntimeService, runtime],
          [IAgentRuntimeBindingService, runtimeBinding],
          [IAgentUsageService, { status: () => ({ total: undefined }) }],
          [IAgentTokenCountingService, { statusSize: () => 0 }],
          [IAgentActivityView, { telemetry: () => ({ toolCallCount: 1 }) }],
          [ISessionMetadata, { ...metadata, snapshot: metadata.current, updateAgent: vi.fn(async () => {}) }],
          [IAgentLifecycleService, { get: (id: string) => id === MAIN_AGENT_ID ? parentHandle : undefined }],
          [IEventDispatcher, { dispatch: async () => {}, dispatchDurably }],
          [IAgentStateService, { get: () => ix!.get(IAgentStateService).get(autonomousReceiptsKey) }],
          [IEventBus, { subscribe: () => ({ dispose: () => {} }) }],
          [IAgentExternalHooksService, { consumeAutonomousStop: (turnId: number) => ix!.get(IAgentExternalHooksService).consumeAutonomousStop(turnId) }],
          [
            IAgentProfileService,
            {
              data: () => ({ profileName: 'implementer', routeId: 'fast-implementer', executorId: 'native' }),
              getRecipeScriptHooks: async () => [],
            },
          ],
          [IAgentContextMemoryService, childContext],
          [IAgentSystemReminderService, childReminder],
          [IAgentExecutionService, childExecution],
        ]),
      );

      const runner = makeHookRunner(
        [
          {
            event: 'SubagentStart',
            matcher: 'fast-implementer',
            command,
            timeout: 5,
          },
          {
            event: 'SubagentStop',
            command,
            timeout: 5,
          },
          { event: 'PreToolUse', command, timeout: 5 },
        ],
        {
          onResolved: (event) => {
            if (event === 'SubagentStop') subagentStopCount += 1;
          },
        },
      );

      ix = createServices(disposables, {
        strict: true,
        additionalServices: (reg) => {
          registerStateServices(reg);
          registerTestAgentWireServices(reg, 'wire/subagent-stop-veto');
          reg.defineInstance(ISessionContext, stubSessionContext(cwd));
          reg.definePartialInstance(ISessionManager, {
            onDidCreateSession: Event.None as ISessionManager['onDidCreateSession'],
            onWillCloseSession: Event.None as ISessionManager['onWillCloseSession'],
          });
          reg.defineInstance(ISessionMetadata, stubSessionMetadata());
          reg.defineInstance(ISessionAgentProfileCatalog, stubProfileCatalog());
          reg.defineInstance(IModelService, stubModelService());
          reg.definePartialInstance(IAgentLifecycleService, {
            onWillCreate: Event.None as Event<IAgentScopeHandle>,
            onDidCreate: Event.None as Event<IAgentScopeHandle>,
            onDidDispose: Event.None as Event<string>,
            get: (id: string) => id === agentId ? childHandle : id === MAIN_AGENT_ID ? parentHandle : undefined,
          });
          reg.definePartialInstance(IFlagService, { enabled: () => false });
          reg.definePartialInstance(IAtomicDocumentStore, {});
          reg.definePartialInstance(IConfigService, {});
          reg.definePartialInstance(IPluginService, {});
          reg.defineInstance(IBootstrapService, stubBootstrap());
          reg.defineInstance(IAgentContextMemoryService, childContext);
          reg.defineInstance(IAgentSystemReminderService, childReminder);
          reg.defineInstance(IAgentLoopService, childLoop);
          reg.define(IEventBus, EventBusService);
          reg.definePartialInstance(IAgentPromptService, { hooks: createHooks(['onBeforeSubmitPrompt']) });
          reg.define(IAgentToolExecutorService, AgentToolExecutorService);
          reg.define(IAgentToolRegistryService, AgentToolRegistryService);
          reg.definePartialInstance(IAgentToolResultTruncationService, { truncateForModel: async (input) => input.result });
          reg.definePartialInstance(IAgentPermissionGate, {});
          reg.definePartialInstance(IAgentFullCompactionService, {
            hooks: createHooks(['onWillCompact', 'onDidCommit']),
          });
          reg.definePartialInstance(IAgentTaskService, {});
          reg.defineInstance(IAgentScopeContext, scope);
          reg.definePartialInstance(IAgentRuntimeService, runtime);
          reg.definePartialInstance(IAgentRuntimeBindingService, runtimeBinding);
          reg.definePartialInstance(IAgentProfileService, {
            data: () => ({ profileName: 'implementer', routeId: 'fast-implementer', executorId: 'native' } as ReturnType<IAgentProfileService['data']>),
            getRecipeScriptHooks: async () => [],
          });
        },
      });
      const fireAndForget = vi.spyOn(runner, 'fireAndForgetTrigger');
      const observedStops = () => fireAndForget.mock.calls.flatMap(([event], index) =>
        event === 'SubagentStop' ? [fireAndForget.mock.results[index]] : []);
      ix.set(IExternalHooksRunnerService, runner);
      ix.set(ISessionSubagentService, new SyncDescriptor(SessionSubagentService));
      ix.set(ISessionExternalHooksService, new SyncDescriptor(SessionExternalHooksService));
      ix.set(IAgentExternalHooksService, new SyncDescriptor(AgentExternalHooksService));

      const subagents = ix.get(ISessionSubagentService);
      ix.get(ISessionExternalHooksService);
      ix.get(IAgentExternalHooksService);

      ix.get(IAgentToolRegistryService).register({
        name: 'ReadFixture', foregroundPolicy: 'instant', description: 'Read fixture', parameters: { type: 'object' },
        resolveExecution: () => ({ approvalRule: 'ReadFixture', accesses: ToolAccesses.none(), execute: async () => ({ output: 'fixture' }) }),
      });
      const runChildWithTool = async (prompt: string) => {
        const signal = new AbortController().signal;
        const run = await subagents.run(agentId, { kind: 'prompt', prompt }, { signal });
        for await (const result of ix!.get(IAgentToolExecutorService).execute(
          [{ id: prompt, name: 'ReadFixture', type: 'function', arguments: '{}' }], { turnId: run.turn.id, signal },
        )) {
          expect(result).toBeDefined();
        }
        return run;
      };
      const bus = ix.get(IEventBus);
      const agentStates = ix.get(IAgentStateService);
      agentStates.contributeState(autonomousReceiptsKey);
      bus.publish(new TurnStarted({ turnId: 0, parentReceiptManaged: false, origin: { kind: 'user' } }));
      await runChildWithTool('Do routed work');
      expect(childContext.messages.some((m) =>
        m.origin?.kind === 'injection' &&
        m.origin.variant === 'hook/SubagentStart' &&
        m.content.some((p) => p.type === 'text' && p.text.includes('route-matched-start')),
      )).toBe(true);

      await childLoop.hooks.onDidFinishStep.run(makeAfterStep(new AbortController().signal));
      expect(childLoop.hasPendingRequests()).toBe(true);
      expect(childContext.messages.at(-1)).toMatchObject({
        role: 'user',
        origin: { kind: 'system_trigger', name: 'stop_hook' },
        content: [{ type: 'text', text: '<system-reminder>\nfinish child checks\n</system-reminder>' }],
      });
      expect(subagentStopCount).toBe(1);
      expect(childLoop.queue.takeNextBatch()?.driver.kind).toBe('stop_hook');
      await childLoop.hooks.onDidFinishStep.run(makeAfterStep(new AbortController().signal));
      expect(childLoop.hasPendingRequests()).toBe(false);
      expect(subagentStopCount).toBe(1);

      agentStates.set(autonomousReceiptsKey, { pending: { '0': receipt } });
      bus.publish(new TurnEnded({ turnId: 0, reason: 'completed' }));
      const deliveries: ReceiptDelivery[] = [];
      disposables.add(observeAutonomousReceipts(childHandle, (delivery) => deliveries.push(delivery), () => false, () => {}, new AbortController().signal));
      expect(deliveries).toHaveLength(1);
      const resumed = await runChildWithTool('Resume the child');
      bus.publish(new TurnStarted({ turnId: 1, parentReceiptManaged: true, origin: { kind: 'user' } }));
      await childLoop.hooks.onDidFinishStep.run({ ...makeAfterStep(new AbortController().signal), turnId: 1 });
      expect(subagentStopCount).toBe(2);
      receiptWrite.resolve();
      await deliveries[0]!.settled;
      expect(recordCompletedTask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentId }), 'autonomous output');
      expect(dispatchDurably).toHaveBeenCalledWith(expect.any(AutonomousReceiptDelivered));
      expect(observedStops()).toHaveLength(0);

      await expect(resumed.completion).resolves.toEqual({ summary: 'done' });
      subagents.notifyAgentTaskStopped({ agentId, agentName: 'fast-implementer', response: 'done' });
      expect(observedStops()).toHaveLength(0);
      subagents.notifyAgentTaskStopped({ agentId, agentName: 'fast-implementer', response: 'unobserved completion' });
      expect(observedStops()).toHaveLength(1);
      await observedStops()[0]!.value;
      expect(subagentStopCount).toBe(3);
      const expectedCall = (hook_event_name: string) => ({ hook_event_name, cwd: childRoot, processCwd: runtimeId === 'local' ? childRoot : cwd });
      expect(readCalls()).toEqual([
        expectedCall('SubagentStart'), expectedCall('PreToolUse'), expectedCall('SubagentStop'),
        expectedCall('SubagentStart'), expectedCall('PreToolUse'), expectedCall('SubagentStop'), expectedCall('SubagentStop'),
      ]);
      await runner.dispose();
    } finally {
      await ix?.dispose();
      await disposables.dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('emits SubagentFailed when the init subagent cannot start', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skill-hooks-init-failure-'));
    try {
      const dispatched: unknown[] = [];
      const initChildHandle = makeFakeAgentHandle(
        'init-child',
        new Map<unknown, unknown>([
          [IAgentPermissionModeService, { mode: 'auto', setMode: () => {} }],
          [IAgentProfileService, { data: () => ({}), getEffectiveThinkingLevel: () => undefined, republishStatus: () => {} }],
        ]),
      );
      const initLifecycle = {
        get: (id: string) => (id === MAIN_AGENT_ID ? mainHandle : id === 'init-child' ? initChildHandle : undefined),
        create: async () => initChildHandle,
      } as unknown as IAgentLifecycleService;
      const mainHandle = makeFakeAgentHandle(
        MAIN_AGENT_ID,
        new Map<unknown, unknown>([
          [IAgentProfileService, { data: () => ({ modelAlias: 'kimi-test', thinkingLevel: 'low' }) }],
          [IAgentPermissionModeService, { mode: 'auto', setMode: () => {} }],
          [IAgentAgentsMdReminderService, { seedInjected: () => {} }],
          [IAgentSystemReminderService, { appendSystemReminder: () => {} }],
          [IAgentLifecycleService, initLifecycle],
          [ITelemetryService, { track2: () => {} }],
          [IEventDispatcher, { dispatch: async (ev: unknown) => { dispatched.push(ev); }, flush: async () => {} }],
        ]),
      );
      const initService = new SessionInitService(
        initLifecycle,
        {
          run: async () => {
            throw new Error('SubagentStart hook failed');
          },
        } as unknown as ISessionSubagentService,
        {} as IHostFileSystem,
        { homeDir: cwd } as IHostEnvironment,
        stubBootstrap(cwd),
        stubSessionContext(cwd),
        { get: () => ({ defaultProfile: 'worker' }) } as unknown as IConfigService,
      );
      await expect(initService.generateAgentsMd()).rejects.toThrow('SubagentStart hook failed');
      expect(dispatched.some((event) => event instanceof SubagentSpawned && event.subagentId === 'init-child')).toBe(true);
      expect(dispatched.some((event) => event instanceof SubagentFailed && event.subagentId === 'init-child')).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('persists session-active skill hooks across cold resume and triggers them on SessionStart resume', async () => {
    const disposables = new DisposableStore();
    const cwd = mkdtempSync(join(tmpdir(), 'skill-hooks-cold-resume-'));
    const externalSkillDir = mkdtempSync(join(tmpdir(), 'skill-hooks-user-dir-'));
    let first: TestInstantiationService | undefined;
    let resumed: TestInstantiationService | undefined;
    try {
      const sharedMeta = stubSessionMetadata();
      const buildSession = (sessionCreated: AsyncEmitter<SessionCreatedEvent & IWaitUntil>, mainContext: ReturnType<typeof stubContextMemory>) => {
        const mainHandle = makeFakeAgentHandle(
          MAIN_AGENT_ID,
          new Map<unknown, unknown>([
            [IAgentContextMemoryService, mainContext],
            [IAgentSystemReminderService, new AgentSystemReminderService(mainContext)],
          ]),
        );
        const container = createServices(disposables, {
          strict: true,
          additionalServices: (reg) => {
            registerStateServices(reg);
            reg.defineInstance(ISessionContext, stubSessionContext(cwd));
            reg.definePartialInstance(ISessionManager, {
              onDidCreateSession: sessionCreated.event,
              onWillCloseSession: Event.None as ISessionManager['onWillCloseSession'],
            });
            reg.defineInstance(ISessionMetadata, sharedMeta);
            reg.defineInstance(ISessionAgentProfileCatalog, stubProfileCatalog());
            reg.defineInstance(IModelService, stubModelService());
            reg.definePartialInstance(ISessionSubagentService, {
              hooks: createHooks<AgentTaskHooks, keyof AgentTaskHooks>(['onWillStartAgentTask']),
              onDidStopAgentTask: Event.None as Event<AgentTaskStopHookContext>,
            });
            reg.definePartialInstance(IAgentLifecycleService, {
              onWillCreate: Event.None as Event<IAgentScopeHandle>,
              onDidCreate: Event.None as Event<IAgentScopeHandle>,
              onDidDispose: Event.None as Event<string>,
              get: (id: string) => (id === MAIN_AGENT_ID ? mainHandle : undefined),
            });
            reg.definePartialInstance(IConfigService, {
              ready: Promise.resolve(),
              get: <T = unknown>() => undefined as T,
            });
            reg.definePartialInstance(IPluginService, {
              enabledHooks: async () => [],
              onDidReload: Event.None as IPluginService['onDidReload'],
            });
            reg.defineInstance(IBootstrapService, stubBootstrap());
            reg.define(IHostProcessService, HostProcessService);
            reg.definePartialInstance(ISessionIndex, { get: async () => undefined });
            reg.definePartialInstance(IPluginUsageService, { enabled: () => false });
          },
        });
        container.set(IExternalHooksRunnerService, new SyncDescriptor(ExternalHooksRunnerService));
        container.set(ISessionExternalHooksService, new SyncDescriptor(SessionExternalHooksService));
        return container;
      };

      const firstCreated = new AsyncEmitter<SessionCreatedEvent & IWaitUntil>();
      first = buildSession(firstCreated, stubContextMemory());
      const firstHooks = first.get(ISessionExternalHooksService);
      firstHooks.registerSkillHooks({
        skillName: 'resume-skill',
        skillPath: join(externalSkillDir, 'SKILL.md'),
        skillDir: externalSkillDir,
        source: 'user',
        hooks: [
          {
            event: 'SessionStart',
            matcher: 'resume',
            command: nodeCommand('process.stdout.write("cold-resume-skill-note");'),
            timeout: 5,
          },
        ],
      });
      await vi.waitFor(() => {
        expect(sharedMeta.current().custom?.['active_skill_hooks']).toBeDefined();
      });
      await first.dispose();
      first = undefined;

      const resumeCreated = new AsyncEmitter<SessionCreatedEvent & IWaitUntil>();
      const resumedMainContext = stubContextMemory();
      resumed = buildSession(resumeCreated, resumedMainContext);
      const resumedHooks = resumed.get(ISessionExternalHooksService);
      expect(await resumedHooks.getSkillHooks()).toHaveLength(1);

      await resumeCreated.fireAsync(
        {
          sessionId: 'session-skill-hooks',
          handle: {} as ISessionScopeHandle,
          source: 'resume' as SessionCreateSource,
        },
        new AbortController().signal,
      );
      expect(resumedMainContext.messages).toHaveLength(1);
      expect(resumedMainContext.messages[0]).toMatchObject({
        role: 'user',
        origin: { kind: 'injection', variant: 'hook/SessionStart' },
        content: [{
          type: 'text',
          text: '<system-reminder>\n<hook_result hook_event="SessionStart">\ncold-resume-skill-note\n</hook_result>\n</system-reminder>',
        }],
      });
    } finally {
      await first?.dispose();
      await resumed?.dispose();
      await disposables.dispose();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(externalSkillDir, { recursive: true, force: true });
    }
  });
});
