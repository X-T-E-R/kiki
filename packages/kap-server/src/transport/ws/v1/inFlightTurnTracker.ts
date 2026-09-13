import type { LoopRecordedEvent } from '@kiki/agent-core-v2';

import type { Event } from './events';
import type { InFlightToolCall, InFlightTurn } from '../../../protocol/rest-snapshot';

const MAIN_AGENT_ID = 'main';

interface ToolAccum {
  tool_call_id: string;
  name: string;
  args?: unknown;
  description?: string;
  display?: unknown;
  last_progress?: {
    kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
    text?: string;
    percent?: number;
  };
}

interface StepOwner {
  step?: number;
  stepId?: string;
}

interface TurnAccum {
  turnId: number;
  step: StepOwner | undefined;
  assistantText: string;
  thinkingText: string;
  assistantClosed: boolean;
  thinkingClosed: boolean;
  tools: Map<string, ToolAccum>;
}

export type DeltaDisposition = 'accepted' | 'rejected' | 'closed';

export interface VolatileAnnotation {
  offset?: number;
  disposition?: DeltaDisposition;
}

export class InFlightTurnTracker {
  private readonly bySession = new Map<string, TurnAccum>();

  apply(sessionId: string, event: Event): VolatileAnnotation {
    if (event.agentId !== MAIN_AGENT_ID) return {};

    switch (event.type) {
      case 'turn.started': {
        this.bySession.set(sessionId, {
          turnId: event.turnId,
          step: undefined,
          assistantText: '',
          thinkingText: '',
          assistantClosed: false,
          thinkingClosed: false,
          tools: new Map(),
        });
        return {};
      }
      case 'turn.ended': {
        this.bySession.delete(sessionId);
        return {};
      }
      case 'turn.step.started': {
        const turn = this.turn(sessionId, event.turnId);
        if (turn === undefined) return {};
        this.beginStep(turn, event.step, event.stepId);
        return {};
      }
      case 'assistant.delta': {
        const turn = this.turn(sessionId, event.turnId);
        if (turn === undefined || !this.acceptsDelta(turn, event.step, event.stepId)) {
          return { disposition: 'rejected' };
        }
        if (turn.assistantClosed) return { disposition: 'closed' };
        const offset = turn.assistantText.length;
        turn.assistantText += event.delta;
        return { disposition: 'accepted', offset };
      }
      case 'thinking.delta': {
        const turn = this.turn(sessionId, event.turnId);
        if (turn === undefined || !this.acceptsDelta(turn, event.step, event.stepId)) {
          return { disposition: 'rejected' };
        }
        if (turn.thinkingClosed) return { disposition: 'closed' };
        const offset = turn.thinkingText.length;
        turn.thinkingText += event.delta;
        return { disposition: 'accepted', offset };
      }
      case 'tool.call.started': {
        const turn = this.turn(sessionId, event.turnId);
        if (turn === undefined) return {};
        turn.tools.set(event.toolCallId, {
          tool_call_id: event.toolCallId,
          name: event.name,
          args: event.args,
          description: event.description,
          display: event.display,
        });
        return {};
      }
      case 'tool.progress': {
        const turn = this.bySession.get(sessionId);
        const tool = turn?.tools.get(event.toolCallId);
        if (tool === undefined) return {};
        const { kind, text, percent } = event.update;
        if (kind === 'custom') return {};
        tool.last_progress = { kind, text, percent };
        return {};
      }
      case 'tool.result': {
        this.bySession.get(sessionId)?.tools.delete(event.toolCallId);
        return {};
      }
      case 'context.append_loop_event': {
        this.applyLoopEvent(sessionId, event.event);
        return {};
      }
      default:
        return {};
    }
  }

  get(sessionId: string): InFlightTurn | null {
    const turn = this.bySession.get(sessionId);
    if (turn === undefined) return null;
    const running_tools: InFlightToolCall[] = Array.from(turn.tools.values()).map((tool) => ({
      tool_call_id: tool.tool_call_id,
      name: tool.name,
      args: tool.args,
      description: tool.description,
      display: tool.display,
      last_progress: tool.last_progress,
    }));
    return {
      turn_id: turn.turnId,
      step: turn.step?.step,
      step_id: turn.step?.stepId,
      assistant_text: turn.assistantText,
      thinking_text: turn.thinkingText,
      running_tools,
    };
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  private turn(sessionId: string, turnId: number): TurnAccum | undefined {
    const turn = this.bySession.get(sessionId);
    return turn?.turnId === turnId ? turn : undefined;
  }

  private beginStep(turn: TurnAccum, step: number | undefined, stepId: string | undefined): void {
    const owner = turn.step;
    const sameStepId = owner?.stepId !== undefined && stepId !== undefined && owner.stepId === stepId;
    const sameStepNumber =
      owner?.step !== undefined &&
      step !== undefined &&
      owner.step === step &&
      (owner.stepId === undefined || stepId === undefined);
    if (owner !== undefined && (sameStepId || sameStepNumber)) {
      owner.step ??= step;
      owner.stepId ??= stepId;
      return;
    }
    turn.step = { step, stepId };
    turn.assistantText = '';
    turn.thinkingText = '';
    turn.assistantClosed = false;
    turn.thinkingClosed = false;
  }

  private acceptsDelta(
    turn: TurnAccum,
    step: number | undefined,
    stepId: string | undefined,
  ): boolean {
    const owner = turn.step;
    if (owner === undefined) {
      turn.step = { step, stepId };
      return true;
    }
    if (owner.stepId !== undefined && stepId !== undefined && owner.stepId !== stepId) return false;
    if (owner.step !== undefined && step !== undefined && owner.step !== step) return false;
    owner.step ??= step;
    owner.stepId ??= stepId;
    return true;
  }

  private applyLoopEvent(sessionId: string, event: LoopRecordedEvent): void {
    switch (event.type) {
      case 'step.begin': {
        const turnId = parseTurnId(event.turnId);
        if (turnId === undefined) return;
        const turn = this.turn(sessionId, turnId);
        if (turn === undefined) return;
        if (turn.step?.stepId !== event.uuid) this.beginStep(turn, event.step, event.uuid);
        return;
      }
      case 'content.part': {
        const turn = this.bySession.get(sessionId);
        if (turn === undefined || turn.step?.stepId !== event.stepUuid) return;
        if (event.turnId !== undefined) {
          const turnId = parseTurnId(event.turnId);
          if (turnId === undefined || turn.turnId !== turnId) return;
        }
        if (event.part.type === 'text') {
          turn.assistantText = '';
          turn.assistantClosed = true;
        }
        if (event.part.type === 'think') {
          turn.thinkingText = '';
          turn.thinkingClosed = true;
        }
        return;
      }
      case 'tool.call': {
        const turnId = parseTurnId(event.turnId);
        if (turnId === undefined) return;
        const turn = this.turn(sessionId, turnId);
        if (turn === undefined) return;
        const existing = turn.tools.get(event.toolCallId);
        if (existing === undefined) {
          turn.tools.set(event.toolCallId, {
            tool_call_id: event.toolCallId,
            name: event.name,
            args: event.args,
          });
        } else {
          existing.name = event.name;
          existing.args ??= event.args;
        }
        return;
      }
      case 'tool.result': {
        this.bySession.get(sessionId)?.tools.delete(event.toolCallId);
        return;
      }
      case 'step.end':
        return;
    }
  }
}

function parseTurnId(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0 || value.trim() !== value) return undefined;
  const turnId = Number(value);
  return Number.isSafeInteger(turnId) && turnId >= 0 ? turnId : undefined;
}
