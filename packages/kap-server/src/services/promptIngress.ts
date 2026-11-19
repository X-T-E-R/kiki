import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  Error2, ErrorCodes, IAgentLifecycleService, IAtomicDocumentStore, IBootstrapService, IFileService, IFileSystemStorageService,
  IBlobStore, ILogService, ISessionContext, ISessionIndex, ISessionManager, ISessionMetadata, IWorkAdmissionService, isError2, type Scope,
} from '@kiki/agent-core-v2';
import { ScopedMediaStore } from '@kiki/agent-core-v2/agent/media/sessionMediaStoreService';
import { fileNotFoundError } from '@kiki/agent-core-v2/app/file/fileService';
import { sessionScopeOf, workspacePersistenceScope } from '@kiki/agent-core-v2/workspace/sessionLifecycle/internal/addressing';
import type { PromptItem, PromptSubmission, PromptSubmitResult, PromptSubmitReceipt } from '../protocol/rest-prompt';
import { assertPromptFileRefs, sessionPromptFiles } from '../lib/promptMedia';
import { mapError } from '../transport/errors';
import type { RestoreProgress } from '@kiki/agent-core-v2/session/agentLifecycle/restoreTiming';
import { abortable } from '@kiki/agent-core-v2/_base/utils/abort';

export type PromptIngressResult = PromptSubmitResult & Pick<PromptSubmitReceipt, 'resolved_parts'>;

const PAGE_SIZE = 64;
const INDEX_KEY = 'index.json';
const STATE_META_CACHE_MAX_ENTRIES = 256;

interface CachedSessionStateMeta {
  readonly fingerprint: string;
  readonly private: boolean;
  readonly agentIds: ReadonlySet<string>;
}

type Admission = NonNullable<PromptItem['admission']>;
interface Target { readonly sessionId: string; readonly scope: string }
interface Entry {
  readonly version: 1;
  readonly key: string;
  readonly ordinal: number;
  readonly agentId: string;
  readonly fingerprint: string;
  readonly body: PromptSubmission;
  readonly createdAt: string;
  readonly owner: string;
  readonly admission: Admission;
  readonly stage: 'restoring' | 'submitting';
  readonly steerTarget?: { readonly turnId?: number; readonly promptId?: string };
  readonly cancelRequested?: boolean;
  readonly error?: PromptItem['admission_error'];
  readonly result?: PromptIngressResult;
  readonly restoreProgress?: PromptItem['restore_progress'];
  readonly duplicateOf?: string;
  readonly contentIdentity?: string;
}
interface Index { readonly next: number }
interface IndexPage { readonly keys: readonly (string | null)[] }
export interface PromptIngressExecution {
  readonly body: PromptSubmission;
  readonly fingerprint: string;
  readonly files: IFileService;
  readonly signal: AbortSignal;
  readonly steerTarget?: { readonly turnId?: number; readonly promptId?: string };
  onRestoreProgress(progress: RestoreProgress): void;
  beforeSubmit(): Promise<void>;
}
interface Consumer {
  submit(sessionId: string, execution: PromptIngressExecution): Promise<PromptIngressResult>;
  cancel(sessionId: string, agentId: string, promptId: string, signal: AbortSignal): Promise<void>;
  projectDelivery?(sessionId: string, agentId: string, result: PromptItem): PromptItem;
}

export class PromptIngress {
  private readonly owner = randomUUID();
  private readonly workers = new Map<string, { controller: AbortController; promise: Promise<void>; cancelChecked: boolean }>();
  private readonly cancelControllers = new Set<AbortController>();
  private readonly targetTails = new Map<string, Promise<void>>();
  private readonly progress = new Map<string, NonNullable<PromptItem['restore_progress']>>();
  private readonly pendingContent = new Map<string, { readonly key: string; readonly promptId: string }>();
  private readonly stateMetaCache = new Map<string, CachedSessionStateMeta>();
  private readonly stateMetaFlights = new Map<string, Promise<CachedSessionStateMeta | undefined>>();
  private closed = false;
  private outboxFlight?: Promise<void>;
  private rerunOutbox = false;
  private readonly admissionListener: { dispose(): void };

  constructor(private readonly core: Scope, private readonly consumer: Consumer) {
    const admission = core.accessor.get(IWorkAdmissionService);
    let previous = admission.state().operationId;
    this.admissionListener = admission.onDidChange(() => {
      const current = admission.state().operationId;
      const reopened = previous !== undefined && current === undefined;
      previous = current;
      if (!this.closed && reopened) this.start();
    });
  }

