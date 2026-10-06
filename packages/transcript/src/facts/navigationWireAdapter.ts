import { bundledSkillActivations, isUndoAnchorOrigin, isVisibleLegacyTurnOrigin } from './wireIdentity';
import { MemoryNavigationAnchorSequence, MemoryNavigationTurnSequence,
  type NavigationAnchor, type NavigationAnchorSequence, type NavigationTurnSequence } from './navigationSequence';
import type { TranscriptWireRecord } from './wireAdapter';

/** A source-backed navigation effect. Text fields live only for the current wire record. */
export type NavigationEffect =
  | { readonly op: 'turn.upsert'; readonly turn: { readonly turnId: string; readonly ordinal: number;
      readonly state: 'running' | 'completed'; readonly startedAt?: string; readonly prompt?: string;
      readonly selector?: string } }
  | { readonly op: 'step.upsert'; readonly turnId: string; readonly step: { readonly stepId: string;
      readonly ordinal: number; readonly state: 'running' | 'completed'; readonly startedAt?: string } }
  | { readonly op: 'frame.upsert'; readonly turnId: string; readonly stepId: string; readonly stepOrdinal: number;
      readonly frame: { readonly kind: 'text' | 'tool' | 'record'; readonly frameId: string;
        readonly role?: 'assistant'; readonly text?: string; readonly input?: unknown;
        readonly output?: unknown; readonly name?: string; readonly selector?: string;
        readonly recordId?: string; readonly recordKind?: 'note' | 'user_excerpt' | 'assistant_excerpt' | 'handoff';
        readonly title?: string; readonly relatedOperationIds?: readonly string[] } }
  | { readonly op: 'visibility.reset'; readonly turns: readonly number[];
      readonly sequenceRange?: readonly [number, number];
      readonly retain?: { readonly turn: number; readonly beforeOrdinal: number } };

type Step = { turnId: string; ordinal: number; sourceOrdinal: number };
type Tool = { turnId: string; stepId: string; stepOrdinal: number;
  frameId: string; name: string; sourceOrdinal: number };

type Anchor = NavigationAnchor;

/** Scalar identity tables may be disk-backed; the default adapter keeps test fixtures in memory. */
export interface NavigationScalarState {
  readonly turns?: NavigationTurnSequence;
  readonly anchors?: NavigationAnchorSequence;
  /** Disk state can purge a removed suffix without enumerating every turn in JavaScript. */
  purgeRemovedTurns?(range: readonly [number, number]): void;
  readonly canonicalTurns: Set<string>;
  readonly turnStart: Map<string, number>;
  readonly turnStates: Map<string, 'running' | 'completed'>;
  readonly steps: Map<string, Step>;
  readonly currentStep: Map<string, string>;
  readonly tools: Map<string, Tool>;
  readonly deliveries: Map<string, Anchor>;
  readonly steeredMessageIds: Set<string>;
  readonly unpairedSteerCredits: Map<string, number>;
}

const objectOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const stringOf = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const numberOf = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
const turnOf = (value: unknown): string | undefined => {
  const id = stringOf(value);
  if (id !== undefined && /^\d+$/u.test(id)) return `t${id}`;
  const number = numberOf(value);
  return number === undefined ? undefined : `t${number}`;
};
const textOf = (parts: unknown): string => Array.isArray(parts)
  ? parts.map((part) => { const item = objectOf(part); return item?.['type'] === 'text' ? stringOf(item['text']) ?? '' : ''; }).join('')
  : '';
export const openingText = (parts: unknown, origin: unknown): string => Array.isArray(parts)
  ? textOf(parts.slice(bundledSkillActivations(origin).length)) : '';
const promptText = (parts: unknown, origin: unknown): string | undefined => openingText(parts, origin) || undefined;
const stamp = (time: unknown): string | undefined => typeof time === 'number' ? new Date(time).toISOString() : undefined;
const outputOf = (value: unknown): string => typeof value === 'string' ? value : textOf(value);

export interface NavigationAdapterCursor {
  readonly ordinal: number;
  readonly legacyTurn: number;
  readonly currentTurn?: string;
  readonly currentPrompt?: string;
}

