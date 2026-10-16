import { parseUsageJson, UsageJsonStream } from '#/agent/usage/usageJson';
import { normalizeUsageFact, type UsageFact } from '#/agent/usage/usageFact';

export type UsageReadStop = 'deadline' | 'record_budget' | 'cancelled' | 'checkpoint' | 'yield' | null;

/** Shared by the host lane and one parser isolate. Lock-free reservations cannot exceed raw/fact allowances or strand a mutex when an isolate is terminated. Negative counters denote unlimited work. */
export class UsageReadAllowance {
  readonly buffer: SharedArrayBuffer;
  private readonly counters: BigInt64Array;

  constructor(raw: number | SharedArrayBuffer, facts = Infinity, bytes = Infinity) {
    this.buffer = typeof raw === 'number' ? new SharedArrayBuffer(48) : raw;
    this.counters = new BigInt64Array(this.buffer);
    if (typeof raw === 'number') this.counters.set([raw, facts, bytes].map((value) => Number.isFinite(value) ? BigInt(Math.ceil(value)) : -1n));
  }

  stop(reason: 'deadline' | 'cancelled'): void { Atomics.store(this.counters, 5, reason === 'deadline' ? 1n : 2n); }
  stopped(): 'deadline' | 'cancelled' | undefined { const state = Atomics.load(this.counters, 5); return state === 1n ? 'deadline' : state === 2n ? 'cancelled' : undefined; }
  rawAvailable(): boolean { return Atomics.load(this.counters, 0) !== 0n; }
  reserveBytes(requested: number): number { return this.take(2, requested); }
  refundBytes(count: number): void { this.refund(2, count); }
  takeRecord(fact: boolean): boolean {
    if (this.take(0, 1) === 0) return false;
    if (fact && this.take(1, 1) === 0) { this.refund(0, 1); return false; }
    Atomics.add(this.counters, 3, 1n);
    if (fact) Atomics.add(this.counters, 4, 1n);
    return true;
  }
  counts(): { raw: number; facts: number } { return { raw: Number(Atomics.load(this.counters, 3)), facts: Number(Atomics.load(this.counters, 4)) }; }
  private refund(index: number, count: number): void { if (Atomics.load(this.counters, index) >= 0n) Atomics.add(this.counters, index, BigInt(count)); }
  private take(index: number, requested: number): number {
    for (;;) {
      const available = Atomics.load(this.counters, index);
      if (available < 0n) return requested;
      const count = BigInt(requested) < available ? BigInt(requested) : available;
      if (Atomics.compareExchange(this.counters, index, available, available - count) === available) return Number(count);
    }
  }
}

export interface UsageWireState {
  readonly offset: number;
  readonly cursor: number;
  readonly valid: boolean;
  readonly parser?: object;
  readonly utf8?: Uint8Array;
  readonly invalid?: boolean;
}

export interface UsageWireSlice {
  readonly consumed: number;
  readonly records: readonly UsageFact[];
  readonly rawCount: number;
  readonly factCount: number;
  readonly state: UsageWireState;
  readonly stop: UsageReadStop;
}

/** Pure source-local framing. Callers own byte acquisition, shared allowances, cooperative yields and durable prefix commits. State retains parsed usage fields, nesting and at most three undecoded UTF-8 bytes, never an unrelated body. */
export class UsageWireFramer {
  private offset: number;
  private cursor: number;
  private valid: boolean;
  private parser?: UsageJsonStream;
  private utf8: Uint8Array = new Uint8Array(0);
  private invalid = false;
  private committedAt: number;
  private readonly sourceAgentId?: string;

  constructor(start: number, sourceAgentId?: string, state?: UsageWireState) {
    this.offset = state?.offset ?? start;
    this.cursor = state?.cursor ?? start;
    this.valid = state?.valid ?? true;
    this.parser = state?.parser === undefined ? undefined : UsageJsonStream.resume(state.parser);
    this.utf8 = state?.utf8 ?? this.utf8;
    this.invalid = state?.invalid ?? false;
    this.committedAt = start;
    this.sourceAgentId = sourceAgentId;
  }

