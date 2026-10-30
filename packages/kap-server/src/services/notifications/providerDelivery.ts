import type { Provider, ProviderContext, SendResult } from '@nb-im/core';

const SEND_DEADLINE_MS = 60_000;

export function sendProvider(provider: Provider, context: ProviderContext, signal: AbortSignal): Promise<SendResult> {
  const deadline = Math.min(Date.parse(context.expires_at), Date.now() + SEND_DEADLINE_MS);
  return new Promise<SendResult>((resolve) => {
    let finished = false;
    let dispatched = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: SendResult): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const interrupt = (expired: boolean): void => settle({
      status: dispatched ? 'unknown' : 'failed', message_ids: [], retryable: false,
      error_kind: dispatched ? 'unknown' : 'configuration',
      diagnostic_code: dispatched ? 'send_outcome_unknown' : expired ? 'delivery_expired' : 'dispatch_stale',
    });
    const onAbort = (): void => interrupt(false);
    const canDispatch = (): 'ready' | 'expired' | 'stale' => {
      if (finished || signal.aborted) return 'stale';
      if (Date.now() >= deadline) return 'expired';
      return context.canDispatch();
    };
    const beginDispatch = (): 'ready' | 'expired' | 'stale' => {
      const state = canDispatch();
      if (state !== 'ready') return state;
      const granted = context.beginDispatch();
      if (granted === 'ready') dispatched = true;
      return granted;
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted || Date.now() >= deadline) {
      interrupt(!signal.aborted);
      return;
    }
    timer = setTimeout(() => interrupt(true), Math.max(0, deadline - Date.now()));
    void Promise.resolve().then(() => {
      if (finished) return undefined;
      return provider.send({ ...context, expires_at: new Date(deadline).toISOString(), canDispatch, beginDispatch,
        resolveCredential: (slot) => {
          if (canDispatch() !== 'ready') throw new Error('credential_scope_violation');
          return context.resolveCredential(slot);
        },
      });
    }).then((result) => {
      if (result !== undefined) settle(result);
    }, () => settle({ status: 'unknown', message_ids: [], retryable: false,
      error_kind: 'unknown', diagnostic_code: 'send_outcome_unknown' }));
  });
}