/** Unlike the canonical replay adapter, this projection never retains message or tool bodies. */
export class NavigationWireAdapter {
  private readonly turns: NavigationTurnSequence;
  private readonly canonicalTurns: Set<string>;
  private readonly turnStart: Map<string, number>;
  private readonly turnStates: Map<string, 'running' | 'completed'>;
  private readonly steps: Map<string, Step>;
  private readonly currentStep: Map<string, string>;
  private readonly tools: Map<string, Tool>;
  private readonly deliveries: Map<string, Anchor>;
  private readonly steeredMessageIds: Set<string>;
  private readonly unpairedSteerCredits: Map<string, number>;
  private readonly anchors: NavigationAnchorSequence;
  private readonly purgeRemovedTurns: NavigationScalarState['purgeRemovedTurns'];
  private currentTurn: string | undefined;
  private currentPrompt: string | undefined;
  private legacyTurn = 0;
  private ordinal = 0;
  /** Long-lived body character count (kept for the memory gate). */
  readonly retainedBodyChars = 0;

  constructor(readonly agentId: string, state: Partial<NavigationScalarState> = {}) {
    this.turns = state.turns ?? new MemoryNavigationTurnSequence();
    this.anchors = state.anchors ?? new MemoryNavigationAnchorSequence();
    this.purgeRemovedTurns = state.purgeRemovedTurns;
    this.canonicalTurns = state.canonicalTurns ?? new Set<string>();
    this.turnStart = state.turnStart ?? new Map<string, number>();
    this.turnStates = state.turnStates ?? new Map<string, 'running' | 'completed'>();
    this.steps = state.steps ?? new Map<string, Step>();
    this.currentStep = state.currentStep ?? new Map<string, string>();
    this.tools = state.tools ?? new Map<string, Tool>();
    this.deliveries = state.deliveries ?? new Map<string, Anchor>();
    this.steeredMessageIds = state.steeredMessageIds ?? new Set<string>();
    this.unpairedSteerCredits = state.unpairedSteerCredits ?? new Map<string, number>();
  }

  checkpoint(): NavigationAdapterCursor {
    return { ordinal: this.ordinal, legacyTurn: this.legacyTurn,
      currentTurn: this.currentTurn, currentPrompt: this.currentPrompt };
  }

  restore(cursor: NavigationAdapterCursor): void {
    if (!Number.isSafeInteger(cursor.ordinal) || cursor.ordinal < 0 ||
        !Number.isSafeInteger(cursor.legacyTurn) || cursor.legacyTurn < 0) throw new Error('invalid_navigation_cursor');
    this.ordinal = cursor.ordinal;
    this.legacyTurn = cursor.legacyTurn;
    this.currentTurn = cursor.currentTurn;
    this.currentPrompt = cursor.currentPrompt;
  }

