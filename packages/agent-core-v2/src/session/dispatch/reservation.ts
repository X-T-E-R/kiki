export interface CommittedReservation<T> {
  readonly fingerprint: string;
  readonly result: T;
}

export type ReservationResult<T> =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'replay'; readonly result: T }
  | {
      readonly kind: 'reserved';
      commit(result: T): CommittedReservation<T>;
      release(): void;
    };

export class KeyReservationRegistry<T> {
  private readonly pending = new Map<string, string>();

  reserve(
    key: string,
    fingerprint: string,
    committed: CommittedReservation<T> | undefined,
    replayCommitted: boolean,
  ): ReservationResult<T> {
    if (committed !== undefined) {
      if (replayCommitted && committed.fingerprint === fingerprint) {
        return { kind: 'replay', result: committed.result };
      }
      return { kind: 'conflict' };
    }
    if (this.pending.has(key)) return { kind: 'conflict' };
    this.pending.set(key, fingerprint);
    let settled = false;
    return {
      kind: 'reserved',
      commit: (result) => {
        if (!settled) {
          settled = true;
          this.pending.delete(key);
        }
        return { fingerprint, result };
      },
      release: () => {
        if (!settled) {
          settled = true;
          this.pending.delete(key);
        }
      },
    };
  }
}
