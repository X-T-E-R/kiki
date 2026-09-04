import type { NormalizedExecutorEvent } from '@moonshot-ai/protocol';

import type { WireRecord } from '#/wire/record';

import type {
  ExternalTranscriptL1Item,
  ExternalTranscriptStep,
  ExternalTranscriptTurn,
  ExternalTurnEventView,
} from './externalDelegation';

type ProjectedEvent = Readonly<{ type: string; time: number } & Record<string, unknown>>;

interface SequencedItem {
  readonly seq: number;
  readonly item: ExternalTranscriptL1Item;
}

type Mutable<T> = T extends unknown ? { -readonly [K in keyof T]: T[K] } : never;
type TranscriptFrame = ExternalTranscriptStep['frames'][number];
type MutableFrame = Mutable<TranscriptFrame>;
type MutableStep = Omit<Mutable<ExternalTranscriptStep>, 'frames'> & { frames: MutableFrame[] };
type MutableTurn = Omit<Mutable<ExternalTranscriptTurn>, 'steps'> & { steps: MutableStep[] };
type MutableToolFrame = Extract<MutableFrame, { kind: 'tool' }>;

export class AgentTurnProjection {
  private nextSeq = 1;
  private readonly events: ExternalTurnEventView[] = [];
  private readonly items: SequencedItem[] = [];
  private readonly itemIndexes = new Map<string, number>();
  private readonly turns = new Map<string, MutableTurn>();
  private readonly steps = new Map<string, MutableStep>();
  private readonly frames = new Map<string, MutableFrame>();
  private readonly frameIndexes = new Map<
    string,
    { readonly step: MutableStep; readonly index: number }
  >();
  private readonly tools = new Map<
    string,
    { readonly turn: MutableTurn; readonly step: MutableStep; readonly frame: MutableToolFrame }
  >();
  private readonly watermarks: { readonly time: number; readonly cursor: number }[] = [];
  private readonly turnEnds = new Map<number, number>();
  private reliableTimes = true;
  private latestTime = 0;

  static async build(records: AsyncIterable<WireRecord>): Promise<AgentTurnProjection> {
    const projection = new AgentTurnProjection();
    await projection.rebuild(records);
    return projection;
  }

  private constructor() {}

  get cursor(): number {
    return this.nextSeq - 1;
  }

  cursorAt(time: number): number {
    let cursor = 0;
    for (const watermark of this.watermarks) {
      if (watermark.time > time) break;
      cursor = watermark.cursor;
    }
    return cursor;
  }

  cursorBefore(time: number): number {
    let cursor = 0;
    for (const watermark of this.watermarks) {
      if (watermark.time >= time) break;
      cursor = watermark.cursor;
    }
    return cursor;
  }

  cursorRange(startTime: number, endTime: number): { readonly start: number; readonly end: number } | undefined {
    if (
      !this.reliableTimes ||
      !Number.isFinite(startTime) ||
      !Number.isFinite(endTime) ||
      endTime < startTime
    ) {
      return undefined;
    }
    const start = this.cursorAt(startTime);
    const end = this.cursorBefore(endTime);
    return start <= end ? { start, end } : undefined;
  }

  hasTurnEnd(turnId: number): boolean {
    return this.turnEnds.has(turnId);
  }

  turnEndCursor(turnId: number): number {
    const cursor = this.turnEnds.get(turnId);
    if (cursor === undefined) throw new Error(`Turn ${turnId} has no completion record`);
    return cursor;
  }

  private async rebuild(records: AsyncIterable<WireRecord>): Promise<void> {
    for await (const record of records) {
      const before = this.cursor;
      this.replayRecord(record);
      if (this.cursor === before) continue;
      const time = record.time;
      if (typeof time !== 'number' || !Number.isFinite(time) || time < this.latestTime) {
        this.reliableTimes = false;
        continue;
      }
      this.latestTime = time;
      this.watermarks.push({ time, cursor: this.cursor });
    }
  }

  eventPage(
    dispatchId: string,
    start: number,
    end: number,
    cursor: number,
    limit: number,
  ): {
    readonly items: readonly ExternalTurnEventView[];
    readonly nextCursor?: number;
  } {
    const matches = this.events.filter(
      (event) => event.seq > Math.max(start, cursor) && event.seq <= end,
    );
    const items = matches.slice(0, limit).map((event) => ({ ...event, dispatchId }));
    return {
      items,
      nextCursor: matches.length > items.length ? items.at(-1)?.seq : undefined,
    };
  }

