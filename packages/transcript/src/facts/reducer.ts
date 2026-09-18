import type { AppliedOps, TranscriptOperation } from '../ops/operation';

export interface TranscriptFact {
  readonly factId: string;
  readonly durability: 'durable' | 'transient';
  readonly operations: readonly TranscriptOperation[];
}

export interface TranscriptFactTarget {
  apply(operations: readonly TranscriptOperation[]): AppliedOps;
}

export interface TranscriptFactResult {
  readonly acceptedFacts: readonly TranscriptFact[];
  readonly acceptedOperations: readonly TranscriptOperation[];
  readonly changedIds: ReadonlySet<string>;
  readonly gap?: AppliedOps['gap'];
}

export class TranscriptFactReducer {
  readonly #acceptedDurableFacts = new Set<string>();

  constructor(readonly transcript: TranscriptFactTarget) {}

  checkpoint(): readonly string[] {
    return [...this.#acceptedDurableFacts];
  }

  restore(factIds: readonly string[]): void {
    this.#acceptedDurableFacts.clear();
    for (const factId of factIds) this.#acceptedDurableFacts.add(factId);
  }

  apply(facts: readonly TranscriptFact[]): TranscriptFactResult {
    const acceptedFacts: TranscriptFact[] = [];
    const acceptedOperations: TranscriptOperation[] = [];
    const changedIds = new Set<string>();
    let gap: TranscriptFactResult['gap'];
    for (const fact of facts) {
      if (fact.durability === 'durable' && this.#acceptedDurableFacts.has(fact.factId)) continue;
      const result = this.transcript.apply(fact.operations);
      if (fact.durability === 'durable') this.#acceptedDurableFacts.add(fact.factId);
      if (result.gap !== undefined) gap = result.gap;
      if (result.accepted.length === 0) continue;
      acceptedFacts.push(fact);
      acceptedOperations.push(...result.accepted);
      for (const operation of result.accepted) collectChangedIds(operation, changedIds);
    }
    return { acceptedFacts, acceptedOperations, changedIds, gap };
  }
}

function collectChangedIds(operation: TranscriptOperation, changed: Set<string>): void {
  switch (operation.op) {
    case 'reset':
      changed.add(operation.agentId);
      return;
    case 'turn.upsert':
      changed.add(operation.turn.turnId);
      return;
    case 'step.upsert':
      changed.add(operation.step.stepId);
      return;
    case 'frame.upsert':
      changed.add(operation.frame.frameId);
      return;
    case 'tool.count.set':
      changed.add('toolCallCount');
      return;
    case 'append':
      changed.add(operation.target.type === 'frame' ? operation.target.frameId : operation.target.taskId);
      return;
    case 'marker.upsert':
      changed.add(operation.item.markerId);
      return;
    case 'taskref.upsert':
      changed.add(operation.item.refId);
      return;
    case 'task.upsert':
      changed.add(operation.task.taskId);
      return;
    case 'interaction.upsert':
      changed.add(operation.interaction.interactionId);
      return;
    case 'attachment.upsert':
      changed.add(operation.attachment.attachmentId);
      return;
    case 'todo.upsert':
      changed.add(operation.todo.todoId);
      return;
    case 'prompt.upsert':
      changed.add(operation.prompt.promptId);
      return;
    case 'meta.merge':
      changed.add('meta');
      return;
    case 'items.remove':
      for (const id of operation.ids) changed.add(id);
  }
}