  snapshot(): UsageWireState {
    return { offset: this.offset, cursor: this.cursor, valid: this.valid, parser: this.parser?.snapshot(), utf8: this.utf8.length > 0 ? this.utf8 : undefined, invalid: this.invalid || undefined };
  }

  consume(input: Uint8Array, allowance: UsageReadAllowance, deadlineAt: number, now: () => number = Date.now): UsageWireSlice {
    const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const records: UsageFact[] = [];
    let rawCount = 0, factCount = 0, start = 0;
    const yieldAt = performance.now() + 8;
    let stop: UsageReadStop = null;
    while (start < bytes.length) {
      const stopped = allowance.stopped();
      if (stopped !== undefined) { stop = stopped; break; }
      if (now() >= deadlineAt) { stop = 'deadline'; break; }
      if (!allowance.rawAvailable()) { stop = 'record_budget'; break; }
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      if (this.parser !== undefined || newline < 0 || end - start > 1 << 20) {
        this.parser ??= new UsageJsonStream();
        while (start < end) {
          const next = Math.min(end, start + (64 << 10));
          if (!this.invalid) {
            try { this.parser.write(this.decode(bytes.subarray(start, next))); }
            catch { this.invalid = true; }
          }
          this.cursor += next - start;
          start = next;
          const interrupted = allowance.stopped();
          if (interrupted !== undefined || now() >= deadlineAt) { stop = interrupted ?? 'deadline'; break; }
          if (performance.now() >= yieldAt) { stop = 'yield'; break; }
        }
        if (stop !== null || newline < 0) break;
      }
      let raw: ReturnType<typeof parseUsageJson>;
      try {
        if (this.parser !== undefined) {
          if (!this.invalid) { this.parser.write(Buffer.from(this.utf8).toString('utf8')); raw = this.parser.finish(); }
        } else if (end > start) raw = parseUsageJson(bytes.subarray(start, end));
      } catch { this.invalid = true; }
      const fact = this.invalid || raw !== undefined;
      if (!allowance.takeRecord(fact)) {
        this.parser = undefined;
        this.utf8 = new Uint8Array(0);
        this.invalid = false;
        this.cursor = this.offset;
        stop = 'record_budget';
        break;
      }
      if (fact) {
        factCount++;
        if (this.invalid) this.valid = false;
        else {
          const record = normalizeUsageFact(raw!, this.sourceAgentId);
          if (record === undefined) this.valid = false;
          else records.push(record);
        }
      }
      this.cursor += end - start + 1;
      this.offset = this.cursor;
      this.parser = undefined;
      this.utf8 = new Uint8Array(0);
      this.invalid = false;
      start = end + 1;
      rawCount++;
      if (this.offset - this.committedAt >= 16 * 1024 * 1024) { this.committedAt = this.offset; stop = 'checkpoint'; break; }
      if (records.length >= 256 || rawCount % 1024 === 0 || (rawCount % 128 === 0 && performance.now() >= yieldAt)) { stop = 'yield'; break; }
    }
    return { consumed: start, records, rawCount, factCount, state: this.snapshot(), stop };
  }

  private decode(bytes: Uint8Array): string {
    const input = this.utf8.length === 0 ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : Buffer.concat([this.utf8, bytes]);
    let lead = input.length - 1;
    while (lead >= Math.max(0, input.length - 3) && input[lead]! >= 0x80 && input[lead]! < 0xc0) lead--;
    const first = input[lead] ?? 0;
    const width = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 1;
    const end = width > input.length - lead ? lead : input.length;
    this.utf8 = Uint8Array.from(input.subarray(end));
    return input.toString('utf8', 0, end);
  }
}
