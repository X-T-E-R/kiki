export async function joinDeliveries(pending: readonly Promise<unknown>[], timeoutMs = 1000): Promise<void> {
  if (pending.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.allSettled(pending), new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
