import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { atomicWrite } from '@kiki/agent-core-v2/_base/utils/fs';
import { abortable } from '@kiki/agent-core-v2/_base/utils/abort';

import {
  agentScopeOf,
  ErrorCodes,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentStateService,
  IBootstrapService,
  IAgentContextMemoryService,
  IConfigService,
  IBotService,
  IEventService,
  IFileService,
  IHostProcessService,
  ISessionActivityView,
  ISessionApprovalService,
  sessionScopeOf,
  workspacePersistenceScope,
  ISessionContext,
  ISessionIndex,
  ISessionInteractionService,
  ISessionManager,
  ISessionMediaStore,
  ISessionMetadata,
  ISessionQuestionService,
  ITelemetryService,
  IWorkAdmissionService,
  applyPromptMetadataUpdate,
  ensureMainAgent,
  isError2,
  promptMetadataTextFromContentParts,
  reservePrompt,
  sessionMediaOriginalsDir,
  type ContentPart,
  type QuestionRequest,
  type Scope,
  type SessionApprovalRequest,
} from '@kiki/agent-core-v2';
import {
  messageContentSchema,
  type AsrTranscribeInput,
  type ImProviderKind,
  type MessageContent,
  type PromptSubmission,
} from '@kiki/protocol';
import type { IAgentScopeHandle } from '@kiki/agent-core-v2/_base/di/scope';
import { IAgentToolExecutorService } from '@kiki/agent-core-v2/agent/toolExecutor/toolExecutor';
import { promptIdentityKey } from '@kiki/agent-core-v2/agent/prompt/promptService';
import { SEND_MESSAGE_SECTION, type SendMessageConfig } from '@kiki/agent-core-v2/agent/tools/message/configSection';
import type { ImBinding, ImMessageMetadata, ImPolicy } from '@nb-corp/im-bridge-core/imSession';
import { createSafeHttpTransport } from '@nb-corp/nb-im';

import { IUserMessageRouter } from '@kiki/agent-core-v2/app/bot/messageRouting';
import { IImMessageHistoryReader } from '@kiki/agent-core-v2/app/bot/imMessageHistory';
import { IAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/interface/atomicDocumentStore';
import { IPluginHostService } from '@kiki/agent-core-v2/app/plugin/pluginHostService';
import { PluginImAdapterBridge } from './pluginAdapter';
import { parseMediaBlobRef } from '@kiki/transcript';
import { IBlobStore } from '@kiki/agent-core-v2/persistence/interface/blobStore';
import { audioWavAttachmentPath, convertAudioToWav } from '../../lib/ffmpegAudio';
import { contentToCoreParts, resolvePromptMediaFiles, sanitizeAttachmentName } from '../../lib/promptMedia';
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
  warn?(fields: Record<string, string | number | boolean>, message: string): void;
}

