import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { atomicWrite } from '@kiki/agent-core-v2/_base/utils/fs';

import {
  ErrorCodes,
  IAgentLoopService,
  IAgentPromptService,
  IBootstrapService,
  IAgentContextMemoryService,
  IBotService,
  IFileService,
  ISessionActivityView,
  ISessionApprovalService,
  ISessionContext,
  ISessionIndex,
  ISessionInteractionService,
  ISessionMediaStore,
  ISessionQuestionService,
  ensureMainAgent,
  isError2,
  reservePrompt,
  type ContentPart,
  type QuestionRequest,
  type Scope,
  type SessionApprovalRequest,
} from '@kiki/agent-core-v2';
import type { ImProviderKind, MessageContent } from '@kiki/protocol';
import { createSafeHttpTransport } from '@nb-im/core';

import { IUserMessageRouter } from '@kiki/agent-core-v2/app/bot/messageRouting';
import { IImMessageHistoryReader } from '@kiki/agent-core-v2/app/bot/imMessageHistory';
import { IAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/interface/atomicDocumentStore';
import { IPluginHostService } from '@kiki/agent-core-v2/app/plugin/pluginHostService';
import { PluginImAdapterBridge } from './pluginAdapter';
import { parseMediaBlobRef } from '@kiki/transcript';
import { agentScopeOf, sessionScopeOf, workspacePersistenceScope } from '@kiki/agent-core-v2/workspace/sessionLifecycle/internal/addressing';
import { IBlobStore } from '@kiki/agent-core-v2/persistence/interface/blobStore';
import { contentToCoreParts, resolvePromptMediaFiles } from '../../lib/promptMedia';
import { withSessionOperation } from '../../lib/sessionOperationLease';
import { StorageStartupCleanupError } from '../../storageStartupCleanup';
import type { NotificationService } from '../notifications/notificationService';
import type { ImAdapterFactory, ImHttpTransport } from './adapter';
import { ImSessionBridge } from './bridge';
import { checkRealtimeSessionAccount, loadHubFactories, sessionAccountHint } from './hubAdapter';
import type { ImAnswerResult, ImQuestionAnswer, ImSessionPorts, ImSubmitResult, ImVisibleMedia, ImVisibleReply } from './ports';
import { WechatQrLogin, type WechatLoginFetch } from './wechatLogin';

const DAY_MS = 24 * 60 * 60 * 1000;
const TELEGRAM_TOKEN = /^[0-9]{1,20}:[A-Za-z0-9_-]{20,128}$/u;
const SESSION_KINDS = new Set<ImProviderKind>(['feishu_app', 'onebot_v11', 'wechat_bridge', 'discord', 'slack', 'matrix']);

interface HostLogger {
  info(fields: Record<string, string | number | boolean>, message: string): void;
}

export async function createImSessionHost(input: {
  readonly core: Scope;
  readonly homeDir: string;
  readonly notifications: NotificationService;
  readonly logger: HostLogger;
  readonly factories?: readonly ImAdapterFactory[];
  readonly wechatFetch?: WechatLoginFetch;
  readonly signal?: AbortSignal;
  readonly onCreate?: (close: () => Promise<void>) => void;
}): Promise<ImSessionBridge> {
  input.signal?.throwIfAborted();
  const factories = [...(input.factories ?? loadSessionFactories(input.homeDir))];
  const plugins = new PluginImAdapterBridge(factories);
  const ports = new NotificationSessionPorts(input.core, input.homeDir, input.notifications, input.logger, plugins);
  const fetchImpl = input.wechatFetch ?? ((url, init) => globalThis.fetch(url, init));
  const wechatLogin = new WechatQrLogin(fetchImpl, () => ports.wechatTokens(), async (credential) => ports.credentials.create!({ providerKind: 'wechat_bridge', credential }));
  const bridge = new ImSessionBridge({ ports, factories, locale: () => readHostLocale(input.homeDir), wechatLogin });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing === undefined) {
      const current = bridge.close();
      closing = current;
      void current.catch(() => { if (closing === current) closing = undefined; });
    }
    return closing;
  };
  const abort = (): void => { void close().catch(() => undefined); };
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    input.onCreate?.(close);
    await bridge.whenReady();
    input.signal?.throwIfAborted();
    await plugins.attach(input.core.accessor.get(IPluginHostService), async (kinds) => {
      if (input.signal?.aborted) return;
      await bridge.reconcileAdapters(kinds);
    });
    input.signal?.throwIfAborted();
    const snapshot = await bridge.snapshot();
    input.signal?.throwIfAborted();
    await bridge.setPolicy(snapshot.policy);
    input.signal?.throwIfAborted();
    input.core.instantiation.provide(IUserMessageRouter, {
      _serviceBrand: undefined,
      sendMessage: (message) => bridge.sendUserMessage(message),
    });
    input.core.instantiation.provide(IImMessageHistoryReader, {
      _serviceBrand: undefined,
      read: (sessionId, query) => bridge.readMessageHistory(sessionId, query),
    });
    return bridge;
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new StorageStartupCleanupError(error, cleanupError, close); }
    throw error;
  } finally { input.signal?.removeEventListener('abort', abort); }
}