  private isSwitchOutboxEnabled(): boolean {
    const bootstrap = this.core.accessor.get(IBootstrapService);
    return bootstrap.getEnv('KIKI_RUNTIME_MANAGED') === '1' || bootstrap.getEnv('KIKI_DESKTOP_BUNDLED') === '1';
  }

  start(): void {
    if (this.closed || !this.isSwitchOutboxEnabled()) return;
    if (this.outboxFlight !== undefined) {
      this.rerunOutbox = true;
      return;
    }
    const runPass = async (): Promise<void> => {
      do {
        this.rerunOutbox = false;
        await this.drainSwitchOutbox();
      } while (this.rerunOutbox && !this.closed && this.core.accessor.get(IWorkAdmissionService).state().operationId === undefined);
    };
    this.outboxFlight = runPass().catch(error => {
      this.core.accessor.get(ILogService).warn('switch outbox recovery failed; saved messages remain available', { error: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      this.outboxFlight = undefined;
      if (this.rerunOutbox && !this.closed && this.core.accessor.get(IWorkAdmissionService).state().operationId === undefined) {
        this.start();
      }
    });
  }

  private async registerSwitchEntry(target: Target, key: string): Promise<void> {
    const scope = 'runtime/switch-outbox';
    const lock = await this.core.accessor.get(IFileSystemStorageService).acquireLock(scope, 'mutation.lock', { waitForMs: 5000 });
    try {
      const index = await this.documents().get<Index>(scope, INDEX_KEY);
      const ordinal = index?.next ?? 0;
      await this.documents().update<{ entries: { target: Target; key: string }[] }>(scope, `${Math.floor(ordinal / PAGE_SIZE)}.json`, page =>
        ({ entries: [...(page?.entries ?? []), { target, key }] }));
      await this.documents().set(scope, INDEX_KEY, { next: ordinal + 1 });
    } finally { await lock.release(); }
  }

  private async drainSwitchOutbox(): Promise<void> {
    const scope = 'runtime/switch-outbox';
    const index = await this.documents().get<Index>(scope, INDEX_KEY);
    for (let page = 0; page * PAGE_SIZE < (index?.next ?? 0); page++) {
      const entries = await this.documents().get<{ entries: { target: Target; key: string }[] }>(scope, `${page}.json`);
      for (const { target, key } of entries?.entries ?? []) {
        if (this.closed || this.core.accessor.get(IWorkAdmissionService).state().operationId !== undefined) return;
        await this.core.accessor.get(IWorkAdmissionService).run('switch-outbox-prepare', async () => {
          const entry = await this.locked(target, async () => {
            const current = await this.read(target, key);
            if (current?.admission !== 'waiting_switch') return undefined;
            const next: Entry = { ...current, admission: 'restoring', owner: this.owner };
            await this.publish(target, next);
            return next;
          });
          if (entry !== undefined) this.schedule(target, entry);
        });
      }
    }
  }

  submitWaitingSwitch(sessionId: string, body: PromptSubmission, fingerprint: string, steerTarget?: PromptIngressExecution['steerTarget']): Promise<PromptItem> {
    if (!this.isSwitchOutboxEnabled()) throw new Error2(ErrorCodes.WORK_ADMISSION_FENCED, 'Waiting to send after the server switch.');
    return this.submitAdmitted(sessionId, body, fingerprint, steerTarget, true);
  }

  private async stateFingerprint(scope: string): Promise<string | undefined> {
    const storage = this.core.accessor.get(IFileSystemStorageService);
    if (storage.stat !== undefined) {
      const info = await storage.stat(scope, 'state.json');
      return info === undefined ? undefined : `${info.size}:${info.revision}:${info.identity ?? ''}`;
    }
    const [size, mtime] = await Promise.all([
      storage.size(scope, 'state.json'),
      storage.mtime(scope, 'state.json'),
    ]);
    return size === undefined && mtime === undefined ? undefined : `${size ?? -1}:${mtime ?? -1}`;
  }

  private async readColdStateMeta(scope: string): Promise<CachedSessionStateMeta | undefined> {
    const fingerprint = await this.stateFingerprint(scope);
    if (fingerprint === undefined) {
      this.stateMetaCache.delete(scope);
      return undefined;
    }
    const cached = this.stateMetaCache.get(scope);
    if (cached?.fingerprint === fingerprint) {
      this.stateMetaCache.delete(scope);
      this.stateMetaCache.set(scope, cached);
      return cached;
    }
    const flightKey = `${scope}\0${fingerprint}`;
    let flight = this.stateMetaFlights.get(flightKey);
    if (flight === undefined) {
      flight = (async (): Promise<CachedSessionStateMeta | undefined> => {
        const metadata = await this.documents().get<{ private?: boolean; agents?: Record<string, unknown> }>(scope, 'state.json');
        if (metadata === undefined) return undefined;
        const entry: CachedSessionStateMeta = {
          fingerprint,
          private: metadata.private === true,
          agentIds: new Set(Object.keys(metadata.agents ?? {})),
        };
        const after = await this.stateFingerprint(scope);
        if (after === fingerprint) {
          this.stateMetaCache.delete(scope);
          this.stateMetaCache.set(scope, entry);
          if (this.stateMetaCache.size > STATE_META_CACHE_MAX_ENTRIES) {
            this.stateMetaCache.delete(this.stateMetaCache.keys().next().value!);
          }
        }
        return entry;
      })().finally(() => {
        if (this.stateMetaFlights.get(flightKey) === flight) this.stateMetaFlights.delete(flightKey);
      });
      this.stateMetaFlights.set(flightKey, flight);
    }
    return flight;
  }

  private async target(sessionId: string, agentId: string): Promise<Target> {
    const live = this.core.accessor.get(ISessionManager).get(sessionId);
    if (live !== undefined) {
      const ctx = live.accessor.get(ISessionContext);
      if (ctx.ephemeral) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Save this temporary session before using durable admission.');
      const scope = sessionScopeOf(workspacePersistenceScope(this.core.accessor.get(IBootstrapService).scope('sessions'), ctx.workspaceId), sessionId);
      if (agentId !== 'main') {
        const present = live.accessor.get(IAgentLifecycleService).get(agentId) !== undefined ||
          (await live.accessor.get(ISessionMetadata).read()).agents?.[agentId] !== undefined;
        if (!present) throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `agent ${agentId} does not exist`);
      }
      return { sessionId, scope };
    }
    const summary = await this.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    const scope = sessionScopeOf(workspacePersistenceScope(this.core.accessor.get(IBootstrapService).scope('sessions'), summary.workspaceId), sessionId);
    if (agentId !== 'main') {
      const metadata = await this.readColdStateMeta(scope);
      if (metadata?.agentIds.has(agentId) !== true) throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `agent ${agentId} does not exist`);
    }
    return { sessionId, scope };
  }

