import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { HostSubscribeIntent } from '#/shared/types';

const MAX_SUBSCRIBE_URL_CHARS = 2048;
const MAX_SUBSCRIBE_NAME_CHARS = 128;
const MAX_QUEUE_SIZE = 32;

export interface ParsedSubscribeIntent {
  readonly url: string;
  readonly name?: string;
  readonly mode?: 'auto' | 'manual' | 'once';
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' || lower === '[::1]';
}

function sanitizeSubscribeName(raw: string): string | undefined {
  const collapsed = raw
    .replaceAll(/[\u0000-\u001F\u007F]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  if (collapsed === '') return undefined;
  return collapsed.slice(0, MAX_SUBSCRIBE_NAME_CHARS);
}

function parseTargetUrl(raw: string, allowLoopback: boolean): string {
  const trimmed = raw.trim();
  if (trimmed === '' || /[\u0000-\u001F\u007F]/.test(trimmed)) {
    throw new Error('Invalid subscription target URL');
  }
  const parsed = URL.parse(trimmed);
  if (parsed === null) {
    throw new Error('Invalid subscription target URL');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Subscription target URL must not include credentials');
  }
  if (parsed.protocol === 'https:') {
    if (parsed.hostname === '') throw new Error('Subscription target URL requires a host');
  } else if (parsed.protocol === 'http:') {
    if (!allowLoopback || !isLoopbackHost(parsed.hostname)) {
      throw new Error('Subscription target URL must use https');
    }
  } else {
    throw new Error('Subscription target URL must use https');
  }
  const serialized = parsed.href;
  if (serialized.length > MAX_SUBSCRIBE_URL_CHARS) {
    throw new Error('Subscription target URL exceeds maximum length');
  }
  return serialized;
}

export function parseSubscribeIntent(
  raw: string,
  options?: { readonly allowLoopback?: boolean },
): ParsedSubscribeIntent | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = URL.parse(trimmed);
  if (parsed === null || parsed.protocol.toLowerCase() !== 'kiki:') return null;
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Subscribe deep link must not include userinfo');
  }
  if (parsed.port !== '') {
    throw new Error('Subscribe deep link must not include a port');
  }
  if (parsed.hash !== '') {
    throw new Error('Subscribe deep link must not include a fragment');
  }

  const hostForm =
    parsed.hostname.toLowerCase() === 'subscribe' &&
    (parsed.pathname === '' || parsed.pathname === '/');
  const pathForm =
    parsed.hostname === '' && parsed.pathname.toLowerCase() === '/subscribe';
  if (!hostForm && !pathForm) {
    throw new Error('Unsupported kiki:// subscribe route');
  }

  const urlParams = parsed.searchParams.getAll('url');
  if (urlParams.length === 0) throw new Error('Missing url parameter in subscribe deep link');
  if (urlParams.length > 1) throw new Error('Duplicate url parameter in subscribe deep link');

  const nameParams = parsed.searchParams.getAll('name');
  if (nameParams.length > 1) throw new Error('Duplicate name parameter in subscribe deep link');

  const modeParams = parsed.searchParams.getAll('mode');
  if (modeParams.length > 1) throw new Error('Duplicate mode parameter in subscribe deep link');

  const allowLoopback =
    options?.allowLoopback ?? process.env['KIKI_ALLOW_LOOPBACK_SUBSCRIBE_URLS'] === '1';
  const targetUrl = parseTargetUrl(urlParams[0] ?? '', allowLoopback);
  const name = nameParams[0] !== undefined ? sanitizeSubscribeName(nameParams[0]) : undefined;
  const rawMode = modeParams[0]?.trim().toLowerCase();
  const mode =
    rawMode === 'auto' || rawMode === 'manual' || rawMode === 'once' ? rawMode : undefined;

  return {
    url: targetUrl,
    name,
    mode,
  };
}

export function extractSubscribeIntentsFromArgs(
  args: readonly string[],
  options?: { readonly allowLoopback?: boolean },
): ParsedSubscribeIntent[] {
  const intents: ParsedSubscribeIntent[] = [];
  for (const arg of args.slice(1)) {
    try {
      const parsed = parseSubscribeIntent(arg, options);
      if (parsed !== null) intents.push(parsed);
    } catch {
      continue;
    }
  }
  return intents;
}

export class SubscribeIntentQueue extends EventEmitter {
  private readonly items: HostSubscribeIntent[] = [];

  enqueue(parsed: ParsedSubscribeIntent): HostSubscribeIntent {
    if (this.items.length >= MAX_QUEUE_SIZE) {
      throw new Error('Subscribe intent queue is full');
    }
    const intent: HostSubscribeIntent = {
      id: randomUUID(),
      url: parsed.url,
      name: parsed.name,
      mode: parsed.mode,
    };
    this.items.push(intent);
    this.emit('intent', intent);
    return intent;
  }

  peek(): HostSubscribeIntent | null {
    return this.items[0] ?? null;
  }

  ack(id: string): boolean {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }

  size(): number {
    return this.items.length;
  }

  onIntent(listener: (intent: HostSubscribeIntent) => void): () => void {
    this.on('intent', listener);
    return () => {
      this.off('intent', listener);
    };
  }
}