  add(record: TranscriptWireRecord): NavigationEffect[] {
    const ordinal = this.ordinal++;
    if (record.type === 'external.activity') {
      const turnNumber = numberOf(record['turnId']);
      const phase = stringOf(record['phase']);
      if (turnNumber === undefined || (phase !== 'started' && phase !== 'completed' && phase !== 'failed' && phase !== 'cancelled')) return [];
      const turnId = `t${turnNumber}`;
      this.track(turnId, ordinal);
      this.canonicalTurns.add(turnId);
      this.currentTurn = turnId;
      this.currentPrompt = undefined;
      this.turnStates.set(turnId, phase === 'started' ? 'running' : 'completed');
      return [{ op: 'turn.upsert', turn: {
        turnId,
        ordinal: turnNumber,
        state: phase === 'started' ? 'running' : 'completed',
        startedAt: stamp(record.time),
      } }];
    }
    if (record.type === 'external.text') {
      const turnNumber = numberOf(record['turnId']);
      const recordId = stringOf(record['recordId']);
      const text = stringOf(record['text']);
      const kind = record['kind'];
      if (turnNumber === undefined || recordId === undefined || text === undefined ||
          (kind !== 'note' && kind !== 'user_excerpt' && kind !== 'assistant_excerpt' && kind !== 'handoff')) return [];
      const turnId = `t${turnNumber}`;
      this.track(turnId, ordinal);
      this.canonicalTurns.add(turnId);
      this.currentTurn = turnId;
      this.turnStates.set(turnId, this.turnStates.get(turnId) ?? 'running');
      const stepId = this.currentStep.get(turnId) ?? `${turnId}.external-record`;
      const step = this.steps.get(stepId);
      const stepOrdinal = step?.ordinal ?? 1;
      const effects: NavigationEffect[] = [];
      if (step === undefined) {
        this.steps.set(stepId, { turnId, ordinal: stepOrdinal, sourceOrdinal: ordinal });
        this.currentStep.set(turnId, stepId);
        effects.push({ op: 'step.upsert', turnId, step: {
          stepId, ordinal: stepOrdinal, state: 'completed', startedAt: stamp(record.time),
        } });
      }
      effects.push({ op: 'frame.upsert', turnId, stepId, stepOrdinal,
        frame: {
          kind: 'record',
          frameId: `external-text:${recordId}`,
          text,
          selector: 'external.text',
          recordId,
          recordKind: kind,
          title: stringOf(record['title']),
          relatedOperationIds: Array.isArray(record['relatedOperationIds'])
            ? record['relatedOperationIds'].filter((value): value is string => typeof value === 'string')
            : undefined,
        } });
      return effects;
    }
    if (record.type === 'turn.prompt') {
      const n = numberOf(record['turnId']) ?? this.legacyTurn++;
      this.legacyTurn = Math.max(this.legacyTurn, n + 1);
      const id = `t${n}`;
      const promptId = stringOf(record['promptId']) ?? stringOf(record['messageId']);
      this.track(id, ordinal);
      this.canonicalTurns.add(id);
      this.turnStates.set(id, 'running');
      this.currentTurn = id;
      this.currentPrompt = promptId;
      const headerOnly = record['managed'] === true || promptId !== undefined && this.deliveries.has(promptId);
      if (!headerOnly && isUndoAnchorOrigin(record['origin'])) this.anchors.push({ turnId: id, ordinal });
      return [{ op: 'turn.upsert', turn: { turnId: id, ordinal: n, state: 'running',
        startedAt: stamp(record.time), prompt: headerOnly ? undefined : promptText(record['input'], record['origin']),
        selector: 'input' } }];
    }
    if (record.type === 'turn.ended') {
      const id = turnOf(record['turnId']);
      if (id === undefined || !this.turnStart.has(id)) return [];
      this.turnStates.set(id, 'completed');
      return [{ op: 'turn.upsert', turn: { turnId: id, ordinal: Number(id.slice(1)), state: 'completed' } }];
    }
    if (record.type === 'turn.steer') {
      if (record['managed'] === true) return [];
      const turnId = turnOf(record['turnId']) ?? this.currentTurn;
      if (turnId === undefined || textOf(record['input']).length === 0 &&
          !(Array.isArray(record['input']) && record['input'].some((item: unknown) =>
            ['image', 'video', 'audio', 'image_url', 'video_url', 'audio_url']
              .includes(stringOf(objectOf(item)?.['type']) ?? '')))) return [];
      const promptId = stringOf(record['promptId']);
      if (promptId !== undefined) this.steeredMessageIds.add(promptId);
      else {
        const kind = stringOf(objectOf(record['origin'])?.['kind']) ?? 'user';
        const key = `${turnId}\0${kind}`;
        this.unpairedSteerCredits.set(key, (this.unpairedSteerCredits.get(key) ?? 0) + 1);
      }
      return [];
    }
    if (record.type === 'context.clear') return this.reset(0);
    if (record.type === 'context.undo') {
      const count = numberOf(record['count']) ?? 1;
      if (count <= 0) return [];
      const target = this.anchors.nthFromLast(count);
      if (target === undefined) return [];
      const cut = target.turnId === undefined ? this.turns.findFromOrdinal(target.ordinal)
        : this.turns.indexOf(target.turnId);
      if (target.messageId !== undefined && target.turnId !== undefined && cut >= 0) {
        const removed = this.reset(cut + 1);
        for (const [id, step] of this.steps) {
          if (step.turnId === target.turnId && step.sourceOrdinal >= target.ordinal) this.steps.delete(id);
        }
        for (const [id, tool] of this.tools) {
          if (tool.turnId === target.turnId && tool.sourceOrdinal >= target.ordinal) this.tools.delete(id);
        }
        this.currentTurn = target.turnId;
        this.currentStep.delete(target.turnId);
        let earlier: [string, Step] | undefined;
        for (const [id, step] of this.steps) {
          if (step.turnId === target.turnId &&
              (earlier === undefined || step.sourceOrdinal >= earlier[1].sourceOrdinal)) earlier = [id, step];
        }
        if (earlier !== undefined) this.currentStep.set(target.turnId, earlier[0]);
        this.anchors.discardFromOrdinal(target.ordinal);
        for (const [id, delivery] of this.deliveries) if (delivery.ordinal >= target.ordinal) this.deliveries.delete(id);
        const reset = removed[0]?.op === 'visibility.reset' ? removed[0] : undefined;
        return [{ op: 'visibility.reset', turns: reset?.turns ?? [], sequenceRange: reset?.sequenceRange,
          retain: { turn: Number(target.turnId.slice(1)), beforeOrdinal: target.ordinal } }];
      }
      return this.reset(cut < 0 ? this.turns.length : cut);
    }
    if (record.type === 'context.append_message') return this.message(record, ordinal);
    if (record.type !== 'context.append_loop_event') return [];
    const event = objectOf(record['event']);
    if (event === undefined) return [];
    const type = event['type'];
    if (type === 'step.begin') {
      const turnId = turnOf(event['turnId']) ?? this.currentTurn;
      if (turnId === undefined) return [];
      const stepId = stringOf(event['uuid']) ?? `legacy:v1:r${ordinal}:step`;
      const step = numberOf(event['step']) ?? 1;
      this.steps.set(stepId, { turnId, ordinal: step, sourceOrdinal: ordinal });
      this.currentStep.set(turnId, stepId);
      const previousState = this.turnStates.get(turnId);
      this.track(turnId, ordinal);
      this.turnStates.set(turnId, 'running');
      const effects: NavigationEffect[] = previousState === undefined || previousState !== 'running'
        ? [{ op: 'turn.upsert', turn: { turnId, ordinal: Number(turnId.slice(1)), state: 'running' } }]
        : [];
      effects.push({ op: 'step.upsert', turnId, step: {
        stepId, ordinal: step, state: 'running', startedAt: stamp(record.time) } });
      return effects;
    }
    if (type === 'step.end') {
      const stepId = stringOf(event['uuid']);
      const step = stepId === undefined ? undefined : this.steps.get(stepId);
      const turnId = turnOf(event['turnId']) ?? step?.turnId;
      if (stepId === undefined || turnId === undefined) return [];
      const effects: NavigationEffect[] = [{ op: 'step.upsert', turnId, step: {
        stepId, ordinal: numberOf(event['step']) ?? step?.ordinal ?? 1, state: 'completed' } }];
      if (!this.canonicalTurns.has(turnId)) {
        this.turnStates.set(turnId, 'completed');
        effects.push({ op: 'turn.upsert', turn: {
          turnId, ordinal: Number(turnId.slice(1)), state: 'completed' } });
      }
      return effects;
    }
    if (type === 'content.part') {
      const stepId = stringOf(event['stepUuid']);
      const turnId = turnOf(event['turnId']) ?? (stepId === undefined ? undefined : this.steps.get(stepId)?.turnId);
      const part = objectOf(event['part']);
      const step = stepId === undefined ? undefined : this.steps.get(stepId);
      if (stepId === undefined || turnId === undefined || step === undefined || part?.['type'] !== 'text') return [];
      return [{ op: 'frame.upsert', turnId, stepId, stepOrdinal: step.ordinal, frame: { kind: 'text', role: 'assistant',
        frameId: stringOf(event['uuid']) ?? `legacy:v1:r${ordinal}:part0`, text: stringOf(part['text']) ?? '',
        selector: 'event.part.text' } }];
    }
    if (type === 'tool.call') {
      const callId = stringOf(event['toolCallId']);
      const stepId = stringOf(event['stepUuid']);
      const turnId = turnOf(event['turnId']) ?? (stepId === undefined ? undefined : this.steps.get(stepId)?.turnId);
      const step = stepId === undefined ? undefined : this.steps.get(stepId);
      if (callId === undefined || stepId === undefined || turnId === undefined || step === undefined) return [];
      const hit = { turnId, stepId, stepOrdinal: step.ordinal, frameId: `${stepId}.${callId}`,
        name: stringOf(event['name']) ?? '', sourceOrdinal: ordinal };
      this.tools.set(callId, hit);
      return [{ op: 'frame.upsert', turnId, stepId, stepOrdinal: step.ordinal, frame: { kind: 'tool', frameId: hit.frameId,
        name: hit.name, input: event['args'], selector: 'event.args' } }];
    }
    if (type === 'tool.result') return this.toolResult(event, 'event.result.output');
    return [];
  }

