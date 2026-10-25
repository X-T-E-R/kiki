import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  Error2, ErrorCodes, IAtomicDocumentStore, IBootstrapService, IFileService, IFileSystemStorageService,
  IBlobStore, ILogService, ISessionIndex, ISessionManager, isError2, type Scope,
} from '@kiki/agent-core-v2';
import { ScopedMediaStore } from '@kiki/agent-core-v2/agent/media/sessionMediaStoreService';
import { fileNotFoundError, type GetResult } from '@kiki/agent-core-v2/app/file/fileService';
import { sessionScopeOf, workspacePersistenceScope } from '@kiki/agent-core-v2/workspace/sessionLifecycle/internal/addressing';
import type { PromptItem, PromptSubmission, PromptSubmitResult, PromptSubmitReceipt } from '../protocol/rest-prompt';
import { assertPromptFileRefs } from '../lib/promptMedia';
import { mapError } from '../transport/errors';

export type PromptIngressResult = PromptSubmitResult & Pick<PromptSubmitReceipt, 'resolved_parts'>;

const PAGE_SIZE = 64;
const INDEX_KEY = 'index.json';

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
}
interface Index { readonly next: number }
interface IndexPage { readonly keys: readonly (string | null)[] }
export interface PromptIngressExecution {
  readonly body: PromptSubmission;
  readonly fingerprint: string;
  readonly files: IFileService;
  readonly signal: AbortSignal;
  readonly steerTarget?: { readonly turnId?: number; readonly promptId?: string };
  beforeSubmit(): Promise<void>;
}
interface Consumer {
  submit(sessionId: string, execution: PromptIngressExecution): Promise<PromptIngressResult>;
  cancel(sessionId: string, agentId: string, promptId: string, signal: AbortSignal): Promise<void>;
}