export function loadSessionFactories(homeDir: string) {
  return loadHubFactories(homeDir);
}

function telegramHttp(token: string): ImHttpTransport {
  const http = createSafeHttpTransport();
  return {
    async call(method, body) {
      const outcome = await http.post({
        url: `https://api.telegram.org/bot${token}/${method}`,
        body: JSON.stringify(body),
        content_type: 'application/json',
      }, () => 'ready');
      if ('blocked' in outcome) throw new Error('telegram_blocked');
      return { status: outcome.status, body: JSON.parse(outcome.body) as unknown };
    },
    async download(filePath) {
      const response = await fetch(new URL(filePath, `https://api.telegram.org/file/bot${token}/`));
      if (!response.ok) throw new Error('telegram_download_failed');
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

class NotificationSessionPorts implements ImSessionPorts {
  private readonly pendingAnswers = new Map<string, Record<string, string | true>>();

  constructor(
    private readonly core: Scope,
    private readonly homeDir: string,
    private readonly notificationService: NotificationService,
    readonly logger: HostLogger,
    private readonly plugins: PluginImAdapterBridge,
  ) {}

  readonly history = {
    get: <T>(key: string) => this.core.accessor.get(IAtomicDocumentStore).get<T>(this.core.accessor.get(IBootstrapService).scope('store'), key),
    set: <T>(key: string, value: T) => this.core.accessor.get(IAtomicDocumentStore).set(this.core.accessor.get(IBootstrapService).scope('store'), key, value),
    delete: (key: string) => this.core.accessor.get(IAtomicDocumentStore).delete(this.core.accessor.get(IBootstrapService).scope('store'), key),
  };

  readonly notifications = {
    channels: (sessionId: string) => this.notificationService.messageChannels(sessionId),
  };

  readonly credentials = {
    list: (): ReturnType<ImSessionPorts['credentials']['list']> => {
      const settings = this.notificationService.getSettings();
      return Object.entries(settings.provider_instances).flatMap(([id, instance]) => {
        const kind = instanceKind(instance);
        if (kind === undefined) return [];
        const slot = instance.options['token_slot'];
        const configured = typeof slot === 'string' && settings.credential_slots[slot]?.configured === true;
        return [{ id, providerId: kind, ...(instance.label === undefined ? {} : { label: instance.label }), configured }];
      }).concat(this.plugins.credentials());
    },
    read: (instanceId: string): string | undefined => {
      const plugin = this.plugins.credential(instanceId);
      if (plugin !== undefined) return plugin;
      const settings = this.notificationService.getSettings();
      const slot = settings.provider_instances[instanceId]?.options['token_slot'];
      if (typeof slot !== 'string') return undefined;
      try { return this.notificationService.revealCredential(slot); } catch { return undefined; }
    },
    write: async (instanceId: string, value: string): Promise<void> => {
      const settings = this.notificationService.getSettings();
      const slot = settings.provider_instances[instanceId]?.options['token_slot'];
      if (typeof slot !== 'string') throw new Error('unknown_instance');
      await this.notificationService.setCredential(slot, value);
    },
    check: async (instanceId: string): Promise<{ ok: boolean; accountId?: string; conflict?: 'webhook'; detail?: string }> => {
      if (this.plugins.credential(instanceId) !== undefined) return { ok: true };
      const credential = this.credentials.read(instanceId);
      if (credential === undefined || credential.length === 0) return { ok: false, detail: 'missing' };
      const kind = instanceKind(this.notificationService.getSettings().provider_instances[instanceId]);
      if (kind === 'telegram') return this.checkTelegram(credential);
      if (kind === 'discord' || kind === 'slack' || kind === 'matrix') return checkRealtimeSessionAccount(kind, credential);
      if (kind === undefined) return { ok: false, detail: 'missing' };
      const hinted = sessionAccountHint(kind, credential);
      return hinted.ok ? { ok: true, ...(hinted.accountId === undefined ? {} : { accountId: hinted.accountId }) } : { ok: false, detail: 'missing' };
    },
    create: async (input: { providerKind: ImProviderKind; credential: string }): Promise<{ instanceId: string; label?: string }> => {
      const existing = this.credentials.list().find((item) => item.providerId === input.providerKind && this.credentials.read(item.id) === input.credential);
      if (existing !== undefined) return { instanceId: existing.id };
      return this.createInstance(input.providerKind, input.credential);
    },
  };

  readonly sessions: ImSessionPorts['sessions'] = {
    listPersonas: async () => (await this.core.accessor.get(IBotService).list()).map((persona) => ({
      id: persona.personaId, name: persona.name, ...(persona.homeSessionId === undefined ? {} : { homeSessionId: persona.homeSessionId }),
    })),
    listSessions: async () => (await this.core.accessor.get(ISessionIndex).listRecent({ limit: 50 })).items.map((session) => ({
      id: session.id, title: session.title ?? session.id, ...(session.personaId === undefined ? {} : { personaId: session.personaId }),
    })),
    owns: async (sessionId: string) => (await this.core.accessor.get(ISessionIndex).get(sessionId)) !== undefined,
    ensureHome: async (personaId: string) => {
      const home = await this.core.accessor.get(IBotService).ensureHomeSession(personaId);
      return { homeSessionId: home.homeSessionId };
    },
    setHome: async (personaId: string, sessionId: string) => { await this.core.accessor.get(IBotService).setHomeSession(personaId, sessionId); },
    activity: (sessionId: string) => this.inSession(sessionId, async (session) => {
      const agent = await ensureMainAgent(session);
      const prompt = agent.accessor.get(IAgentPromptService);
      const loop = agent.accessor.get(IAgentLoopService);
      const queue = prompt.list();
      const state = session.accessor.get(ISessionActivityView).state();
      return { busy: state.busy, pending: state.pendingInteraction, queueLength: queue.pending.length, ...(queue.active === undefined ? {} : { activePromptId: queue.active.id }), ...(loop.status().activeTurnId === undefined ? {} : { activeTurnId: loop.status().activeTurnId }) };
    }),
    submit: (input) => this.submit(input),
    steer: (sessionId, promptId) => this.inSession(sessionId, async (session) => {
      const prompt = (await ensureMainAgent(session)).accessor.get(IAgentPromptService);
      if (!prompt.list().pending.some((item) => item.id === promptId)) return 'started' as const;
      try {
        const [handle] = await prompt.steer([promptId]);
        return handle?.state === 'steered' ? 'steered' as const : prompt.list().pending.some((item) => item.id === promptId) ? 'queued' as const : 'started' as const;
      } catch (error) {
        if (!isError2(error) || (error.code !== ErrorCodes.PROMPT_NOT_FOUND && error.code !== ErrorCodes.REQUEST_INVALID)) throw error;
        return prompt.list().pending.some((item) => item.id === promptId) ? 'queued' as const : 'started' as const;
      }
    }),
    abort: (sessionId, promptId, turnId) => this.inSession(sessionId, async (session) => {
      const agent = await ensureMainAgent(session);
      let aborted = false;
      if (promptId !== undefined) {
        try { aborted = agent.accessor.get(IAgentPromptService).abort(promptId) || aborted; } catch { aborted = aborted || false; }
      }
      const loop = agent.accessor.get(IAgentLoopService);
      if (turnId !== undefined && loop.status().activeTurnId === turnId) aborted = loop.cancel(turnId) || aborted;
      return aborted;
    }),
    saveMedia: (input) => this.saveMedia(input),
    historyMedia: (sessionId, content) => this.inSession(sessionId, async (session) => {
      const store = session.accessor.get(ISessionMediaStore);
      const available: MessageContent[] = [];
      for (const part of content.slice(0, 4)) {
        if (part.type !== 'image' || part.source.kind !== 'session_media') continue;
        const media = await store.open(part.source.file_id);
        if (media === undefined || media.size > 5 * 1024 * 1024 || !media.mediaType.startsWith('image/')) continue;
        available.push(part);
      }
      return available;
    }),
    readAttachment: async ({ sessionId, blobId }) => {
      const ref = parseMediaBlobRef(blobId);
      if (ref?.kind !== 'agent') return undefined;
      const summary = await this.core.accessor.get(ISessionIndex).get(sessionId);
      if (summary === undefined) return undefined;
      const sessionScope = sessionScopeOf(
        workspacePersistenceScope(this.core.accessor.get(IBootstrapService).scope('sessions'), summary.workspaceId),
        summary.id,
      );
      const bytes = await this.core.accessor.get(IBlobStore).get(`${agentScopeOf(sessionScope, ref.agentId)}/blobs`, ref.hash);
      return bytes === undefined ? undefined : { bytes, name: ref.hash.slice(0, 12) };
    },
    readVisible: (sessionId, promptId, turnId) => this.readVisible(sessionId, promptId, turnId),
    listInteractions: (sessionId, signal) => this.listInteractions(sessionId, signal),
    decideApproval: (input) => this.decide(input, false),
    decideHostKey: (input) => this.decide(input, true),
    answerQuestion: (input) => this.answerQuestion(input),
  };

  wechatTokens(): string[] {
    const tokens: string[] = [];
    for (const item of this.credentials.list()) {
      if (item.providerId !== 'wechat_bridge') continue;
      const token = this.credentials.read(item.id)?.split('\n')[0]?.trim() ?? '';
      if (token.length === 0) continue;
      tokens.push(token);
      if (tokens.length === 10) break;
    }
    return tokens;
  }

  async load(): Promise<string | undefined> {
    try {
      const text = await readFile(join(this.homeDir, 'im-session-bridge.json'), 'utf8');
      return text.trim() === '' ? undefined : text;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async save(value: string): Promise<void> {
    await mkdir(this.homeDir, { recursive: true });
    await atomicWrite(join(this.homeDir, 'im-session-bridge.json'), value);
  }

  private async createInstance(kind: ImProviderKind, credential: string): Promise<{ instanceId: string }> {
    const instanceId = `im_${randomUUID().replace(/-/gu, '')}`;
    const purpose = kind === 'telegram' ? 'telegram_bot' : 'im_session';
    const slot = `${instanceId}.${purpose}`;
    const env = `KIKI_NOTIFY_${slot.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}`.slice(0, 128);
    const options = kind === 'telegram' ? { token_slot: slot } : { session_kind: kind, token_slot: slot };
    await this.notificationService.upsertInstance(instanceId, {
      provider_id: kind, enabled: true, revision: '1', options,
    }, { [slot]: { provider_id: kind, provider_instance_id: instanceId, purpose, env } });
    await this.notificationService.setCredential(slot, credential);
    return { instanceId };
  }

  private async checkTelegram(credential: string): Promise<{ ok: boolean; accountId?: string; conflict?: 'webhook'; detail?: string }> {
    if (!TELEGRAM_TOKEN.test(credential)) return { ok: false, detail: 'unauthorized' };
    const http = telegramHttp(credential);
    const me = recordOf(recordOf((await http.call('getMe', {}))['body'])?.['result']);
    const id = me?.['id'];
    if (!Number.isSafeInteger(id)) return { ok: false, detail: 'unauthorized' };
    const webhook = recordOf(recordOf((await http.call('getWebhookInfo', {}))['body'])?.['result']);
    if (typeof webhook?.['url'] === 'string' && webhook['url'].length > 0) return { ok: false, accountId: String(id), conflict: 'webhook' };
    return { ok: true, accountId: String(id) };
  }

  private inSession<T>(sessionId: string, work: (session: NonNullable<Parameters<Parameters<typeof withSessionOperation>[2]>[0]>) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withSessionOperation(this.core, sessionId, async (session) => {
      signal?.throwIfAborted();
      if (session === undefined) throw new Error('unknown_session');
      return work(session);
    }, signal);
  }

  private async submit(input: Parameters<ImSessionPorts['sessions']['submit']>[0]): Promise<ImSubmitResult> {
    return this.inSession(input.sessionId, async (session) => {
      const agent = await ensureMainAgent(session);
      const prompt = agent.accessor.get(IAgentPromptService);
      const known = prompt.lookup(input.promptId);
      if (known !== undefined) return { duplicate: true, promptId: input.promptId, turnId: known.turnId, deliveryState: prompt.list().pending.some((item) => item.id === input.promptId) ? 'queued' : 'pending' };
      const prepared = await resolvePromptMediaFiles([...input.content], this.core.accessor.get(IFileService), this.core.accessor.get(IBootstrapService).cacheDir, {
        resolveAttachmentsDir: async () => join(session.accessor.get(ISessionContext).sessionDir, 'attachments'),
      });
      const reservation = reservePrompt(prompt, input.promptId, true);
      try {
        const handle = await reservation.submit({ role: 'user', content: contentToCoreParts(prepared.content), toolCalls: [], providerMessageId: input.im?.source_message_id, origin: { kind: 'user', im: input.im } });
        void Promise.race([handle.launched, handle.completion]).then(() => prepared.discard(), () => prepared.discard());
        const queue = prompt.list();
        const pending = queue.pending.some((item) => item.id === handle.id);
        return { duplicate: false, promptId: handle.id, turnId: prompt.lookup(handle.id)?.turnId, deliveryState: pending ? 'queued' : 'pending' };
      } catch (error) {
        await prepared.discard();
        if (isError2(error) && error.code === ErrorCodes.PROMPT_ID_CONFLICT) return { duplicate: true, promptId: input.promptId, deliveryState: 'pending' };
        throw error;
      } finally {
        await reservation.dispose();
      }
    });
  }

  private async saveMedia(input: { sessionId: string; kind: 'image' | 'file' | 'audio' | 'video'; name: string; mediaType: string; bytes: Uint8Array; text?: string }): Promise<readonly MessageContent[]> {
    return this.inSession(input.sessionId, async (session) => {
      const dir = join(session.accessor.get(ISessionContext).sessionDir, 'attachments');
      await mkdir(dir, { recursive: true });
      const safe = input.name.replace(/[^\w.-]+/gu, '_').replace(/^\.+/u, '').slice(0, 80) || 'file';
      await writeFile(join(dir, `${randomUUID()}-${safe}`), input.bytes);
      const text = input.text === undefined ? [] : [{ type: 'text' as const, text: input.text }];
      const saved = await this.core.accessor.get(IFileService).save(Readable.from(Buffer.from(input.bytes)), safe, { mimeType: input.mediaType });
      await session.accessor.get(ISessionMediaStore).materialize({ fileId: saved.id, size: saved.size, name: saved.name, mimeType: input.mediaType, stream: () => Readable.from(Buffer.from(input.bytes)) });
      if (input.kind === 'file') return [...text, { type: 'file', file_id: saved.id, name: saved.name, media_type: saved.media_type, size: saved.size }];
      return [...text, { type: input.kind, name: safe, source: { kind: 'session_media', file_id: saved.id } }];
    });
  }

  private async readVisible(sessionId: string, promptId: string, turnId?: number): Promise<ImVisibleReply> {
    return this.inSession(sessionId, async (session) => {
      const agent = await ensureMainAgent(session);
      const messages = agent.accessor.get(IAgentContextMemoryService).get();
      const selected = visibleReplyMessages(messages, promptId, turnId);
      const text = selected.flatMap((message) => message.content.flatMap((part) => part.type === 'text' ? [part.text] : [])).join('');
      const media: ImVisibleMedia[] = [];
      const store = session.accessor.get(ISessionMediaStore);
      for (const message of selected) {
        for (const part of message.content) {
          const item = await mediaBytes(part, store);
          if (item !== undefined) media.push(item);
        }
      }
      const queue = agent.accessor.get(IAgentPromptService).list();
      const live = queue.active?.id === promptId || queue.launching?.id === promptId || queue.pending.some((item) => item.id === promptId);
      const turnLive = turnId !== undefined && agent.accessor.get(IAgentLoopService).status().activeTurnId === turnId;
      return { text, done: !live && !turnLive, media };
    });
  }

  private listInteractions(sessionId: string, signal?: AbortSignal) {
    return this.inSession(sessionId, async (session) => {
      const approvals: { id: string; expiresAt: number; toolName: string; action: string; ssh?: 'login' | 'host_key' }[] = [];
      const questions: { id: string; questionIndex: number; expiresAt: number; questionKey: string; options: { id: string; label: string }[]; multi: boolean; allowOther: boolean }[] = [];
      for (const item of session.accessor.get(ISessionInteractionService).listPending()) {
        const expiresAt = item.createdAt + DAY_MS;
        if (Date.now() > expiresAt) continue;
        if (item.kind === 'approval') {
          const payload = item.payload as SessionApprovalRequest;
          approvals.push({ id: item.id, expiresAt, toolName: payload.toolName, action: payload.action, ...(payload.ssh === undefined ? {} : { ssh: payload.ssh.kind }) });
        } else if (item.kind === 'question') {
          const payload = item.payload as QuestionRequest;
          payload.questions.forEach((question, index) => {
            questions.push({
              id: item.id, questionIndex: index, expiresAt, questionKey: question.question,
              options: question.options.map((option, optionIndex) => ({ id: `opt_${index}_${optionIndex}`, label: option.label })),
              multi: question.multiSelect === true, allowOther: true,
            });
          });
        }
      }
      return { approvals, questions };
    }, signal);
  }

  private decide(input: { sessionId: string; interactionId: string; decision: 'approved' | 'rejected' }, hostKey: boolean) {
    return this.inSession(input.sessionId, async (session) => {
      const interactions = session.accessor.get(ISessionInteractionService);
      const pending = interactions.listPending().find((item) => item.id === input.interactionId);
      if (pending === undefined) return interactions.isRecentlyResolved(input.interactionId) ? 'resolved' as const : 'expired' as const;
      if (Date.now() > pending.createdAt + DAY_MS) return 'expired' as const;
      const payload = pending.payload as SessionApprovalRequest;
      if (!hostKey && payload.ssh?.kind === 'login') return 'resolved' as const;
      if (hostKey) {
        if (payload.ssh?.kind !== 'host_key') return 'resolved' as const;
        session.accessor.get(ISessionApprovalService).decideSsh(input.interactionId, { decision: input.decision, scope: 'session' });
        return 'decided' as const;
      }
      if (payload.ssh !== undefined) return 'resolved' as const;
      session.accessor.get(ISessionApprovalService).decide(input.interactionId, { decision: input.decision, scope: 'session' });
      return 'decided' as const;
    });
  }

  private answerQuestion(input: { sessionId: string; interactionId: string; response: ImQuestionAnswer; previous?: Record<string, string | true> }): Promise<ImAnswerResult> {
    return this.inSession(input.sessionId, async (session) => {
      const interactions = session.accessor.get(ISessionInteractionService);
      const pending = interactions.listPending('question').find((item) => item.id === input.interactionId);
      if (pending === undefined) return interactions.isRecentlyResolved(input.interactionId) ? 'answered' as const : 'expired' as const;
      if (Date.now() > pending.createdAt + DAY_MS) return 'expired' as const;
      const request = pending.payload as QuestionRequest;
      const previous = input.previous ?? this.pendingAnswers.get(input.interactionId) ?? {};
      const merged = mergeQuestionAnswers(request.questions, previous, input.response);
      if (!merged.complete) {
        this.pendingAnswers.set(input.interactionId, merged.answers);
        return { result: 'partial' as const, answers: merged.answers };
      }
      this.pendingAnswers.delete(input.interactionId);
      session.accessor.get(ISessionQuestionService).answer(input.interactionId, { answers: merged.answers, method: 'number_key' });
      return { result: 'answered' as const, answers: merged.answers };
    });
  }
}

function instanceKind(instance: { provider_id?: unknown; options?: Record<string, unknown> } | undefined): ImProviderKind | undefined {
  if (instance === undefined) return undefined;
  const kind = instance.options?.['session_kind'];
  if (typeof kind === 'string' && SESSION_KINDS.has(kind as ImProviderKind)) return kind as ImProviderKind;
  return instance.provider_id === 'telegram' ? 'telegram' : undefined;
}

export function readHostLocale(homeDir: string): 'en' | 'zh' {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(homeDir, 'desktop.json'), 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'locale' in parsed && (parsed.locale === 'zh' || parsed.locale === 'en')) return parsed.locale;
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }
  return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function mergeQuestionAnswers(
  questions: readonly { readonly question: string; readonly options: readonly { readonly label: string }[] }[],
  previous: Record<string, string | true>,
  response: ImQuestionAnswer,
): { answers: Record<string, string | true>; complete: boolean } {
  const index = response.questionIndex !== undefined && response.questionIndex >= 0 && response.questionIndex < questions.length
    ? response.questionIndex
    : uniqueQuestionIndex(questions, response.questionKey);
  const complete = (answers: Record<string, string | true>) => questions.length > 0 && questions.every((_, item) => answers[`q_${item}`] !== undefined);
  if (index === undefined) return { answers: previous, complete: complete(previous) };
  const question = questions[index]!;
  const label = (id: string) => {
    const match = new RegExp(`^opt_${index}_(\\d+)$`).exec(id);
    return match === null ? id : question.options[Number(match[1])]?.label ?? id;
  };
  const value = response.kind === 'single'
    ? label(response.optionIds?.[0] ?? '')
    : response.kind === 'multi'
      ? (response.optionIds ?? []).map(label).join(', ')
      : response.kind === 'other'
        ? response.text ?? ''
        : [...(response.optionIds ?? []).map(label), response.text ?? ''].filter((item) => item !== '').join(', ');
  const answers: Record<string, string | true> = { ...previous, [`q_${index}`]: value };
  if (questions.filter((item) => item.question === question.question).length === 1) answers[question.question] = value;
  return { answers, complete: complete(answers) };
}

function uniqueQuestionIndex(questions: readonly { readonly question: string }[], key: string | undefined): number | undefined {
  if (key === undefined) return questions.length === 1 ? 0 : undefined;
  const matches = questions.flatMap((item, index) => item.question === key ? [index] : []);
  return matches.length === 1 ? matches[0] : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

interface ReplySelectorMessage {
  readonly id?: string;
  readonly role: string;
  readonly origin?: { readonly kind?: string };
  readonly source?: { readonly turnId?: number };
}

export function visibleReplyMessages<T extends ReplySelectorMessage>(messages: readonly T[], promptId: string, turnId?: number): T[] {
  const resolved = turnId ?? messages.find((message) => message.id === promptId)?.source?.turnId;
  if (typeof resolved === 'number') {
    return messages.filter((message) => message.role === 'assistant' && message.source?.turnId === resolved);
  }
  const start = messages.findIndex((message) => message.id === promptId);
  if (start < 0) return [];
  const selected: T[] = [];
  for (const message of messages.slice(start + 1)) {
    if (message.role === 'user' && message.origin?.kind !== 'injection') break;
    if (message.role === 'assistant') selected.push(message);
  }
  return selected;
}

async function mediaBytes(part: ContentPart, store: ISessionMediaStore): Promise<ImVisibleMedia | undefined> {
  if (part.type !== 'image_url' && part.type !== 'audio_url' && part.type !== 'video_url') return undefined;
  const ref = part.type === 'image_url' ? part.imageUrl : part.type === 'audio_url' ? part.audioUrl : part.videoUrl;
  const kind = part.type === 'image_url' ? 'image' : part.type === 'audio_url' ? 'audio' : 'file';
  const data = /^data:([^;]+);base64,([\s\S]*)$/u.exec(ref.url);
  if (data !== null) return { kind, name: ref.name ?? kind, mediaType: data[1]!, bytes: Buffer.from(data[2]!, 'base64') };
  const daemon = /^kimi-file:\/\/([^?]*)/u.exec(ref.url);
  if (daemon === null) return undefined;
  const file = await store.read(decodeURIComponent(daemon[1] ?? ''));
  if (file === undefined) return undefined;
  return { kind, name: ref.name ?? file.name, mediaType: ref.mimeType ?? 'application/octet-stream', bytes: file.data };
}
