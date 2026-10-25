import { randomUUID } from 'node:crypto';
import { createOneBotWsTransport } from '@nb-im/core';

type OneBotTransport = ReturnType<typeof createOneBotWsTransport>;
export type OneBotIdentityLink = Awaited<ReturnType<OneBotTransport['connect']>>;

export interface OneBotIdentitySource {
  readonly transport: OneBotTransport;
  readonly ready: Promise<void>;
  readonly accountId: string | undefined;
}

export function oneBotIdentityTransport(base: OneBotTransport = createOneBotWsTransport()): OneBotIdentitySource {
  let accountId: string | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => undefined);
  const identify = (value: unknown) => {
    const id = typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
    if (!/^[1-9]\d{0,19}$/u.test(id)) return;
    accountId = id;
    resolveReady();
  };
  const observe = (link: OneBotIdentityLink, signal: AbortSignal) => {
    const echo = `kiki-listener:${randomUUID()}`;
    link.onFrame((frame) => {
      if (typeof frame !== 'object' || frame === null) return;
      const value = frame as Record<string, unknown>;
      if (value['echo'] === echo && value['status'] === 'ok' && value['retcode'] === 0 && typeof value['data'] === 'object' && value['data'] !== null) identify((value['data'] as Record<string, unknown>)['user_id']);
      if (value['post_type'] === 'message' || value['post_type'] === 'meta_event') identify(value['self_id']);
    });
    const abort = () => rejectReady(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    link.onClose(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
    else if (link.role !== 'event') link.send({ action: 'get_login_info', params: {}, echo });
    return link;
  };
  const transport: OneBotTransport = {
    connect: async (input) => observe(await base.connect(input), input.signal),
    listen: (input) => {
      const abort = () => rejectReady(input.signal.reason);
      input.signal.addEventListener('abort', abort, { once: true });
      if (input.signal.aborted) abort();
      return base.listen({ ...input, authorize: (headers, url) => {
        const allowed = input.authorize(headers, url);
        if (allowed) identify(headers['x-self-id']);
        return allowed;
      }, accept: (link) => input.accept(observe(link, input.signal)) });
    },
    download: base.download?.bind(base),
  };
  return { transport, ready, get accountId() { return accountId; } };
}
