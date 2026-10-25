export type OlderLoadResult =
  | { kind: 'advanced'; changed: true }
  | { kind: 'preparing' | 'exhausted'; changed: boolean }
  | { kind: 'failed' | 'cancelled'; changed: false };

interface OlderFlight {
  controller: AbortController;
  consumers: Set<symbol>;
  promise: Promise<OlderLoadResult>;
}

export class OlderLoadCoordinator {
  private readonly flights = new Map<string, OlderFlight>();

  constructor(private readonly onCancel: (agentId: string) => void) {}

  request(agentId: string, run: (signal: AbortSignal) => Promise<OlderLoadResult>, signal?: AbortSignal): Promise<OlderLoadResult> {
    if (signal?.aborted) return Promise.resolve({ kind: 'cancelled', changed: false });
    let flight = this.flights.get(agentId);
    if (flight === undefined) {
      const controller = new AbortController();
      flight = { controller, consumers: new Set(), promise: Promise.resolve({ kind: 'cancelled', changed: false }) };
      this.flights.set(agentId, flight);
      const created = flight;
      created.promise = run(controller.signal).finally(() => {
        if (this.flights.get(agentId) === created) this.flights.delete(agentId);
      });
    }
    const shared = flight;
    const consumer = Symbol();
    shared.consumers.add(consumer);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: OlderLoadResult) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        shared.consumers.delete(consumer);
        if (result.kind === 'cancelled' && shared.consumers.size === 0 && this.flights.get(agentId) === shared) this.cancel(agentId);
        resolve(result);
      };
      const abort = () => { finish({ kind: 'cancelled', changed: false }); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      void shared.promise.then(finish, () => { finish({ kind: 'failed', changed: false }); });
    });
  }

  cancel(agentId: string): void {
    const flight = this.flights.get(agentId);
    this.flights.delete(agentId);
    flight?.controller.abort();
    if (flight !== undefined) this.onCancel(agentId);
  }

  cancelAll(): void {
    for (const agentId of this.flights.keys()) this.cancel(agentId);
  }
}
