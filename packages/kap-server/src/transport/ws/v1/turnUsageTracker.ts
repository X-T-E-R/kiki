/** Per-agent step-usage fold that enriches the terminal turn frame. */

import type { Event2 } from '@kiki/agent-core-v2';
import type { TurnStepCompleted } from '@kiki/agent-core-v2/agent/loop/turnEvents';
import type { TurnEnded } from '@kiki/agent-core-v2/agent/loop/turnOps';
import type { TokenUsage } from '@kiki/agent-core-v2/kosong/contract/usage';

export interface TurnUsageSummary {
  readonly usage: TokenUsage;
  readonly tokensPerSecond?: number;
}

interface TurnUsageAccum {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
  streamDurationMs: number;
}

export class TurnUsageTracker {
  private readonly turns = new Map<number, TurnUsageAccum>();

  apply(event: Event2<any>): TurnUsageSummary | undefined {
    if (event.type === 'turn.started') {
      this.turns.clear();
      return undefined;
    }
    if (event.type === 'turn.step.completed') {
      const step = event as TurnStepCompleted;
      if (step.usage === undefined) return undefined;
      const turn = this.turns.get(step.turnId) ?? {
        inputOther: 0,
        output: 0,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        streamDurationMs: 0,
      };
      turn.inputOther += step.usage.inputOther;
      turn.output += step.usage.output;
      turn.inputCacheRead += step.usage.inputCacheRead;
      turn.inputCacheCreation += step.usage.inputCacheCreation;
      if (step.llmStreamDurationMs !== undefined && step.llmStreamDurationMs > 0) {
        turn.streamDurationMs += step.llmStreamDurationMs;
      }
      this.turns.set(step.turnId, turn);
      return undefined;
    }
    if (event.type !== 'turn.ended') return undefined;
    const ended = event as TurnEnded;
    const turn = this.turns.get(ended.turnId);
    this.turns.delete(ended.turnId);
    if (turn === undefined) return undefined;
    const durationMs = turn.streamDurationMs > 0 ? turn.streamDurationMs : ended.durationMs;
    return {
      usage: {
        inputOther: turn.inputOther,
        output: turn.output,
        inputCacheRead: turn.inputCacheRead,
        inputCacheCreation: turn.inputCacheCreation,
      },
      tokensPerSecond:
        durationMs !== undefined && durationMs > 0
          ? turn.output / (durationMs / 1000)
          : undefined,
    };
  }
}