  private key(agentId: string, promptId: string): string {
    return createHash('sha256').update(JSON.stringify([agentId, promptId])).digest('hex');
  }

  private documents() { return this.core.accessor.get(IAtomicDocumentStore); }
  private media(target: Target): ScopedMediaStore {
    return new ScopedMediaStore(`${target.scope}/media`, this.core.accessor.get(IFileSystemStorageService), this.documents(),
      this.core.accessor.get(IBlobStore), target.scope);
  }
  private async locked<T>(target: Target, operation: () => Promise<T>): Promise<T> {
    const lock = await this.core.accessor.get(IFileSystemStorageService).acquireLock(`${target.scope}/prompt-ingress`, 'mutation.lock', { waitForMs: 5000 });
    try { return await operation(); } finally { await lock.release(); }
  }
  private read(target: Target, key: string): Promise<Entry | undefined> {
    return this.documents().get(`${target.scope}/prompt-ingress/requests`, `${key}.json`);
  }
  private async payload(target: Target, key: string): Promise<PromptSubmission> {
    const body = await this.documents().get<PromptSubmission>(`${target.scope}/prompt-ingress/payloads`, `${key}.json`);
    if (body === undefined) throw new Error2(ErrorCodes.INTERNAL, 'The saved prompt payload is unavailable.');
    return body;
  }
  private async save(target: Target, entry: Entry): Promise<void> {
    await this.documents().set(`${target.scope}/prompt-ingress/requests`, `${entry.key}.json`, entry);
  }
  private async publish(target: Target, entry: Entry): Promise<void> {
    await this.save(target, entry);
    await this.documents().update<IndexPage>(`${target.scope}/prompt-ingress/pages`, `${Math.floor(entry.ordinal / PAGE_SIZE)}.json`, current => {
      const keys = [...(current?.keys ?? [])];
      keys[entry.ordinal % PAGE_SIZE] = entry.key;
      return { keys };
    });
  }
  private preview(content: PromptSubmission['content']): PromptSubmission['content'] {
    let text = '';
    for (const part of content) {
      if (part.type === 'text') text += (text ? '\n' : '') + part.text.slice(0, 1024 - text.length);
      if (text.length >= 1024) break;
    }
    return [{ type: 'text', text: text || '[Attachment]' }];
  }
  private progressSnapshot(key: string): PromptItem['restore_progress'] {
    const progress = this.progress.get(key);
    return progress === undefined ? undefined : { ...progress, elapsed_ms: Math.max(progress.elapsed_ms, Date.now() - Date.parse(progress.started_at)) };
  }

