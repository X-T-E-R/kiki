import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { HookRulesSession } from '#/features/externalHooks/session/hookRulesService';
import { ISessionHookWorkspace, IHookRulesSession } from '#/features/externalHooks/session/hookRules';
import { IHookRulesRegistry } from '#/features/externalHooks/app/hookRules';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlledPromise } from '@antfu/utils';
import { IAgentTaskService } from '#/agent/task/task';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import { createAgentTaskPersistence, type TaskServiceTestManager } from '../../agent/task/stubs';
import { IAgentCollaborationMessageStore } from '#/session/agentCollaboration/messageMailbox';
import { appServices, homeDirServices } from '../../harness';
import { Emitter, Event } from '#/_base/event';
import { IPluginUsageService, type PluginUsageChange } from '#/app/pluginUsage/pluginUsage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ContextAppendLoopEvent, ContextApplyCompaction, ContextUndo } from '#/agent/contextMemory/contextEvents';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IModelService } from '#/kosong/model/model';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentCommandService } from '#/agent/command/agentCommand';
import { IEventBus } from '#/app/event/eventBus';
import { HookResult } from '#/features/externalHooks/agent/agentExternalHooksService';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { parseManifest } from '#/app/plugin/manifest';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HookRuleSchema, hookHash, matchesHook, renderHookInjection, type HookRule, type HookRulesSnapshot, type HookEvent } from '#/features/externalHooks/internal/rules';
import { loadHookRules } from '#/features/externalHooks/internal/loadRules';
import { HooksConfigSchema, hooksFromToml, hooksToToml, legacyHooks } from '#/features/externalHooks/configSection';
import { hookStateKey } from '#/features/externalHooks/agent/hookState';
import { IAgentHookRules } from '#/features/externalHooks/agent/hookRules';
import { sessionService, createTestAgent, permissionModeServices, agentService, type TestAgentContext, type TestAgentOptions } from '../../harness';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { APIStatusError } from '#/kosong/contract/errors';

const path = { ...nodePath, separator: nodePath.sep };
const fs = new HostFileSystem();
const temporary: string[] = [];
const agents: TestAgentContext[] = [];
afterEach(async () => {
  for (const ctx of agents.splice(0)) await ctx.dispose();
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function rule(input: Partial<HookRule> = {}): HookRule {
  return HookRuleSchema.parse({ id: 'focus', event: 'step.before', cadence: { everyCompletedSteps: 1, counterScope: 'agent', partitionBy: 'model' }, action: { type: 'inject', text: 'Check evidence.' }, ...input });
}
function snapshot(rules: readonly HookRule[]): HookRulesSnapshot {
  const effective = rules.map((rule) => ({ rule, id: `user/${rule.id}`, namespace: 'user', path: '/example/hooks.toml', mutable: true, active: true,
    contentHash: hookHash(rule), semanticHash: hookHash({ event: rule.event, match: rule.match, cadence: rule.cadence }), text: rule.action.type === 'inject' ? rule.action.text : undefined }));
  return { revision: hookHash(rules), rules: effective, diagnostics: [] };
}
function agentWithRules(read: () => HookRulesSnapshot, observe: (event: HookEvent, id: string) => void = () => {}, agentId?: string, initialConfig: TestAgentOptions['initialConfig'] = {}): TestAgentContext {
  const identity = agentId === undefined ? [] : [agentService(IAgentScopeContext, makeAgentScopeContext({ agentId, agentScope: agentId, parentAgentId: 'main' }))];
  const ctx = createTestAgent(sessionService(IHookRulesSession, {
    _serviceBrand: undefined, ready: Promise.resolve(), onDidChange: Event.None, onDidObserve: Event.None,
    snapshot: read, reload: async () => {}, observe,
  }), permissionModeServices('yolo'), identity, { initialConfig: { ...initialConfig, retry: { policies: [{ match: '.*', backoff: 0, maxAttempts: 2 }] } } });
  agents.push(ctx);
  ctx.get(IAgentProfileService).update({ activeToolNames: [] });
  return ctx;
}
async function turn(ctx: TestAgentContext, text = 'Continue'): Promise<void> {
  ctx.mockNextResponse({ type: 'text', text: 'Done' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text }] });
  await ctx.untilTurnEnd();
}
function injections(ctx: TestAgentContext) {
  return ctx.get(IAgentContextMemoryService).get().filter((message) => message.origin?.kind === 'injection' && message.origin.variant.startsWith('hook_rule/'));
}

async function source(config: unknown, namespace = 'user', trusted = true) {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'hook-rules-'));
  temporary.push(root);
  const file = nodePath.join(root, 'hooks.toml');
  await writeFile(file, '');
  return { namespace, root, path: file, config, mutable: true, trusted };
}

const v2 = (rules: readonly unknown[], rest: Record<string, unknown> = {}) => ({ schema_version: 2, rules, ...rest });

