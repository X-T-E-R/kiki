import { AgentTranscriptDraft, TranscriptFactReducer, TranscriptWireAdapter,
  type AgentTranscriptSnapshot, type TranscriptOperation, type TranscriptTurn, type TranscriptWireRecord } from '@kiki/transcript';

const EXTRA_BYTES = 8 << 20;

export class HistoryResidentProof {
  readonly draft: AgentTranscriptDraft;
  readonly adapter: TranscriptWireAdapter;
  private readonly reducer: TranscriptFactReducer;
  private readonly strings = new Map<string, string>();
  private readonly prefixes = new Map<string, string>();
  private indexBytes = 0;
  private prefixBytes = 0;
  private stateUpperBound = 0;
  private privateIndexBytes = 0;
  private traversalBytes = 0;
  private maxTraversalBytes = 0;
  private maxRecordWorkspace = 0;
  private reconciliations = 0;
  private traversalOverBudget = false;

  constructor(readonly resident: TranscriptTurn, agent: string) {
    this.draft = new AgentTranscriptDraft(agent);
    this.adapter = new TranscriptWireAdapter(agent, { turn: id => this.draft.getTurn(id),
      tool: id => this.draft.getToolCall(id), task: id => this.draft.getTask(id) });
    this.reducer = new TranscriptFactReducer({ apply: operations => this.draft.apply(operations.map(operation => this.append(operation))) });
  }

