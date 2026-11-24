import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import {
  IAtomicDocumentStore,
  IConfigService,
  ISessionManager,
  type IDisposable,
  type Scope,
} from '@kiki/agent-core-v2';
import { z } from 'zod';
import { SESSION_ACCESS_SECTION, type SessionAccessConfig } from './configSection';

const PERSISTED_SCOPE = 'server';
const PERSISTED_KEY = 'session-access-tokens.json';

export const sessionAccessScopesSchema = z.array(z.enum(['read', 'prompt', 'abort', 'llm', 'interact'])).min(1);
export const sessionAccessClientSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[\x20-\x7e]+$/),
  version: z.string().max(32).optional(),
}).strict();
export const sessionAccessBudgetSchema = z.object({
  max_requests: z.number().int().min(1).optional(),
  max_tokens: z.number().int().min(1).optional(),
  max_cost_usd: z.number().nonnegative().optional(),
}).strict();

export type SessionAccessScope = z.infer<typeof sessionAccessScopesSchema>[number];
export type SessionAccessClient = z.infer<typeof sessionAccessClientSchema>;
export type SessionAccessBudget = z.infer<typeof sessionAccessBudgetSchema>;

export interface SessionAccessUsage {
  requests: number;
  tokens: number;
  cost_usd: number;
}

export interface SessionAccessToken {
  readonly id: string;
  readonly digest: string;
  readonly session_id?: string;
  readonly scopes: SessionAccessScope[];
  readonly client: SessionAccessClient;
  readonly channel: 'owner' | 'terminal';
  readonly holder_id?: string;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly budget?: SessionAccessBudget;
  readonly usage: SessionAccessUsage;
  readonly persistent?: boolean;
}

const persistedTokenSchema = z.object({
  id: z.string().min(1),
  digest: z.string().min(1),
  session_id: z.string().min(1).optional(),
  scopes: sessionAccessScopesSchema,
  client: sessionAccessClientSchema,
  channel: z.enum(['owner', 'terminal']),
  holder_id: z.string().optional(),
  issued_at: z.number(),
  expires_at: z.number(),
  budget: sessionAccessBudgetSchema.optional(),
  usage: z.object({
    requests: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    cost_usd: z.number().nonnegative(),
  }).default({ requests: 0, tokens: 0, cost_usd: 0 }),
  persistent: z.literal(true),
});

const persistedStoreSchema = z.object({
  version: z.literal(1),
  tokens: z.array(persistedTokenSchema),
});

export class SessionAccessStore {
  private readonly tokens = new Map<string, SessionAccessToken>();
  private readonly closers = new Map<string, Set<() => void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners: IDisposable[] = [];
  private persistQueue: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(private readonly core: Scope, readonly now: () => number = Date.now) {
    this.listeners.push(core.accessor.get(IConfigService).onDidSectionChange(({ domain }) => {
      if (domain === SESSION_ACCESS_SECTION && !this.config().enabled) this.revokeAll();
    }));
    const deleted = core.accessor.get(ISessionManager).onDidDeleteSession;
    if (deleted !== undefined) {
      this.listeners.push(deleted(({ sessionId }) => this.revokeWhere((token) => token.session_id === sessionId)));
    }
    this.ready = this.loadPersisted();
  }

  private get documents(): IAtomicDocumentStore | undefined {
    try {
      return this.core.accessor.get(IAtomicDocumentStore);
    } catch {
      return undefined;
    }
  }

  private async loadPersisted(): Promise<void> {
    const store = this.documents;
    if (store === undefined) return;
    try {
      const raw = await store.get<unknown>(PERSISTED_SCOPE, PERSISTED_KEY);
      const parsed = persistedStoreSchema.safeParse(raw);
      if (!parsed.success) return;
      const now = this.now();
      let pruned = false;
      for (const record of parsed.data.tokens) {
        if (record.expires_at <= now) {
          pruned = true;
          continue;
        }
        if (this.tokens.has(record.digest)) continue;
        this.tokens.set(record.digest, { ...record, usage: { ...record.usage } });
        this.scheduleExpiry(this.tokens.get(record.digest)!);
      }
      if (pruned) this.schedulePersist();
    } catch {}
  }