describe('hooks v2 loading contract', () => {
  it('reads both legacy and v2 legacy without changing timeout or regular-expression semantics', () => {
    const old = [{ event: 'PreToolUse', matcher: 'Read|Write', command: 'check', timeout: 7 }];
    expect(HooksConfigSchema.parse(hooksFromToml(old))).toEqual(old);
    const data = HooksConfigSchema.parse(hooksFromToml(v2([rule()], { legacy: old })));
    expect(legacyHooks(data)).toEqual(old);
    expect(hooksToToml(data, undefined)).toMatchObject({ schema_version: 2, rules: [{ cadence: { every_completed_steps: 1, counter_scope: 'agent' } }], legacy: old });
  });

  it.each([0, -1, 1.5])('rejects invalid cadence %s at load', (n) => {
    expect(() => HookRuleSchema.parse({ ...rule(), cadence: { everyCompletedSteps: n } })).toThrow();
  });
  it.each(['command', 'block', 'gate', 'continue'])('rejects unsupported %s before dispatch', (type) => {
    expect(() => HookRuleSchema.parse({ ...rule(), action: { type } })).toThrow(/slice A/);
  });
  it('rejects empty text, ambiguous text sources and unsafe event/action combinations', () => {
    expect(() => rule({ action: { type: 'inject', text: '  ' } })).toThrow(/empty/);
    expect(() => rule({ action: { type: 'inject', text: 'text', textFile: 'text.md' } })).toThrow(/exactly one/);
    expect(() => rule({ event: 'tool.after', cadence: undefined })).toThrow(/inject is not supported/);
  });
  it('resolves aliases to configuration identities and matches AND across fields / OR within them', async () => {
    const entry = await source(v2([rule({ match: { models: ['short', 'other'], profiles: ['analysis', 'review'], agentRoles: ['root'], executors: ['native'] } })]));
    const loaded = await loadHookRules([entry], fs, path, (alias) => ({ short: 'canonical', other: 'second' })[alias]);
    expect(loaded.diagnostics).toEqual([]);
    const hook = loaded.rules[0]!;
    expect(hook.models).toEqual(['canonical', 'second']);
    expect(matchesHook(hook, { event: 'step.before', modelId: 'canonical', profileId: 'review', executorId: 'native', agentRole: 'root' })).toBe(true);
    expect(matchesHook(hook, { event: 'step.before', modelId: 'canonical', profileId: 'review', executorId: 'native', agentRole: 'subagent' })).toBe(false);
    expect(matchesHook(hook, { event: 'step.before', modelId: 'provider-model', profileId: 'review', executorId: 'native', agentRole: 'root' })).toBe(false);
  });
  it('diagnoses bad aliases, missing text/includes, duplicate IDs and byte budgets before N', async () => {
    const entry = await source(v2([
      rule({ id: 'bad-alias', match: { models: ['typo'] } }),
      rule({ id: 'missing', action: { type: 'inject', textFile: 'absent.md' } }),
      rule({ id: 'duplicate' }), rule({ id: 'duplicate' }),
      rule({ id: 'large', action: { type: 'inject', text: '文'.repeat(8192) } }),
    ], { files: ['missing.toml'] }));
    const loaded = await loadHookRules([entry], fs, path, () => undefined);
    expect(loaded.diagnostics.map((entry) => entry.message).join('\n')).toMatch(/unknown model alias/);
    expect(loaded.diagnostics).toHaveLength(5);
    expect(loaded.rules.every((entry) => !entry.active)).toBe(true);
  });
  it('accepts canonical symlink text outside the declaration while rejecting repeated includes and cross-disabling', async () => {
    const shared = await source(undefined);
    const external = nodePath.join(shared.root, 'external.md');
    await writeFile(external, 'Shared evidence guidance');
    const entry = await source(v2([rule({ action: { type: 'inject', textFile: 'link.md' } })], { files: ['nested.toml', 'nested.toml'], disabled: ['user/global'] }), 'workspace');
    await writeFile(nodePath.join(entry.root, 'nested.toml'), '[hooks]\nschema_version = 2\n');
    const realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, 'realpath').mockImplementation((file) => nodePath.basename(file) === 'link.md' ? Promise.resolve(external) : realpath(file));
    const loaded = await loadHookRules([entry], fs, path, () => undefined);
    expect(loaded.rules[0]?.text).toBe('Shared evidence guidance');
    expect(loaded.diagnostics.map((entry) => entry.message).join('\n')).toMatch(/duplicate or cyclic/);
    expect(loaded.diagnostics.map((entry) => entry.message).join('\n')).toMatch(/cannot disable hook/);
  });
  it.each(['absolute', 'relative'] as const)('loads %s shared text and includes without laundering workspace trust', async (kind) => {
    const shared = await source(undefined);
    const textFile = nodePath.join(shared.root, 'shared.md');
    await writeFile(textFile, 'Shared guidance');
    await writeFile(nodePath.join(shared.root, 'nested.toml'), '[hooks]\nschema_version = 2\n[[hooks.rules]]\nid = "shared"\nevent = "step.before"\n[hooks.rules.action]\ntype = "inject"\ntext = "Included guidance"\n');
    const entry = await source(undefined, 'workspace', false);
    const ref = (file: string) => kind === 'absolute' ? file : nodePath.relative(entry.root, file);
    const loaded = await loadHookRules([{ ...entry, config: v2([rule({ action: { type: 'inject', textFile: ref(textFile) } })], { files: [ref(nodePath.join(shared.root, 'nested.toml'))] }) }], fs, path, () => undefined);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.rules).toHaveLength(2);
    expect(loaded.rules.every((rule) => rule.reason === 'workspace_untrusted' && !rule.active)).toBe(true);
    expect(loaded.rules.find((rule) => rule.id === 'workspace/focus')?.text).toBe('Shared guidance');
  });
  it('exports user disables from included files for the session project-source fold', async () => {
    const user = await source(v2([], { files: ['nested.toml'] }));
    await writeFile(nodePath.join(user.root, 'nested.toml'), '[hooks]\nschema_version = 2\ndisabled = ["workspace/focus"]\n');
    const loaded = await loadHookRules([user], fs, path, () => undefined);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.disabled).toEqual(['workspace/focus']);
  });
  it('keeps three namespaces additive, trust-disabled project rules visible, and ordering stable', async () => {
    const user = await source(v2([rule({ priority: 100 })]));
    const workspace = await source(v2([rule({ priority: 10 })]), 'workspace', false);
    const plugin = await source(v2([rule({ priority: 50 })]), 'plugin/example');
    const loaded = await loadHookRules([user, workspace, plugin], fs, path, () => undefined);
    expect(loaded.rules.map((entry) => entry.id)).toEqual(['workspace/focus', 'plugin/example/focus', 'user/focus']);
    expect(loaded.rules[0]).toMatchObject({ active: false, reason: 'workspace_untrusted' });
    expect(loaded.rules.slice(1).every((entry) => entry.active)).toBe(true);
    expect(renderHookInjection(loaded.rules[1]!)).toContain('plugin/example/focus');
  });
});

describe('hooks v2 session workspace loading', () => {
  it('filters plugin rules by workspace without changing user rules or the home registry', async () => {
    const change = new Emitter<PluginUsageChange>();
    let overrides: Readonly<Record<string, boolean>> = { example: false };
    const global = snapshot([rule({ id: 'user' }), rule({ id: 'plugin' })]);
    const plugin = global.rules[1]!;
    const merged: HookRulesSnapshot = { ...global, rules: [global.rules[0]!, { ...plugin, id: 'plugin/example/plugin', namespace: 'plugin/example' }] };
    const usage: IPluginUsageService = { _serviceBrand: undefined, enabled: () => true,
      read: async (workspaceId) => ({ workspaceId, revision: 0, overrides, applyState: 'applied', errors: [] }),
      allows: async (_workspaceId, id) => overrides[id] !== false, set: async () => { throw new Error('unused'); },
      registerPluginStateReader: () => ({ dispose: () => {} }),
      readSession: async (workspaceId, sessionId) => ({ workspaceId, sessionId, revision: 0, overrides: {}, applyState: 'applied' as const, errors: [] }),
      applySession: async (snapshot) => snapshot,
      onDidChange: change.event, onDidApply: Event.None as IPluginUsageService['onDidApply'] };
    const session = new HookRulesSession(
      { _serviceBrand: undefined, ready: Promise.resolve(), onDidChange: Event.None as IHookRulesRegistry['onDidChange'], snapshot: () => merged, disabled: () => [], reload: async () => {} },
      { onDidChangeModels: Event.None } as unknown as IModelService,
      { current: undefined, onDidChange: Event.None } as unknown as import('#/_base/di/instantiation').LiveRef<import('#/features/externalHooks/session/hookRules').ISessionHookWorkspace>,
      usage, { workspaceId: 'workspace-a' } as unknown as ISessionContext,
    );
    try {
      await session.ready;
      expect(session.snapshot().rules.find((entry) => entry.namespace === 'plugin/example')).toMatchObject({ active: false, reason: 'workspace_plugin_disabled' });
      expect(session.snapshot().rules.find((entry) => entry.namespace === 'user')?.active).toBe(true);
      expect(merged.rules.every((entry) => entry.active)).toBe(true);
      overrides = {};
      const waiters: Promise<unknown>[] = [];
      change.fire({ workspaceId: 'workspace-a', pluginId: 'example', revision: 1, waitUntil: (work) => { waiters.push(work); } });
      await session.ready;
      await Promise.all(waiters);
      expect(session.snapshot().rules.every((entry) => entry.active)).toBe(true);
    } finally { await session.dispose(); change.dispose(); }
  });

  it('watches absent files, hot-loads rules, follows trust revocation and reports syntax errors before execution', async () => {
    const entry = await source(undefined, 'workspace', false);
    const file = nodePath.join(entry.root, '.kiki', 'hooks.toml');
    const watched: string[] = [];
    let trusted = false;
    const disposables = new DisposableStore();
    const ix = createServices(disposables, { additionalServices: (reg) => {
      reg.define(IHookRulesSession, HookRulesSession);
      const noEvent = () => ({ dispose: () => {} });
      reg.definePartialInstance(IHookRulesRegistry, { ready: Promise.resolve(), onDidChange: noEvent, snapshot: () => snapshot([]), disabled: () => [] });
      reg.definePartialInstance(IModelService, { onDidChangeModels: noEvent, resolveId: (id) => id });
      reg.definePartialInstance(IPluginUsageService, { enabled: () => false, onDidChange: noEvent });
      reg.definePartialInstance(ISessionContext, { workspaceId: 'example' });
      reg.defineInstance(ISessionHookWorkspace, {
        _serviceBrand: undefined, root: entry.root,
        trust: { _serviceBrand: undefined, ready: Promise.resolve(), get: async () => trusted, isTrusted: () => trusted, trust: async () => { trusted = true; }, untrust: async () => { trusted = false; }, onDidChange: noEvent },
        runtime: {
          identity: { workspaceId: 'example', runtimeId: 'local', generation: '1' }, capabilities: new Set(['fs', 'watch'] as const),
          status: 'ready', onDidChangeStatus: noEvent, dispose: () => {}, fs, path,
          workspace: { mapRoots: (roots) => roots },
          environment: { osKind: 'test', osArch: 'test', osVersion: 'test', shellName: 'sh', shellPath: '/bin/sh', pathClass: path.separator === '\\' ? 'win32' : 'posix', homeDir: entry.root },
          watch: { _serviceBrand: undefined, watch: (path) => { watched.push(path); return { ready: Promise.resolve(), onDidChange: noEvent, dispose: () => {} }; } },
        },
      });
    } });
    try {
      const session = ix.get(IHookRulesSession);
      await session.ready;
      expect(session.snapshot().diagnostics).toEqual([]);
      expect(watched).toContain(file);
      await mkdir(nodePath.dirname(file));
      await writeFile(file, '[hooks]\nschema_version = 2\n[[hooks.rules]]\nid = "project"\nevent = "step.before"\n[hooks.rules.action]\ntype = "inject"\ntext = "Project guidance"\n');
      await session.reload();
      expect(session.snapshot().rules[0]).toMatchObject({ active: false, reason: 'workspace_untrusted' });
      trusted = true;
      await session.reload();
      expect(session.snapshot().rules[0]).toMatchObject({ active: true });
      trusted = false;
      expect(session.snapshot().rules[0]).toMatchObject({ active: false, reason: 'workspace_untrusted' });
      trusted = true;
      const configured = '[hooks]\nschema_version = 2\n[[hooks.rules]]\nid = "project"\nevent = "step.before"\n[hooks.rules.cadence]\nevery_completed_steps = 5\n[hooks.rules.action]\ntype = "inject"\ntext = "Project guidance"\n';
      await writeFile(file, configured);
      await session.reload();
      const ctx = agentWithRules(() => session.snapshot());
      await turn(ctx); await turn(ctx);
      const before = ctx.get(IAgentStateService).get(hookStateKey).rules['workspace/project']!;
      expect(Object.values(before.buckets)[0]?.completed).toBe(2);
      await writeFile(file, '[hooks invalid syntax');
      await session.reload();
      expect(session.snapshot().diagnostics).toHaveLength(1);
      expect(session.snapshot().sources).toContainEqual({ namespace: 'workspace', path: file, status: 'invalid' });
      expect(session.snapshot().rules[0]).toMatchObject({ active: false, reason: 'source_invalid' });
      await turn(ctx);
      await writeFile(file, configured);
      await session.reload();
      await turn(ctx);
      const restored = ctx.get(IAgentStateService).get(hookStateKey).rules['workspace/project']!;
      expect(restored.revision).toBe(before.revision);
      expect(Object.values(restored.buckets)[0]?.completed).toBe(3);
      expect(watched).toContain(file);
    } finally { await disposables.dispose(); }
  });
});