  async initialize(signal: AbortSignal): Promise<void> {
    const pending: Iterator<unknown>[] = [[this.resident].values()];
    let visited = 0;
    while (pending.length > 0) {
      signal.throwIfAborted();
      const next = pending.at(-1)!.next();
      if (next.done) pending.pop();
      else if (typeof next.value === 'string') {
        if (!this.strings.has(next.value)) { this.strings.set(next.value, next.value); this.indexBytes += 64; }
      } else if (next.value !== null && typeof next.value === 'object') pending.push(values(next.value));
      if (this.indexBytes + pending.length * 64 > EXTRA_BYTES) { this.indexBytes = EXTRA_BYTES + 1; return; }
      if (++visited % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  async apply(record: TranscriptWireRecord, signal: AbortSignal): Promise<boolean> {
    if (!await this.reuse(record, signal)) return false;
    const facts = this.adapter.add(record);
    if (!await this.reuse(facts, signal)) return false;
    const result = this.reducer.apply(facts);
    if (result.gap !== undefined) throw new Error('history_canonical_proof_gap');
    const workspace = await this.measure([record, facts], EXTRA_BYTES, signal);
    this.maxRecordWorkspace = Math.max(this.maxRecordWorkspace, workspace);
    this.stateUpperBound += workspace * 4 + 512 + facts.reduce((bytes, fact) => bytes + fact.operations.reduce((total, operation) => total + operationIndexAllowance(operation), 0), 0);
    return this.extraBytes() <= EXTRA_BYTES || this.reconcileBudget(signal);
  }

  async reconcileBudget(signal: AbortSignal): Promise<boolean> {
    this.reconciliations += 1;
    this.privateIndexBytes = this.draft.residentIndexBytes() + this.adapter.residentIndexBytes();
    const allowance = EXTRA_BYTES - this.indexStateBytes();
    if (allowance < 0 || this.traversalOverBudget) { this.stateUpperBound = 0; return false; }
    this.stateUpperBound = await this.measure([this.draft.checkpoint(), this.adapter.checkpoint()], allowance, signal);
    return this.extraBytes() <= EXTRA_BYTES;
  }

  report() {
    return { traversalPeakBytes: this.maxTraversalBytes, recordWorkspaceEstimate: this.maxRecordWorkspace, reconciliations: this.reconciliations };
  }

  snapshot(): AgentTranscriptSnapshot {
    return this.draft.checkpoint();
  }

  extraBytes(): number {
    const bytes = this.indexStateBytes() + this.stateUpperBound;
    return this.traversalOverBudget ? Math.max(bytes, EXTRA_BYTES + 1) : bytes;
  }

  private indexStateBytes(): number {
    return this.indexBytes + this.prefixBytes + this.reducer.residentBytes() + this.privateIndexBytes;
  }

  private async measure(roots: unknown[], allowance: number, signal: AbortSignal): Promise<number> {
    const shared = new Set(this.prefixes.values());
    const seen = new WeakSet<object>();
    const pending = [entries(roots)];
    let bytes = 0;
    let visited = 0;
    while (pending.length > 0 && bytes <= allowance) {
      signal.throwIfAborted();
      const next = pending.at(-1)!.next();
      if (next.done) { pending.pop(); continue; }
      const [key, value] = next.value;
      bytes += 16 + key.length * 2;
      if (typeof value === 'string') {
        if (!this.strings.has(value) && !shared.has(value)) bytes += value.length * 2;
      } else if (value !== null && typeof value === 'object' && !seen.has(value)) {
        seen.add(value);
        bytes += 96;
        pending.push(entries(value));
      } else bytes += 8;
      this.maxTraversalBytes = Math.max(this.maxTraversalBytes, pending.length * 96);
      if (pending.length * 96 > EXTRA_BYTES) { this.traversalOverBudget = true; return EXTRA_BYTES + 1; }
      if (++visited % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    return bytes;
  }

  private async reuse(value: object, signal: AbortSignal): Promise<boolean> {
    const pending = [{ target: value as Record<string, unknown>, iterator: entries(value) }];
    let visited = 0;
    try {
      while (pending.length > 0) {
        signal.throwIfAborted();
        this.traversalBytes = pending.length * 96;
        this.maxTraversalBytes = Math.max(this.maxTraversalBytes, this.traversalBytes);
        if (this.traversalBytes > EXTRA_BYTES) { this.traversalOverBudget = true; return false; }
        const current = pending.at(-1)!;
        const next = current.iterator.next();
        if (next.done) pending.pop();
        else {
          const [key, entry] = next.value;
          if (typeof entry === 'string') {
            const retained = this.strings.get(entry);
            if (retained !== undefined) current.target[key] = retained;
          } else if (entry !== null && typeof entry === 'object') pending.push({ target: entry as Record<string, unknown>, iterator: entries(entry) });
        }
        if (++visited % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      }
      return true;
    } finally { this.traversalBytes = 0; }
  }

  private append(operation: TranscriptOperation): TranscriptOperation {
    if (operation.op !== 'append' || operation.target.type !== 'frame' || operation.target.turnId !== this.resident.turnId) return operation;
    const { stepId, frameId } = operation.target;
    const original = this.resident.steps.find(step => step.stepId === stepId)?.frames.find(frame => frame.frameId === frameId);
    const current = this.draft.getTurn(this.resident.turnId)?.steps.find(step => step.stepId === stepId)?.frames.find(frame => frame.frameId === frameId);
    if (original === undefined || current === undefined || (original.kind !== 'text' && original.kind !== 'thinking') || current.kind !== original.kind) return operation;
    const text = (current as typeof original).text;
    const end = operation.offset + operation.text.length;
    if (operation.offset > text.length || end > original.text.length || !original.text.startsWith(text) || !original.text.startsWith(operation.text, operation.offset)) return operation;
    if (end <= text.length) return operation;
    const prefix = end === original.text.length ? original.text : original.text.slice(0, end);
    const key = `${stepId}\0${frameId}`;
    if (!this.prefixes.has(key)) this.prefixBytes += 128 + key.length * 2;
    this.prefixes.set(key, prefix);
    return { op: 'frame.upsert', turnId: this.resident.turnId, stepId, frame: { ...current, text: prefix } };
  }
}

function operationIndexAllowance(operation: TranscriptOperation): number {
  if (operation.op === 'frame.upsert') return 1024 + (operation.turnId.length + operation.stepId.length + operation.frame.frameId.length + 2) * 16;
  if (operation.op === 'step.upsert') return 1024 + (operation.turnId.length + operation.step.stepId.length + 1) * 16;
  if (operation.op === 'append') return operation.target.type === 'frame'
    ? 1024 + (operation.target.turnId.length + operation.target.stepId.length + operation.target.frameId.length + 8) * 16
    : 1024 + (operation.target.taskId.length + 5) * 16;
  if (operation.op === 'frame.remove') return 1024 + (operation.turnId.length + operation.stepId.length + operation.frameId.length + 2) * 16;
  return 1024;
}

function* values(value: object): Generator<unknown> {
  for (const [, entry] of entries(value)) yield entry;
}

function* entries(value: object): Generator<[string, unknown]> {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) yield [String(index), value[index]];
  } else for (const key in value) if (Object.hasOwn(value, key)) yield [key, (value as Record<string, unknown>)[key]];
}
