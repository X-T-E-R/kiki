import type { PluginFocusIntent } from '@kiki/protocol';

export const PLUGIN_FOCUS_TTL_MS = 10_000;

export interface PluginFocusRequest {
  readonly id: number;
  readonly pluginId?: string;
  readonly sessionId: string;
  readonly at: number;
}

export interface PluginFocusServiceOptions {
  readonly now?: () => number;
}

export function pluginFocusRoute(sessionId: string): string | undefined {
  if (sessionId.length === 0) return undefined;
  const route = `/s/${encodeURIComponent(sessionId)}`;
  return /^\/s\/[^/?#]+$/.test(route) ? route : undefined;
}

export function pluginFocusIsActionable(request: PluginFocusRequest, seenId: number, nowMs: number, ttlMs = PLUGIN_FOCUS_TTL_MS): boolean {
  return request.id > seenId && nowMs - request.at < ttlMs;
}

export class PluginFocusService {
  private pending: { readonly intent: PluginFocusIntent; readonly at: number } | null = null;
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;

  constructor(options: PluginFocusServiceOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  seenRequestId(homeId: string): number {
    return this.seen.get(homeId) ?? 0;
  }

  remember(homeId: string, requestId: number): void {
    if (requestId > (this.seen.get(homeId) ?? 0)) this.seen.set(homeId, requestId);
  }

  store(intent: PluginFocusIntent, at?: number): void {
    this.pending = { intent, at: at ?? this.now() };
  }

  publish(homeId: string, request: PluginFocusRequest): PluginFocusIntent | undefined {
    const route = pluginFocusRoute(request.sessionId);
    if (route === undefined) return undefined;
    const intent: PluginFocusIntent = { homeId, route, requestId: request.id };
    this.store(intent, request.at);
    return intent;
  }

  read(homeId?: string): PluginFocusIntent | null {
    const pending = this.pending;
    if (pending === null) return null;
    if (this.now() - pending.at >= PLUGIN_FOCUS_TTL_MS) return null;
    const intent = pending.intent;
    if (homeId !== undefined && intent.homeId === homeId) return null;
    if (intent.requestId <= this.seenRequestId(intent.homeId)) return null;
    return intent;
  }

  acknowledge(homeId: string, requestId: number): boolean {
    const pending = this.pending;
    if (pending !== null && pending.intent.homeId === homeId && pending.intent.requestId === requestId) {
      this.pending = null;
      return true;
    }
    return false;
  }

  reset(): void {
    this.pending = null;
    this.seen.clear();
  }
}
