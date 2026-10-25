import type { AgentHooksInspect } from '@kiki/protocol';
import type { DeepReadonly } from '#/state/state';
import { ContextAppendLoopEvent, ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import { AgentModelSwitch } from '#/agent/modelSwitch/modelSwitchEvent';
import { ConfigUpdate, ProfileBind, profileKey } from '#/agent/profile/profileOps';
import { event2FromRecord, type Event2Class } from '#/app/event/event2';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { subagentProfileName } from '#/session/agentLifecycle/subagentMetadata';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { HookObserved, HookRulesConfigured, HookStepPrepared, hookPartition, hookStateKey, semanticRevision, type HooksState } from '../agent/hookState';
import type { HookBinding, HookRulesSnapshot } from './rules';

const replayContext = { silent: true, checkpoint: () => {}, clearCheckpoints: () => {}, undoToCheckpoint: (_count: number) => {}, emit: () => {} };
const profileClasses: ReadonlyMap<string, Event2Class> = new Map([ProfileBind, ConfigUpdate, AgentModelSwitch].map(cls => [cls.type, cls]));
const clockClasses: ReadonlyMap<string, Event2Class> = new Map([HookRulesConfigured, HookStepPrepared, HookObserved, ContextAppendLoopEvent, ContextAppendMessage].map(cls => [cls.type, cls]));

export async function readPersistedHookInspection(appendLog: IAppendLogStore, scope: string, metadata: AgentMeta | undefined, signal?: AbortSignal): Promise<{ binding: HookBinding; clock: DeepReadonly<HooksState> }> {
  let profile = structuredClone(profileKey.initial());
  let clock = hookStateKey.initial();
  let profileSeen = false;
  for await (const record of appendLog.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY, { signal })) {
    const profileClass = profileClasses.get(record.type);
    if (profileClass !== undefined) {
      const event = event2FromRecord(profileClass, record);
      if (event === undefined) continue;
      const fold = profileKey.replayable.folds.get(profileClass);
      const next = fold?.(profile as never, event as never, replayContext);
      if (next !== undefined) profile = next;
      profileSeen = true;
      continue;
    }
    if (record.type === ContextAppendLoopEvent.type && (record['event'] as { type?: string } | undefined)?.type !== 'step.end') continue;
    if (record.type === ContextAppendMessage.type && (record['message'] as { origin?: { kind?: string; variant?: string } } | undefined)?.origin?.kind !== 'injection') continue;
    const clockClass = clockClasses.get(record.type);
    if (clockClass === undefined) continue;
    const event = event2FromRecord(clockClass, record);
    if (event === undefined) continue;
    const fold = hookStateKey.replayable.folds.get(clockClass);
    const next = fold?.(clock as never, event as never, replayContext);
    if (next !== undefined) clock = next;
  }
  signal?.throwIfAborted();
  return { clock, binding: {
    modelAlias: profileSeen ? profile.modelAlias : metadata?.model,
    profileId: profileSeen ? profile.profileDefinitionId ?? profile.profileName : subagentProfileName(metadata),
    routeId: profileSeen ? profile.routeId : undefined,
    executorId: (profileSeen ? profile.executorId : metadata?.executor) ?? 'native',
    agentRole: metadata?.parentAgentId === undefined ? 'root' : 'subagent',
  } };
}

export function projectHookInspection(snapshot: HookRulesSnapshot, binding: HookBinding, clock: DeepReadonly<HooksState>): AgentHooksInspect {
  return { revision: snapshot.revision, sources: [...snapshot.sources ?? []], diagnostics: [...snapshot.diagnostics], binding: { ...binding, executorId: binding.executorId ?? 'native' }, rules: snapshot.rules.map((rule, order) => {
    const unsupported = binding.executorId !== 'native' && ['step.before', 'step.after', 'tool.before', 'tool.after'].includes(rule.rule.event);
    const cadence = rule.rule.cadence;
    const stored = clock.rules[rule.id];
    const state = stored?.semanticHash === rule.semanticHash ? stored : undefined;
    const bucket = state?.buckets[hookPartition(binding.modelId ?? '', clock.turnId, cadence?.counterScope ?? 'agent')];
    const reason = rule.reason ?? (unsupported ? 'unsupported_executor' : undefined);
    return { id: rule.id, path: rule.path, namespace: rule.namespace, event: rule.rule.event, action: { type: rule.rule.action.type }, active: rule.active && !unsupported, reason, order,
      resetPending: stored !== undefined && state === undefined,
      semanticRevision: state === undefined ? undefined : semanticRevision(state),
      completedSteps: bucket?.completed ?? 0,
      nextDue: cadence === undefined ? undefined : (Math.floor((bucket?.delivered ?? 0) / cadence.everyCompletedSteps) + 1) * cadence.everyCompletedSteps,
    };
  }) };
}
