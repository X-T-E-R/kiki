import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { ExecutionControlState } from './executionControl';

export async function readPersistedExecutionControl(documents: IAtomicDocumentStore, sessionScope: string): Promise<ExecutionControlState> {
  const saved = await documents.get<{ readonly state: ExecutionControlState }>(sessionScope, 'execution-control.json');
  const state = saved?.state ?? { phase: 'running' as const, agents: [] };
  return state.phase === 'pausing' || state.phase === 'resuming'
    ? { ...state, phase: 'failed', error: 'The process stopped before the control operation settled. Inspect saved work before resuming.' }
    : state;
}
