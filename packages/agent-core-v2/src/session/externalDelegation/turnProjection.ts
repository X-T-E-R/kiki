import type { IEventBus } from '#/app/event/eventBus';
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

export class DispatchTurnProjection {
  private nextSeq = 1;
  private readonly events: ExternalTurnEventView[] = [];
  private readonly items: SequencedItem[] = [];
  private readonly subscription: { dispose(): void };

  constructor(
    private readonly dispatchId: string,
    bus: IEventBus,
  ) {
    this.subscription = bus.subscribe((event) => this.record(event as unknown as ProjectedEvent));
  }

  get cursor(): number {
    return this.nextSeq - 1;
  }

  dispose(): void {
    this.subscription.dispose();
  }

  async replay(records: AsyncIterable<WireRecord>): Promise<void> {
    for await (const record of records) this.replayRecord(record);
  }

  eventPage(cursor: number, limit: number): {
    readonly items: readonly ExternalTurnEventView[];
    readonly nextCursor?: number;
  } {
    const matches = this.events.filter((event) => event.seq > cursor);
    const items = matches.slice(0, limit);
    return {
      items,
      nextCursor: matches.length > items.length ? items.at(-1)?.seq : undefined,
    };
  }

  itemPage(cursor: number, limit: number): {
    readonly items: readonly ExternalTranscriptL1Item[];
    readonly nextCursor?: number;
  } {
    const matches = this.items.filter((entry) => entry.seq > cursor);
    const page = matches.slice(0, limit);
    return {
      items: page.map((entry) => entry.item),
      nextCursor: matches.length > page.length ? page.at(-1)?.seq : undefined,
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
    const turn: ExternalTranscriptTurn = {
      kind: 'turn',
      turnId,
      ordinal: readNumber(event, 'turnId') ?? existing?.ordinal ?? 0,
      state: 'running',
      origin: event['origin'] ?? existing?.origin ?? { kind: 'other' },
      prompt: readString(event, 'prompt') ?? existing?.prompt,
      steps: existing?.steps ?? [],
      startedAt: iso(event.time),
      endedAt: existing?.endedAt,
      usage: existing?.usage,
    };
    this.putItem(turnId, turn);
  }

  private endTurn(event: ProjectedEvent): void {
    const turnId = turnIdOf(event);
    const existing = this.turn(turnId);
    if (existing === undefined) return;
    const reason = readString(event, 'reason');
    this.putItem(turnId, {
      ...existing,
      state:
        reason === 'completed'
          ? 'completed'
          : reason === 'cancelled'
            ? 'cancelled'
            : 'failed',
      endedAt: iso(event.time),
    });
  }

  private upsertStep(event: ProjectedEvent): void {
    const turnId = turnIdOf(event);
    const turn = this.turn(turnId);
    if (turn === undefined) return;
    const stepId = stepIdOf(event);
    const existing = turn.steps.find((step) => step.stepId === stepId);
    const step: ExternalTranscriptStep = {
      kind: 'step',
      stepId,
      turnId,
      ordinal: readNumber(event, 'step') ?? existing?.ordinal ?? 0,
      state: 'running',
      frames: existing?.frames ?? [],
      startedAt: iso(event.time),
      endedAt: existing?.endedAt,
      usage: existing?.usage,
    };
    this.putItem(turnId, { ...turn, steps: replaceStep(turn.steps, step) });
  }

  private endStep(event: ProjectedEvent): void {
    const turnId = turnIdOf(event);
    const turn = this.turn(turnId);
    if (turn === undefined) return;
    const stepId = stepIdOf(event);
    const existing = turn.steps.find((step) => step.stepId === stepId);
    if (existing === undefined) return;
    const usage = usageOf(event['usage']);
    const step: ExternalTranscriptStep = {
      ...existing,
      state: event.type === 'turn.step.completed' ? 'completed' : 'interrupted',
      endedAt: iso(event.time),
      usage: usage ?? existing.usage,
    };
    this.putItem(turnId, { ...turn, steps: replaceStep(turn.steps, step) });
  }

  private appendText(event: ProjectedEvent, kind: 'text' | 'thinking'): void {
    const turnId = turnIdOf(event);
    const step = this.requireStep(turnId, event);
    if (step === undefined) return;
    const partId = readString(event, 'partId') ?? `${kind}-${step.frames.length}`;
    const frameId = `${step.stepId}.${partId}`;
    const delta = readString(event, 'delta') ?? '';
    const frame = step.frames.find((candidate) => candidate.frameId === frameId);
    const nextFrame = kind === 'text'
      ? {
          kind: 'text' as const,
          frameId,
          role: 'assistant' as const,
          text: `${frame?.kind === 'text' ? frame.text : ''}${delta}`,
        }
      : {
          kind: 'thinking' as const,
          frameId,
          text: `${frame?.kind === 'thinking' ? frame.text : ''}${delta}`,
        };
    this.replaceFrame(turnId, step, nextFrame);
    this.emit(
      kind === 'text'
        ? { type: 'message.delta', role: 'assistant', messageId: partId, content: { type: 'text', text: delta } }
        : { type: 'thought.delta', messageId: partId, content: { type: 'text', text: delta } },
      event.time,
    );
  }

  private startTool(event: ProjectedEvent): void {
    const turnId = turnIdOf(event);
    const step = this.requireStep(turnId, event);
    if (step === undefined) return;
    const toolCallId = readString(event, 'toolCallId') ?? '';
    const title = readString(event, 'description') ?? readString(event, 'name') ?? toolCallId;
    this.replaceFrame(turnId, step, {
      kind: 'tool',
      frameId: `${step.stepId}.${toolCallId}`,
      toolCallId,
      name: readString(event, 'name') ?? title,
      state: 'running',
      input: event['args'],
      display: event['display'],
      startedAt: iso(event.time),
    });
    this.emit({ type: 'tool.call', toolCallId, title, status: 'running', rawInput: event['args'] }, event.time);
  }

  private updateTool(event: ProjectedEvent, terminal: boolean): void {
    const toolCallId = readString(event, 'toolCallId') ?? '';
    const hit = this.tool(toolCallId);
    if (hit !== undefined) {
      const output = terminal ? event['output'] : event['update'];
      this.replaceFrame(hit.turn.turnId, hit.step, {
        ...hit.frame,
        state: terminal ? (event['isError'] === true ? 'error' : 'done') : 'running',
        output: terminal ? output : hit.frame.output,
        progress: terminal ? hit.frame.progress : event['update'],
        endedAt: terminal ? iso(event.time) : hit.frame.endedAt,
      });
    }
    this.emit({
      type: 'tool.update',
      toolCallId,
      status: terminal ? (event['isError'] === true ? 'error' : 'done') : 'running',
      rawOutput: terminal ? event['output'] : event['update'],
    }, event.time);
  }

  private requireStep(turnId: string, event: ProjectedEvent): ExternalTranscriptStep | undefined {
    const turn = this.turn(turnId);
    if (turn === undefined) return undefined;
    const explicitStepId = readString(event, 'stepId');
    let step = explicitStepId === undefined
      ? turn.steps.at(-1)
      : turn.steps.find((candidate) => candidate.stepId === explicitStepId);
    if (step !== undefined) return step;
    const stepId = stepIdOf(event);
    step = {
      kind: 'step',
      stepId,
      turnId,
      ordinal: readNumber(event, 'step') ?? turn.steps.length + 1,
      state: 'running',
      frames: [],
      startedAt: iso(event.time),
    };
    this.putItem(turnId, { ...turn, steps: [...turn.steps, step] });
    return step;
  }

  private replaceFrame(
    turnId: string,
    step: ExternalTranscriptStep,
    frame: ExternalTranscriptStep['frames'][number],
  ): void {
    const turn = this.turn(turnId);
    if (turn === undefined) return;
    const nextStep = {
      ...step,
      frames: replaceBy(step.frames, frame, (candidate) => candidate.frameId),
    };
    this.putItem(turnId, { ...turn, steps: replaceStep(turn.steps, nextStep) });
  }

  private turn(turnId: string): ExternalTranscriptTurn | undefined {
    const entry = this.items.find((candidate) => itemId(candidate.item) === turnId);
    return entry?.item.kind === 'turn' ? entry.item : undefined;
  }

  private tool(toolCallId: string): {
    readonly turn: ExternalTranscriptTurn;
    readonly step: ExternalTranscriptStep;
    readonly frame: Extract<ExternalTranscriptStep['frames'][number], { readonly kind: 'tool' }>;
  } | undefined {
    for (const entry of this.items) {
      if (entry.item.kind !== 'turn') continue;
      for (const step of entry.item.steps) {
        const frame = step.frames.find(
          (candidate): candidate is Extract<typeof candidate, { readonly kind: 'tool' }> =>
            candidate.kind === 'tool' && candidate.toolCallId === toolCallId,
        );
        if (frame !== undefined) return { turn: entry.item, step, frame };
      }
    }
    return undefined;
  }

  private putItem(id: string, item: ExternalTranscriptL1Item): void {
    const existing = this.items.findIndex((entry) => itemId(entry.item) === id);
    const seq = this.nextSeq++;
    if (existing === -1) {
      this.items.push({ seq, item });
      return;
    }
    this.items[existing] = { seq, item };
  }

  private emit(event: NormalizedExecutorEvent, at: number): void {
    this.events.push({ seq: this.nextSeq++, dispatchId: this.dispatchId, at, event });
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

function iso(value: number): string {
  return new Date(value).toISOString();
}

function itemId(item: ExternalTranscriptL1Item): string {
  return item.kind === 'turn' ? item.turnId : item.kind === 'marker' ? item.markerId : item.refId;
}

function replaceStep(
  steps: readonly ExternalTranscriptStep[],
  step: ExternalTranscriptStep,
): readonly ExternalTranscriptStep[] {
  return replaceBy(steps, step, (candidate) => candidate.stepId);
}

function replaceBy<T>(items: readonly T[], item: T, key: (value: T) => string): readonly T[] {
  const id = key(item);
  const index = items.findIndex((candidate) => key(candidate) === id);
  if (index === -1) return [...items, item];
  return items.map((candidate, candidateIndex) => candidateIndex === index ? item : candidate);
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