describe('hooks v2 completed-step engine contract', () => {
  it.each([false, true])('consumes durable child notifications through task rules once before the next actual request (busy=%s)', async (busy) => {
    const observed: HookEvent[] = [];
    const ctx = agentWithRules(() => snapshot([
      rule({ id: 'human', event: 'prompt.submit', cadence: undefined, match: {}, action: { type: 'inject', text: 'HUMAN ONLY' } }),
      rule({ id: 'task', event: 'prompt.submit', cadence: undefined, match: { sources: ['task'], agentRoles: ['root'] }, action: { type: 'inject', text: 'TASK CONSUMPTION CUE' } }),
      rule({ id: 'task-observe', event: 'prompt.submit', cadence: undefined, match: { sources: ['task'] }, action: { type: 'observe' } }),
      rule({ id: 'child-only', event: 'prompt.submit', cadence: undefined, match: { sources: ['task'], agentRoles: ['subagent'] }, action: { type: 'inject', text: 'WRONG ROLE' } }),
    ]), (event) => observed.push(event));
    const model = ctx.kimiConfig.models!['mock-model']!;
    ctx.kimiConfig = { ...ctx.kimiConfig, models: { ...ctx.kimiConfig.models, 'mock-model': { ...model, cognition: { steering: { text: 'COMPLETION STEERING' } } } } };
    await ctx.get(IAgentProfileService).bind({ profile: 'agent', model: 'mock-model' });
    const loop = ctx.get(IAgentLoopService);
    const tasks = ctx.get(IAgentTaskService) as TaskServiceTestManager;
    const entered = createControlledPromise<void>();
    const release = createControlledPromise<void>();
    const hold = loop.hooks.onWillBeginStep.register('hold-current-request', async (step, next) => {
      if (busy && step.firstStepOfTurn) { entered.resolve(); await release; }
      await next();
    });
    const completion = createControlledPromise<{ result: string }>();
    const taskId = tasks.registerTask(new SubagentTask({ agentId: 'example-child', profileName: 'worker', completion }, 'child result', new AbortController()));
    try {
      if (busy) {
        ctx.mockNextResponse({ type: 'text', text: 'Parent finishes first request' });
        await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Parent work' }] });
        await entered;
      }
      expect(observed).toHaveLength(0);
      ctx.mockNextResponse({ type: 'text', text: 'Consume child result' });
      const ended = ctx.untilTurnEnd();
      const enqueue = vi.spyOn(loop, 'enqueue');
      completion.resolve({ result: 'COMMITTED CHILD OUTPUT' });
      await vi.waitFor(() => expect(enqueue.mock.calls.some(([request]) => request.kind === 'task_notification')).toBe(true));
      if (busy) expect(injections(ctx).filter((message) => JSON.stringify(message).includes('TASK CONSUMPTION CUE'))).toHaveLength(0);
      release.resolve();
      await ended;
      await loop.settled();
      expect(ctx.llmCalls).toHaveLength(busy ? 2 : 1);
      const texts = ctx.llmCalls.at(-1)!.history.flatMap((message) => message.content).filter((part) => part.type === 'text').map((part) => part.text);
      const receiptIndex = texts.findIndex((text) => text.includes(taskId));
      const hookIndex = texts.findIndex((text) => text.includes('TASK CONSUMPTION CUE'));
      expect(receiptIndex).toBeGreaterThanOrEqual(0);
      expect(hookIndex).toBeGreaterThan(receiptIndex);
      expect(texts.findLastIndex((text) => text === 'COMPLETION STEERING')).toBeGreaterThan(hookIndex);
      expect(texts.filter((text) => text === 'COMPLETION STEERING')).toHaveLength(busy ? 2 : 1);
      expect(texts.some((text) => text.includes('WRONG ROLE'))).toBe(false);
      expect(texts.filter((text) => text.includes('HUMAN ONLY'))).toHaveLength(busy ? 1 : 0);
      expect(observed).toMatchObject([{ event: 'prompt.submit', source: 'task', agentRole: 'root', eventId: `task/task:${taskId}:completed` }]);
      expect(injections(ctx).filter((message) => JSON.stringify(message).includes('TASK CONSUMPTION CUE'))).toHaveLength(1);
      await tasks.reconcile();
      await ctx.expectResumeMatches();
      expect(observed).toHaveLength(1);
    } finally {
      release.resolve();
      completion.resolve({ result: 'cleanup' });
      await hold.dispose();
    }
  });

  it('consumes an undelivered persisted child receipt once and does not replay its task hooks', async () => {
    const home = await mkdtemp(nodePath.join(tmpdir(), 'task-hook-restore-'));
    temporary.push(home);
    const persistence = createAgentTaskPersistence(home);
    await persistence.commitTerminalTask({ taskId: 'agent-example1', kind: 'agent', agentId: 'example-child', description: 'completed work', status: 'completed', detached: true, startedAt: 1, endedAt: 2 }, 'RESTORED CHILD OUTPUT');
    const observed: HookEvent[] = [];
    const rules = snapshot([
      rule({ id: 'task', event: 'prompt.submit', cadence: undefined, match: { sources: ['task'] }, action: { type: 'inject', text: 'RESTORED TASK CUE' } }),
      rule({ id: 'observe', event: 'prompt.submit', cadence: undefined, match: { sources: ['task'] }, action: { type: 'observe' } }),
    ]);
    const ctx = createTestAgent(homeDirServices(home), appServices((reg) => {
      reg.definePartialInstance(IAgentCollaborationMessageStore, { listPendingAgents: async () => [], nextQueued: async () => undefined });
    }), sessionService(IHookRulesSession, {
      _serviceBrand: undefined, ready: Promise.resolve(), onDidChange: Event.None as IHookRulesSession['onDidChange'], onDidObserve: Event.None as IHookRulesSession['onDidObserve'],
      snapshot: () => rules, reload: async () => {}, observe: (event) => { observed.push(event); },
    }));
    agents.push(ctx);
    const tasks = ctx.get(IAgentTaskService) as TaskServiceTestManager;
    await tasks.loadFromDisk();
    await tasks.reconcile();
    expect(ctx.llmCalls).toHaveLength(0);
    expect(observed).toMatchObject([{ source: 'task', eventId: 'task/task:agent-example1:completed' }]);
    await tasks.reconcile();
    await ctx.expectResumeMatches();
    expect(observed).toHaveLength(1);
    await turn(ctx);
    const text = JSON.stringify(ctx.llmCalls[0]!.history);
    expect(text.indexOf('RESTORED TASK CUE')).toBeGreaterThan(text.indexOf('RESTORED CHILD OUTPUT'));
    expect(injections(ctx)).toHaveLength(1);
    expect(observed).toHaveLength(1);
  });

  it('holds task guidance after user cancel until an authorized input and never injects for unfinished work', async () => {
    const observed: HookEvent[] = [];
    const ctx = agentWithRules(() => snapshot([
      rule({ id: 'task', event: 'prompt.submit', cadence: undefined, match: { sources: ['task'] }, action: { type: 'inject', text: 'HELD TASK CUE' } }),
      rule({ id: 'observe', event: 'prompt.submit', cadence: undefined, match: { sources: ['task'] }, action: { type: 'observe' } }),
    ]), (event) => observed.push(event));
    const loop = ctx.get(IAgentLoopService);
    const tasks = ctx.get(IAgentTaskService);
    const completion = createControlledPromise<{ result: string }>();
    let taskId = '';
    const cancel = loop.hooks.onDidFinishStep.register('test.cancel', async (_step, next) => {
      const ownerTurnId = loop.status().activeTurnId;
      expect(ownerTurnId).toBe(0);
      taskId = tasks.registerTask(new SubagentTask({ agentId: 'example-child', profileName: 'worker', completion }, 'unfinished work', new AbortController()));
      expect(tasks.getTask(taskId)?.ownerTurnId).toBe(ownerTurnId);
      loop.cancel();
      await next();
    });
    try { await turn(ctx, 'Start work'); await loop.settled(); }
    finally { await cancel.dispose(); }
    expect(loop.status().lastTurnResult).toBe('cancelled');
    expect(observed).toHaveLength(0);
    expect(injections(ctx)).toHaveLength(0);
    const enqueue = vi.spyOn(loop, 'enqueue');
    completion.resolve({ result: 'HELD COMPLETION' });
    await vi.waitFor(() => expect(enqueue.mock.calls.some(([request]) => request.kind === 'task_notification')).toBe(true));
    expect(ctx.llmCalls).toHaveLength(1);
    expect(observed).toHaveLength(0);
    expect(injections(ctx)).toHaveLength(0);
    await turn(ctx, 'Inspect the completed result');
    await loop.settled();
    expect(ctx.llmCalls).toHaveLength(2);
    expect(JSON.stringify(ctx.llmCalls[1]!.history)).toContain('HELD COMPLETION');
    expect(JSON.stringify(ctx.llmCalls[1]!.history)).toContain('HELD TASK CUE');
    expect(observed).toMatchObject([{ source: 'task', eventId: `task/task:${taskId}:completed` }]);
    expect(injections(ctx)).toHaveLength(1);
    await ctx.expectResumeMatches();
    expect(observed).toHaveLength(1);
  });

  it('runs Send now guidance once at safe materialization while retaining user/mailbox source identity', async () => {
    const observed: HookEvent[] = [];
    const ctx = agentWithRules(() => snapshot([
      rule({ id: 'human', event: 'prompt.submit', cadence: undefined, match: {}, action: { type: 'inject', text: 'USER GUIDANCE' } }),
      rule({ id: 'steer', event: 'prompt.submit', cadence: undefined, match: { sources: ['steering'] }, action: { type: 'inject', text: 'STEER GUIDANCE' } }),
      rule({ id: 'mailbox', event: 'prompt.submit', cadence: undefined, match: { sources: ['mailbox'] }, action: { type: 'observe' } }),
    ]), (event) => observed.push(event));
    const loop = ctx.get(IAgentLoopService);
    const prompts = ctx.get(IAgentPromptService);
    const steerings: Array<ReturnType<typeof prompts.steer>> = [];
    const subscription = loop.hooks.onDidFinishStep.register('test.sendnow-hooks', async ({ step }, next) => {
      if (step === 1) {
        const human = await prompts.enqueue({ message: { role: 'user', toolCalls: [], content: [{ type: 'text', text: 'Human correction' }], origin: { kind: 'user' } } });
        const peer = await prompts.enqueue({ message: { role: 'user', toolCalls: [], content: [{ type: 'text', text: 'Peer correction' }], origin: { kind: 'agent_message', messageId: 'example-message', senderAgentId: 'example-child', senderTaskName: 'example' } } });
        expect(injections(ctx)).toHaveLength(1);
        steerings.push(prompts.steer([human.id, peer.id]));
      }
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'Initial answer' });
    ctx.mockNextResponse({ type: 'text', text: 'Corrected answer' });
    try { await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Initial user input' }] }); await loop.settled(); await Promise.all(steerings); }
    finally { await subscription.dispose(); }
    expect(ctx.llmCalls).toHaveLength(2);
    const text = ctx.llmCalls[1]!.history.flatMap((message) => message.content).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    expect(text.match(/USER GUIDANCE/g)).toHaveLength(2);
    expect(text.match(/STEER GUIDANCE/g)).toHaveLength(2);
    expect(observed.some((event) => event.source === 'mailbox' && event.delivery === 'steering')).toBe(true);
    const history = ctx.get(IAgentContextMemoryService).get();
    const corrections = history.filter((message) => (message.origin?.kind === 'user' || message.origin?.kind === 'agent_message') && JSON.stringify(message.content).includes('correction'));
    expect(corrections.map((message) => message.origin?.kind)).toEqual(['user', 'agent_message']);
    const steeringOwners = injections(ctx).flatMap((message) => {
      const origin = message.origin;
      return origin?.kind === 'injection' && origin.variant === 'hook_rule/user/steer' ? [origin.ownerPromptId] : [];
    });
    expect(steeringOwners).toEqual(corrections.map((message) => message.id));
  });
  it.each([1, 5])('injects only after %s committed steps, on the next request, including across naturally-ended turns', async (n) => {
    const config = snapshot([rule({ cadence: { everyCompletedSteps: n, counterScope: 'agent', partitionBy: 'model' } })]);
    const ctx = agentWithRules(() => config);
    for (let i = 0; i < n; i++) { await turn(ctx); expect(injections(ctx)).toHaveLength(0); }
    await turn(ctx);
    expect(injections(ctx)).toHaveLength(1);
    const state = ctx.get(IAgentStateService).get(hookStateKey);
    expect(Object.values(state.completed)).toEqual([n + 1]);
    expect(injections(ctx)[0]?.origin).toMatchObject({ kind: 'injection', variant: 'hook_rule/user/focus', disclosure: { milestone: n } });
    await ctx.expectResumeMatches();
  });

  it('uses committed completion rather than raw engine step, and does not consume due milestones on failed append', async () => {
    const ctx = agentWithRules(() => snapshot([rule()]));
    await turn(ctx);
    const loop = ctx.get(IAgentLoopService);
    const memory = ctx.get(IAgentContextMemoryService);
    const append = vi.spyOn(memory, 'appendObservable').mockImplementationOnce(() => { throw new Error('append failed'); });
    const signal = new AbortController().signal;
    await loop.hooks.onWillBeginStep.run({ turnId: 10, step: 99, firstStepOfTurn: true, stepId: 'raw-a', logicalStepId: 'logical-a', attempt: 1, signal });
    expect(injections(ctx)).toHaveLength(0);
    append.mockRestore();
    await loop.hooks.onWillBeginStep.run({ turnId: 10, step: 100, firstStepOfTurn: false, stepId: 'raw-b', logicalStepId: 'logical-a', attempt: 2, signal });
    expect(injections(ctx)).toHaveLength(1);
    await loop.hooks.onWillBeginStep.run({ turnId: 10, step: 101, firstStepOfTurn: false, stepId: 'raw-c', logicalStepId: 'logical-a', attempt: 3, signal });
    expect(injections(ctx)).toHaveLength(1);
    const dispatcher = ctx.get(IEventDispatcher);
    await dispatcher.dispatch(new ContextAppendLoopEvent({ event: { type: 'step.end', uuid: 'raw-c', finishReason: 'error' } }));
    expect(Object.values(ctx.get(IAgentStateService).get(hookStateKey).completed)).toEqual([1]);
    await dispatcher.dispatch(new ContextAppendLoopEvent({ event: { type: 'step.end', uuid: 'raw-c', finishReason: 'tool_calls' } }));
    await dispatcher.dispatch(new ContextAppendLoopEvent({ event: { type: 'step.end', uuid: 'raw-c', finishReason: 'tool_calls' } }));
    expect(Object.values(ctx.get(IAgentStateService).get(hookStateKey).completed)).toEqual([2]);
  });

  it('resets turn cadence, preserves agent cadence and never replays after compaction, undo or restore', async () => {
    const ctx = agentWithRules(() => snapshot([rule(), rule({ id: 'turn', cadence: { everyCompletedSteps: 1, counterScope: 'turn', partitionBy: 'model' } })]));
    await turn(ctx);
    await turn(ctx);
    expect(injections(ctx).map((message) => message.origin?.kind === 'injection' ? message.origin.variant : '')).toEqual(['hook_rule/user/focus']);
    const before = ctx.get(IAgentStateService).get(hookStateKey);
    await ctx.get(IEventDispatcher).dispatch(new ContextApplyCompaction({ summary: 'Summary', compactedCount: ctx.contextData().history.length }));
    await ctx.get(IEventDispatcher).dispatch(new ContextUndo({ count: 1 }));
    expect(ctx.get(IAgentStateService).get(hookStateKey)).toEqual(before);
    await ctx.expectResumeMatches();
  });

  it('changes text at the next milestone, but resets counters for changed cadence and exposes unsupported executors', async () => {
    let config = snapshot([rule()]);
    const ctx = agentWithRules(() => config);
    await turn(ctx);
    config = snapshot([rule({ action: { type: 'inject', text: 'Updated text' } })]);
    await turn(ctx);
    expect(JSON.stringify(injections(ctx))).toContain('Updated text');
    config = snapshot([rule({ cadence: { everyCompletedSteps: 5, counterScope: 'agent', partitionBy: 'model' } })]);
    const beforeInspect = ctx.get(IAgentStateService).get(hookStateKey);
    expect(await ctx.get(IAgentHookRules).inspect()).toMatchObject({ rules: [{ resetPending: true, completedSteps: 0, nextDue: 5 }] });
    expect(ctx.get(IAgentStateService).get(hookStateKey)).toEqual(beforeInspect);
    await turn(ctx);
    expect(injections(ctx)).toHaveLength(1);
    expect(Object.values(ctx.get(IAgentStateService).get(hookStateKey).rules['user/focus']!.buckets)[0]?.completed).toBe(1);
    ctx.get(IAgentProfileService).applyBindingSnapshot({ ...ctx.get(IAgentProfileService).data(), executorId: 'external', thinkingLevel: 'off', systemPrompt: 'Example' });
    expect(await ctx.get(IAgentHookRules).inspect()).toMatchObject({ rules: [{ active: false, reason: 'unsupported_executor' }] });
  });

  it('does not deliver due reminders during idle reconciliation or replay them after same-step compaction', async () => {
    const ctx = agentWithRules(() => snapshot([rule()]));
    await turn(ctx);
    await ctx.get(IAgentContextInjectorService).reconcileAllAtSafeBoundary();
    expect(injections(ctx)).toHaveLength(0);
    const loop = ctx.get(IAgentLoopService);
    const compact = loop.hooks.onWillBeginStep.register('test-compact', async (_ctx, next) => {
      const memory = ctx.get(IAgentContextMemoryService);
      memory.applyCompaction({ summary: 'Summary', compactedCount: memory.get().length, tokensBefore: ctx.contextData().tokenCount });
      await next();
    });
    try {
      await loop.hooks.onWillBeginStep.run({ turnId: 2, step: 1, firstStepOfTurn: true, stepId: 'raw', logicalStepId: 'logical', signal: new AbortController().signal });
      expect(injections(ctx)).toHaveLength(0);
      const bucket = Object.values(ctx.get(IAgentStateService).get(hookStateKey).rules['user/focus']!.buckets)[0]!;
      expect(bucket.delivered).toBe(1);
      await ctx.get(IAgentContextInjectorService).reconcileAllAtSafeBoundary();
      expect(injections(ctx)).toHaveLength(0);
      await ctx.expectResumeMatches();
    } finally { await compact.dispose(); }
  });

  it('does not credit an in-flight old step to a replacement semantic revision', async () => {
    let config = snapshot([rule({ cadence: { everyCompletedSteps: 5, counterScope: 'agent', partitionBy: 'model' } })]);
    const ctx = agentWithRules(() => config);
    const loop = ctx.get(IAgentLoopService);
    const signal = new AbortController().signal;
    await loop.hooks.onWillBeginStep.run({ turnId: 1, step: 1, firstStepOfTurn: true, stepId: 'old-step', logicalStepId: 'old-step', signal });
    config = snapshot([rule()]);
    await ctx.get(IAgentPromptService).hooks.onBeforeSubmitPrompt.run({ promptMessage: { id: 'next-input', role: 'user', content: [{ type: 'text', text: 'Next' }], toolCalls: [], origin: { kind: 'user' } }, isSteer: true, block: false });
    await ctx.get(IEventDispatcher).dispatch(new ContextAppendLoopEvent({ event: { type: 'step.end', uuid: 'old-step', finishReason: 'completed' } }));
    expect(ctx.get(IAgentStateService).get(hookStateKey).rules['user/focus']!.buckets).toEqual({});
    await loop.hooks.onWillBeginStep.run({ turnId: 1, step: 2, firstStepOfTurn: false, stepId: 'new-step', logicalStepId: 'new-step', signal });
    expect(injections(ctx)).toHaveLength(0);
  });

  it('retains A buckets through A-B-A switches even when provider model names are identical', async () => {
    const model = { provider: 'test-provider', model: 'same-provider-model', maxContextSize: 1_000_000 };
    const ctx = agentWithRules(() => snapshot([rule()]), undefined, undefined, { models: { alpha: model, beta: model } });
    expect(ctx.get(IModelService).resolveId('alpha')).toBe('alpha');
    expect(ctx.get(IModelService).resolveId('beta')).toBe('beta');
    const loop = ctx.get(IAgentLoopService);
    const signal = new AbortController().signal;
    const prepare = async (modelAlias: string, id: string) => {
      ctx.get(IAgentProfileService).update({ modelAlias });
      await loop.hooks.onWillBeginStep.run({ turnId: 1, step: 90, firstStepOfTurn: false, stepId: id, logicalStepId: id, signal });
    };
    await prepare('alpha', 'a1');
    await ctx.get(IEventDispatcher).dispatch(new ContextAppendLoopEvent({ event: { type: 'step.end', uuid: 'a1', finishReason: 'completed' } }));
    await prepare('beta', 'b1');
    expect(injections(ctx)).toHaveLength(0);
    await ctx.get(IEventDispatcher).dispatch(new ContextAppendLoopEvent({ event: { type: 'step.end', uuid: 'b1', finishReason: 'completed' } }));
    await prepare('alpha', 'a2');
    expect(injections(ctx)).toHaveLength(1);
    expect(ctx.get(IAgentStateService).get(hookStateKey).completed).toEqual({ alpha: 1, beta: 1 });
  });

  it('isolates parallel subagent clocks and includes agent identity in persisted keys', async () => {
    const config = snapshot([rule({ match: { agentRoles: ['subagent'] } })]);
    const a = agentWithRules(() => config, undefined, 'worker-a');
    const b = agentWithRules(() => config, undefined, 'worker-b');
    await Promise.all([turn(a), turn(b)]);
    await turn(a);
    expect(injections(a)).toHaveLength(1);
    expect(injections(b)).toHaveLength(0);
    await turn(b);
    const key = (ctx: TestAgentContext) => (injections(ctx)[0]?.origin as { disclosure: { key: string } }).disclosure.key;
    expect(key(a)).not.toBe(key(b));
    expect(key(a)).toContain('worker-a');
    expect(key(b)).toContain('worker-b');
  });

  it('counts a multi-tool step once and bridges tool before/after without disturbing results', async () => {
    const events: string[] = [];
    const config = snapshot([rule(), ...(['tool.before', 'tool.after'] as const).map((event) => rule({ id: event, event, cadence: undefined, action: { type: 'observe' } }))]);
    const ctx = agentWithRules(() => config, (event) => { events.push(`${event.event}:${event.status ?? ''}`); });
    ctx.get(IAgentProfileService).update({ activeToolNames: ['ExampleTool'] });
    ctx.get(IAgentToolRegistryService).register({
      name: 'ExampleTool', description: 'Example', parameters: { type: 'object', properties: { value: { type: 'integer' } } },
      resolveExecution: () => ({ approvalRule: 'ExampleTool', execute: async () => ({ output: 'original-result' }) }),
    });
    ctx.mockNextResponse({ type: 'function', id: 'tool-a', name: 'ExampleTool', arguments: '{"value":1}' }, { type: 'function', id: 'tool-b', name: 'ExampleTool', arguments: '{"value":2}' });
    ctx.mockNextResponse({ type: 'text', text: 'Finished' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use tools' }] });
    await ctx.untilTurnEnd();
    expect(injections(ctx)).toHaveLength(1);
    expect(Object.values(ctx.get(IAgentStateService).get(hookStateKey).completed)).toEqual([2]);
    expect(events.filter((event) => event === 'tool.before:')).toHaveLength(2);
    expect(events.filter((event) => event === 'tool.after:success')).toHaveLength(2);
    expect(JSON.stringify(ctx.contextData())).toContain('original-result');
  });

  it('provider retry does not add a completed step or duplicate an already appended milestone', async () => {
    const ctx = agentWithRules(() => snapshot([rule()]));
    await turn(ctx);
    ctx.mockNextProviderResponse({ error: new APIStatusError(520, 'provider failure') });
    ctx.mockNextResponse({ type: 'text', text: 'Recovered' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Retry' }] });
    await ctx.untilTurnEnd();
    expect(injections(ctx)).toHaveLength(1);
    expect(Object.values(ctx.get(IAgentStateService).get(hookStateKey).completed)).toEqual([2]);
    await ctx.expectResumeMatches();
  });

  it('exposes effective rules through the contributed inspect command without adding model context', async () => {
    const ctx = agentWithRules(() => snapshot([rule()]));
    const outputs: string[] = [];
    const subscription = ctx.get(IEventBus).subscribe(HookResult, (event) => { if (event.hookEvent === 'hooks.inspect') outputs.push(event.content); });
    const before = ctx.get(IAgentContextMemoryService).get();
    try {
      await ctx.get(IAgentCommandService).run('hooks-inspect');
      expect(outputs).toHaveLength(1);
      expect(JSON.parse(outputs[0]!)).toMatchObject({ rules: [{ id: 'user/focus', completedSteps: 0, nextDue: 1 }] });
      expect(ctx.get(IAgentContextMemoryService).get()).toEqual(before);
    } finally { await subscription.dispose(); }
  });

  it('keeps prompt input intact and skips a failed prompt injection without consuming its receipt', async () => {
    const ctx = agentWithRules(() => snapshot([rule({ event: 'prompt.submit', cadence: undefined })]));
    const slot = ctx.get(IAgentPromptService).hooks.onBeforeSubmitPrompt;
    const run = slot.run.bind(slot);
    const append = vi.spyOn(slot, 'run').mockImplementationOnce((input) => run({ ...input, appendMessage: () => { throw new Error('append failed'); } }));
    await turn(ctx, 'Original first input');
    expect(injections(ctx)).toHaveLength(0);
    expect(ctx.get(IAgentStateService).get(hookStateKey).rules['user/focus']!.buckets).toEqual({});
    append.mockRestore();
    await turn(ctx, 'Original second input');
    const history = ctx.get(IAgentContextMemoryService).get();
    const host = history.find((message) => message.role === 'user' && JSON.stringify(message.content).includes('Original second input'));
    expect(host).toBeDefined();
    expect(injections(ctx)).toHaveLength(1);
    expect(injections(ctx)[0]?.origin).toMatchObject({ kind: 'injection', ownerPromptId: host!.id });
    expect(JSON.stringify(history)).toContain('Original first input');
    await ctx.expectResumeMatches();
  });

  it('counts committed completions for step.after cadence with a completed-outcome matcher', async () => {
    const events: string[] = [];
    const ctx = agentWithRules(() => snapshot([rule({ event: 'step.after', match: { outcomes: ['completed'] }, action: { type: 'observe' } })]), (event) => { events.push(event.event); });
    await turn(ctx);
    expect(events).toEqual(['step.after']);
    expect(Object.values(ctx.get(IAgentStateService).get(hookStateKey).rules['user/focus']!.buckets)[0]).toMatchObject({ completed: 1, delivered: 1 });
    await ctx.expectResumeMatches();
  });

  it('observes prompt, step, stopping and turn events once without injecting or starting extra turns', async () => {
    const events: string[] = [];
    const rules = ['prompt.submit', 'step.before', 'step.after', 'turn.stopping', 'turn.after'].map((event) => rule({ id: event, event: event as HookRule['event'], cadence: undefined, action: { type: 'observe' } }));
    const ctx = agentWithRules(() => snapshot(rules), (event) => { events.push(event.event); });
    await turn(ctx);
    await Promise.resolve();
    expect(events).toEqual(['prompt.submit', 'step.before', 'step.after', 'turn.stopping', 'turn.after']);
    expect(injections(ctx)).toHaveLength(0);
    await ctx.expectResumeMatches();
    expect(events).toHaveLength(5);
  });

  it('parses plugin hook_rules alongside legacy StopFailure hooks and triggers early summarize once for read-heavy 0-write subagents', async () => {
    const pluginDir = await mkdtemp(nodePath.join(tmpdir(), 'argon-plugin-'));
    temporary.push(pluginDir);
    await writeFile(nodePath.join(pluginDir, 'kimi.plugin.json'), JSON.stringify({
      name: 'argon-error-recovery',
      version: '0.3.0',
      hooks: [{ event: 'StopFailure', command: 'node ./scripts/recover.mjs', timeout: 5 }],
      hook_rules: {
        schema_version: 2,
        rules: [{
          id: 'early-read-summarize',
          event: 'step.before',
          match: { models: ['axon-message/gemini-4-argon'], executors: ['native'], agent_roles: ['subagent'] },
          action: {
            type: 'compact',
            strategy: 'summarize',
            counter_scope: 'turn',
            min_completed_steps: 16,
            min_read_calls: 40,
            min_read_chars: 400_000,
            max_write_calls: 0,
          },
        }],
      },
    }));
    const parsedManifest = await parseManifest(pluginDir);
    expect(parsedManifest.diagnostics).toEqual([]);
    expect(parsedManifest.manifest?.hooks).toEqual([{ event: 'StopFailure', command: 'node ./scripts/recover.mjs', timeout: 5 }]);
    expect(parsedManifest.manifest?.hookRules?.rules).toHaveLength(1);

    const loaded = await loadHookRules([{
      namespace: 'plugin/argon-error-recovery',
      path: nodePath.join(pluginDir, 'kimi.plugin.json'),
      root: pluginDir,
      config: parsedManifest.manifest!.hookRules,
      mutable: false,
      trusted: true,
    }], fs, path, () => undefined);
    expect(loaded.diagnostics).toEqual([]);
    const pluginRule = loaded.rules[0]!;
    expect(pluginRule).toMatchObject({
      id: 'plugin/argon-error-recovery/early-read-summarize',
      active: true,
      models: ['axon-message/gemini-4-argon'],
    });

    function seedReadHeavyWindow(
      ctx: TestAgentContext,
      options: { steps: number; reads: number; charsPerRead: number; includeEdit?: boolean },
    ): void {
      const memory = ctx.get(IAgentContextMemoryService);
      memory.append({
        role: 'user',
        content: [{ type: 'text', text: 'Audit the repository architecture and report concrete findings.\nRecipe directive: keep verified file references.' }],
        toolCalls: [],
        origin: { kind: 'user' },
        source: { turnId: 0, step: 0, stepId: 't0.0' },
      });
      let readIndex = 0;
      const chunk = 'x'.repeat(options.charsPerRead);
      for (let step = 1; step <= options.steps; step++) {
        const callsInStep = step === options.steps
          ? Math.max(1, options.reads - readIndex)
          : Math.min(3, Math.max(1, Math.ceil((options.reads - readIndex) / (options.steps - step + 1))));
        const toolCalls = Array.from({ length: callsInStep }, (_, i) => {
          readIndex++;
          return {
            type: 'function' as const,
            id: `read-${step}-${i}`,
            name: 'Read',
            arguments: JSON.stringify({ path: `/workspace/src/mod-${readIndex}.ts` }),
          };
        });
        if (options.includeEdit && step === options.steps) {
          toolCalls.push({
            type: 'function' as const,
            id: `edit-${step}`,
            name: 'Edit',
            arguments: JSON.stringify({ path: '/workspace/src/mod-1.ts' }),
          });
        }
        memory.append({
          role: 'assistant',
          content: [{ type: 'text', text: `Inspecting batch ${step}` }],
          toolCalls,
          source: { turnId: 0, step, stepId: `t0.${step}` },
        });
        for (const call of toolCalls) {
          const isRead = call.name === 'Read';
          const body = isRead ? `1\t${chunk}\n<system>1 line read starting at line 1. Total lines in file: 10.</system>` : 'Edited /workspace/src/mod-1.ts';
          memory.append({
            role: 'tool',
            toolCallId: call.id,
            content: [{ type: 'text', text: body }],
            toolCalls: [],
            source: { turnId: 0, step, stepId: `t0.${step}` },
          });
        }
      }
      vi.spyOn(ctx.get(ISessionTodoService), 'getNotes').mockReturnValue({
        notes: {
          goal: 'Audit the repository architecture and report concrete findings.',
          directives: 'Recipe directive: keep verified file references.\nSteer: prioritize module boundaries.',
          decided: 'Surveyed 67 steps of module definitions.',
          open: 'Synthesize final report.',
        },
        meta: {
          rev: 1,
          hash: 'h1',
          writtenTurn: 0,
          writtenStep: `t0.${options.steps}`,
          coveredMessageId: '',
          windowEpoch: 0,
        },
      });
    }

    let pluginEnabled = true;
    const observedHooks: string[] = [];
    const currentSnapshot = (): HookRulesSnapshot => ({
      ...loaded,
      revision: `${loaded.revision}:${String(pluginEnabled)}`,
      rules: loaded.rules.map((entry) => ({ ...entry, active: pluginEnabled })),
    });

    const subagent = agentWithRules(currentSnapshot, (_event, id) => observedHooks.push(id), 'sub-1320');
    const mockModel = subagent.kimiConfig.models!['mock-model']!;
    const baseModel = {
      ...mockModel,
      capabilities: mockModel.capabilities ? [...mockModel.capabilities] : undefined,
      supportEfforts: mockModel.supportEfforts ? [...mockModel.supportEfforts] : undefined,
    };
    const argonModels = {
      'mock-model': baseModel,
      'axon-message/gemini-4-argon': { ...baseModel, model: 'gemini-4-argon' },
    };
    subagent.get(IModelService).loadAll(argonModels, 'axon-message/gemini-4-argon');
    await subagent.get(IAgentProfileService).bind({ profile: 'agent', model: 'axon-message/gemini-4-argon' });

    const committedStrategies: Array<'summarize' | 'relay' | undefined> = [];
    subagent.get(IAgentFullCompactionService).hooks.onDidCommit.register('test-commit', async (task, next) => {
      committedStrategies.push(task.committedStrategy);
      await next();
    });
    seedReadHeavyWindow(subagent, { steps: 67, reads: 196, charsPerRead: 13_500 });
    subagent.mockNextResponse({ type: 'text', text: 'Synthesized summary of the 196 read files.' });
    subagent.mockNextResponse({ type: 'text', text: 'Final subagent report after early summary.' });
    await subagent.rpc.prompt({ input: [{ type: 'text', text: 'Continue synthesis' }] });
    await subagent.untilTurnEnd();

    expect(observedHooks).toEqual(['plugin/argon-error-recovery/early-read-summarize']);
    expect(committedStrategies).toEqual(['summarize']);
    const compactedMessage = subagent.get(IAgentContextMemoryService).get().find((m) => m.origin?.kind === 'compaction_summary');
    expect(compactedMessage?.origin).toMatchObject({ kind: 'compaction_summary' });
    const summaryText = JSON.stringify(compactedMessage?.content ?? []);
    expect(summaryText).toContain('Synthesized summary of the 196 read files.');
    expect(summaryText).toContain('Recipe directive: keep verified file references.');
    expect(summaryText).toContain('Steer: prioritize module boundaries.');
    expect(summaryText).toContain('/workspace/src/mod-194.ts');
    expect(subagent.get(ISessionTodoService).getNotes('sub-1320').notes?.decided).toBe('Surveyed 67 steps of module definitions.');

    await turn(subagent, 'Follow-up step');
    expect(observedHooks).toHaveLength(1);

    const thresholdHooks: string[] = [];
    const thresholdAgent = agentWithRules(currentSnapshot, (_event, id) => thresholdHooks.push(id), 'sub-threshold');
    thresholdAgent.get(IModelService).loadAll(argonModels, 'axon-message/gemini-4-argon');
    await thresholdAgent.get(IAgentProfileService).bind({ profile: 'agent', model: 'axon-message/gemini-4-argon' });
    seedReadHeavyWindow(thresholdAgent, { steps: 16, reads: 40, charsPerRead: 10_000 });
    thresholdAgent.mockNextResponse({ type: 'text', text: 'Synthesized summary at 16-step 40-read 400k threshold.' });
    thresholdAgent.mockNextResponse({ type: 'text', text: 'Continued after threshold summary.' });
    await thresholdAgent.rpc.prompt({ input: [{ type: 'text', text: 'Continue at threshold' }] });
    await thresholdAgent.untilTurnEnd();
    expect(thresholdHooks).toEqual(['plugin/argon-error-recovery/early-read-summarize']);
    expect(thresholdAgent.get(IAgentContextMemoryService).get().some((m) => m.origin?.kind === 'compaction_summary')).toBe(true);

    pluginEnabled = false;
    const disabledHooks: string[] = [];
    const disabledSubagent = agentWithRules(currentSnapshot, (_event, id) => disabledHooks.push(id), 'sub-disabled');
    disabledSubagent.get(IModelService).loadAll(argonModels, 'axon-message/gemini-4-argon');
    await disabledSubagent.get(IAgentProfileService).bind({ profile: 'agent', model: 'axon-message/gemini-4-argon' });
    seedReadHeavyWindow(disabledSubagent, { steps: 67, reads: 196, charsPerRead: 13_500 });
    await turn(disabledSubagent, 'Continue with plugin disabled');
    expect(disabledHooks).toEqual([]);
    expect(disabledSubagent.get(IAgentContextMemoryService).get().some((m) => m.origin?.kind === 'compaction_summary')).toBe(false);

    pluginEnabled = true;
    for (const [label, setup] of [
      ['short task', (ctx: TestAgentContext) => seedReadHeavyWindow(ctx, { steps: 6, reads: 10, charsPerRead: 2_000 })],
      ['editing task', (ctx: TestAgentContext) => seedReadHeavyWindow(ctx, { steps: 20, reads: 45, charsPerRead: 10_000, includeEdit: true })],
      ['explicit fresh model strategy', (ctx: TestAgentContext) => {
        ctx.get(IModelService).loadAll({
          ...argonModels,
          'axon-message/gemini-4-argon': { ...baseModel, model: 'gemini-4-argon', contextStrategy: 'fresh' },
        }, 'axon-message/gemini-4-argon');
        seedReadHeavyWindow(ctx, { steps: 20, reads: 45, charsPerRead: 10_000 });
      }],
      ['other model', async (ctx: TestAgentContext) => {
        await ctx.get(IAgentProfileService).bind({ profile: 'agent', model: 'mock-model' });
        seedReadHeavyWindow(ctx, { steps: 20, reads: 45, charsPerRead: 10_000 });
      }],
    ] as const) {
      const negHooks: string[] = [];
      const negAgent = agentWithRules(currentSnapshot, (_event, id) => negHooks.push(id), `sub-${label}`);
      negAgent.get(IModelService).loadAll(argonModels, 'axon-message/gemini-4-argon');
      await negAgent.get(IAgentProfileService).bind({ profile: 'agent', model: 'axon-message/gemini-4-argon' });
      await setup(negAgent);
      expect(negAgent.get(IAgentFullCompactionService).isCompacting(), label).toBe(false);
      await turn(negAgent, `Check ${label}`);
      expect(negHooks, label).toEqual([]);
      expect(negAgent.get(IAgentContextMemoryService).get().some((m) => m.origin?.kind === 'compaction_summary'), label).toBe(false);
    }

    const budgetHooks: string[] = [];
    const budgetAgent = agentWithRules(currentSnapshot, (_event, id) => budgetHooks.push(id), 'sub-budget');
    budgetAgent.get(IModelService).loadAll(argonModels, 'axon-message/gemini-4-argon');
    await budgetAgent.get(IAgentProfileService).bind({ profile: 'agent', model: 'axon-message/gemini-4-argon' });
    seedReadHeavyWindow(budgetAgent, { steps: 16, reads: 40, charsPerRead: 10_000 });
    const budgetCompaction = budgetAgent.get(IAgentFullCompactionService);
    const beginSpy = vi.spyOn(budgetCompaction, 'begin').mockReturnValue(false);
    await turn(budgetAgent, 'Step while begin returns false');
    expect(budgetHooks).toEqual([]);
    expect(budgetAgent.get(IAgentContextMemoryService).get().some((m) => m.origin?.kind === 'compaction_summary')).toBe(false);
    beginSpy.mockRestore();

    const requester = budgetAgent.get(IAgentLLMRequesterService);
    const originalStart = requester.start.bind(requester);
    let failCompactionRequestOnce = true;
    const startSpy = vi.spyOn(requester, 'start').mockImplementation((request, onPart, signal) => {
      if (failCompactionRequestOnce && request?.source?.type === 'operation' && request.source.requestKind === 'full_compaction') {
        failCompactionRequestOnce = false;
        const rejected = Promise.reject(new Error('summary provider failure'));
        void rejected.catch(() => undefined);
        return { trace: { traceId: 'trace-fail' } as ReturnType<typeof requester.start>['trace'], result: rejected };
      }
      return originalStart(request, onPart, signal);
    });
    await turn(budgetAgent, 'Step hitting COMPACTION_FAILED');
    startSpy.mockRestore();
    expect(budgetCompaction.isCompacting()).toBe(false);
    expect(budgetHooks).toEqual([]);
    expect(budgetAgent.get(IAgentContextMemoryService).get().some((m) => m.origin?.kind === 'compaction_summary')).toBe(false);

    const dispatcher = budgetAgent.get(IEventDispatcher);
    const originalFlush = dispatcher.flush.bind(dispatcher);
    let blockCommitFlush = true;
    const flushSpy = vi.spyOn(dispatcher, 'flush').mockImplementation(async () => {
      if (blockCommitFlush && (budgetCompaction.compacting as { readonly phase?: string } | null)?.phase === 'committing') {
        throw new Error('disk full');
      }
      return originalFlush();
    });
    budgetAgent.mockNextResponse({ type: 'text', text: 'Summary prepared before persist failure.' });
    await turn(budgetAgent, 'Step hitting persistBlocked');
    blockCommitFlush = false;
    flushSpy.mockRestore();
    expect(budgetCompaction.isCompacting()).toBe(true);
    expect(budgetHooks).toEqual([]);

    expect(budgetCompaction.begin({ source: 'auto', strategy: 'summarize' })).toBe(true);
    await budgetCompaction.compacting?.promise;
    expect(budgetCompaction.isCompacting()).toBe(false);
    expect(budgetHooks).toEqual(['plugin/argon-error-recovery/early-read-summarize']);
  });
});