type ImReplaceContent = Parameters<NonNullable<ImSessionPorts['sessions']['replace']>>[2];

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
  let activeBridge: ImSessionBridge | undefined;
  const ports = new NotificationSessionPorts(input.core, input.homeDir, input.notifications, input.logger, plugins,
    () => activeBridge?.policy() ?? { allowed: true, default_enabled: true },
    async () => (await activeBridge!.snapshot()).bindings);
  const fetchImpl = input.wechatFetch ?? ((url, init) => globalThis.fetch(url, init));
  const wechatLogin = new WechatQrLogin(fetchImpl, () => ports.wechatTokens(), async (credential) => ports.credentials.create!({ providerKind: 'wechat_bridge', credential }));
  const bridge = new ImSessionBridge({ ports, factories, locale: () => readHostLocale(input.homeDir), wechatLogin });
  activeBridge = bridge;
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
      listChannels: (sessionId) => bridge.channelViews(sessionId),
      allowChannelBorrowing: async () => (await bridge.snapshot()).policy.allow_channel_borrowing ?? false,
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
  private readonly settledSteerPrompts = new Set<string>();
  private readonly replyDeliveries = new WeakMap<IAgentScopeHandle, Map<string, Set<string>>>();
  private readonly replyDestinations = new WeakMap<IAgentScopeHandle, Map<string, readonly string[]>>();

  constructor(
    private readonly core: Scope,
    private readonly homeDir: string,
    private readonly notificationService: NotificationService,
    readonly logger: HostLogger,
    private readonly plugins: PluginImAdapterBridge,
    private readonly readPolicy: () => ImPolicy,
    private readonly readBindings: () => Promise<readonly ImBinding[]>,
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
    remove: async (instanceId: string): Promise<void> => {
      const settings = this.notificationService.getSettings();
      if (!Object.hasOwn(settings.provider_instances, instanceId)) return;
      const usedByAlertChannel = Object.values(settings.channels).some((channel) => channel.provider_instance_id === instanceId);
      if (usedByAlertChannel) return;
      await this.notificationService.deleteInstance(instanceId);
    },
  };

  readonly sessions: ImSessionPorts['sessions'] = {
    listPersonas: async () => (await this.core.accessor.get(IBotService).list()).map((persona) => ({
      id: persona.personaId, name: persona.name, ...(persona.homeSessionId === undefined ? {} : { homeSessionId: persona.homeSessionId }),
    })),
    listSessions: async () => {
      try {
        return (await this.core.accessor.get(ISessionIndex).listRecent({ limit: 50 })).items.map((session) => ({
          id: session.id, title: session.title ?? session.id, ...(session.personaId === undefined ? {} : { personaId: session.personaId }),
        }));
      } catch (error) {
        if (isError2(error) && error.code === ErrorCodes.SESSION_INDEX_BUILDING) return [];
        throw error;
      }
    },
    owns: async (sessionId: string) => (await this.core.accessor.get(ISessionIndex).get(sessionId)) !== undefined,
    ensureHome: async (personaId: string) => {
      const home = await this.core.accessor.get(IBotService).ensureHomeSession(personaId);
      return { homeSessionId: home.homeSessionId };
    },
    setHome: async (personaId: string, sessionId: string) => { await this.core.accessor.get(IBotService).setHomeSession(personaId, sessionId); },
    activity: (sessionId: string) => this.inSession(sessionId, async (session) => {
      const agent = await ensureMainAgent(session);
      this.observeReplyDeliveries(agent);
      const prompt = agent.accessor.get(IAgentPromptService);
      const loop = agent.accessor.get(IAgentLoopService);
      const queue = prompt.list();
      const state = session.accessor.get(ISessionActivityView).state();
      return { busy: state.busy, pending: state.pendingInteraction, queueLength: queue.pending.length, ...(queue.active === undefined ? {} : { activePromptId: queue.active.id }), ...(loop.status().activeTurnId === undefined ? {} : { activeTurnId: loop.status().activeTurnId }) };
    }),
    submit: (input) => this.submit(input),
    steer: (sessionId, promptId) => {
      if (this.settledSteerPrompts.delete(`${sessionId}:${promptId}`)) return Promise.resolve('queued' as const);
      return this.inSession(sessionId, async (session) => {
        const agent = await ensureMainAgent(session);
        const prompt = agent.accessor.get(IAgentPromptService);
        const activeTurnId = agent.accessor.get(IAgentLoopService).status().activeTurnId;
        const pending = () => prompt.list().pending.some((item) => item.id === promptId);
        if (!pending()) return imNativeSteerState(prompt, promptId) ?? 'started';
        try {
          const [handle] = await prompt.acceptSteer([promptId], activeTurnId);
          return imNativeSteerState(prompt, promptId) ?? (wasSteeredIntoTurn(prompt, handle, activeTurnId) ? 'steered' : pending() ? 'queued' : 'started');
        } catch (error) {
          if (!isError2(error) || (error.code !== ErrorCodes.PROMPT_NOT_FOUND && error.code !== ErrorCodes.REQUEST_INVALID)) throw error;
          return imNativeSteerState(prompt, promptId) ?? (pending() ? 'queued' : 'started');
        }
      });
    },
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
    replace: (sessionId, promptId, content) => this.replaceQueuedPrompt(sessionId, promptId, content),
    retract: (sessionId, promptId) => this.retractQueuedPrompt(sessionId, promptId),
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

  private submit(input: Parameters<ImSessionPorts['sessions']['submit']>[0]): Promise<ImSubmitResult> {
    return this.core.accessor.get(IWorkAdmissionService).run('im-prompt', () => this.submitAdmitted(input));
  }

  private async submitAdmitted(input: Parameters<ImSessionPorts['sessions']['submit']>[0]): Promise<ImSubmitResult> {
    const isSteer = input.delivery !== 'queue';
    const live = isSteer ? this.core.accessor.get(ISessionManager).get(input.sessionId) : undefined;
    const liveAgent = isSteer ? live?.accessor.get(IAgentLifecycleService).get('main') : undefined;
    const steerTarget = isSteer
      ? {
          turnId: liveAgent?.accessor.get(IAgentLoopService).status().activeTurnId,
          promptId: liveAgent?.accessor.get(IAgentPromptService).list().active?.id ?? liveAgent?.accessor.get(IAgentPromptService).list().launching?.id,
        }
      : undefined;
    return this.inSession(input.sessionId, async (session) => {
      const agent = await ensureMainAgent(session);
      this.observeReplyDeliveries(agent);
      if (input.im !== undefined) {
        const destinations = this.replyDestinations.get(agent) ?? new Map<string, readonly string[]>();
        if (destinations.size >= 256) destinations.delete(destinations.keys().next().value!);
        destinations.set(input.promptId, replyChannelIds(input.sessionId, input.im, await this.readBindings()));
        this.replyDestinations.set(agent, destinations);
      }
      const prompt = agent.accessor.get(IAgentPromptService);
      const known = prompt.lookup(input.promptId);
      if (known !== undefined) {
        return {
          duplicate: true,
          promptId: input.promptId,
          turnId: known.turnId,
          deliveryState: imDuplicateDeliveryState(prompt, input.promptId),
        };
      }
      const content = input.content.map((part) => messageContentSchema.parse(part));
      const profile = agent.accessor.get(IAgentProfileService);
      const sessionMedia = session.accessor.get(ISessionMediaStore);
      const sessionDir = session.accessor.get(ISessionContext).sessionDir;
      const prepared = await resolvePromptMediaFiles(content, this.core.accessor.get(IFileService), this.core.accessor.get(IBootstrapService).cacheDir, {
        telemetry: this.core.accessor.get(ITelemetryService).withContext({ sessionId: input.sessionId }),
        sessionMedia,
        providerType: profile.getModelProviderType(),
        resolveOriginalsDir: async () => sessionMediaOriginalsDir(sessionDir),
        resolveAttachmentsDir: async () => join(sessionDir, 'attachments'),
      });
      const isNative = (profile.data().executorId ?? 'native') === 'native';
      const reservation = reservePrompt(prompt, input.promptId, true, undefined, {
        waitForLaunch: isSteer ? false : undefined,
        nativeSteer: isSteer && isNative ? { turnId: steerTarget?.turnId } : undefined,
        contentRanges: prepared.sourceRanges,
      });
      let enqueued = false;
      try {
        const parts = contentToCoreParts(prepared.content);
        await applyPromptMetadataUpdate(
          {
            metadata: session.accessor.get(ISessionMetadata),
            eventService: this.core.accessor.get(IEventService),
            sessionId: input.sessionId,
          },
          promptMetadataTextFromContentParts(parts),
        );
        const handle = await reservation.submit({
          role: 'user',
          content: parts,
          toolCalls: [],
          providerMessageId: input.im?.source_message_id,
          origin: { kind: 'user', im: input.im },
        });
        enqueued = true;
        void Promise.race([handle.launched, handle.completion]).then(() => prepared.discard(), () => prepared.discard());
        if (!isSteer) {
          const pending = prompt.list().pending.some((item) => item.id === handle.id);
          return { duplicate: false, promptId: handle.id, turnId: prompt.lookup(handle.id)?.turnId, deliveryState: pending ? 'queued' : 'pending' };
        }
        const native = imNativeSteerState(prompt, handle.id);
        if (native !== undefined) {
          return {
            duplicate: false,
            promptId: handle.id,
            turnId: prompt.lookup(handle.id)?.turnId,
            deliveryState: native === 'started' ? 'pending' : native,
          };
        }
        const queue = prompt.list();
        const pending = queue.pending.find((item) => item.id === handle.id);
        if (pending === undefined) {
          return { duplicate: false, promptId: handle.id, turnId: prompt.lookup(handle.id)?.turnId, deliveryState: 'pending' };
        }
        const activeTurnId = agent.accessor.get(IAgentLoopService).status().activeTurnId;
        const activePromptId = queue.active?.id ?? queue.launching?.id;
        const settleQueued = (): ImSubmitResult => {
          this.settledSteerPrompts.add(`${input.sessionId}:${handle.id}`);
          return { duplicate: false, promptId: handle.id, turnId: prompt.lookup(handle.id)?.turnId, deliveryState: 'queued' };
        };
        if ((activeTurnId !== undefined && activeTurnId !== steerTarget?.turnId) ||
            (activePromptId !== undefined && activePromptId !== steerTarget?.promptId)) {
          return settleQueued();
        }
        let steered: typeof handle | undefined;
        try {
          [steered] = await prompt.acceptSteer([handle.id], activeTurnId);
        } catch (error) {
          if (!isError2(error) || (error.code !== ErrorCodes.PROMPT_NOT_FOUND && error.code !== ErrorCodes.REQUEST_INVALID)) throw error;
          const stillPending = prompt.list().pending.some((item) => item.id === handle.id);
          return stillPending ? settleQueued() : { duplicate: false, promptId: handle.id, turnId: prompt.lookup(handle.id)?.turnId, deliveryState: 'pending' };
        }
        const steeredIntoTurn = wasSteeredIntoTurn(prompt, steered, activeTurnId);
        const stillPending = steered?.state === 'pending' || prompt.list().pending.some((item) => item.id === handle.id);
        return steeredIntoTurn
          ? { duplicate: false, promptId: handle.id, turnId: prompt.lookup(handle.id)?.turnId, deliveryState: 'steered' }
          : stillPending
            ? settleQueued()
            : { duplicate: false, promptId: handle.id, turnId: prompt.lookup(handle.id)?.turnId, deliveryState: 'pending' };
      } catch (error) {
        if (!enqueued) await prepared.discard();
        if (isError2(error) && error.code === ErrorCodes.PROMPT_ID_CONFLICT) {
          return {
            duplicate: true,
            promptId: input.promptId,
            turnId: prompt.lookup(input.promptId)?.turnId,
            deliveryState: imDuplicateDeliveryState(prompt, input.promptId),
          };
        }
        throw error;
      } finally {
        await reservation.dispose();
      }
    });
  }

  private async saveMedia(input: { sessionId: string; kind: 'image' | 'file' | 'audio' | 'video'; name: string; mediaType: string; bytes: Uint8Array; text?: string; voice?: boolean; signal?: AbortSignal }): Promise<readonly MessageContent[]> {
    return this.inSession(input.sessionId, async (session) => {
      input.signal?.throwIfAborted();
      const sessionDir = session.accessor.get(ISessionContext).sessionDir;
      const attachmentsDir = join(sessionDir, 'attachments');
      const safe = sanitizeAttachmentName(input.name);
      const fileId = `f_${randomUUID().replaceAll('-', '')}`;
      const bytes = Buffer.from(input.bytes);
      const media = session.accessor.get(ISessionMediaStore);
      const originalPath = await media.materialize({
        fileId,
        size: bytes.byteLength,
        name: safe,
        mimeType: input.mediaType,
        stream: () => Readable.from(bytes),
        signal: input.signal,
      });
      await mkdir(attachmentsDir, { recursive: true });
      await atomicWrite(join(attachmentsDir, `${fileId}-${safe}`), bytes, undefined, undefined, input.signal);
      input.signal?.throwIfAborted();
      const content: MessageContent[] = input.text === undefined || input.text.length === 0 ? [] : [{ type: 'text', text: input.text }];
      const voice = input.voice === true && input.mediaType.toLowerCase().startsWith('audio/');
      if (input.kind === 'file' && !voice) {
        content.push({ type: 'file', file_id: fileId, name: safe, media_type: input.mediaType, size: bytes.byteLength });
        return content;
      }
      if (input.kind === 'audio' || voice) {
        const transcript = await this.transcribeInboundAudio({ fileId, mediaType: input.mediaType, signal: input.signal, originalPath, attachmentsDir });
        content.push({ type: 'audio', name: safe, source: { kind: 'session_media', file_id: fileId } });
        if (transcript !== undefined) content.push({ type: 'text', text: `Audio transcription: ${transcript}` });
        return content;
      }
      if (input.kind === 'image' || input.kind === 'video') {
        content.push({ type: input.kind, name: safe, source: { kind: 'session_media', file_id: fileId } });
      }
      return content;
    }, input.signal);
  }

  private async transcribeInboundAudio(input: {
    fileId: string;
    mediaType: string;
    signal?: AbortSignal;
    originalPath: string | undefined;
    attachmentsDir: string;
  }): Promise<string | undefined> {
    const policy = this.readPolicy();
    if (policy.asr_mode === 'off') {
      this.warnAsr('off');
      return undefined;
    }
    if (input.originalPath === undefined) {
      this.warnAsr('audio_path_missing');
      return undefined;
    }
    const timeout = AbortSignal.timeout(45_000);
    const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
    try {
      const sendMessageConfig = this.core.accessor.get(IConfigService).get<SendMessageConfig | undefined>(SEND_MESSAGE_SECTION);
      const configuredFfmpeg = sendMessageConfig?.ffmpegPath?.trim();
      const wavPath = audioWavAttachmentPath(input.attachmentsDir, input.fileId);
      const convertedPath = await convertAudioToWav(input.originalPath, wavPath, signal, this.core.accessor.get(IHostProcessService), configuredFfmpeg || 'ffmpeg');
      signal.throwIfAborted();
      const plugins = this.core.accessor.get(IPluginHostService);
      const requested = policy.asr_provider?.trim();
      let providerRef = requested;
      if (providerRef === undefined || providerRef.length === 0) {
        const registrations = await abortable(plugins.listAsrProviders(), signal);
        signal.throwIfAborted();
        const registration = registrations[0];
        if (registration === undefined) {
          this.warnAsr('provider_missing');
          return undefined;
        }
        providerRef = `${registration.pluginId}/${registration.definition.id}`;
      }
      const request: AsrTranscribeInput = { wavPath: convertedPath, originalPath: input.originalPath, mediaType: 'audio/wav' };
      const result = await plugins.transcribeAudio(providerRef, request, signal);
      signal.throwIfAborted();
      const text = result.text.trim();
      if (text.length === 0) {
        this.warnAsr('empty_transcription');
        return undefined;
      }
      return text;
    } catch {
      if (input.signal?.aborted) input.signal.throwIfAborted();
      this.warnAsr(timeout.aborted ? 'timeout' : 'failed');
      return undefined;
    }
  }

  private warnAsr(outcome: string): void {
    const fields = { asr: outcome };
    if (this.logger.warn !== undefined) this.logger.warn(fields, 'IM audio transcription unavailable');
    else this.logger.info(fields, 'IM audio transcription unavailable');
  }

  private replaceQueuedPrompt(sessionId: string, promptId: string, content: ImReplaceContent): Promise<boolean> {
    return this.inSession(sessionId, async (session) => {
      const agent = session.accessor.get(IAgentLifecycleService).get('main');
      if (agent === undefined) return false;
      const prompt = agent.accessor.get(IAgentPromptService);
      if (!prompt.list().pending.some((item) => item.id === promptId)) return false;
      const profile = agent.accessor.get(IAgentProfileService);
      const sessionMedia = session.accessor.get(ISessionMediaStore);
      const sessionDir = session.accessor.get(ISessionContext).sessionDir;
      const validatedContent = content.map((part) => messageContentSchema.parse(part) as PromptSubmission['content'][number]);
      const prepared = await resolvePromptMediaFiles(validatedContent, this.core.accessor.get(IFileService), this.core.accessor.get(IBootstrapService).cacheDir, {
        telemetry: this.core.accessor.get(ITelemetryService).withContext({ sessionId }),
        sessionMedia,
        providerType: profile.getModelProviderType(),
        resolveOriginalsDir: async () => sessionMediaOriginalsDir(sessionDir),
        resolveAttachmentsDir: async () => join(sessionDir, 'attachments'),
      });
      try {
        if (!prompt.list().pending.some((item) => item.id === promptId)) return false;
        prompt.replace(promptId, contentToCoreParts(prepared.content), true);
        return true;
      } catch (error) {
        if (isError2(error) && error.code === ErrorCodes.PROMPT_NOT_FOUND) return false;
        throw error;
      } finally {
        await prepared.discard();
      }
    });
  }

  private retractQueuedPrompt(sessionId: string, promptId: string): Promise<boolean> {
    return this.inSession(sessionId, async (session) => {
      const agent = session.accessor.get(IAgentLifecycleService).get('main');
      if (agent === undefined) return false;
      return agent.accessor.get(IAgentPromptService).abortQueued(promptId);
    });
  }

  private observeReplyDeliveries(agent: IAgentScopeHandle): void {
    if (this.replyDeliveries.has(agent)) return;
    const delivered = new Map<string, Set<string>>();
    this.replyDeliveries.set(agent, delivered);
    agent.accessor.get(IAgentToolExecutorService).hooks.onDidExecuteTool.register('im-reply-delivery', async (context, next) => {
      await next();
      if (context.toolCall.name !== 'SendMessage' || context.result.isError === true) return;
      const channels = deliveredUserChannels(typeof context.result.output === 'string' ? context.result.output : '');
      if (channels.size === 0) return;
      const to = recordOf(context.args)?.['to'];
      if (to !== undefined && to !== 'user') return;
      let promptId: string | undefined;
      for (const identity of agent.accessor.get(IAgentStateService).get(promptIdentityKey).values()) {
        if (identity.turnId === context.turnId) promptId = identity.promptId;
      }
      if (promptId !== undefined) {
        if (delivered.size >= 256) delivered.delete(delivered.keys().next().value!);
        const prior = delivered.get(promptId) ?? new Set<string>();
        for (const channel of channels) prior.add(channel);
        delivered.set(promptId, prior);
      }
    });
  }

  private async readVisible(sessionId: string, promptId: string, turnId?: number): Promise<ImVisibleReply> {
    return this.inSession(sessionId, async (session) => {
      const agent = await ensureMainAgent(session);
      this.observeReplyDeliveries(agent);
      const prompt = agent.accessor.get(IAgentPromptService);
      const resolvedTurnId = turnId ?? prompt.lookup(promptId)?.turnId;
      const messages = agent.accessor.get(IAgentContextMemoryService).get();
      const identities = agent.accessor.get(IAgentStateService).get(promptIdentityKey);
      let latestPromptId: string | undefined;
      for (const identity of identities.values()) {
        if (identity.turnId === resolvedTurnId) latestPromptId = identity.promptId;
      }
      const origin = messages.find(message => message.id === promptId)?.origin;
      const metadata = origin?.kind === 'user' ? origin.im : undefined;
      let destinations = this.replyDestinations.get(agent)?.get(promptId);
      if (destinations === undefined && metadata !== undefined) {
        destinations = replyChannelIds(sessionId, metadata, await this.readBindings());
        const retained = this.replyDestinations.get(agent) ?? new Map<string, readonly string[]>();
        if (retained.size >= 256) retained.delete(retained.keys().next().value!);
        retained.set(promptId, destinations);
        this.replyDestinations.set(agent, retained);
      }
      const channels = this.replyDeliveries.get(agent)?.get(promptId);
      const delivered = destinations !== undefined && destinations.some(channel => channels?.has(channel));
      const selected = visibleReplyMessages(messages, promptId, resolvedTurnId, latestPromptId, delivered, destinations);
      const text = selected.flatMap((message) => message.content.flatMap((part) => part.type === 'text' ? [part.text] : [])).join('');
      const media: ImVisibleMedia[] = [];
      const store = session.accessor.get(ISessionMediaStore);
      for (const message of selected) {
        for (const part of message.content) {
          const item = await mediaBytes(part, store);
          if (item !== undefined) media.push(item);
        }
      }
      const queue = prompt.list();
      const live = queue.active?.id === promptId || queue.launching?.id === promptId || queue.pending.some((item) => item.id === promptId);
      const turnLive = resolvedTurnId !== undefined && agent.accessor.get(IAgentLoopService).status().activeTurnId === resolvedTurnId;
      const inFlight = prompt.lookup(promptId)?.terminal === undefined;
      return { text, done: !live && !turnLive && !inFlight, media };
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

function imNativeSteerState(prompt: IAgentPromptService, id: string): 'accepted' | 'steered' | 'started' | undefined {
  const receipt = prompt.lookup(id);
  if (!receipt?.steerAccepted) return undefined;
  if (receipt.steered) return 'steered';
  if (receipt.turnId !== undefined || receipt.terminal !== undefined) return 'started';
  return 'accepted';
}

function imDuplicateDeliveryState(prompt: IAgentPromptService, id: string): ImSubmitResult['deliveryState'] {
  const native = imNativeSteerState(prompt, id);
  if (native !== undefined) return native === 'started' ? 'pending' : native;
  return prompt.list().pending.some((item) => item.id === id) ? 'queued' : 'pending';
}

function wasSteeredIntoTurn(
  prompt: IAgentPromptService,
  handle: { readonly id: string; readonly state: string } | undefined,
  turnId?: number,
): boolean {
  return handle !== undefined && (handle.state === 'steered' || (turnId !== undefined && prompt.lookup(handle.id)?.turnId === turnId));
}

interface ReplySelectorMessage {
  readonly id?: string;
  readonly role: string;
  readonly origin?: { readonly kind?: string };
  readonly source?: { readonly turnId?: number };
  readonly toolCalls?: readonly { readonly id: string; readonly name?: string; readonly function?: { readonly name: string } }[];
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
}

function isReplyPrompt(message: ReplySelectorMessage): boolean {
  return message.role === 'user' && (message.origin === undefined || message.origin.kind === 'user');
}

export function replyChannelIds(sessionId: string, metadata: ImMessageMetadata, bindings: readonly ImBinding[]): readonly string[] {
  return bindings.filter(binding => {
    if (binding.session_id !== sessionId || binding.provider_instance_id !== metadata.provider_instance_id || binding.account_id !== metadata.account_id) return false;
    const identity = binding.identity;
    const incoming = metadata.identity;
    if (identity.chat_id !== incoming.chat_id) return false;
    const scope = binding.binding_scope ?? 'sender';
    if (scope === 'chat') return identity.chat_kind === 'group' && incoming.chat_kind === 'group';
    if (identity.topic_id !== incoming.topic_id) return false;
    return scope === 'topic' && identity.topic_id !== '0'
      ? identity.chat_kind === 'group' && incoming.chat_kind === 'group' : identity.sender_id === incoming.sender_id;
  }).map(binding => `im:${binding.id}`);
}

function isDeliveredUserChannelReceipt(channel: Record<string, unknown> | undefined): boolean {
  if (channel === undefined || channel['borrowed'] === true) return false;
  if (channel['status'] === 'delivered') return true;
  if (channel['status'] !== 'partial') return false;
  const detail = typeof channel['detail'] === 'string' ? channel['detail'] : undefined;
  if (
    detail === 'text_failed' ||
    detail?.startsWith('text_failed:') ||
    detail === 'text_empty' ||
    detail?.startsWith('text_empty:')
  ) {
    return false;
  }
  if (Array.isArray(channel['unsupported']) && channel['unsupported'].length > 0) return true;
  if (detail !== undefined && detail.length > 0) return true;
  const messageIds = channel['message_ids'];
  return !Array.isArray(messageIds) || messageIds.some((id) => typeof id === 'string' && id.length > 0);
}

function deliveredUserChannels(output: string): Set<string> {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return new Set();
  }
  const receipt = recordOf(value);
  const messages = Array.isArray(receipt?.['messages']) ? receipt['messages'].map(recordOf) : [receipt];
  let delivered: Set<string> | undefined;
  for (const message of messages) {
    if (
      !Array.isArray(message?.['delivered_to']) ||
      !message['delivered_to'].includes('user') ||
      !Array.isArray(message['channels'])
    ) {
      return new Set();
    }
    if (message['voice_only'] === true) continue;
    const channels = new Set<string>();
    for (const item of message['channels']) {
      const channel = recordOf(item);
      if (typeof channel?.['channel_id'] === 'string' && channel['channel_id'].startsWith('im:') &&
          isDeliveredUserChannelReceipt(channel)) channels.add(channel['channel_id']);
    }
    delivered = delivered === undefined ? channels : new Set([...delivered].filter(channel => channels.has(channel)));
  }
  return delivered ?? new Set();
}

export function visibleReplyMessages<T extends ReplySelectorMessage>(messages: readonly T[], promptId: string, turnId?: number, latestPromptId?: string, delivered = false, destinations?: readonly string[]): T[] {
  if (delivered) return [];
  const promptIndex = messages.findIndex((message) => message.id === promptId);
  const resolved = turnId ?? (promptIndex >= 0 ? messages[promptIndex]?.source?.turnId : undefined);
  if (promptIndex < 0 && (resolved === undefined || latestPromptId !== undefined && latestPromptId !== promptId ||
    messages.some((message) => isReplyPrompt(message) && message.source?.turnId === resolved))) return [];
  const selected: T[] = [];
  const sends = new Set<string>();
  for (let index = promptIndex + 1; index < messages.length; index++) {
    const message = messages[index]!;
    if (promptIndex >= 0 && isReplyPrompt(message)) break;
    if (resolved !== undefined && message.source?.turnId !== resolved) continue;
    if (message.role === 'assistant') {
      selected.push(message);
      for (const call of message.toolCalls ?? []) {
        if (call.name === 'SendMessage' || call.function?.name === 'SendMessage') sends.add(call.id);
      }
    } else if (message.role === 'tool' && message.isError !== true && message.toolCallId !== undefined && sends.has(message.toolCallId)) {
      const output = (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('');
      const channels = deliveredUserChannels(output);
      if (destinations === undefined ? channels.size > 0 : destinations.some(channel => channels.has(channel))) return [];
    }
  }
  return selected;
}

const OUTBOUND_MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  'text/html': '.html',
  'text/markdown': '.md',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

const SOURCE_EXTENSION_RE = /(?=\.[A-Za-z0-9]*[A-Za-z])(\.(?:tar\.(?:gz|bz2|xz|zst)|[A-Za-z0-9]{1,12}))$/u;
const HAS_REAL_EXTENSION_RE = /\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,12}$/u;

function sanitizeOutboundName(raw: string | undefined): string {
  return (raw ?? '').replaceAll(/[/\\\0]/gu, '').trim();
}

/** Resolves an IM outbound attachment filename, preserving or inferring the file extension when a display title omits it. */
export function resolveOutboundFilename(
  preferred: string | undefined,
  fallbackFilename: string | undefined,
  mediaType: string,
): string {
  const safePreferred = sanitizeOutboundName(preferred);
  const safeFallback = sanitizeOutboundName(fallbackFilename);
  const base = safePreferred || safeFallback || 'file';
  if (HAS_REAL_EXTENSION_RE.test(base)) return base;
  const sourceMatch = SOURCE_EXTENSION_RE.exec(safeFallback);
  const normalizedMime = mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const ext = sourceMatch?.[1] ?? OUTBOUND_MEDIA_EXTENSIONS[normalizedMime];
  return ext !== undefined ? `${base}${ext}` : base;
}

async function mediaBytes(part: ContentPart, store: ISessionMediaStore): Promise<ImVisibleMedia | undefined> {
  if (part.type !== 'image_url' && part.type !== 'audio_url' && part.type !== 'video_url') return undefined;
  const ref = part.type === 'image_url' ? part.imageUrl : part.type === 'audio_url' ? part.audioUrl : part.videoUrl;
  const kind = part.type === 'image_url' ? 'image' : part.type === 'audio_url' ? 'audio' : 'file';
  const data = /^data:([^;]+);base64,([\s\S]*)$/u.exec(ref.url);
  if (data !== null) return { kind, name: resolveOutboundFilename(ref.name, kind, data[1]!), mediaType: data[1]!, bytes: Buffer.from(data[2]!, 'base64') };
  const daemon = /^kimi-file:\/\/([^?]*)/u.exec(ref.url);
  if (daemon === null) return undefined;
  const file = await store.read(decodeURIComponent(daemon[1] ?? ''));
  if (file === undefined) return undefined;
  const mediaType = ref.mimeType ?? 'application/octet-stream';
  return { kind, name: resolveOutboundFilename(ref.name, file.name, mediaType), mediaType, bytes: file.data };
}
