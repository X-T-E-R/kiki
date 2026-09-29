export type NavigationAnchor = { ordinal: number; turnId?: string; messageId?: string };

/** Ordered identities remain queryable after a suffix is hidden for a range visibility effect. */
export interface NavigationTurnSequence {
  readonly length: number;
  push(id: string, startOrdinal: number): void;
  at(index: -1): string | undefined;
  indexOf(id: string): number;
  findFromOrdinal(ordinal: number): number;
  removeFrom(index: number): { readonly ids?: readonly string[]; readonly sequenceRange?: readonly [number, number] };
}

export interface NavigationAnchorSequence {
  push(anchor: NavigationAnchor): void;
  nthFromLast(count: number): NavigationAnchor | undefined;
  hasTurn(turnId: string): boolean;
  discardFromOrdinal(ordinal: number): void;
  discardRemovedTurns(range: readonly [number, number] | undefined, removedIds: readonly string[] | undefined): void;
}

export class MemoryNavigationTurnSequence implements NavigationTurnSequence {
  private readonly items: Array<{ id: string; startOrdinal: number }> = [];
  get length(): number { return this.items.length; }
  push(id: string, startOrdinal: number): void { this.items.push({ id, startOrdinal }); }
  at(index: -1): string | undefined { return this.items.at(index)?.id; }
  indexOf(id: string): number { return this.items.findIndex((item) => item.id === id); }
  findFromOrdinal(ordinal: number): number {
    return this.items.findIndex((item) => item.startOrdinal >= ordinal);
  }
  removeFrom(index: number): { ids: readonly string[] } {
    return { ids: this.items.splice(index).map((item) => item.id) };
  }
}

export class MemoryNavigationAnchorSequence implements NavigationAnchorSequence {
  private readonly items: NavigationAnchor[] = [];
  push(anchor: NavigationAnchor): void { this.items.push(anchor); }
  nthFromLast(count: number): NavigationAnchor | undefined {
    return this.items.toSorted((a, b) => b.ordinal - a.ordinal)[count - 1];
  }
  hasTurn(turnId: string): boolean { return this.items.some((anchor) => anchor.turnId === turnId); }
  discardFromOrdinal(ordinal: number): void {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i]!.ordinal >= ordinal) this.items.splice(i, 1);
    }
  }
  discardRemovedTurns(_range: readonly [number, number] | undefined, removedIds: readonly string[] | undefined): void {
    if (removedIds === undefined) return;
    const removed = new Set(removedIds);
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i]?.turnId !== undefined && removed.has(this.items[i]!.turnId!)) this.items.splice(i, 1);
    }
  }
}
