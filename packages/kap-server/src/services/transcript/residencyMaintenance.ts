import { stat } from 'node:fs/promises';
import type { TranscriptTurn } from '@kiki/transcript';
import type { ResidentProofFailure } from '../history/historyCanonicalReader';
import type { HistoryLocatorStore } from '../history/historyLocatorStore';

export const RESIDENCY_MAINTENANCE_MAX_CONCURRENT = 2;
export const RESIDENCY_MAINTENANCE_DEBOUNCE_MS = 25;

export interface KnownUnreleasableTurn {
  readonly turn: WeakRef<TranscriptTurn>;
  readonly status: ResidentProofFailure;
}

export interface AgentResidencyState {
  readonly knownUnreleasable: Map<string, KnownUnreleasableTurn>;
  verifiedWireFingerprint?: string;
  verifiedLocator?: HistoryLocatorStore;
  lastWarnedFailureSet?: string;
}

export interface ResidencyPassContext {
  readonly signal: AbortSignal;
  readonly state: AgentResidencyState;
  readonly clearAgain: () => void;
}

export interface ResidencyTask {
  run(context: ResidencyPassContext): Promise<void>;
  shouldReArm(state: AgentResidencyState): boolean;
}

interface ScheduledAgent {
  readonly key: string;
  readonly state: AgentResidencyState;
  task?: ResidencyTask;
  timer?: ReturnType<typeof setTimeout>;
  queued: boolean;
  active?: {
    readonly controller: AbortController;
    again: boolean;
  };
  cancelled: boolean;
}

export class ResidencyMaintenanceScheduler {
  private readonly agents = new Map<string, ScheduledAgent>();
  private readonly queue: ScheduledAgent[] = [];
  private activeCount = 0;
  private peakActive = 0;

  constructor(
    private readonly maxConcurrent = RESIDENCY_MAINTENANCE_MAX_CONCURRENT,
    private readonly debounceMs = RESIDENCY_MAINTENANCE_DEBOUNCE_MS,
  ) {}

  schedule(key: string, task: ResidencyTask): void {
    let entry = this.agents.get(key);
    if (entry === undefined) {
      entry = {
        key,
        state: { knownUnreleasable: new Map() },
        queued: false,
        cancelled: false,
      };
      this.agents.set(key, entry);
    }
    entry.task = task;
    if (entry.active !== undefined) {
      entry.active.again = true;
      return;
    }
    if (entry.queued || entry.timer !== undefined) return;
    const owned = entry;
    owned.timer = setTimeout(() => {
      owned.timer = undefined;
      if (owned.cancelled || this.agents.get(key) !== owned) return;
      if (owned.active !== undefined || owned.queued) return;
      owned.queued = true;
      this.queue.push(owned);
      this.pump();
    }, this.debounceMs);
    owned.timer.unref();
  }

  cancel(key: string, reason: Error): void {
    const entry = this.agents.get(key);
    if (entry === undefined) return;
    this.agents.delete(key);
    entry.cancelled = true;
    entry.task = undefined;
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (entry.queued) {
      entry.queued = false;
      const index = this.queue.indexOf(entry);
      if (index >= 0) this.queue.splice(index, 1);
    }
    entry.state.knownUnreleasable.clear();
    entry.state.verifiedWireFingerprint = undefined;
    entry.state.verifiedLocator = undefined;
    entry.state.lastWarnedFailureSet = undefined;
    entry.active?.controller.abort(reason);
  }

  cancelPrefix(prefix: string, reason: Error): void {
    for (const key of this.agents.keys()) {
      if (key.startsWith(prefix)) this.cancel(key, reason);
    }
  }

  clearFailureCaches(): void {
    for (const entry of this.agents.values()) {
      entry.state.knownUnreleasable.clear();
      entry.state.verifiedWireFingerprint = undefined;
      entry.state.verifiedLocator = undefined;
      entry.state.lastWarnedFailureSet = undefined;
    }
  }

  dispose(): void {
    const reason = new DOMException('Transcript service is disposing', 'AbortError');
    for (const key of this.agents.keys()) this.cancel(key, reason);
  }

  report(): { readonly active: number; readonly queued: number; readonly peak: number; readonly maxConcurrent: number } {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      peak: this.peakActive,
      maxConcurrent: this.maxConcurrent,
    };
  }

  private pump(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      entry.queued = false;
      if (entry.cancelled || this.agents.get(entry.key) !== entry || entry.task === undefined) continue;
      const task = entry.task;
      entry.task = undefined;
      const controller = new AbortController();
      const active = { controller, again: false };
      entry.active = active;
      this.activeCount += 1;
      this.peakActive = Math.max(this.peakActive, this.activeCount);
      void Promise.resolve()
        .then(() =>
          task.run({
            signal: controller.signal,
            state: entry.state,
            clearAgain: () => {
              active.again = false;
            },
          }),
        )
        .finally(() => {
          this.activeCount -= 1;
          const nextTask = entry.task;
          entry.task = undefined;
          const shouldReArm =
            !entry.cancelled &&
            this.agents.get(entry.key) === entry &&
            entry.active === active &&
            active.again &&
            nextTask !== undefined &&
            nextTask.shouldReArm(entry.state);
          if (entry.active === active) entry.active = undefined;
          if (shouldReArm && nextTask !== undefined) {
            this.schedule(entry.key, nextTask);
          }
          this.pump();
        });
    }
  }
}

export async function wireFingerprintForMaintenance(
  wirePath: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  signal.throwIfAborted();
  try {
    const info = await stat(wirePath, { bigint: true });
    signal.throwIfAborted();
    if (!info.isFile()) return undefined;
    return `${String(info.dev)}:${String(info.ino)}:${String(info.birthtimeNs)}:${String(info.size)}:${String(info.mtimeNs)}:${String(info.ctimeNs)}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return undefined;
  }
}

export function failureSetSignature(retained: ReadonlyMap<string, ResidentProofFailure>): string {
  return [...retained.entries()]
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([turnId, status]) => `${turnId}:${status}`)
    .join('\0');
}

export function estimateResidentTurnBytes(turn: TranscriptTurn): number {
  return estimateResidentValueBytes(turn);
}

export function estimateResidentValueBytes(root: unknown): number {
  let bytes = 0;
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || value === undefined) {
      bytes += 8;
      continue;
    }
    if (typeof value === 'string') {
      bytes += 24 + value.length * 2;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      bytes += 8;
      continue;
    }
    if (typeof value !== 'object') {
      bytes += 16;
      continue;
    }
    if (seen.has(value)) {
      bytes += 8;
      continue;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      bytes += 32 + value.length * 8;
      for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
      continue;
    }
    if (value instanceof Map) {
      bytes += 48 + value.size * 24;
      for (const [key, entry] of value) {
        stack.push(entry);
        stack.push(key);
      }
      continue;
    }
    if (value instanceof Set) {
      bytes += 48 + value.size * 16;
      for (const entry of value) stack.push(entry);
      continue;
    }
    bytes += 48;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      bytes += 16 + key.length * 2;
      stack.push((value as Record<string, unknown>)[key]);
    }
  }
  return bytes;
}
