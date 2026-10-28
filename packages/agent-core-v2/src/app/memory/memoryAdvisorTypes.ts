import type { MemoryAdvisorStatus } from '@kiki/protocol';
import type { MemoryRecallEntry } from './memoryRecall';

export type MemoryAdviceUse = 'apply' | 'history' | 'skip' | 'recommended';
export interface MemoryAdviceItem {
  readonly key: string;
  readonly revision: string;
  readonly use: MemoryAdviceUse;
  readonly score?: number;
}
export interface MemoryAdvice {
  readonly fingerprint: string;
  readonly generation: string;
  readonly mode: 'rank' | 'select';
  readonly items: readonly MemoryAdviceItem[];
  readonly seen: readonly string[];
  readonly status: MemoryAdvisorStatus;
}
export function memoryAdviceKey(entry: Pick<MemoryRecallEntry, 'scope' | 'id'>): string {
  const scope = entry.scope;
  return JSON.stringify([
    scope.kind,
    'workspaceId' in scope ? scope.workspaceId : null,
    'personaId' in scope ? scope.personaId : null,
    entry.id,
  ]);
}
export function advisorStatus(
  state: MemoryAdvisorStatus['state'],
  extra: Partial<MemoryAdvisorStatus> = {},
): MemoryAdvisorStatus {
  return {
    state,
    consent_required: false,
    logical_calls: 0,
    requests: 0,
    retries: 0,
    displaced_ids: [],
    unjudged_count: 0,
    ...extra,
  };
}
