import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { IConfigService, ISessionManager, type IDisposable, type Scope } from '@kiki/agent-core-v2';
import { z } from 'zod';
import { SESSION_ACCESS_SECTION, type SessionAccessConfig } from './configSection';

export const sessionAccessScopesSchema = z.array(z.enum(['read', 'prompt', 'abort'])).min(1);
export const sessionAccessClientSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[\x20-\x7e]+$/),
  version: z.string().max(32).optional(),
}).strict();
export type SessionAccessScope = z.infer<typeof sessionAccessScopesSchema>[number];
export type SessionAccessClient = z.infer<typeof sessionAccessClientSchema>;
export interface SessionAccessToken {
  readonly id: string;
  readonly digest: string;
  readonly session_id: string;
  readonly scopes: SessionAccessScope[];
  readonly client: SessionAccessClient;
  readonly channel: 'owner' | 'terminal';
  readonly holder_id?: string;
  readonly issued_at: number;
  readonly expires_at: number;
}

export class SessionAccessStore {
  private readonly tokens = new Map<string, SessionAccessToken>();
  private readonly closers = new Map<string, Set<() => void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners: IDisposable[] = [];

  constructor(private readonly core: Scope, readonly now: () => number = Date.now) {
    this.listeners.push(core.accessor.get(IConfigService).onDidSectionChange(({ domain }) => {
      if (domain === SESSION_ACCESS_SECTION && !this.config().enabled) this.revokeAll();
    }));
    const deleted = core.accessor.get(ISessionManager).onDidDeleteSession;
    if (deleted !== undefined) this.listeners.push(deleted(({ sessionId }) => this.revokeWhere((token) => token.session_id === sessionId)));
  }

  config(): SessionAccessConfig {
    return this.core.accessor.get(IConfigService).get<SessionAccessConfig>(SESSION_ACCESS_SECTION);
  }

  issue(input: { session_id: string; scopes: SessionAccessScope[]; client: SessionAccessClient; channel: SessionAccessToken['channel']; holder_id?: string; ttl_seconds: number }): { token: string; record: SessionAccessToken } {
    const token = `ksa_${randomBytes(32).toString('base64url')}`;
    const issued_at = this.now();
    const record: SessionAccessToken = {
      id: `sat_${ulid()}`, digest: digest(token), session_id: input.session_id,
      scopes: [...new Set(input.scopes)], client: input.client, channel: input.channel,
      holder_id: input.holder_id, issued_at, expires_at: issued_at + input.ttl_seconds * 1000,
    };
    this.tokens.set(record.digest, record);
    this.scheduleExpiry(record);
    return { token, record };
  }

  lookup(secret: string): SessionAccessToken | undefined {
    const token = this.tokens.get(digest(secret));
    if (token !== undefined && token.expires_at <= this.now()) { this.revoke(token.id); return undefined; }
    return token;
  }

  list(): Array<Omit<SessionAccessToken, 'digest' | 'holder_id'>> {
    this.revokeWhere((token) => token.expires_at <= this.now());
    return [...this.tokens.values()].map(({ id, session_id, scopes, client, channel, issued_at, expires_at }) => ({ id, session_id, scopes, client, channel, issued_at, expires_at }));
  }

  attach(token: SessionAccessToken, close: () => void): () => void {
    if (!this.tokens.has(token.digest)) { close(); return () => {}; }
    let closers = this.closers.get(token.id);
    if (closers === undefined) { closers = new Set(); this.closers.set(token.id, closers); }
    closers.add(close);
    return () => { closers.delete(close); if (closers.size === 0) this.closers.delete(token.id); };
  }

  revoke(id: string): number { return this.revokeWhere((token) => token.id === id); }
  revokeAll(): number { return this.revokeWhere(() => true); }
  revokeWhere(matches: (token: SessionAccessToken) => boolean): number {
    let revoked = 0;
    for (const token of this.tokens.values()) {
      if (!matches(token)) continue;
      this.tokens.delete(token.digest);
      clearTimeout(this.timers.get(token.id)); this.timers.delete(token.id);
      const closers = this.closers.get(token.id); this.closers.delete(token.id);
      for (const close of closers ?? []) close();
      revoked += 1;
    }
    return revoked;
  }

  close(): void {
    for (const listener of this.listeners) listener.dispose();
    this.revokeAll();
  }

  private scheduleExpiry(token: SessionAccessToken): void {
    const timer = setTimeout(() => {
      if (token.expires_at <= this.now()) this.revoke(token.id);
      else this.scheduleExpiry(token);
    }, token.expires_at - this.now());
    timer.unref();
    this.timers.set(token.id, timer);
  }
}

export function digest(secret: string): string { return createHash('sha256').update(secret).digest('hex'); }
