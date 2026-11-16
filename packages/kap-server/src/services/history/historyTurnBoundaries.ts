import { NavigationWireAdapter } from '@kiki/transcript/navigationWireAdapter';
import { historyNavigationProof, matchesNavigationProof, type HistoryNavigationProof } from './historyNavigationProof';
import { streamLogicalWireRecords } from './logicalWireRead';
import { historyNavigationRecord } from './historyWirePrefilter';

export interface HistoryTurnBoundary {
  readonly turn: number;
  readonly start: number;
  readonly end: number;
}

export interface HistoryTurnBoundaries {
  readonly proof: HistoryNavigationProof;
  readonly watermark: number;
  readonly turns: readonly HistoryTurnBoundary[];
  readonly bytesRead: number;
  readonly recordsRead: number;
}

export async function discoverHistoryTurnBoundaries(path: string, agent: string, watermark: number,
  signal?: AbortSignal): Promise<HistoryTurnBoundaries | undefined> {
  const proof = await historyNavigationProof(path, watermark, signal);
  const turns = new Map<number, { start: number; end: number }>();
  const invalid = new Set<number>();
  const adapter = new NavigationWireAdapter(agent);
  let current: number | undefined;
  const read = await streamLogicalWireRecords(path, {
    endByteOffset: watermark, chunkBytes: 1 << 20, maxLineBytes: 32 << 20, signal, decodeRecord: historyNavigationRecord,
    onRecord(record, span) {
      const effects = adapter.add(record);
      if (record['type'] === 'turn.prompt') {
        if (current !== undefined) {
          const previous = turns.get(current);
          if (previous !== undefined) previous.end = span.startByteOffset;
        }
        const turn = record['turnId'];
        current = typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 ? turn : undefined;
        if (current !== undefined) {
          if (turns.has(current)) invalid.add(current);
          else turns.set(current, { start: span.startByteOffset, end: watermark });
        }
      }
      for (const effect of effects) {
        if (effect.op === 'visibility.reset') {
          for (const turn of effect.turns) turns.delete(turn);
          if (effect.retain !== undefined) invalid.add(effect.retain.turn);
        } else {
          const turn = Number((effect.op === 'turn.upsert' ? effect.turn.turnId : effect.turnId).slice(1));
          if (turn !== current) invalid.add(turn);
        }
      }
    },
  });
  if (!read.complete || read.nextByteOffset !== watermark) return undefined;
  const after = await historyNavigationProof(path, watermark, signal);
  if (!matchesNavigationProof(proof, after)) throw new Error('history_source_changed');
  return { proof, watermark, turns: [...turns].filter(([turn]) => !invalid.has(turn))
    .map(([turn, range]) => ({ turn, ...range })), bytesRead: read.bytesRead, recordsRead: read.recordCount };
}