  private schedulePersist(): Promise<void> {
    const store = this.documents;
    if (store === undefined) return Promise.resolve();
    const persistentTokens = [...this.tokens.values()]
      .filter((token) => token.persistent === true && token.expires_at > this.now())
      .map((token) => ({
        id: token.id,
        digest: token.digest,
        ...(token.session_id === undefined ? {} : { session_id: token.session_id }),
        scopes: token.scopes,
        client: token.client,
        channel: token.channel,
        ...(token.holder_id === undefined ? {} : { holder_id: token.holder_id }),
        issued_at: token.issued_at,
        expires_at: token.expires_at,
        ...(token.budget === undefined ? {} : { budget: token.budget }),
        usage: { ...token.usage },
        persistent: true as const,
      }));
    const payload = { version: 1 as const, tokens: persistentTokens };
    const next = this.persistQueue
      .catch(() => {})
      .then(() => store.set(PERSISTED_SCOPE, PERSISTED_KEY, payload));
    this.persistQueue = next;
    void next.catch(() => {});
    return next;
  }

  async flushPersisted(): Promise<void> {
    await this.ready;
    await this.persistQueue;
  }

  config(): SessionAccessConfig {
    return this.core.accessor.get(IConfigService).get<SessionAccessConfig>(SESSION_ACCESS_SECTION);
  }

  issue(input: {
    session_id?: string;
    scopes: SessionAccessScope[];
    client: SessionAccessClient;
    channel: SessionAccessToken['channel'];
    holder_id?: string;
    ttl_seconds: number;
    budget?: SessionAccessBudget;
    persistent?: boolean;
  }): { token: string; record: SessionAccessToken } {
    const token = `ksa_${randomBytes(32).toString('base64url')}`;
    const issued_at = this.now();
    const record: SessionAccessToken = {
      id: `sat_${ulid()}`,
      digest: digest(token),
      session_id: input.session_id,
      scopes: [...new Set(input.scopes)],
      client: input.client,
      channel: input.channel,
      holder_id: input.holder_id,
      issued_at,
      expires_at: issued_at + input.ttl_seconds * 1000,
      budget: input.budget,
      usage: { requests: 0, tokens: 0, cost_usd: 0 },
      persistent: input.persistent === true ? true : undefined,
    };
    this.tokens.set(record.digest, record);
    this.scheduleExpiry(record);
    if (record.persistent === true) this.schedulePersist();
    return { token, record };
  }

  lookup(secret: string): SessionAccessToken | undefined {
    const token = this.tokens.get(digest(secret));
    if (token !== undefined && token.expires_at <= this.now()) {
      this.revoke(token.id);
      return undefined;
    }
    return token;
  }

  private readonly reservedTokens = new Map<string, number>();
  private readonly reservedCostUsd = new Map<string, number>();

