import { produce } from 'immer';
import { join } from 'pathe';

import { unwrapErrorCause } from '#/_base/errors/errors';
import { event2FromRecord } from '#/app/event/event2';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { StorageError, StorageErrors } from '#/persistence/interface/storage';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { expandedStateFolds } from '#/state/state';
import { AGENT_WIRE_RECORD_KEY, isWireRecord, isWireMetadataRecord } from '#/wire/record';
import { migrateV1_4ToV1_5, migrateWireRecord, resolveWireMigrations, type WireMigration } from '#/wire/migration/migration';
import type { PlanData } from './plan';
import { planKey, type PlanState } from './planOps';

export function planFilePath(sessionDir: string, agentId: string, id: string): string {
  return join(sessionDir, 'agents', agentId, 'plans', `${id}.md`);
}

export async function readPlanData(hostFs: IHostFileSystem, sessionDir: string, agentId: string, state: PlanState): Promise<PlanData> {
  if (!state.active || state.id === undefined) return null;
  const path = planFilePath(sessionDir, agentId, state.id);
  let content = '';
  try {
    content = await hostFs.readText(path);
  } catch (error) {
    const cause = unwrapErrorCause(error);
    if (cause === null || typeof cause !== 'object' || (cause as { code?: unknown }).code !== 'ENOENT') throw error;
  }
  return { id: state.id, content, path };
}

/** Read the canonical plan folds, including conversation undo, without creating an agent or rewriting its journal. The caller establishes agent identity. */
export async function readPersistedPlan(context: ISessionContext, agentId: string, log: IAppendLogStore, hostFs: IHostFileSystem): Promise<PlanData> {
  const folds = new Map([...expandedStateFolds(planKey)].map(([event, fold]) => [event.type, { event, fold }]));
  let state: PlanState = planKey.initial();
  let checkpoints: PlanState[] = [];
  let migrations: readonly WireMigration[] = [];
  let first = true;
  for await (const candidate of log.read<unknown>(context.scope(`agents/${agentId}`), AGENT_WIRE_RECORD_KEY)) {
    if (!isWireRecord(candidate)) throw new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, 'Malformed plan history record');
    if (first) {
      first = false;
      if (candidate.type !== 'metadata') migrations = [migrateV1_4ToV1_5];
      else if (!isWireMetadataRecord(candidate)) throw new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, 'Malformed plan history metadata');
      else migrations = resolveWireMigrations(candidate.protocol_version);
    }
    const record = migrateWireRecord(candidate, migrations);
    const entry = folds.get(record.type);
    if (entry === undefined) continue;
    const event = event2FromRecord(entry.event, record);
    if (event === undefined) throw new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, 'Malformed plan state event');
    let checkpoint = false;
    let clear = false;
    let undo: number | undefined;
    const next = produce(state, (draft) => entry.fold(draft, event, {
      silent: true,
      emit: () => {},
      checkpoint: () => { checkpoint = true; },
      clearCheckpoints: () => { clear = true; },
      undoToCheckpoint: (count) => { undo = count; },
    }));
    if (undo !== undefined) {
      const index = checkpoints.length - undo;
      if (index < 0) throw new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, 'Plan undo exceeds available history');
      state = checkpoints[index]!;
      checkpoints = checkpoints.slice(0, index);
    } else {
      state = next;
      if (clear) checkpoints = [];
      if (checkpoint) checkpoints.push(state);
    }
  }
  return readPlanData(hostFs, context.sessionDir, agentId, state);
}
