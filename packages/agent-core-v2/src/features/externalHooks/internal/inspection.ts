import type { AgentHooksInspect } from '@kiki/protocol';
import type { DeepReadonly } from '#/state/state';
import { ContextAppendLoopEvent, ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import { AgentModelSwitch } from '#/agent/modelSwitch/modelSwitchEvent';
import { PermissionSetMode, permissionModeKey } from '#/agent/permissionMode/permissionModeOps';
import { ConfigUpdate, ProfileBind, profileKey } from '#/agent/profile/profileOps';
import { event2FromRecord, type Event2Class } from '#/app/event/event2';
import { readLogicalBytes } from '#/persistence/coldSegmentLog';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { subagentProfileName } from '#/session/agentLifecycle/subagentMetadata';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { HookObserved, HookRulesConfigured, HookStepPrepared, hookPartition, hookStateKey, semanticRevision, type HooksState } from '../agent/hookState';
import type { HookBinding, HookRulesSnapshot } from './rules';

const replayContext = { silent: true, checkpoint: () => {}, clearCheckpoints: () => {}, undoToCheckpoint: (_count: number) => {}, emit: () => {} };
const profileClasses: ReadonlyMap<string, Event2Class> = new Map([ProfileBind, ConfigUpdate, AgentModelSwitch].map(cls => [cls.type, cls]));
const clockClasses: ReadonlyMap<string, Event2Class> = new Map([HookRulesConfigured, HookStepPrepared, HookObserved, ContextAppendLoopEvent, ContextAppendMessage].map(cls => [cls.type, cls]));
const HOOK_SCAN_CHUNK_BYTES = 1024 * 1024;
const HOOK_STEP_END_NEEDLE = Buffer.from('"step.end"');
const HOOK_INJECTION_NEEDLE = Buffer.from('"injection"');
const ALWAYS_PARSE_HOOK_TYPES = new Set<string>([
  PermissionSetMode.type,
  ProfileBind.type,
  ConfigUpdate.type,
  AgentModelSwitch.type,
  HookRulesConfigured.type,
  HookStepPrepared.type,
  HookObserved.type,
]);

async function* filteredHookInspectionRecords(
  storage: IFileSystemStorageService,
  scope: string,
  signal?: AbortSignal,
): AsyncIterable<WireRecord> {
  let pending = Buffer.alloc(0);
  let skip = false;
  let yieldedAt = performance.now();
  const maybeParseLine = (line: Buffer): WireRecord | undefined => {
    if (line.length === 0) return undefined;
    const head = line.toString('utf8', 0, Math.min(128, line.length));
    const type = /^\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(head)?.[1];
    if (type !== undefined) {
      if (!ALWAYS_PARSE_HOOK_TYPES.has(type)) {
        if (type === ContextAppendLoopEvent.type) {
          if (line.indexOf(HOOK_STEP_END_NEEDLE) === -1) return undefined;
        } else if (type === ContextAppendMessage.type) {
          if (line.indexOf(HOOK_INJECTION_NEEDLE) === -1) return undefined;
        } else {
          return undefined;
        }
      }
    }
    try {
      const parsed: unknown = JSON.parse(line.toString('utf8'));
      if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
        return parsed as WireRecord;
      }
    } catch {
    }
    return undefined;
  };
  for await (const raw of readLogicalBytes(storage, scope, AGENT_WIRE_RECORD_KEY, undefined, { chunkBytes: HOOK_SCAN_CHUNK_BYTES })) {
    signal?.throwIfAborted();
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      const index = newline < 0 ? chunk.length : newline;
      const fragment = chunk.subarray(start, index);
      if (pending.length === 0 && !skip && index !== chunk.length) {
        const parsed = maybeParseLine(fragment);
        if (parsed !== undefined) yield parsed;
        start = index + 1;
        continue;
      }
      if (!skip) pending = pending.length === 0 ? Buffer.from(fragment) : Buffer.concat([pending, fragment]);
      if (!skip && pending.length >= 128) {
        const type = /^\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(pending.toString('utf8', 0, 128))?.[1];
        if (
          type !== undefined &&
          !ALWAYS_PARSE_HOOK_TYPES.has(type) &&
          type !== ContextAppendLoopEvent.type &&
          type !== ContextAppendMessage.type
        ) {
          skip = true;
          pending = Buffer.alloc(0);
        }
      }
      if (index !== chunk.length) {
        if (!skip && pending.length > 0) {
          const parsed = maybeParseLine(pending);
          if (parsed !== undefined) yield parsed;
        }
        pending = Buffer.alloc(0);
        skip = false;
      }
      if (index === chunk.length) break;
      start = index + 1;
    }
    if (performance.now() - yieldedAt >= 4) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      signal?.throwIfAborted();
      yieldedAt = performance.now();
    }
  }
  if (!skip && pending.length > 0) {
    const parsed = maybeParseLine(pending);
    if (parsed !== undefined) yield parsed;
  }
}

export async function readPersistedHookInspection(
  appendLog: IAppendLogStore,
  scope: string,
  metadata: AgentMeta | undefined,
  signal?: AbortSignal,
  storage?: IFileSystemStorageService,
): Promise<{ binding: HookBinding; clock: DeepReadonly<HooksState> }> {
  let profile = structuredClone(profileKey.initial());
  let clock = hookStateKey.initial();
  let permissionMode: string | undefined;
  let profileSeen = false;
  const records = storage !== undefined && typeof storage.readStream === 'function'
    ? filteredHookInspectionRecords(storage, scope, signal)
    : appendLog.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY, { signal });
  for await (const record of records) {
    if (record.type === PermissionSetMode.type) {
      const event = event2FromRecord(PermissionSetMode, record);
      if (event !== undefined) {
        const fold = permissionModeKey.replayable.folds.get(PermissionSetMode);
        const next = fold?.((permissionMode ?? permissionModeKey.initial()) as never, event as never, replayContext);
        if (next !== undefined) permissionMode = next;
      }
      continue;
    }
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
    thinkingEffort: profileSeen ? (profile.thinkingLevel === '' ? undefined : profile.thinkingLevel) : metadata?.thinkingEffort,
    profileId: profileSeen ? profile.profileDefinitionId ?? profile.profileName : subagentProfileName(metadata),
    profileName: profileSeen ? profile.profileName : subagentProfileName(metadata),
    profilePath: profileSeen ? profile.boundProfile?.sourcePath : undefined,
    routeId: profileSeen ? profile.routeId : undefined,
    executorId: (profileSeen ? profile.executorId : metadata?.executor) ?? 'native',
    permissionMode,
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