  itemPage(start: number, end: number, cursor: number, limit: number): {
    readonly items: readonly ExternalTranscriptL1Item[];
    readonly nextCursor?: number;
    readonly cursor: number;
  } {
    const matches = this.items.filter(
      (entry) => entry.seq > Math.max(start, cursor) && entry.seq <= end,
    );
    const page = matches.slice(0, limit);
    const hasMore = matches.length > page.length;
    const watermark = hasMore ? page.at(-1)!.seq : end;
    return {
      items: page.map((entry) => entry.item),
      nextCursor: hasMore ? watermark : undefined,
      cursor: watermark,
    };
  }

  private replayRecord(record: WireRecord): void {
    const time = record.time ?? 0;
    if (record.type === 'turn.prompt') {
      this.upsertTurn({
        ...record,
        type: 'turn.started',
        time,
        prompt: contentText(record['input']),
      });
      return;
    }
    if (record.type === 'context.append_loop_event') {
      const event = objectValue(record['event']);
      if (event === undefined) return;
      const type = readString(event, 'type');
      const turnId = turnNumber(event);
      if (type === 'step.begin') {
        this.upsertStep({ ...event, type: 'turn.step.started', time, turnId });
      } else if (type === 'step.end') {
        this.endStep({ ...event, type: 'turn.step.completed', time, turnId, usage: event['usage'] });
      } else if (type === 'content.part') {
        const part = objectValue(event['part']);
        if (part?.['type'] === 'text') {
          this.appendText({ ...event, type: 'assistant.delta', time, turnId, delta: part['text'] }, 'text');
        } else if (part?.['type'] === 'think') {
          this.appendText({ ...event, type: 'thinking.delta', time, turnId, delta: part['think'] }, 'thinking');
        }
      } else if (type === 'tool.call') {
        this.startTool({ ...event, type: 'tool.call.started', time, turnId });
      } else if (type === 'tool.result') {
        const result = objectValue(event['result']);
        this.updateTool({
          ...event,
          type: 'tool.result',
          time,
          output: result?.['output'],
          isError: result?.['isError'],
        }, true);
      }
      return;
    }
    this.record({ ...record, time });
  }

  private record(event: ProjectedEvent): void {
    switch (event.type) {
      case 'turn.started':
        this.upsertTurn(event);
        return;
      case 'turn.ended':
        this.endTurn(event);
        return;
      case 'turn.step.started':
        this.upsertStep(event);
        return;
      case 'turn.step.completed':
      case 'turn.step.interrupted':
        this.endStep(event);
        return;
      case 'assistant.delta':
        this.appendText(event, 'text');
        return;
      case 'thinking.delta':
        this.appendText(event, 'thinking');
        return;
      case 'tool.call.started':
        this.startTool(event);
        return;
      case 'tool.progress':
        this.updateTool(event, false);
        return;
      case 'tool.result':
        this.updateTool(event, true);
        return;
      case 'plan.revision':
        this.emit({
          type: 'plan.update',
          plan: {
            id: readString(event, 'id'),
            version: readNumber(event, 'version'),
            path: readString(event, 'path'),
            sha256: readString(event, 'sha256'),
            bytes: readNumber(event, 'bytes'),
          },
          unstable: false,
        }, event.time);
        return;
      case 'executor.plan.update':
        this.emit({ type: 'plan.update', plan: event['plan'], unstable: true }, event.time);
        return;
      case 'executor.plan.remove':
        this.emit({ type: 'plan.remove', planId: readString(event, 'planId'), unstable: true }, event.time);
        return;
      case 'executor.commands.update':
        this.emit({ type: 'commands.update', commands: readArray(event, 'commands') }, event.time);
        return;
      case 'executor.mode.update':
        this.emit({ type: 'mode.update', currentModeId: readString(event, 'currentModeId') ?? '' }, event.time);
        return;
      case 'executor.config.update':
        this.emit({ type: 'config.update', configOptions: readArray(event, 'configOptions') }, event.time);
        return;
      case 'executor.session.info':
        this.emit({ type: 'session.info', title: readString(event, 'title'), meta: event['meta'] }, event.time);
        return;
      case 'agent.status.updated': {
        const used = readNumber(event, 'contextTokens');
        const size = readNumber(event, 'maxContextTokens');
        if (used !== undefined && size !== undefined) {
          this.emit({ type: 'usage', used, size }, event.time);
        }
        return;
      }
      default:
        if (event.type.startsWith('transcript.')) {
          this.emit({ type: 'unknown', updateType: event.type }, event.time);
        }
    }
  }

