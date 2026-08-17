/** Per-agent step-usage fold that enriches the terminal turn frame. */

import type { DomainEvent } from '@moonshot-ai/agent-core-v2';
import type { TokenUsage } from '@moonshot-ai/agent-core-v2/kosong/contract/usage';

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

  apply(event: DomainEvent): TurnUsageSummary | undefined {
    if (event.type === 'turn.started') {
      this.turns.clear();
      return undefined;
    }
    if (event.type === 'turn.step.completed') {
      if (event.usage === undefined) return undefined;
      const turn = this.turns.get(event.turnId) ?? {
        inputOther: 0,
        output: 0,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        streamDurationMs: 0,
      };
      turn.inputOther += event.usage.inputOther;
      turn.output += event.usage.output;
      turn.inputCacheRead += event.usage.inputCacheRead;
      turn.inputCacheCreation += event.usage.inputCacheCreation;
      if (event.llmStreamDurationMs !== undefined && event.llmStreamDurationMs > 0) {
        turn.streamDurationMs += event.llmStreamDurationMs;
      }
      this.turns.set(event.turnId, turn);
      return undefined;
    }
    if (event.type !== 'turn.ended') return undefined;
    const turn = this.turns.get(event.turnId);
    this.turns.delete(event.turnId);
    if (turn === undefined) return undefined;
    const durationMs = turn.streamDurationMs > 0 ? turn.streamDurationMs : event.durationMs;
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
