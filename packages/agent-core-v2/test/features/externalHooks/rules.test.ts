import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { HookRulesSession } from '#/features/externalHooks/session/hookRulesService';
import { ISessionHookWorkspace, IHookRulesSession } from '#/features/externalHooks/session/hookRules';
import { IHookRulesRegistry } from '#/features/externalHooks/app/hookRules';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Event } from '#/_base/event';
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
    } finally { disposables.dispose(); }
  });
});

describe('hooks v2 completed-step engine contract', () => {
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
    } finally { compact.dispose(); }
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
    } finally { subscription.dispose(); }
  });

  it('keeps prompt input intact and skips a failed prompt injection without consuming its receipt', async () => {
    const ctx = agentWithRules(() => snapshot([rule({ event: 'prompt.submit', cadence: undefined })]));
    const append = vi.spyOn(ctx.get(IAgentSystemReminderService), 'appendSystemReminder').mockImplementationOnce(() => { throw new Error('append failed'); });
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
});