  private message(record: TranscriptWireRecord, ordinal: number): NavigationEffect[] {
    const message = objectOf(record['message']);
    const role = message?.['role'];
    if (message === undefined) return [];
    if (role === 'tool') {
      const callId = stringOf(message['toolCallId']);
      return callId === undefined ? [] : this.toolResult({ toolCallId: callId,
        result: { output: textOf(message['content']) } }, 'message.content');
    }
    if (role === 'assistant') {
      const id = this.currentTurn;
      if (id === undefined) return [];
      const stepId = this.currentStep.get(id) ?? `legacy:v1:r${ordinal}:step`;
      const step = this.steps.get(stepId);
      if (step === undefined) { this.steps.set(stepId, { turnId: id, ordinal: 1, sourceOrdinal: ordinal }); this.currentStep.set(id, stepId); }
      const effects: NavigationEffect[] = [{ op: 'step.upsert', turnId: id, step: {
        stepId, ordinal: step?.ordinal ?? 1, state: 'completed' } }];
      const content = Array.isArray(message['content']) ? message['content'] : [];
      for (const [index, item] of content.entries()) {
        const part = objectOf(item);
        if (part?.['type'] !== 'text') continue;
        effects.push({ op: 'frame.upsert', turnId: id, stepId, stepOrdinal: step?.ordinal ?? 1,
          frame: { kind: 'text', role: 'assistant',
          frameId: `legacy:v1:r${ordinal}:part${index}`, text: stringOf(part['text']) ?? '',
          selector: `message.content.${index}` } });
      }
      for (const [index, item] of (Array.isArray(message['toolCalls']) ? message['toolCalls'] : []).entries()) {
        const call = objectOf(item);
        const callId = stringOf(call?.['id']);
        if (callId === undefined) continue;
        const hit = { turnId: id, stepId, stepOrdinal: step?.ordinal ?? 1,
          frameId: `${stepId}.${callId}`, name: stringOf(call?.['name']) ?? '', sourceOrdinal: ordinal };
        this.tools.set(callId, hit);
        let args: unknown;
        try { args = JSON.parse(stringOf(call?.['arguments']) ?? 'null') as unknown; }
        catch { args = call?.['arguments']; }
        effects.push({ op: 'frame.upsert', turnId: id, stepId, stepOrdinal: hit.stepOrdinal,
          frame: { kind: 'tool', frameId: hit.frameId,
          name: hit.name, input: args, selector: `message.toolCalls.${index}.arguments` } });
      }
      this.turnStates.set(id, 'completed');
      effects.push({ op: 'turn.upsert', turn: { turnId: id, ordinal: Number(id.slice(1)), state: 'completed' } });
      return effects;
    }
    if (role !== 'user') return [];
    const messageId = stringOf(message['id']) ?? `legacy:v1:r${ordinal}:message`;
    const origin = objectOf(message['origin']);
    const canonical = objectOf(record['delivery']);
    if (this.deliveries.has(messageId) || canonical === undefined && messageId === this.currentPrompt ||
        this.steeredMessageIds.has(messageId)) return [];
    if (canonical === undefined && this.currentTurn !== undefined && isVisibleLegacyTurnOrigin(this.agentId, origin)) {
      const kind = stringOf(origin?.['kind']) ?? 'user';
      const key = `${this.currentTurn}\0${kind}`;
      const count = this.unpairedSteerCredits.get(key) ?? 0;
      if (count > 0) {
        this.unpairedSteerCredits.set(key, count - 1);
        this.steeredMessageIds.add(messageId);
        return [];
      }
    }
    if (canonical !== undefined || origin?.['kind'] === 'agent_message' || origin?.['kind'] === 'injection' ||
        this.canonicalTurns.size > 0 && isVisibleLegacyTurnOrigin(this.agentId, origin)) {
      const turnId = turnOf(canonical?.['turnId']) ?? this.currentTurn;
      this.deliveries.set(messageId, { ordinal, turnId, messageId });
      if (turnId !== undefined && messageId === this.currentPrompt) {
        if (isUndoAnchorOrigin(message['origin']) && !this.anchors.hasTurn(turnId)) {
          this.anchors.push({ ordinal: this.turnStart.get(turnId) ?? ordinal, turnId });
        }
        return [{ op: 'turn.upsert', turn: { turnId, ordinal: Number(turnId.slice(1)),
          state: this.turnStates.get(turnId) ?? 'running', prompt: promptText(message['content'], message['origin']), selector: 'message.content' } }];
      }
      if (isUndoAnchorOrigin(message['origin'])) this.anchors.push({ ordinal, turnId, messageId });
      if (turnId === undefined) return [];
      const stepId = stringOf(canonical?.['stepId']) ?? this.currentStep.get(turnId) ?? `${turnId}.delivery`;
      const step = numberOf(canonical?.['step']) ?? this.steps.get(stepId)?.ordinal ?? 0;
      if (this.steps.has(stepId)) return [];
      this.steps.set(stepId, { turnId, ordinal: step, sourceOrdinal: ordinal });
      return [{ op: 'step.upsert', turnId, step: { stepId, ordinal: step,
        state: canonical?.['stepId'] === undefined ? 'completed' : 'running' } }];
    }
    const n = this.legacyTurn++;
    if (!isVisibleLegacyTurnOrigin(this.agentId, origin)) return [];
    const id = `t${n}`;
    this.track(id, ordinal);
    this.turnStates.set(id, 'running');
    this.currentTurn = id;
    this.currentPrompt = messageId;
    if (isUndoAnchorOrigin(message['origin'])) this.anchors.push({ ordinal, turnId: id });
    return [{ op: 'turn.upsert', turn: { turnId: id, ordinal: n, state: 'running',
      startedAt: stamp(record.time), prompt: promptText(message['content'], message['origin']), selector: 'message.content' } }];
  }