  admitBudget(
    token: SessionAccessToken,
    estimated: number | { readonly tokens?: number; readonly costUsd?: number } = 0,
  ): { readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly reason: string } {
    const live = this.tokens.get(token.digest);
    if (live === undefined) return { ok: false, reason: 'session_access_revoked' };
    const budget = live.budget;
    const rawTokens = typeof estimated === 'number' ? estimated : (estimated.tokens ?? 0);
    const rawCostUsd = typeof estimated === 'number' ? 0 : (estimated.costUsd ?? 0);
    const currentReserved = this.reservedTokens.get(live.digest) ?? 0;
    const currentReservedCost = this.reservedCostUsd.get(live.digest) ?? 0;
    const reserve = Number.isFinite(rawTokens) && rawTokens > 0 ? Math.round(rawTokens) : 0;
    const reserveCost = Number.isFinite(rawCostUsd) && rawCostUsd > 0 ? rawCostUsd : 0;
    if (budget !== undefined) {
      if (budget.max_requests !== undefined && live.usage.requests >= budget.max_requests) {
        return { ok: false, reason: 'session_access_budget_requests_exceeded' };
      }
      if (
        budget.max_tokens !== undefined &&
        (live.usage.tokens + currentReserved >= budget.max_tokens ||
          live.usage.tokens + currentReserved + reserve > budget.max_tokens)
      ) {
        return { ok: false, reason: 'session_access_budget_tokens_exceeded' };
      }
      if (
        budget.max_cost_usd !== undefined &&
        (live.usage.cost_usd + currentReservedCost >= budget.max_cost_usd ||
          live.usage.cost_usd + currentReservedCost + reserveCost > budget.max_cost_usd)
      ) {
        return { ok: false, reason: 'session_access_budget_cost_exceeded' };
      }
    }
    live.usage.requests += 1;
    if (reserve > 0) {
      this.reservedTokens.set(live.digest, currentReserved + reserve);
    }
    if (reserveCost > 0) {
      this.reservedCostUsd.set(live.digest, currentReservedCost + reserveCost);
    }
    if (live.persistent === true) void this.schedulePersist();
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        if (reserve > 0) {
          const remaining = Math.max(0, (this.reservedTokens.get(live.digest) ?? 0) - reserve);
          if (remaining === 0) this.reservedTokens.delete(live.digest);
          else this.reservedTokens.set(live.digest, remaining);
        }
        if (reserveCost > 0) {
          const remainingCost = Math.max(0, (this.reservedCostUsd.get(live.digest) ?? 0) - reserveCost);
          if (remainingCost <= 1e-12) this.reservedCostUsd.delete(live.digest);
          else this.reservedCostUsd.set(live.digest, remainingCost);
        }
      },
    };
  }

  recordBudgetUsage(token: SessionAccessToken, delta: { readonly tokens?: number; readonly costUsd?: number }): void {
    const live = this.tokens.get(token.digest);
    if (live === undefined) return;
    if (delta.tokens !== undefined && Number.isFinite(delta.tokens) && delta.tokens > 0) {
      live.usage.tokens += Math.round(delta.tokens);
    }
    if (delta.costUsd !== undefined && Number.isFinite(delta.costUsd) && delta.costUsd > 0) {
      live.usage.cost_usd += delta.costUsd;
    }
    if (live.persistent === true) this.schedulePersist();
  }

  list(): Array<Omit<SessionAccessToken, 'digest' | 'holder_id'>> {
    this.revokeWhere((token) => token.expires_at <= this.now());
    return [...this.tokens.values()].map(({
      id, session_id, scopes, client, channel, issued_at, expires_at, budget, usage, persistent,
    }) => ({
      id,
      ...(session_id === undefined ? {} : { session_id }),
      scopes,
      client,
      channel,
      issued_at,
      expires_at,
      ...(budget === undefined ? {} : { budget }),
      usage: { ...usage },
      ...(persistent === true ? { persistent: true } : {}),
    }));
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
  revokeWhere(matches: (token: SessionAccessToken) => boolean, persist = true): number {
    let revoked = 0;
    let touchedPersistent = false;
    for (const token of this.tokens.values()) {
      if (!matches(token)) continue;
      if (token.persistent === true) touchedPersistent = true;
      this.tokens.delete(token.digest);
      clearTimeout(this.timers.get(token.id));
      this.timers.delete(token.id);
      const closers = this.closers.get(token.id);
      this.closers.delete(token.id);
      for (const close of closers ?? []) close();
      revoked += 1;
    }
    if (persist && touchedPersistent) this.schedulePersist();
    return revoked;
  }

  close(): void {
    for (const listener of this.listeners) void listener.dispose();
    this.revokeWhere(() => true, false);
  }

  private scheduleExpiry(token: SessionAccessToken): void {
    const delay = Math.min(2_147_483_647, Math.max(0, token.expires_at - this.now()));
    const timer = setTimeout(() => {
      if (token.expires_at <= this.now()) this.revoke(token.id);
      else this.scheduleExpiry(token);
    }, delay);
    timer.unref();
    this.timers.set(token.id, timer);
  }
}

export function digest(secret: string): string { return createHash('sha256').update(secret).digest('hex'); }