  private async item(target: Target, entry: Entry, full = true, knownBody?: PromptSubmission): Promise<PromptItem> {
    const result = entry.result === undefined ? undefined : full
      ? await this.documents().get<PromptSubmitResult>(`${target.scope}/prompt-ingress/results`, `${entry.key}.json`) : entry.result;
    const body = full && result === undefined ? (knownBody ?? await this.payload(target, entry.key)) : entry.body;
    const progress = entry.admission === 'restoring' ? this.progress.get(`${target.scope}/${entry.key}`) ?? entry.restoreProgress : entry.restoreProgress;
    const item: PromptItem = { ...result, restore_progress: progress === undefined ? undefined : { ...progress, elapsed_ms: entry.admission === 'restoring' ? Math.max(progress.elapsed_ms, Date.now() - Date.parse(progress.started_at)) : progress.elapsed_ms },
      admission_duplicate_of: entry.duplicateOf, prompt_id: entry.body.prompt_id!, user_message_id: result?.user_message_id ?? entry.body.prompt_id!,
      status: result?.status ?? 'queued', content: result?.content ?? body.content,
      created_at: result?.created_at ?? entry.createdAt, append_timing: result?.append_timing ?? entry.body.append_timing ?? 'agent_idle',
      revision: result?.revision ?? 0, admission: entry.admission, admission_error: entry.error,
      admission_content_truncated: full ? undefined : true };
    return entry.admission === 'admitted' ? this.consumer.projectDelivery?.(target.sessionId, entry.agentId, item) ?? item : item;
  }

  submit(sessionId: string, body: PromptSubmission, fingerprint: string, steerTarget?: PromptIngressExecution['steerTarget']): Promise<PromptItem> {
    return this.core.accessor.get(IWorkAdmissionService).run('durable-prompt', () => this.submitAdmitted(sessionId, body, fingerprint, steerTarget));
  }

