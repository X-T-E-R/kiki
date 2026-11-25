import { describe, expect, it } from 'vitest';

import { resolveModelDisplay, type CatalogModelLike } from '../../settings/modelDisplay';
import { projectAgentTranscriptView } from './project';
import { resolveInjectionHeading } from './injectionLabels';
import {
  buildNoticePlacementContext,
  buildSupersededIncidentState,
  classifyNoticePlacement,
  hasConfirmedSubsequentSuccess,
  hasSubsequentCompactionResolution,
  hasSubsequentModelSwitchResolution,
  latestUnresolvedCompactionId,
  resolveRecoverableInterruption,
} from './timelinePlacement';
import { createViewState, type Block, type NoticeBlock, type TurnTailInfo } from './types';

function notice(id: string, overrides: Partial<NoticeBlock> = {}): NoticeBlock {
  return {
    kind: 'notice',
    id,
    text: id,
    tone: 'neutral',
    createdAt: '2026-11-25T00:00:00.000Z',
    ...overrides,
  };
}

describe('0.6.1 timelinePlacement (18 dispositions & domain supersession)', () => {
  it('classifies the epoch whitelist and separates visible-activity, foldable, and error notices', () => {
    const blocks: Block[] = [
      notice('n-clear', { markerKind: 'context.clear', i18n: { key: 'transcript.marker.contextClear' } }),
      notice('n-branch', { markerKind: 'branch.base', branchBase: { sourceAgentId: 'main', seedMode: 'compact', inheritedMessages: 4 } }),
      notice('n-handoff', { markerKind: 'context.handoff' }),
      notice('n-compact-done', { markerKind: 'compaction', compactionPhase: 'completed', i18n: { key: 'transcript.marker.compactionSummarize' } }),
      notice('n-compact-running', { markerKind: 'compaction', compactionPhase: 'running', i18n: { key: 'transcript.marker.compactionRunning' } }),
      notice('n-compact-queued', { markerKind: 'compaction', compactionPhase: 'queued', i18n: { key: 'transcript.marker.compactionQueued' } }),
      notice('n-compact-failed', { markerKind: 'compaction', compactionPhase: 'failed', tone: 'danger', i18n: { key: 'transcript.marker.compactionFailed' } }),
      notice('n-compact-interrupted', { markerKind: 'compaction', compactionPhase: 'interrupted', tone: 'neutral', i18n: { key: 'transcript.marker.compactionInterrupted' } }),
      notice('n-compact-cancelled', { markerKind: 'compaction', compactionPhase: 'cancelled', i18n: { key: 'transcript.marker.compactionCancelled' } }),
      notice('n-exec-compact', { executor: { kind: 'compaction' } }),
      notice('n-exec-other', { executor: { kind: 'hint', method: 'native_steer', status: 'delivered' } }),
      notice('n-switch-model', {
        markerKind: 'model.switch',
        modelSwitch: { operationId: 'op1', state: 'completed', from: 'a/m1', to: 'a/m2', mode: 'direct' },
      }),
      notice('n-switch-fresh-same', {
        markerKind: 'model.switch',
        modelSwitch: { operationId: 'op2', state: 'completed', from: 'a/m1', to: 'a/m1', mode: 'fresh' },
      }),
      notice('n-switch-effort-same', {
        markerKind: 'model.switch',
        modelSwitch: { operationId: 'op3', state: 'completed', from: 'a/m1', to: 'a/m1', mode: 'direct' },
      }),
      notice('n-switch-pending', {
        markerKind: 'model.switch',
        modelSwitch: { operationId: 'op4', state: 'pending', from: 'a/m1', to: 'a/m2', mode: 'direct' },
      }),
      notice('n-switch-failed', {
        markerKind: 'model.switch',
        tone: 'danger',
        modelSwitch: { operationId: 'op5', state: 'failed', from: 'a/m1', to: 'a/m2', mode: 'direct', error: { code: 'bad', message: 'bad' } },
      }),
      notice('n-switch-uncertain', { markerKind: 'model.switch.uncertain' }),
      notice('n-legacy-switch', { markerKind: 'model.switch', modelSwitchFrom: 'a/old', modelSwitchTo: 'a/new' }),
      notice('n-legacy-switch-same', { markerKind: 'model.switch', modelSwitchFrom: 'a/same', modelSwitchTo: 'a/same' }),
      notice('n-goal-created', { goalChange: { kind: 'created' } }),
      notice('n-goal-upd-old', { goalChange: { kind: 'updated' } }),
      notice('n-goal-upd-new', { goalChange: { kind: 'updated' } }),
      notice('n-goal-blocked', { goalChange: { kind: 'blocked', reason: 'waiting' } }),
      notice('n-plan-enter', { markerKind: 'plan.enter' }),
      notice('n-plan-rev-old', { markerKind: 'plan.revision', planRevision: { id: 'p1', version: 1, path: 'v1.md' } }),
      notice('n-plan-rev-new', { markerKind: 'plan.revision', planRevision: { id: 'p1', version: 2, path: 'v2.md' } }),
      notice('n-plan-exit', { markerKind: 'plan.exit' }),
      notice('n-stop', { markerKind: 'interruption', i18n: { key: 'transcript.marker.interruption' } }),
      notice('n-hook', { markerKind: 'hook' }),
      notice('n-task-active', { taskRef: { taskId: 'tk1', state: 'running' } }),
      notice('n-task-done', { taskRef: { taskId: 'tk2', state: 'completed' } }),
      notice('n-task-failed', { taskRef: { taskId: 'tk3', state: 'failed' } }),
      notice('n-retry-last', { i18n: { key: 'transcript.lastRetryFailed' } }),
      notice('n-turn-err', { tone: 'danger', text: 'Upstream 503' }),
    ];

    const ctx = buildNoticePlacementContext(blocks.filter((b) => b.id !== 'n-plan-exit'));
    const byId = new Map((blocks as NoticeBlock[]).map((b) => [b.id, classifyNoticePlacement(b, ctx)]));

    expect(byId.get('n-clear')).toBe('epoch');
    expect(byId.get('n-branch')).toBe('epoch');
    expect(byId.get('n-handoff')).toBe('epoch');
    expect(byId.get('n-compact-done')).toBe('epoch');
    expect(byId.get('n-compact-running')).toBe('visible-activity');
    expect(byId.get('n-compact-queued')).toBe('visible-activity');
    expect(byId.get('n-exec-compact')).toBe('epoch');
    expect(byId.get('n-switch-model')).toBe('epoch');
    expect(byId.get('n-switch-fresh-same')).toBe('epoch');
    expect(byId.get('n-legacy-switch')).toBe('epoch');

    expect(byId.get('n-compact-failed')).toBe('error');
    expect(byId.get('n-compact-interrupted')).toBe('error');
    expect(byId.get('n-switch-failed')).toBe('error');
    expect(byId.get('n-task-failed')).toBe('foldable');
    expect(byId.get('n-turn-err')).toBe('error');

    expect(byId.get('n-switch-pending')).toBe('visible-activity');
    expect(byId.get('n-switch-uncertain')).toBe('visible-activity');
    expect(byId.get('n-goal-created')).toBe('visible-activity');
    expect(byId.get('n-goal-upd-new')).toBe('visible-activity');
    expect(byId.get('n-goal-blocked')).toBe('visible-activity');
    expect(byId.get('n-plan-enter')).toBe('visible-activity');
    expect(byId.get('n-plan-rev-new')).toBe('visible-activity');
    expect(byId.get('n-plan-exit')).toBe('visible-activity');
    expect(byId.get('n-stop')).toBe('visible-activity');
    expect(byId.get('n-task-active')).toBe('visible-activity');

    expect(byId.get('n-compact-cancelled')).toBe('foldable');
    expect(byId.get('n-exec-other')).toBe('foldable');
    expect(byId.get('n-switch-effort-same')).toBe('foldable');
    expect(byId.get('n-legacy-switch-same')).toBe('foldable');
    expect(byId.get('n-goal-upd-old')).toBe('foldable');
    expect(byId.get('n-plan-rev-old')).toBe('foldable');
    expect(byId.get('n-hook')).toBe('foldable');
    expect(byId.get('n-task-done')).toBe('foldable');
    expect(byId.get('n-retry-last')).toBe('foldable');
  });

  it('quiets errors only on strictly later committed completed turns and domain-specific resolutions', () => {
    const blocks: Block[] = [
      { kind: 'user', id: 'u1', text: 'first', turnId: 't1', createdAt: '2026-11-25T00:00:00Z' },
      notice('err1', { turnId: 't1', tone: 'danger', text: 'No capacity' }),
      { kind: 'user', id: 'u2', text: '继续', turnId: 't2', createdAt: '2026-11-25T00:01:00Z' },
      { kind: 'assistant', id: 'a2', text: 'partial', streaming: false, turnId: 't2', createdAt: '2026-11-25T00:01:05Z' },
    ];
    const terminalsFailed: Record<string, TurnTailInfo> = {
      t1: { turnId: 't1', state: 'failed', endedAt: '2026-11-25T00:00:10Z', durationMs: undefined, ttftMs: undefined, usage: undefined, tokensPerSecond: undefined, error: 'No capacity' },
      t2: { turnId: 't2', state: 'failed', endedAt: '2026-11-25T00:01:10Z', durationMs: undefined, ttftMs: undefined, usage: undefined, tokensPerSecond: undefined, error: 'Still failed' },
    };
    expect(hasConfirmedSubsequentSuccess('t1', blocks, undefined)).toBe(false);
    expect(hasConfirmedSubsequentSuccess('t1', blocks, terminalsFailed)).toBe(false);

    const terminalsDone: Record<string, TurnTailInfo> = {
      ...terminalsFailed,
      t2: { turnId: 't2', state: 'completed', endedAt: '2026-11-25T00:01:20Z', durationMs: 2000, ttftMs: undefined, usage: undefined, tokensPerSecond: undefined },
    };
    expect(hasConfirmedSubsequentSuccess('t1', blocks, terminalsDone)).toBe(true);
    expect(hasConfirmedSubsequentSuccess('t2', blocks, terminalsDone)).toBe(false);

    const compactBlocks: Block[] = [
      notice('c-int', { markerKind: 'compaction', compactionPhase: 'interrupted' }),
      { kind: 'user', id: 'u3', text: 'next', turnId: 't3', createdAt: '2026-11-25T00:02:00Z' },
    ];
    expect(latestUnresolvedCompactionId(compactBlocks)).toBe('c-int');
    expect(hasSubsequentCompactionResolution(compactBlocks, 'c-int')).toBe(false);

    const compactResolved = [
      ...compactBlocks,
      notice('c-ok', { markerKind: 'compaction', compactionPhase: 'completed' }),
    ];
    expect(latestUnresolvedCompactionId(compactResolved)).toBeUndefined();
    expect(hasSubsequentCompactionResolution(compactResolved, 'c-int')).toBe(true);

    const switchBlocks: Block[] = [
      notice('sw-fail', {
        markerKind: 'model.switch',
        modelSwitch: { operationId: 'op1', state: 'failed', from: 'a', to: 'b', mode: 'direct' },
      }),
      notice('sw-ok', {
        markerKind: 'model.switch',
        modelSwitch: { operationId: 'op2', state: 'completed', from: 'a', to: 'b', mode: 'direct' },
      }),
    ];
    expect(hasSubsequentModelSwitchResolution(switchBlocks, 'sw-fail')).toBe(true);
    expect(hasSubsequentModelSwitchResolution([switchBlocks[0]!], 'sw-fail')).toBe(false);

    const precomputed = buildSupersededIncidentState(
      [...blocks, ...compactResolved, ...switchBlocks],
      terminalsDone,
    );
    expect(precomputed.isTurnSuperseded('t1')).toBe(true);
    expect(precomputed.isTurnSuperseded('t2')).toBe(false);
    expect(precomputed.isCompactionSuperseded('c-int')).toBe(true);
    expect(precomputed.isModelSwitchSuperseded('sw-fail')).toBe(true);
  });

  it('distinguishes genuinely recoverable restart work from stale empty objects', () => {
    expect(resolveRecoverableInterruption({
      agentId: 'main',
      interruptedWork: { interrupted_at: '2026-11-25T00:00:00Z', lost_tasks: 0, interrupted_branches: 0 },
    }).recoverable).toBe(false);

    const live = resolveRecoverableInterruption({
      agentId: 'main',
      interruptedWork: {
        interrupted_at: '2026-11-25T00:00:00Z',
        lost_tasks: 6,
        targets: [
          { agent_id: 'a1', kind: 'subagent', reason: 'lost_task', label: 'worker-1', lost_tasks: 3 },
          { agent_id: 'a1', kind: 'subagent', reason: 'lost_task', label: 'worker-1', lost_tasks: 3 },
          { agent_id: 'a2', kind: 'subagent', reason: 'lost_task', label: 'worker-2', lost_tasks: 3 },
        ],
      },
    });
    expect(live.recoverable).toBe(true);
    expect(live.lostTasks).toBe(6);
    expect(live.targets).toHaveLength(2);
  });
});

