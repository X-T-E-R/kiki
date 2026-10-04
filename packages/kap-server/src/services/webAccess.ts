import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { webAccessEnableInputSchema, webSessionSummarySchema, type WebAccessEnableInput, type WebAccessStatus, type WebSessionSummary, type WebAccessLink } from '@kiki/protocol';
import { readPrivateFile, writePrivateFile } from './auth/privateFiles';
import { AdmissionError } from './connections/admission';

const CODE_TTL = 10 * 60 * 1000;
const TEMPORARY_TTL = 8 * 60 * 60 * 1000;
const IDLE_TTL = 30 * 24 * 60 * 60 * 1000;
const WRITE_INTERVAL = 15 * 60 * 1000;
interface StoredSession extends WebSessionSummary { digest: string }
export interface WebPrincipal { kind: 'web'; sessionId: string }
const principals = new WeakMap<object, WebPrincipal>();
export function webPrincipal(request: object): WebPrincipal | undefined { return principals.get(request); }
export function setWebPrincipal(request: object, principal: WebPrincipal): void { principals.set(request, principal); }
export interface WebListener { url: string; host: string; port: number; close(): Promise<void> }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function secret(): string { return randomBytes(32).toString('base64url'); }
export class WebAccess {
  readonly cookieName: string;
  private input?: WebAccessEnableInput;
  private listener?: WebListener;
  private expiresAt: number | null = null;
  private readonly sessions = new Map<string, StoredSession>();
  private readonly codes = new Map<string, { expiresAt: number; origin: string }>();
  private readonly leases = new Map<string, Set<() => void>>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  private lastWrite = 0;
  private readonly timer: NodeJS.Timeout;
  private expiryTimer?: NodeJS.Timeout;
  constructor(homeDir: string, homeId: string, private readonly startListener: (input: WebAccessEnableInput) => Promise<WebListener>, private readonly now = Date.now) {
    this.path = join(homeDir, 'server', 'web-access.json');
    this.cookieName = 'kiki_web_' + homeId.replaceAll('-', '');
    this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, 60_000);
    this.timer.unref();
  }
  async ready(): Promise<void> {
    try {
      const state = JSON.parse((await readPrivateFile(this.path)).toString('utf8')) as { input?: unknown; sessions?: unknown[] };
      if (state.input === undefined) return;
      const input = webAccessEnableInputSchema.parse(state.input);
      if (input.mode !== 'persistent' || !Array.isArray(state.sessions)) throw new Error('Invalid Web access store');
      for (const raw of state.sessions) {
        const entry = webSessionSummarySchema.parse(raw);
        const hash = (raw as StoredSession).digest;
        if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || this.sessions.has(entry.id)) throw new Error('Invalid Web session digest');
        if (entry.lastUsedAt + IDLE_TTL > this.now()) this.sessions.set(entry.id, { ...entry, digest: hash });
      }
      this.listener = await this.startListener(input); this.input = input;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  status(): WebAccessStatus {
    const enabled = this.listener !== undefined && (this.expiresAt === null || this.expiresAt > this.now());
    return { enabled, mode: enabled ? this.input!.mode : null, url: enabled ? this.listener!.url : null,
      expiresAt: enabled ? this.expiresAt : null, host: enabled ? this.listener!.host : null, port: enabled ? this.listener!.port : null,
      insecure: enabled && this.listener!.url.startsWith('http:') && !isLoopback(new URL(this.listener!.url).hostname),
      sessions: [...this.sessions.values()].filter((s) => this.valid(s)).map((s) => this.summary(s)) };
  }
  enable(input: WebAccessEnableInput): Promise<WebAccessStatus> {
    return this.change(async () => {
      const parsed = webAccessEnableInputSchema.parse(input);
      if (this.status().enabled && parsed.mode === this.input?.mode && (parsed.host === undefined || parsed.host === this.input.host) && (parsed.port === undefined || parsed.port === this.input.port) && (parsed.publicUrl === undefined || new URL(parsed.publicUrl).origin === this.input.publicUrl) && (parsed.insecureNoTls === undefined || parsed.insecureNoTls === this.input.insecureNoTls)) return this.status();
      await this.stop();
      this.listener = await this.startListener(parsed);
      this.input = { ...parsed, host: this.listener.host, port: this.listener.port, publicUrl: this.listener.url };
      this.expiresAt = parsed.mode === 'temporary' ? this.now() + TEMPORARY_TTL : null;
      if (this.expiresAt !== null) { this.expiryTimer = setTimeout(() => { void this.disable().catch(() => {}); }, TEMPORARY_TTL); this.expiryTimer.unref(); }
      await this.persist(); return this.status();
    });
  }
  disable(): Promise<WebAccessStatus> { return this.change(async () => { await this.stop(); await this.persist(); return this.status(); }); }
  issueLink(): WebAccessLink {
    this.requireEnabled();
    const value = secret(); const expiresAt = Math.min(this.now() + CODE_TTL, this.expiresAt ?? Infinity);
    for (const [hash, code] of this.codes) if (code.expiresAt <= this.now()) this.codes.delete(hash);
    if (this.codes.size >= 128) throw new AdmissionError(429, 'too_many_web_links');
    this.codes.set(digest(value), { expiresAt, origin: new URL(this.listener!.url).origin });
    return { url: this.listener!.url + '#access=' + value, expiresAt };
  }
  exchange(code: string, request: IncomingMessage, label?: string): Promise<{ session: WebSessionSummary; cookie: string }> {
    return this.change(async () => {
      this.requireEnabled(); this.requireOrigin(request);
      const hash = digest(code); const entry = this.codes.get(hash);
      if (entry === undefined || entry.expiresAt <= this.now() || entry.origin !== request.headers.origin) throw new AdmissionError(401, 'invalid_web_access_code');
      this.codes.delete(hash);
      if (this.sessions.size >= 128) throw new AdmissionError(429, 'too_many_web_sessions');
      const value = secret(); const now = this.now();
      const session: StoredSession = { id: randomUUID(), label: label?.trim() || 'Browser', createdAt: now, lastUsedAt: now,
        expiresAt: this.expiresAt ?? now + IDLE_TTL, digest: digest(value) };
      this.sessions.set(session.id, session); await this.persist();
      return { session: this.summary(session), cookie: this.cookie(value, request) };
    });
  }
  authenticate(request: IncomingMessage): WebPrincipal {
    this.requireEnabled();
    const value = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(this.cookieName + '='))?.slice(this.cookieName.length + 1);
    const session = value === undefined ? undefined : [...this.sessions.values()].find((s) => s.digest === digest(value));
    if (session === undefined) throw new AdmissionError(401, 'invalid_web_session');
    if (!this.valid(session)) { this.remove(session.id); throw new AdmissionError(401, 'invalid_web_session'); }
    if (!['GET', 'HEAD'].includes(request.method ?? '') || request.headers.origin !== undefined) this.requireOrigin(request);
    if (!this.hostAllowed(request.headers.host)) throw new AdmissionError(403, 'web_host_not_allowed');
    session.lastUsedAt = this.now(); session.expiresAt = this.expiresAt ?? session.lastUsedAt + IDLE_TTL;
    if (this.input?.mode === 'persistent' && this.now() - this.lastWrite >= WRITE_INTERVAL) {
      this.lastWrite = this.now();
      void this.change(() => this.persist()).catch(() => {});
    }
    return { kind: 'web', sessionId: session.id };
  }
  current(request: IncomingMessage): WebSessionSummary | null {
    try { const principal = this.authenticate(request); return this.summary(this.sessions.get(principal.sessionId)!); }
    catch (error) { if (error instanceof AdmissionError && error.status === 401) return null; throw error; }
  }
  logout(request: IncomingMessage): Promise<void> {
    this.requireOrigin(request);
    return this.change(async () => { const current = this.current(request); if (current !== null) this.remove(current.id); await this.persist(); });
  }
  revoke(id?: string): Promise<WebAccessStatus> {
    return this.change(async () => { if (id === undefined) for (const key of this.sessions.keys()) this.remove(key); else this.remove(id); await this.persist(); return this.status(); });
  }
  attach(principal: WebPrincipal, close: () => void): () => void {
    const entry = this.sessions.get(principal.sessionId);
    if (!this.status().enabled || entry === undefined || !this.valid(entry)) { close(); return () => {}; }
    let timer: NodeJS.Timeout | undefined;
    const closeLease = () => { if (timer !== undefined) clearTimeout(timer); close(); };
    const check = () => {
      if (!this.valid(entry) || !this.sessions.has(entry.id)) { this.remove(entry.id); return; }
      timer = setTimeout(check, Math.max(1, Math.min(entry.expiresAt - this.now(), 24 * 60 * 60 * 1000))); timer.unref();
    };
    const set = this.leases.get(entry.id) ?? new Set<() => void>(); set.add(closeLease); this.leases.set(entry.id, set); check();
    return () => { if (timer !== undefined) clearTimeout(timer); set.delete(closeLease); if (set.size === 0) this.leases.delete(entry.id); };
  }
  requireOrigin(request: IncomingMessage): void {
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (origin === undefined || host === undefined || origin === 'null') throw new AdmissionError(403, 'web_origin_required');
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new AdmissionError(403, 'web_origin_invalid'); }
    const publicOrigin = this.input?.publicUrl === undefined ? undefined : new URL(this.input.publicUrl).origin;
    const expected = publicOrigin !== undefined && new URL(publicOrigin).host === host ? publicOrigin : 'http://' + host;
    if (parsed.origin !== origin || origin !== expected || !this.hostAllowed(host)) throw new AdmissionError(403, 'web_origin_not_allowed');
  }
  hostAllowed(host: string | undefined): boolean {
    if (host === undefined || this.listener === undefined) return false;
    return host === new URL(this.listener.url).host;
  }
  clearCookie(request: IncomingMessage): string { return this.cookie('', request, 0); }
  refreshCookie(request: IncomingMessage): string {
    const value = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(this.cookieName + '='))?.slice(this.cookieName.length + 1) ?? '';
    return this.cookie(value, request);
  }
  private cookie(value: string, _request: IncomingMessage, maxAge?: number): string {
    const secure = this.input?.publicUrl?.startsWith('https:') === true;
    return `${this.cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=${maxAge ?? Math.floor((this.expiresAt === null ? IDLE_TTL : Math.max(0, this.expiresAt - this.now())) / 1000)}`;
  }
  private valid(session: StoredSession): boolean { return this.statusEnabled() && session.expiresAt > this.now() && session.lastUsedAt + IDLE_TTL > this.now(); }
  private statusEnabled(): boolean { return this.listener !== undefined && (this.expiresAt === null || this.expiresAt > this.now()); }
  private requireEnabled(): void { if (!this.statusEnabled()) throw new AdmissionError(401, 'web_access_disabled'); }
  private summary({ digest: _digest, ...session }: StoredSession): WebSessionSummary { return session; }
  private remove(id: string): void { this.sessions.delete(id); const set = this.leases.get(id); this.leases.delete(id); for (const close of set ?? []) close(); }
  private async stop(): Promise<void> {
    if (this.expiryTimer !== undefined) { clearTimeout(this.expiryTimer); this.expiryTimer = undefined; }
    this.codes.clear(); for (const id of this.sessions.keys()) this.remove(id);
    const listener = this.listener; this.listener = undefined; this.input = undefined; this.expiresAt = null;
    await listener?.close();
  }
  private async sweep(): Promise<void> {
    if (this.listener !== undefined && this.expiresAt !== null && this.expiresAt <= this.now()) { await this.disable(); return; }
    await this.change(async () => { let changed = false; for (const [id, session] of this.sessions) if (!this.valid(session)) { this.remove(id); changed = true; } if (changed) await this.persist(); });
  }
  private async persist(): Promise<void> {
    this.lastWrite = this.now();
    await writePrivateFile(this.path, JSON.stringify(this.input?.mode === 'persistent' ? { input: this.input, sessions: [...this.sessions.values()] } : {}));
  }
  private change<T>(fn: () => Promise<T>): Promise<T> { const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result; }
  async close(): Promise<void> { clearInterval(this.timer); await this.change(async () => { await this.persist(); await this.stop(); }); }
}
export function isLoopback(host: string): boolean { return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'; }
