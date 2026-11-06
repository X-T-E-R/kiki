import { setImmediate } from 'node:timers/promises';
import { produce } from 'immer';
import { event2FromRecord } from '#/app/event/event2';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { StorageError, StorageErrors } from '#/persistence/interface/storage';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { autonomousReceiptsKey } from './autonomousReceiptOps';

type ReceiptState = ReturnType<typeof autonomousReceiptsKey.initial>;
interface ReceiptCheckpoint {
  readonly generation: string;
  readonly through: number;
  readonly state: ReceiptState;
}
const folds = new Map([...autonomousReceiptsKey.replayable.folds].filter(([event]) => event.durable).map(([event, fold]) => [event.type, { event, fold }]));

export async function readPendingAutonomousReceipts(scope: string, logs: IAppendLogStore, docs: IAtomicDocumentStore, signal?: AbortSignal): Promise<ReceiptState['pending']> {
  signal?.throwIfAborted();
  const generation = await logs.generation(scope, AGENT_WIRE_RECORD_KEY);
  const saved = await docs.get<ReceiptCheckpoint>(scope, 'autonomous-receipts-v1');
  const checkpoint = saved?.generation === generation ? saved : undefined;
  let state = checkpoint === undefined ? autonomousReceiptsKey.initial() : autonomousReceiptsKey.replayable.schema.parse(checkpoint.state);
  let through = checkpoint?.through ?? 0;
  let records = 0;
  for await (const record of logs.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY, {
    startOffset: through, chunkBytes: 256 * 1024, onPosition: (offset) => { through = offset; }, signal,
  })) {
    signal?.throwIfAborted();
    const entry = folds.get(record.type);
    if (entry !== undefined) {
      const event = event2FromRecord(entry.event, record);
      if (event === undefined) throw new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, 'Malformed autonomous receipt event', { details: { scope, type: record.type } });
      state = produce(state, (draft) => entry.fold(draft, event, {
        silent: true, emit: () => {}, checkpoint: () => {}, clearCheckpoints: () => {}, undoToCheckpoint: () => {},
      }));
    }
    if (++records % 512 === 0) await setImmediate(undefined, { signal });
  }
  signal?.throwIfAborted();
  if (checkpoint === undefined || through !== checkpoint.through) {
    await docs.set(scope, 'autonomous-receipts-v1', { generation, through, state });
  }
  return state.pending;
}