describe('0.6.1 injectionLabels (§4 bilingual lookup)', () => {
  it.each([
    ['model_steering', 'transcript.injection.modelSteering'],
    ['injection:model_steering', 'transcript.injection.modelSteering'],
    ['subagent_parent_steering', 'transcript.injection.subagentParentSteering'],
    ['runtime_snapshot', 'transcript.injection.runtimeSnapshot'],
    ['agents_md', 'transcript.injection.agentsMd'],
    ['memory_authority', 'transcript.injection.memoryAuthority'],
    ['capability_delta', 'transcript.injection.capabilityUpdate'],
    ['capabilities_rebuilt', 'transcript.injection.capabilityUpdate'],
    ['profile_capabilities_changed', 'transcript.injection.capabilityUpdate'],
    ['agent_profile_changes', 'transcript.injection.agentProfileChanges'],
    ['loadable-tools', 'transcript.injection.loadableTools'],
    ['dynamic_tool_schema', 'transcript.injection.dynamicToolSchema'],
    ['plugin_session_start', 'transcript.injection.pluginContext'],
    ['plugin_change', 'transcript.injection.pluginContext'],
    ['plugin_extension/acme', 'transcript.injection.pluginContext'],
    ['plan_mode', 'transcript.injection.planMode'],
    ['permission_mode', 'transcript.injection.permissionMode'],
    ['goal', 'transcript.injection.goalStatus'],
    ['goal_state', 'transcript.injection.goalStatus'],
    ['goal_cancelled', 'transcript.injection.goalCancelled'],
    ['goal_budget_stop', 'transcript.injection.goalBudgetStop'],
    ['goal_fork_cleared', 'transcript.injection.goalForkCleared'],
    ['todo_list_reminder', 'transcript.injection.todoListReminder'],
    ['todo_state', 'transcript.injection.todoState'],
    ['background_task_status', 'transcript.injection.backgroundTaskStatus'],
    ['shell_command_backgrounded', 'transcript.injection.shellCommandBackgrounded'],
    ['interruption', 'transcript.injection.interruption'],
    ['message_delivery', 'transcript.injection.messageDelivery'],
    ['compaction_elision', 'transcript.injection.compactionElision'],
    ['image_compression', 'transcript.injection.imageCompression'],
    ['date_change', 'transcript.injection.dateChange'],
    ['mesh_context', 'transcript.injection.meshContext'],
    ['btw', 'transcript.injection.btw'],
    ['init', 'transcript.injection.init'],
    ['room_joined', 'transcript.injection.roomJoined'],
    ['room_left', 'transcript.injection.roomLeft'],
    ['extension_recovery', 'transcript.injection.extensionRecovery'],
    ['system_reminder', 'transcript.systemReminder'],
    ['task', 'transcript.injection.taskNotification'],
    ['agent_message', 'transcript.injection.agentMessage'],
  ] as const)('maps variant %s -> %s', (variant, expectedKey) => {
    const resolved = resolveInjectionHeading({ variant });
    expect(resolved.labelKey).toBe(expectedKey);
    expect(resolved.verbatimSource).toBe(variant);
  });

  it('handles parameterized hook families, category precedence, and malformed/unknown fallbacks', () => {
    const hookRule = resolveInjectionHeading({ variant: 'hook_rule/no-force-push' });
    expect(hookRule.labelKey).toBe('transcript.injection.hookRule');
    expect(hookRule.secondary).toBe('no-force-push');
    expect(hookRule.verbatimSource).toBe('hook_rule/no-force-push');

    const hookEvent = resolveInjectionHeading({ variant: 'hook/PreToolUse' });
    expect(hookEvent.labelKey).toBe('transcript.injection.hookEvent');
    expect(hookEvent.secondary).toBe('PreToolUse');

    const malformed = resolveInjectionHeading({ variant: 'hook_rule/' });
    expect(malformed.labelKey).toBe('transcript.systemReminder');
    expect(malformed.verbatimSource).toBe('hook_rule/');

    const categoryWins = resolveInjectionHeading({
      category: { kind: 'renew', triggers: ['T1'], epoch: 2 },
      variant: 'runtime_snapshot',
    });
    expect(categoryWins.labelKey).toBe('transcript.reminder.renew');
    expect(categoryWins.verbatimSource).toBe('runtime_snapshot');
  });
});