  private upsertTurn(event: ProjectedEvent): void {
    const turnId = turnIdOf(event);
    const existing = this.turn(turnId);
    if (existing !== undefined) {
      existing.ordinal = readNumber(event, 'turnId') ?? existing.ordinal;
      existing.state = 'running';
      existing.origin = event['origin'] ?? existing.origin;
      existing.prompt = readString(event, 'prompt') ?? existing.prompt;
      existing.startedAt = iso(event.time);
      this.touchItem(turnId);
      return;
    }
    const turn: MutableTurn = {
      kind: 'turn',
      turnId,
      ordinal: readNumber(event, 'turnId') ?? 0,
      state: 'running',
      origin: event['origin'] ?? { kind: 'other' },
      prompt: readString(event, 'prompt'),
      steps: [],
      startedAt: iso(event.time),
    };
    this.turns.set(turnId, turn);
    this.putItem(turnId, turn);
  }

  private endTurn(event: ProjectedEvent): void {
    const turnId = turnIdOf(event);
    const turn = this.turn(turnId);
    if (turn === undefined) return;
    const reason = readString(event, 'reason');
    turn.state = reason === 'completed' ? 'completed' : reason === 'cancelled' ? 'cancelled' : 'failed';
    turn.endedAt = iso(event.time);
    this.touchItem(turnId);
    this.turnEnds.set(turnNumber(event), this.cursor);
  }

  private upsertStep(event: ProjectedEvent): void {
    const turnId = turnIdOf(event);
    const turn = this.turn(turnId);
    if (turn === undefined) return;
    const stepId = stepIdOf(event);
    const existing = this.steps.get(stepKey(turnId, stepId));
    if (existing !== undefined) {
      existing.ordinal = readNumber(event, 'step') ?? existing.ordinal;
      existing.state = 'running';
      existing.startedAt = iso(event.time);
      this.touchItem(turnId);
      return;
    }
    const step: MutableStep = {
      kind: 'step',
      stepId,
      turnId,
      ordinal: readNumber(event, 'step') ?? 0,
      state: 'running',
      frames: [],
      startedAt: iso(event.time),
    };
    turn.steps.push(step);
    this.steps.set(stepKey(turnId, stepId), step);
    this.touchItem(turnId);
  }

  private endStep(event: ProjectedEvent): void {
    const turnId = turnIdOf(event);
    const turn = this.turn(turnId);
    if (turn === undefined) return;
    const step = this.steps.get(stepKey(turnId, stepIdOf(event)));
    if (step === undefined) return;
    const usage = usageOf(event['usage']);
    step.state = event.type === 'turn.step.completed' ? 'completed' : 'interrupted';
    step.endedAt = iso(event.time);
    step.usage = usage ?? step.usage;
    this.touchItem(turnId);
    if (usage !== undefined) {
      this.emit({
        type: 'usage',
        used:
          usage.inputOther +
          usage.inputCacheRead +
          usage.inputCacheCreation +
          usage.output,
        size: 0,
      }, event.time);
    }
  }

  private appendText(event: ProjectedEvent, kind: 'text' | 'thinking'): void {
    const turnId = turnIdOf(event);
    const step = this.requireStep(turnId, event);
    if (step === undefined) return;
    const partId = readString(event, 'partId') ?? readString(event, 'uuid') ?? `${kind}-${step.frames.length}`;
    const frameId = `${step.stepId}.${partId}`;
    const delta = readString(event, 'delta') ?? '';
    const existing = this.frames.get(frameKey(turnId, frameId));
    const frame: MutableFrame = kind === 'text'
      ? {
          kind: 'text',
          frameId,
          role: 'assistant',
          text: `${existing?.kind === 'text' ? existing.text : ''}${delta}`,
        }
      : {
          kind: 'thinking',
          frameId,
          text: `${existing?.kind === 'thinking' ? existing.text : ''}${delta}`,
        };
    this.setFrame(turnId, step, frame);
    this.emit(
      kind === 'text'
        ? { type: 'message.delta', role: 'assistant', messageId: partId, content: { type: 'text', text: delta } }
        : { type: 'thought.delta', messageId: partId, content: { type: 'text', text: delta } },
      event.time,
    );
  }

  private startTool(event: ProjectedEvent): void {
    const turnId = turnIdOf(event);
    const turn = this.turn(turnId);
    const step = this.requireStep(turnId, event);
    if (turn === undefined || step === undefined) return;
    const toolCallId = readString(event, 'toolCallId') ?? '';
    const title = readString(event, 'description') ?? readString(event, 'name') ?? toolCallId;
    const frame: MutableToolFrame = {
      kind: 'tool',
      frameId: `${step.stepId}.${toolCallId}`,
      toolCallId,
      name: readString(event, 'name') ?? title,
      state: 'running',
      input: event['args'],
      display: event['display'],
      startedAt: iso(event.time),
    };
    this.setFrame(turnId, step, frame);
    this.tools.set(toolCallId, { turn, step, frame });
    this.emit({ type: 'tool.call', toolCallId, title, status: 'running', rawInput: event['args'] }, event.time);
  }