export class PromptIngress {
  private readonly owner = randomUUID();
  private readonly workers = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly targetTails = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly core: Scope, private readonly consumer: Consumer) {}

  private async target(sessionId: string, agentId: string): Promise<Target> {
    const summary = await this.core.accessor.get(ISessionIndex).get(sessionId);
    const live = summary === undefined ? this.core.accessor.get(ISessionManager).get(sessionId) : undefined;
    if (summary === undefined && live === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    if (summary === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Save this temporary session before using durable admission.');
    const scope = sessionScopeOf(workspacePersistenceScope(this.core.accessor.get(IBootstrapService).scope('sessions'), summary.workspaceId), sessionId);
    if (agentId !== 'main') {
      const metadata = await this.documents().get<{ agents?: Record<string, unknown> }>(scope, 'state.json');
      if (metadata?.agents?.[agentId] === undefined) throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `agent ${agentId} does not exist`);
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
  private async item(target: Target, entry: Entry, full = true): Promise<PromptItem> {
    const result = entry.result === undefined ? undefined : full
      ? await this.documents().get<PromptSubmitResult>(`${target.scope}/prompt-ingress/results`, `${entry.key}.json`) : entry.result;
    const body = full && result === undefined ? await this.payload(target, entry.key) : entry.body;
    return { ...result, prompt_id: entry.body.prompt_id!, user_message_id: result?.user_message_id ?? entry.body.prompt_id!,
      status: result?.status ?? 'queued', content: result?.content ?? body.content,
      created_at: result?.created_at ?? entry.createdAt, append_timing: result?.append_timing ?? entry.body.append_timing ?? 'agent_idle',
      revision: result?.revision ?? 0, admission: entry.admission, admission_error: entry.error,
      admission_content_truncated: full ? undefined : true };
  }

  async submit(sessionId: string, body: PromptSubmission, fingerprint: string, steerTarget?: PromptIngressExecution['steerTarget']): Promise<PromptItem> {
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
        await this.publish(target, current);
        return current;
      });
      if (recovered.owner === this.owner && recovered.admission === 'restoring') this.schedule(target, recovered);
      return this.item(target, recovered);
    }
    const content = await this.retainMedia(target, body.content);
    const entry = await this.locked(target, async () => {
      const raced = await this.read(target, key);
      if (raced !== undefined) {
        if (raced.fingerprint !== fingerprint) throw new Error2(ErrorCodes.PROMPT_ID_CONFLICT, 'This prompt_id already belongs to another request.');
        return raced;
      }
      await this.documents().set(`${target.scope}/prompt-ingress/payloads`, `${key}.json`, { ...body, content, admission: undefined });
      const index = await this.documents().get<Index>(`${target.scope}/prompt-ingress`, INDEX_KEY);
      const ordinal = index?.next ?? 0;
      await this.documents().set<Index>(`${target.scope}/prompt-ingress`, INDEX_KEY, { next: ordinal + 1 });
      const created: Entry = { version: 1, key, ordinal, agentId, body: { prompt_id: body.prompt_id, append_timing: body.append_timing, content: this.preview(content) }, fingerprint,
        createdAt: new Date().toISOString(), owner: this.owner, admission: 'restoring', stage: 'restoring',
        steerTarget: body.delivery_mode === 'steer' ? steerTarget : undefined };
      await this.publish(target, created);
      return created;
    });
    if (entry.owner === this.owner && entry.admission === 'restoring') this.schedule(target, entry);
    return this.item(target, entry);
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

  async resume(sessionId: string, agentId: string, promptId: string): Promise<PromptItem | undefined> {
    const target = await this.target(sessionId, agentId);
    const key = this.key(agentId, promptId);
    let entry = await this.read(target, key);
    if (entry === undefined) return undefined;
    entry = await this.recover(target, entry);
    if (entry.admission !== 'held' && entry.admission !== 'failed') return this.item(target, entry);
    const resumed = await this.locked(target, async () => {
      const current = (await this.read(target, key))!;
      if (current.admission !== 'held' && current.admission !== 'failed') return current;
      const next: Entry = { ...current, owner: this.owner, admission: 'restoring', error: undefined };
      await this.publish(target, next);
      return next;
    });
    if (resumed.owner === this.owner && resumed.admission === 'restoring') this.schedule(target, resumed);
    return this.item(target, resumed);
  }

  async abort(sessionId: string, agentId: string, promptId: string): Promise<boolean | undefined> {
    if (await this.core.accessor.get(ISessionIndex).get(sessionId) === undefined) return undefined;
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
    if (this.closed || this.workers.has(key)) return;
    const controller = new AbortController();
    const lane = `${target.scope}/${entry.agentId}`;
    const previous = this.targetTails.get(lane) ?? Promise.resolve();
    const promise = previous.catch(() => {}).then(() => this.run(target, entry.key, controller)).catch(error => {
      this.core.accessor.get(ILogService).warn('durable prompt admission stopped', { error: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      this.workers.delete(key);
      if (this.targetTails.get(lane) === promise) this.targetTails.delete(lane);
    });
    this.workers.set(key, { controller, promise });
    this.targetTails.set(lane, promise);
  }

  private async run(target: Target, key: string, controller: AbortController): Promise<void> {
    if (this.closed) return;
    const lease = await this.core.accessor.get(IFileSystemStorageService).acquireLock(`${target.scope}/prompt-ingress`, `${key}.worker.lock`, { waitForMs: 0 });
    try {
      let entry = (await this.read(target, key))!;
      if (entry.owner !== this.owner || (entry.admission !== 'restoring' && !entry.cancelRequested) || entry.admission === 'cancelled') return;
      try {
        if (entry.cancelRequested) {
          await this.consumer.cancel(target.sessionId, entry.agentId, entry.body.prompt_id!, controller.signal);
          await this.locked(target, () => this.publish(target, { ...entry, admission: 'cancelled', error: undefined }));
          return;
        }
        const result = await this.consumer.submit(target.sessionId, { body: await this.payload(target, key), fingerprint: entry.fingerprint, files: this.files(target), signal: controller.signal,
          steerTarget: entry.steerTarget,
          beforeSubmit: async () => {
            await this.locked(target, async () => {
              entry = (await this.read(target, key))!;
              if (entry.cancelRequested || controller.signal.aborted || this.closed) throw new Error('Prompt admission cancelled');
              entry = { ...entry, stage: 'submitting' };
              await this.save(target, entry);
            });
          } });
        await this.documents().set(`${target.scope}/prompt-ingress/results`, `${key}.json`, result);
        await this.locked(target, async () => {
          const current = (await this.read(target, key))!;
          entry = { ...current, result: { ...result, content: this.preview(result.content), resolved_parts: undefined }, admission: current.cancelRequested ? 'held' : 'admitted', error: undefined };
          await this.publish(target, entry);
        });
        if (entry.cancelRequested) {
          await this.consumer.cancel(target.sessionId, entry.agentId, entry.body.prompt_id!, controller.signal);
          await this.locked(target, () => this.publish(target, { ...entry, admission: 'cancelled' }));
        }
      } catch (error) {
        const mapped = mapError(error, entry.body.prompt_id!);
        await this.locked(target, async () => {
          const current = (await this.read(target, key))!;
          if (current.admission === 'cancelled') return;
          await this.publish(target, { ...current, admission: this.closed || current.cancelRequested || current.stage === 'submitting' ? 'held' : 'failed',
            error: { code: mapped.code, message: mapped.msg } });
        });
      }
    } finally { await lease.release(); }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const worker of this.workers.values()) worker.controller.abort(new Error('Server stopped during prompt admission'));
    await Promise.all([...this.workers.values()].map(worker => worker.promise));
  }

  private files(target: Target): IFileService {
    const staged = this.core.accessor.get(IFileService);
    const media = this.media(target);
    return { _serviceBrand: undefined, save: (source, name, options) => staged.save(source, name, options), delete: id => staged.delete(id),
      get: async (id): Promise<GetResult> => {
        const file = await media.open(id);
        if (file === undefined) return staged.get(id);
        return { meta: { id, name: file.name, media_type: file.mediaType, size: file.size, created_at: new Date(0).toISOString() },
          stream: range => Readable.from(file.stream(range)) };
      } };
  }

  private async retainMedia(target: Target, content: PromptSubmission['content']): Promise<PromptSubmission['content']> {
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
        if ((part.type === 'image' || part.type === 'video' || part.type === 'audio') && part.source.kind === 'session_media' && !part.source.file_id.startsWith('inline')) {
          if (await media.open(part.source.file_id) === undefined) throw fileNotFoundError(part.source.file_id);
        }
        retained.push(part);
      }
    }
    return retained;
  }
}