describe('0.6.1 resolveModelDisplay (scoped catalog & disambiguation)', () => {
  const catalog: readonly CatalogModelLike[] = [
    { id: 'axon-message/gemini-4-neon', remote_id: 'gemini-4-neon', provider_id: 'axon-message', display_name: 'Gemini 4 Neon', provider_display_name: 'Axon' },
    { id: 'axon/gpt-6-luna', remote_id: 'gpt-6-luna', provider_id: 'axon', display_name: 'GPT-6 Luna', provider_display_name: 'Axon' },
    { id: 'openai/gpt-6-luna', remote_id: 'gpt-6-luna', provider_id: 'openai', display_name: 'GPT-6 Luna', provider_display_name: 'OpenAI' },
    { id: 'custom/only-bare', remote_id: 'only-bare', provider_id: 'custom', display_name: 'Only Bare' },
  ];

  it('resolves exact matches, disambiguates colliding display names, rejects ambiguous bare aliases, and isolates external executors', () => {
    const exact = resolveModelDisplay('axon-message/gemini-4-neon', { catalog, unknownLabel: 'Unknown model', scope: 's1' });
    expect(exact).toEqual({ label: 'Gemini 4 Neon', known: true, rawId: 'axon-message/gemini-4-neon', providerLabel: undefined });

    const colliding = resolveModelDisplay('openai/gpt-6-luna', { catalog, unknownLabel: 'Unknown model', scope: 's1' });
    expect(colliding.label).toBe('GPT-6 Luna (OpenAI)');
    expect(colliding.known).toBe(true);

    const uniqueBare = resolveModelDisplay('only-bare', { catalog, unknownLabel: 'Unknown model', scope: 's1' });
    expect(uniqueBare.label).toBe('Only Bare');

    const ambiguousBare = resolveModelDisplay('gpt-6-luna', { catalog, unknownLabel: 'Unknown model', scope: 's1' });
    expect(ambiguousBare.known).toBe(false);
    expect(ambiguousBare.ambiguous).toBe(true);
    expect(ambiguousBare.label).toBe('Unknown model');

    const missing = resolveModelDisplay('provider/unknown-99', { catalog, unknownLabel: '模型名称未知', scope: 's1' });
    expect(missing.label).toBe('模型名称未知');
    expect(missing.rawId).toBe('provider/unknown-99');

    const externalIsolated = resolveModelDisplay('axon-message/gemini-4-neon', {
      catalog,
      unknownLabel: 'Unknown model',
      externalExecutor: true,
    });
    expect(externalIsolated.known).toBe(false);
    expect(externalIsolated.label).toBe('Unknown model');
  });

  it('preserves surviving context.clear and leading model.switch epoch boundaries before a post-clear turn (ordinal > 0)', () => {
    const projected = projectAgentTranscriptView(createViewState('session_clear_post'), 'main', {
      items: [
        { kind: 'marker', markerId: 'context.clear', marker: 'context.clear', at: '2026-11-25T07:55:00.000Z' },
        { kind: 'marker', markerId: 'm-sw', marker: 'model.switch', at: '2026-11-25T07:56:00.000Z', payload: { from: 'a/old', to: 'a/new' } },
        {
          kind: 'turn',
          turnId: 't5',
          ordinal: 5,
          state: 'completed',
          origin: { kind: 'user' },
          prompt: 'After clear',
          startedAt: '2026-11-25T07:57:00.000Z',
          endedAt: '2026-11-25T07:57:02.000Z',
          steps: [],
        },
      ],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
      hasMoreOlder: false,
    });
    const notices = projected.blocks.filter((block): block is NoticeBlock => block.kind === 'notice');
    expect(notices.map((n) => n.markerKind)).toEqual(['context.clear', 'model.switch']);
  });
});
