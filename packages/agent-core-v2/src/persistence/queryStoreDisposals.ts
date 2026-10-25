const pendingDisposals = new Set<Promise<void>>();

export function trackQueryStoreDisposal(pending: Promise<void>): void {
  pendingDisposals.add(pending);
  void pending.finally(() => pendingDisposals.delete(pending)).catch(() => undefined);
}

export async function drainQueryStoreDisposals(): Promise<void> {
  await Promise.all(pendingDisposals);
}