  private async submitAdmitted(sessionId: string, body: PromptSubmission, fingerprint: string, steerTarget?: PromptIngressExecution['steerTarget'], waitingSwitch = false): Promise<PromptItem> {
    if (this.closed) throw new Error2(ErrorCodes.REQUEST_INVALID, 'The server is stopping. Retry this request after reconnecting.');
    if (body.prompt_id === undefined || body.prompt_id.length > 256) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Durable admission requires a prompt_id of 1–256 characters.');
    if (body.content.every(part => part.type === 'text' && part.text.trim() === '')) throw new Error2(ErrorCodes.REQUEST_INVALID, 'A prompt must contain text or an attachment.');
    const agentId = body.agent_id ?? 'main';
    const target = await this.target(sessionId, agentId);
    const key = this.key(agentId, body.prompt_id);
    const existing = await this.read(target, key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, 'This prompt_id already belongs to another request.');
      await this.recover(target, existing);
      const recovered = await this.locked(target, async () => {
        const current = (await this.read(target, key))!;
        if (current.result === undefined && await this.documents().get(`${target.scope}/prompt-ingress/payloads`, `${key}.json`) === undefined) {
          const repairedContent = await this.retainMedia(target, body.content);
          await this.documents().set(`${target.scope}/prompt-ingress/payloads`, `${key}.json`, { ...body, content: repairedContent, admission: undefined });
        }
        await this.publish(target, current);
        if (waitingSwitch && current.admission === 'waiting_switch') await this.registerSwitchEntry(target, key);
        return current;
      });
      if (recovered.owner === this.owner && recovered.admission === 'restoring' && !waitingSwitch) this.schedule(target, recovered);
      if (recovered.admission === 'waiting_switch' && this.core.accessor.get(IWorkAdmissionService).state().operationId === undefined) this.start();
      return this.item(target, recovered);
    }
    const content = await this.retainMedia(target, body.content);
    const savedPayload: PromptSubmission = { ...body, content, admission: undefined };
    const entry = await this.locked(target, async () => {
      const [raced, index] = await Promise.all([
        this.read(target, key),
        this.documents().get<Index>(`${target.scope}/prompt-ingress`, INDEX_KEY),
      ]);
      if (raced !== undefined) {
        if (raced.fingerprint !== fingerprint) throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, 'This prompt_id already belongs to another request.');
        if (raced.result === undefined && await this.documents().get(`${target.scope}/prompt-ingress/payloads`, `${key}.json`) === undefined) {
          await this.documents().set(`${target.scope}/prompt-ingress/payloads`, `${key}.json`, savedPayload);
        }
        await this.publish(target, raced);
        return raced;
      }
      const ordinal = index?.next ?? 0;
      const contentIdentity = `${target.scope}/${agentId}/${createHash('sha256').update(JSON.stringify({ ...body, prompt_id: undefined, admission: undefined })).digest('hex')}`;
      const duplicate = this.pendingContent.get(contentIdentity);
      const created: Entry = { version: 1, key, ordinal, agentId, body: { prompt_id: body.prompt_id, append_timing: body.append_timing, content: this.preview(content) }, fingerprint,
        createdAt: new Date().toISOString(), owner: this.owner, admission: duplicate !== undefined ? 'held' : waitingSwitch ? 'waiting_switch' : 'restoring', stage: 'restoring',
        contentIdentity, duplicateOf: duplicate?.promptId,
        error: duplicate === undefined ? undefined : { code: 40903, message: 'An identical message is already waiting for restoration. This copy is held. Cancel it or explicitly resume it to send it separately.' },
        steerTarget: body.delivery_mode === 'steer' ? steerTarget : undefined };
      await this.documents().set(`${target.scope}/prompt-ingress/payloads`, `${key}.json`, savedPayload);
      await this.documents().set<Index>(`${target.scope}/prompt-ingress`, INDEX_KEY, { next: ordinal + 1 });
      await this.publish(target, created);
      if (created.admission === 'waiting_switch') await this.registerSwitchEntry(target, key);
      if (duplicate === undefined) this.pendingContent.set(contentIdentity, { key, promptId: body.prompt_id! });
      return created;
    });
    if (entry.owner === this.owner && entry.admission === 'restoring') this.schedule(target, entry);
    if (entry.admission === 'waiting_switch' && this.core.accessor.get(IWorkAdmissionService).state().operationId === undefined) this.start();
    return this.item(target, entry, true, entry.owner === this.owner && entry.result === undefined ? savedPayload : undefined);
  }

  async lookup(sessionId: string, agentId: string, promptId: string): Promise<PromptItem | undefined> {
    const target = await this.target(sessionId, agentId);
    const entry = await this.read(target, this.key(agentId, promptId));
    return entry === undefined ? undefined : this.item(target, await this.recover(target, entry));
  }

  async list(sessionId: string, agentId: string, cursor?: string): Promise<{ items: PromptItem[]; nextCursor?: string }> {
    const target = await this.target(sessionId, agentId);
    const pageNumber = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 0 || (cursor !== undefined && String(pageNumber) !== cursor)) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Invalid durable prompt cursor.');
    }
    const index = await this.documents().get<Index>(`${target.scope}/prompt-ingress`, INDEX_KEY);
    const page = await this.documents().get<IndexPage>(`${target.scope}/prompt-ingress/pages`, `${pageNumber}.json`);
    const items: PromptItem[] = [];
    for (const key of page?.keys ?? []) {
      if (key === null || key === undefined) continue;
      const entry = await this.read(target, key);
      if (entry?.agentId === agentId) items.push(await this.item(target, await this.recover(target, entry), false));
    }
    return { items, nextCursor: (pageNumber + 1) * PAGE_SIZE < (index?.next ?? 0) ? String(pageNumber + 1) : undefined };
  }

  resume(sessionId: string, agentId: string, promptId: string): Promise<PromptItem | undefined> {
    return this.core.accessor.get(IWorkAdmissionService).run('durable-prompt-resume', () => this.resumeAdmitted(sessionId, agentId, promptId));
  }

  private async resumeAdmitted(sessionId: string, agentId: string, promptId: string): Promise<PromptItem | undefined> {
    const target = await this.target(sessionId, agentId);
    const key = this.key(agentId, promptId);
    let entry = await this.read(target, key);
    if (entry === undefined) return undefined;
    entry = await this.recover(target, entry);
    if (entry.admission !== 'held' && entry.admission !== 'failed') return this.item(target, entry);
    const resumed = await this.locked(target, async () => {
      const current = (await this.read(target, key))!;
      if (current.admission !== 'held' && current.admission !== 'failed') return current;
      const next: Entry = { ...current, owner: this.owner, admission: 'restoring', error: undefined, duplicateOf: undefined };
      await this.publish(target, next);
      return next;
    });
    if (resumed.owner === this.owner && resumed.admission === 'restoring') this.schedule(target, resumed);
    return this.item(target, resumed);
  }

  async abort(sessionId: string, agentId: string, promptId: string): Promise<boolean | undefined> {
    const live = this.core.accessor.get(ISessionManager).get(sessionId);
    if (live !== undefined && live.accessor.get(ISessionContext).ephemeral) return undefined;
    if (live === undefined && await this.core.accessor.get(ISessionIndex).get(sessionId) === undefined) return undefined;
    const target = await this.target(sessionId, agentId);
    const key = this.key(agentId, promptId);
    const entry = await this.locked(target, async () => {
      const current = await this.read(target, key);
      if (current === undefined || current.admission === 'admitted' || current.admission === 'cancelled') return current;
      const next: Entry = { ...current, owner: this.owner, cancelRequested: true, admission: current.stage === 'restoring' ? 'cancelled' : 'held',
        error: current.stage === 'restoring' ? undefined : { code: 40903, message: 'Cancellation is waiting for the saved request to be reconciled with the agent.' } };
      await this.publish(target, next);
      return next;
    });
    if (entry === undefined || entry.admission === 'admitted') return undefined;
    this.workers.get(`${target.scope}/${key}`)?.controller.abort(new Error('Prompt cancelled'));
    if (entry.admission !== 'cancelled') this.schedule(target, entry);
    return entry.admission === 'cancelled';
  }

  private async recover(target: Target, entry: Entry): Promise<Entry> {
    if (entry.owner === this.owner || entry.admission !== 'restoring') return entry;
    let worker;
    try { worker = await this.core.accessor.get(IFileSystemStorageService).acquireLock(`${target.scope}/prompt-ingress`, `${entry.key}.worker.lock`, { waitForMs: 0 }); }
    catch (error) { if (isError2(error) && error.code === 'storage.locked') return entry; throw error; }
    try {
      return await this.locked(target, async () => {
        const current = (await this.read(target, entry.key))!;
        if (current.owner === this.owner || current.admission !== 'restoring') return current;
        const held: Entry = { ...current, admission: 'held', error: undefined };
        await this.publish(target, held);
        return held;
      });
    } finally { await worker.release(); }
  }

  private schedule(target: Target, entry: Entry): void {
    const key = `${target.scope}/${entry.key}`;
    if (this.closed) return;
    const running = this.workers.get(key);
    if (running !== undefined) {
      const observedCancelAfterCheck = entry.cancelRequested === true && running.cancelChecked;
      void running.promise.then(async () => {
        if (this.closed || this.workers.has(key)) return;
        const current = await this.read(target, entry.key).catch(() => undefined);
        if (current === undefined || current.owner !== this.owner) return;
        if (current.admission === 'restoring' || (observedCancelAfterCheck && current.cancelRequested === true && current.admission !== 'cancelled' && current.admission !== 'admitted')) {
          this.schedule(target, current);
        }
      });
      return;
    }
    const admission = entry.cancelRequested ? undefined : this.core.accessor.get(IWorkAdmissionService).acquire('durable-prompt-prepare');
    if (entry.contentIdentity !== undefined && !this.pendingContent.has(entry.contentIdentity)) {
      this.pendingContent.set(entry.contentIdentity, { key: entry.key, promptId: entry.body.prompt_id! });
    }
    const controller = new AbortController();
    const lane = `${target.scope}/${entry.agentId}`;
    const previous = this.targetTails.get(lane) ?? Promise.resolve();
    this.progress.set(key, { phase: this.targetTails.has(lane) ? 'prompt_queue' : 'prompt_acquire', started_at: new Date().toISOString(), elapsed_ms: 0 });
    const timeout = setTimeout(() => {
      const phase = this.progress.get(key)?.phase ?? 'prompt_acquire';
      controller.abort(new Error2(ErrorCodes.SESSION_BUSY, `Message restoration timed out after 120s during ${phase}. Retry this saved message or cancel it.`));
    }, 120_000);
    timeout.unref?.();
    const workerEntry = { controller, promise: Promise.resolve(), cancelChecked: false };
    const run = () => this.run(target, entry.key, controller, timeout, previous, workerEntry);
    const promise = (admission === undefined ? run() : admission.run(run)).catch(error => {
      this.core.accessor.get(ILogService).warn('durable prompt admission stopped', { error: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      admission?.dispose();
      clearTimeout(timeout);
      this.workers.delete(key);
      this.progress.delete(key);
      if (entry.contentIdentity !== undefined && this.pendingContent.get(entry.contentIdentity)?.key === entry.key) this.pendingContent.delete(entry.contentIdentity);
      if (this.targetTails.get(lane) === promise) this.targetTails.delete(lane);
    });
    workerEntry.promise = promise;
    this.workers.set(key, workerEntry);
    this.targetTails.set(lane, promise);
  }

  private async runCancelReconciliation(sessionId: string, agentId: string, promptId: string): Promise<void> {
    if (this.closed) throw new Error('Server stopped during prompt admission');
    const cancelController = new AbortController();
    this.cancelControllers.add(cancelController);
    const timer = setTimeout(() => {
      cancelController.abort(new Error2(ErrorCodes.SESSION_BUSY, 'Prompt cancellation timed out while reconciling with the agent.'));
    }, 30_000);
    timer.unref?.();
    try {
      await this.consumer.cancel(sessionId, agentId, promptId, cancelController.signal);
    } finally {
      clearTimeout(timer);
      this.cancelControllers.delete(cancelController);
    }
  }

  private async run(target: Target, key: string, controller: AbortController, timeout: ReturnType<typeof setTimeout>, previous: Promise<void>, workerEntry: { cancelChecked: boolean }): Promise<void> {
    if (this.closed) return;
    const lease = await this.core.accessor.get(IFileSystemStorageService).acquireLock(`${target.scope}/prompt-ingress`, `${key}.worker.lock`, { waitForMs: 0 });
    try {
      let entry = (await this.read(target, key))!;
      if (entry.owner !== this.owner || (entry.admission !== 'restoring' && !entry.cancelRequested) || entry.admission === 'cancelled') return;
      let submittingStarted = false;
      let submitSettled = false;
      let submitFlight: Promise<PromptIngressResult> | undefined;
      try {
        await abortable(previous.catch(() => {}), controller.signal);
        if (entry.cancelRequested) {
          await this.runCancelReconciliation(target.sessionId, entry.agentId, entry.body.prompt_id!);
          await this.locked(target, async () => {
            const current = (await this.read(target, key))!;
            workerEntry.cancelChecked = true;
            await this.publish(target, { ...current, admission: 'cancelled', error: undefined });
          });
          return;
        }
        controller.signal.throwIfAborted();
        const progressKey = `${target.scope}/${key}`;
        const payload = await this.payload(target, key);
        controller.signal.throwIfAborted();
        submitFlight = this.consumer.submit(target.sessionId, { body: payload, fingerprint: entry.fingerprint, files: this.files(target), signal: controller.signal,
          steerTarget: entry.steerTarget,
          onRestoreProgress: progress => {
            if (controller.signal.aborted) return;
            const previous = this.progress.get(progressKey);
            this.progress.set(progressKey, { phase: progress.phase, started_at: previous?.started_at ?? progress.startedAt,
              elapsed_ms: previous === undefined ? progress.elapsedMs : Date.now() - Date.parse(previous.started_at), queue_position: progress.queuePosition });
          },
          beforeSubmit: async () => {
            await this.locked(target, async () => {
              entry = (await this.read(target, key))!;
              if (entry.cancelRequested || controller.signal.aborted || this.closed) throw new Error('Prompt admission cancelled');
              submittingStarted = true;
              entry = { ...entry, stage: 'submitting', restoreProgress: this.progressSnapshot(progressKey) };
              await this.save(target, entry);
              clearTimeout(timeout);
              if (entry.contentIdentity !== undefined && this.pendingContent.get(entry.contentIdentity)?.key === entry.key) this.pendingContent.delete(entry.contentIdentity);
            });
          } });
        const result = await abortable(submitFlight, controller.signal);
        submitSettled = true;
        await this.documents().set(`${target.scope}/prompt-ingress/results`, `${key}.json`, result);
        await this.locked(target, async () => {
          const current = (await this.read(target, key))!;
          entry = { ...current, result: { ...result, content: this.preview(result.content), resolved_parts: undefined }, admission: current.cancelRequested ? 'held' : 'admitted', error: undefined };
          if (!current.cancelRequested) workerEntry.cancelChecked = true;
          await this.publish(target, entry);
        });
        if (entry.cancelRequested) {
          await this.runCancelReconciliation(target.sessionId, entry.agentId, entry.body.prompt_id!);
          await this.locked(target, async () => {
            const current = (await this.read(target, key))!;
            workerEntry.cancelChecked = true;
            await this.publish(target, { ...current, admission: 'cancelled', error: undefined });
          });
        }
      } catch (error) {
        let submitError = error;
        const pendingCancel = !this.closed && (await this.read(target, key))?.cancelRequested === true;
        let settledResult: PromptIngressResult | undefined;
        if (pendingCancel && submittingStarted && !submitSettled && submitFlight !== undefined) {
          try {
            settledResult = await submitFlight;
            await this.documents().set(`${target.scope}/prompt-ingress/results`, `${key}.json`, settledResult);
          } catch (innerError) {
            submitError = innerError;
          }
        }
        if (pendingCancel && submittingStarted) {
          try {
            await this.runCancelReconciliation(target.sessionId, entry.agentId, entry.body.prompt_id!);
            await this.locked(target, async () => {
              const current = (await this.read(target, key))!;
              workerEntry.cancelChecked = true;
              const compact = settledResult === undefined
                ? current.result
                : { ...settledResult, content: this.preview(settledResult.content), resolved_parts: undefined };
              await this.publish(target, { ...current, result: compact, admission: 'cancelled', error: undefined });
            });
            return;
          } catch (cancelError) {
            submitError = cancelError;
          }
        }
        const mapped = mapError(submitError, entry.body.prompt_id!);
        const holdForDeletedWorkspace = isError2(submitError) && submitError.code === ErrorCodes.WORKSPACE_NOT_FOUND;
        await this.locked(target, async () => {
          const current = (await this.read(target, key))!;
          workerEntry.cancelChecked = true;
          if (current.admission === 'cancelled') return;
          await this.publish(target, { ...current, admission: this.closed || current.cancelRequested || current.stage === 'submitting' || holdForDeletedWorkspace ? 'held' : 'failed',
            restoreProgress: this.progressSnapshot(`${target.scope}/${key}`), error: { code: mapped.code, message: mapped.msg } });
        });
      }
    } finally { await lease.release(); }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.admissionListener.dispose();
    await this.outboxFlight;
    for (const worker of this.workers.values()) worker.controller.abort(new Error('Server stopped during prompt admission'));
    for (const cancelController of this.cancelControllers) cancelController.abort(new Error('Server stopped during prompt admission'));
    await Promise.all([...this.workers.values()].map(worker => worker.promise));
  }

  private files(target: Target): IFileService {
    return sessionPromptFiles(this.core.accessor.get(IFileService), this.media(target));
  }

  private async retainMedia(target: Target, content: PromptSubmission['content']): Promise<PromptSubmission['content']> {
    if (content.every((part) => part.type === 'text')) return content;
    const media = this.media(target);
    const files = this.files(target);
    await assertPromptFileRefs(content, files);
    const retained: PromptSubmission['content'] = [];
    for (const part of content) {
      const uploadId = part.type === 'file' ? part.file_id : (part.type === 'image' || part.type === 'video' || part.type === 'audio') && part.source.kind === 'file' ? part.source.file_id : undefined;
      if (uploadId !== undefined) {
        const file = await files.get(uploadId);
        await media.materialize({ fileId: uploadId, size: file.meta.size, name: file.meta.name, mimeType: file.meta.media_type, stream: () => file.stream() });
        retained.push(part);
      } else if ((part.type === 'image' || part.type === 'video' || part.type === 'audio') && part.source.kind === 'base64') {
        const bytes = Buffer.from(part.source.data, 'base64');
        const id = `f_${randomUUID()}`;
        const extension = part.source.media_type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
        await media.materialize({ fileId: id, size: bytes.length, name: part.name ?? `${part.type}.${extension}`, mimeType: part.source.media_type, stream: () => Readable.from(bytes) });
        retained.push({ ...part, source: { kind: 'file', file_id: id } });
      } else {
        if ((part.type === 'image' || part.type === 'video' || part.type === 'audio') && part.source.kind === 'session_media' && !part.source.file_id.startsWith('inline')
          && await media.open(part.source.file_id) === undefined) {
          const file = await this.core.accessor.get(IFileService).get(part.source.file_id);
          await media.materialize({ fileId: file.meta.id, size: file.meta.size, name: file.meta.name, mimeType: file.meta.media_type, stream: () => file.stream() });
          if (await media.open(part.source.file_id) === undefined) throw fileNotFoundError(part.source.file_id);
        }
        retained.push(part);
      }
    }
    return retained;
  }
}