  private toolResult(event: Record<string, unknown>, selector: string): NavigationEffect[] {
    const callId = stringOf(event['toolCallId']);
    const hit = callId === undefined ? undefined : this.tools.get(callId);
    if (hit === undefined) return [];
    return [{ op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, stepOrdinal: hit.stepOrdinal,
      frame: {
      kind: 'tool', frameId: hit.frameId, name: hit.name,
      output: outputOf(objectOf(event['result'])?.['output']), selector } }];
  }

  private track(id: string, ordinal: number): void {
    if (!this.turnStart.has(id)) { this.turnStart.set(id, ordinal); this.turns.push(id, ordinal); }
  }

  private reset(start: number): NavigationEffect[] {
    if (start >= this.turns.length) {
      if (start === 0) {
        this.anchors.discardFromOrdinal(0);
        this.deliveries.clear();
        this.currentTurn = undefined;
        this.currentPrompt = undefined;
      }
      return [];
    }
    const removed = this.turns.removeFrom(start);
    if (removed.sequenceRange !== undefined && this.purgeRemovedTurns !== undefined) {
      this.purgeRemovedTurns(removed.sequenceRange);
    } else {
      for (const id of removed.ids ?? []) {
        this.turnStart.delete(id);
        this.turnStates.delete(id);
        this.canonicalTurns.delete(id);
        this.currentStep.delete(id);
        for (const key of this.unpairedSteerCredits.keys()) {
          if (key.startsWith(`${id}\0`)) this.unpairedSteerCredits.delete(key);
        }
        for (const [stepId, step] of this.steps) if (step.turnId === id) this.steps.delete(stepId);
        for (const [callId, tool] of this.tools) if (tool.turnId === id) this.tools.delete(callId);
      }
    }
    this.anchors.discardRemovedTurns(removed.sequenceRange, removed.ids);
    if (start === 0) {
      this.anchors.discardFromOrdinal(0);
      this.deliveries.clear();
    }
    this.currentTurn = this.turns.at(-1);
    this.currentPrompt = undefined;
    return [{ op: 'visibility.reset', turns: (removed.ids ?? []).map((id) => Number(id.slice(1))),
      sequenceRange: removed.sequenceRange }];
  }
}