  private updateTool(event: ProjectedEvent, terminal: boolean): void {
    const toolCallId = readString(event, 'toolCallId') ?? '';
    const hit = this.tools.get(toolCallId);
    if (hit !== undefined) {
      const output = terminal ? event['output'] : event['update'];
      hit.frame.state = terminal ? (event['isError'] === true ? 'error' : 'done') : 'running';
      hit.frame.output = terminal ? output : hit.frame.output;
      hit.frame.progress = terminal ? hit.frame.progress : event['update'];
      hit.frame.endedAt = terminal ? iso(event.time) : hit.frame.endedAt;
      this.touchItem(hit.turn.turnId);
    }
    this.emit({
      type: 'tool.update',
      toolCallId,
      status: terminal ? (event['isError'] === true ? 'error' : 'done') : 'running',
      rawOutput: terminal ? event['output'] : event['update'],
    }, event.time);
  }

  private requireStep(turnId: string, event: ProjectedEvent): MutableStep | undefined {
    const turn = this.turn(turnId);
    if (turn === undefined) return undefined;
    const explicitStepId = readString(event, 'stepId');
    const existing = explicitStepId === undefined
      ? turn.steps.at(-1)
      : this.steps.get(stepKey(turnId, explicitStepId));
    if (existing !== undefined) return existing;
    const stepId = stepIdOf(event);
    const step: MutableStep = {
      kind: 'step',
      stepId,
      turnId,
      ordinal: readNumber(event, 'step') ?? turn.steps.length + 1,
      state: 'running',
      frames: [],
      startedAt: iso(event.time),
    };
    turn.steps.push(step);
    this.steps.set(stepKey(turnId, stepId), step);
    this.touchItem(turnId);
    return step;
  }

  private setFrame(turnId: string, step: MutableStep, frame: MutableFrame): void {
    const key = frameKey(turnId, frame.frameId);
    const existing = this.frameIndexes.get(key);
    if (existing === undefined) {
      this.frameIndexes.set(key, { step, index: step.frames.length });
      step.frames.push(frame);
    } else {
      existing.step.frames[existing.index] = frame;
    }
    this.frames.set(key, frame);
    this.touchItem(turnId);
  }

  private turn(turnId: string): MutableTurn | undefined {
    return this.turns.get(turnId);
  }

  private putItem(id: string, item: ExternalTranscriptL1Item): void {
    const existing = this.itemIndexes.get(id);
    const seq = this.nextSeq++;
    if (existing === undefined) {
      this.itemIndexes.set(id, this.items.length);
      this.items.push({ seq, item });
      return;
    }
    this.items[existing] = { seq, item };
  }

  private touchItem(id: string): void {
    const index = this.itemIndexes.get(id)!;
    this.items[index] = { seq: this.nextSeq++, item: this.items[index]!.item };
  }

  private emit(event: NormalizedExecutorEvent, at: number): void {
    this.events.push({ seq: this.nextSeq++, dispatchId: '', at, event });
  }
}

function turnIdOf(event: ProjectedEvent): string {
  return `t${turnNumber(event)}`;
}

function turnNumber(value: object): number {
  const field = (value as Record<string, unknown>)['turnId'];
  if (typeof field === 'number') return field;
  if (typeof field === 'string') {
    const parsed = Number(field.startsWith('t') ? field.slice(1) : field);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

function stepIdOf(event: ProjectedEvent): string {
  return readString(event, 'stepId') ?? `${turnIdOf(event)}.s${readNumber(event, 'step') ?? 0}`;
}

function stepKey(turnId: string, stepId: string): string {
  return `${turnId}\0${stepId}`;
}

function frameKey(turnId: string, frameId: string): string {
  return `${turnId}\0${frameId}`;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function contentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((part) => {
    const record = objectValue(part);
    return record?.['type'] === 'text' && typeof record['text'] === 'string'
      ? [record['text']]
      : [];
  }).join('');
  return text.length > 0 ? text : undefined;
}

function readString(value: object, key: string): string | undefined {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

function readNumber(value: object, key: string): number | undefined {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' ? field : undefined;
}

function readArray(value: object, key: string): readonly unknown[] {
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field) ? field : [];
}

function usageOf(value: unknown): ExternalTranscriptStep['usage'] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const inputOther = record['inputOther'];
  const output = record['output'];
  const inputCacheRead = record['inputCacheRead'];
  const inputCacheCreation = record['inputCacheCreation'];
  if (
    typeof inputOther !== 'number' ||
    typeof output !== 'number' ||
    typeof inputCacheRead !== 'number' ||
    typeof inputCacheCreation !== 'number'
  ) {
    return undefined;
  }
  return { inputOther, output, inputCacheRead, inputCacheCreation };
}
