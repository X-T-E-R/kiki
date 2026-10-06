import type { TranscriptOperation } from '../ops/operation';
import type { TranscriptWireRecord } from './wireAdapter';

interface CompactionRun {
  readonly markerId: string;
  readonly at?: string;
  readonly payload: Record<string, unknown>;
}

export interface CompactionProjectionCheckpoint {
  readonly running?: CompactionRun;
  readonly queued?: CompactionRun;
  readonly cancelled?: CompactionRun;
}

export class CompactionProjection {
  #running: CompactionRun | undefined;
  #queued: CompactionRun | undefined;
  #cancelled: CompactionRun | undefined;

  checkpoint(): CompactionProjectionCheckpoint {
    return { running: this.#running, queued: this.#queued, cancelled: this.#cancelled };
  }

  restore(checkpoint?: CompactionProjectionCheckpoint): void {
    this.#running = checkpoint?.running;
    this.#queued = checkpoint?.queued;
    this.#cancelled = checkpoint?.cancelled;
  }

  activeOperations(): TranscriptOperation[] {
    return [this.#running, this.#queued].flatMap((run) => run === undefined ? [] : [upsert(run)]);
  }

  finish(): TranscriptOperation[] {
    return [this.#running, this.#queued].flatMap((run) => run === undefined || run.payload['phase'] === 'completed'
      ? [] : [upsert({ ...run, payload: { ...run.payload, phase: 'interrupted' } })]);
  }

  project(record: TranscriptWireRecord, ordinal: number): TranscriptOperation[] | undefined {
    const at = record.time === undefined ? undefined : new Date(record.time).toISOString();
    if (record.type === 'full_compaction.begin') {
      const queued = record['queued'] === true;
      const previous = record['source'] === 'manual' ? this.#queued : undefined;
      const run: CompactionRun = {
        markerId: previous?.markerId ?? identity(record, ordinal),
        at,
        payload: { phase: queued ? 'queued' : 'running', source: record['source'], startedAt: queued ? undefined : at },
      };
      if (queued) this.#queued = run;
      else {
        this.#running = run;
        this.#cancelled = undefined;
        if (record['source'] === 'manual') this.#queued = undefined;
      }
      return [upsert(run)];
    }
    if (record.type === 'context.apply_compaction') {
      const previous = this.#running;
      const run: CompactionRun = {
        markerId: previous?.markerId ?? identity(record, ordinal),
        at,
        payload: { ...record, phase: 'completed', source: previous?.payload['source'], startedAt: previous?.payload['startedAt'] },
      };
      if (previous !== undefined) this.#running = run;
      return [upsert(run)];
    }
    if (record.type === 'full_compaction.complete') {
      const previous = this.#running;
      this.#running = undefined;
      if (previous === undefined || previous.payload['phase'] === 'completed') return [];
      return [upsert({ ...previous, at, payload: { ...previous.payload, phase: 'interrupted' } })];
    }
    if (record.type === 'full_compaction.cancel') {
      const queued = record['queued'] === true;
      const previous = queued ? this.#queued : this.#running;
      if (queued) this.#queued = undefined;
      else this.#running = undefined;
      if (previous === undefined || previous.payload['phase'] === 'completed') return [];
      const reason = typeof record['reason'] === 'string' ? record['reason'] : undefined;
      this.#cancelled = { ...previous, at, payload: { ...previous.payload, phase: reason === undefined ? 'cancelled' : 'failed', reason } };
      return [upsert(this.#cancelled)];
    }
    if (record.type === 'compaction.cancelled') {
      const previous = this.#cancelled;
      if (previous === undefined || typeof record['reason'] !== 'string') return [];
      this.#cancelled = { ...previous, payload: { ...previous.payload, phase: 'failed', reason: record['reason'] } };
      return [upsert(this.#cancelled)];
    }
    if (record.type.startsWith('compaction.')) return [];
    return undefined;
  }
}

function identity(record: TranscriptWireRecord, ordinal: number): string {
  return typeof record['id'] === 'string' ? record['id']
    : record.time === undefined ? `wire:v2:r${ordinal}:compaction` : `wire:v2:compaction:t${record.time}`;
}

function upsert(run: CompactionRun): TranscriptOperation {
  return { op: 'marker.upsert', item: { kind: 'marker', markerId: run.markerId, marker: 'compaction', at: run.at, payload: run.payload } };
}
