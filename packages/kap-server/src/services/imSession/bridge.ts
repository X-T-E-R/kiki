import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { Error2, ErrorCodes } from '@kiki/agent-core-v2';
import { ImIdentityAlreadyBoundError, ImSessionBridge as CoreImSessionBridge } from '@nb-corp/im-bridge-core/bridge';
import { MessageRoutingError } from '@nb-corp/im-bridge-core/userMessageRouting';

import { ImSendError, type ImAdapterFactory, type ImSessionAdapter } from './adapter';
import type { ImSessionBridgeOptions } from './ports';

export { ImIdentityAlreadyBoundError };

interface StoredBindingSummary {
  readonly id: string;
  readonly providerInstanceId: string;
  readonly providerKind: string;
  readonly identity: {
    readonly chatId: string;
    readonly senderId: string;
    readonly topicId: string;
  };
}

interface StoredPartialChannel {
  status?: unknown;
  messageIds?: unknown;
  unsupported?: unknown;
  detail?: unknown;
}

interface TextSendOutcomes {
  readonly receiptKey: string;
  readonly textEmpty: boolean;
  readonly delivered: Set<string>;
  readonly failed: Set<string>;
}

const MAX_CLASSIFIED_DETAILS = 1024;

function adapterTokenKey(providerKind: string, credential: string | undefined, fallbackInstanceId: string): string {
  if (credential !== undefined && credential.length > 0) {
    return createHash('sha256').update(`${providerKind}\0${credential}`).digest('hex');
  }
  return `instance:${fallbackInstanceId}`;
}

function textTargetKey(tokenKey: string, chatId: string, senderId: string, topicId: string): string {
  return JSON.stringify([tokenKey, chatId, senderId, topicId]);
}

function rememberClassifiedDetail(cache: Map<string, string>, key: string, detail: string): void {
  if (cache.has(key)) cache.delete(key);
  else if (cache.size >= MAX_CLASSIFIED_DETAILS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, detail);
}

function bindingTargetKey(
  channelId: string,
  bindingsByChannelId: ReadonlyMap<string, StoredBindingSummary>,
  readCredential: (instanceId: string) => string | undefined,
): string | undefined {
  const binding = bindingsByChannelId.get(channelId);
  if (binding === undefined) return undefined;
  const tokenKey = adapterTokenKey(binding.providerKind, readCredential(binding.providerInstanceId), binding.providerInstanceId);
  return textTargetKey(tokenKey, binding.identity.chatId, binding.identity.senderId, binding.identity.topicId);
}

function classifyPartialDetail(
  channelId: string,
  currentDetail: string | undefined,
  messageIdsCount: number,
  unsupportedCount: number,
  outcomes: TextSendOutcomes,
  bindingsByChannelId: ReadonlyMap<string, StoredBindingSummary>,
  readCredential: (instanceId: string) => string | undefined,
): string | undefined {
  if (outcomes.textEmpty) {
    if (currentDetail === 'text_empty' || currentDetail?.startsWith('text_empty:')) return currentDetail;
    return currentDetail ? `text_empty:${currentDetail}` : 'text_empty';
  }
  const key = bindingTargetKey(channelId, bindingsByChannelId, readCredential);
  if (key === undefined) return currentDetail;
  if (outcomes.failed.has(key)) {
    if (currentDetail === 'text_failed' || currentDetail?.startsWith('text_failed:')) return currentDetail;
    return currentDetail ? `text_failed:${currentDetail}` : 'text_failed';
  }
  if (outcomes.delivered.has(key) && messageIdsCount === 0 && unsupportedCount === 0 && !currentDetail) {
    return 'attachment_partial';
  }
  return currentDetail;
}

function syncBindingsFromState(parsed: Record<string, unknown>, bindingsByChannelId: Map<string, StoredBindingSummary>): void {
  const rawBindings = parsed['bindings'];
  if (!Array.isArray(rawBindings)) return;
  bindingsByChannelId.clear();
  for (const item of rawBindings) {
    if (item === null || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const id = entry['id'];
    const providerInstanceId = entry['providerInstanceId'];
    const providerKind = entry['providerKind'];
    const identity = entry['identity'];
    if (
      typeof id !== 'string' ||
      typeof providerInstanceId !== 'string' ||
      typeof providerKind !== 'string' ||
      identity === null ||
      typeof identity !== 'object'
    ) {
      continue;
    }
    const idObj = identity as Record<string, unknown>;
    if (
      typeof idObj['chatId'] !== 'string' ||
      typeof idObj['senderId'] !== 'string' ||
      typeof idObj['topicId'] !== 'string'
    ) {
      continue;
    }
    bindingsByChannelId.set(`im:${id}`, {
      id,
      providerInstanceId,
      providerKind,
      identity: {
        chatId: idObj['chatId'],
        senderId: idObj['senderId'],
        topicId: idObj['topicId'],
      },
    });
  }
}

function hydrateClassifiedDetails(parsed: Record<string, unknown>, classifiedDetails: Map<string, string>): void {
  const receipts = parsed['messageReceipts'];
  if (receipts === null || typeof receipts !== 'object') return;
  for (const [receiptKey, rawRecord] of Object.entries(receipts as Record<string, unknown>)) {
    if (rawRecord === null || typeof rawRecord !== 'object') continue;
    const rawChannels = (rawRecord as Record<string, unknown>)['channels'];
    if (rawChannels === null || typeof rawChannels !== 'object') continue;
    for (const [channelId, rawChannel] of Object.entries(rawChannels as Record<string, unknown>)) {
      if (rawChannel === null || typeof rawChannel !== 'object') continue;
      const ch = rawChannel as StoredPartialChannel;
      if (ch.status === 'partial' && typeof ch.detail === 'string' && ch.detail.length > 0) {
        rememberClassifiedDetail(classifiedDetails, `${receiptKey}\0${channelId}`, ch.detail);
      }
    }
  }
}

function wrapAdapter(
  adapter: ImSessionAdapter,
  sendTextContext: AsyncLocalStorage<TextSendOutcomes>,
  tokenKey: string,
): ImSessionAdapter {
  const wrappedSendTextParts: ImSessionAdapter['sendTextParts'] = async (message) => {
    const outcomes = sendTextContext.getStore();
    const key = outcomes === undefined || message.code !== 'send_message'
      ? undefined
      : textTargetKey(tokenKey, message.identity.chatId, message.identity.senderId, message.identity.topicId);
    try {
      const result = await adapter.sendTextParts(message);
      if (key !== undefined) outcomes!.delivered.add(key);
      return result;
    } catch (error) {
      if (key !== undefined && !(error instanceof ImSendError && error.acceptedIds.some((id) => id.length > 0))) {
        outcomes!.failed.add(key);
      }
      throw error;
    }
  };
  return new Proxy(adapter, {
    get: (target, prop) => {
      if (prop === 'sendTextParts') return wrappedSendTextParts;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function proxyFactories(
  factories: readonly ImAdapterFactory[],
  sendTextContext: AsyncLocalStorage<TextSendOutcomes>,
): readonly ImAdapterFactory[] {
  const wrapped = new WeakMap<ImAdapterFactory, ImAdapterFactory>();
  const wrapFactory = (factory: ImAdapterFactory): ImAdapterFactory => {
    const cached = wrapped.get(factory);
    if (cached !== undefined) return cached;
    const proxied = new Proxy(factory, {
      get: (target, prop) => {
        if (prop === 'create') {
          return (config: Parameters<ImAdapterFactory['create']>[0]) => {
            const tokenKey = adapterTokenKey(target.providerKind, config?.credential, config?.instanceId ?? '');
            return wrapAdapter(target.create(config), sendTextContext, tokenKey);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    wrapped.set(factory, proxied);
    return proxied;
  };
  return new Proxy(factories, {
    get: (target, prop) => {
      const value = Reflect.get(target, prop, target);
      if (typeof prop === 'string' && /^\d+$/u.test(prop) && value !== undefined) {
        return wrapFactory(value as ImAdapterFactory);
      }
      return value;
    },
  });
}

export class ImSessionBridge extends CoreImSessionBridge {
  private readonly sendTextContext: AsyncLocalStorage<TextSendOutcomes>;
  private readonly bindingsByChannelId: Map<string, StoredBindingSummary>;
  private readonly classifiedDetails: Map<string, string>;
  private readonly readCredential: (instanceId: string) => string | undefined;
  private readonly ensureBindingsSynced: () => void;

  constructor(options: ImSessionBridgeOptions) {
    const sendTextContext = new AsyncLocalStorage<TextSendOutcomes>();
    const bindingsByChannelId = new Map<string, StoredBindingSummary>();
    const classifiedDetails = new Map<string, string>();
    let latestRawState: string | undefined;
    let bindingsSyncedRaw: string | undefined;
    const ensureBindingsSynced = (): void => {
      if (latestRawState === undefined || bindingsSyncedRaw === latestRawState) return;
      try {
        const parsed = JSON.parse(latestRawState) as unknown;
        if (parsed !== null && typeof parsed === 'object') {
          syncBindingsFromState(parsed as Record<string, unknown>, bindingsByChannelId);
        }
      } catch {}
      bindingsSyncedRaw = latestRawState;
    };
    const readCredential = (instanceId: string): string | undefined => {
      try {
        return options.ports.credentials.read(instanceId);
      } catch {
        return undefined;
      }
    };
    const wrappedLoad: ImSessionBridgeOptions['ports']['load'] = async () => {
      const raw = await options.ports.load();
      if (raw !== undefined && raw.length > 0) {
        latestRawState = raw;
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed !== null && typeof parsed === 'object') {
            syncBindingsFromState(parsed as Record<string, unknown>, bindingsByChannelId);
            hydrateClassifiedDetails(parsed as Record<string, unknown>, classifiedDetails);
            bindingsSyncedRaw = raw;
          }
        } catch {}
      }
      return raw;
    };
    const wrappedSave: ImSessionBridgeOptions['ports']['save'] = async (raw) => {
      const store = sendTextContext.getStore();
      if ((store === undefined && classifiedDetails.size === 0) || !raw.includes('"partial"')) {
        await options.ports.save(raw);
        latestRawState = raw;
        return;
      }
      let outgoing = raw;
      let parsedState: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed !== null && typeof parsed === 'object') {
          parsedState = parsed as Record<string, unknown>;
          const stagedBindings = new Map<string, StoredBindingSummary>();
          syncBindingsFromState(parsedState, stagedBindings);
          let modified = false;
          const receipts = parsedState['messageReceipts'];
          if (store !== undefined && receipts !== null && typeof receipts === 'object') {
            const record = (receipts as Record<string, unknown>)[store.receiptKey];
            const channels = record !== null && typeof record === 'object'
              ? (record as Record<string, unknown>)['channels']
              : undefined;
            if (channels !== null && typeof channels === 'object') {
              for (const [channelId, rawChannel] of Object.entries(channels as Record<string, unknown>)) {
                if (rawChannel === null || typeof rawChannel !== 'object') continue;
                const ch = rawChannel as StoredPartialChannel;
                if (ch.status !== 'partial') continue;
                const key = bindingTargetKey(channelId, stagedBindings, readCredential);
                const hasOutcome = key !== undefined && (store.delivered.has(key) || store.failed.has(key));
                if (!store.textEmpty && !hasOutcome) continue;
                const currentDetail = typeof ch.detail === 'string' ? ch.detail : undefined;
                const nextDetail = classifyPartialDetail(
                  channelId,
                  currentDetail,
                  Array.isArray(ch.messageIds) ? ch.messageIds.length : 0,
                  Array.isArray(ch.unsupported) ? ch.unsupported.length : 0,
                  store,
                  stagedBindings,
                  readCredential,
                );
                if (nextDetail !== undefined && nextDetail.length > 0) {
                  rememberClassifiedDetail(classifiedDetails, `${store.receiptKey}\0${channelId}`, nextDetail);
                  if (nextDetail !== currentDetail) {
                    ch.detail = nextDetail;
                    modified = true;
                  }
                }
              }
            }
          }
          if (classifiedDetails.size > 0 && receipts !== null && typeof receipts === 'object') {
            const receiptMap = receipts as Record<string, unknown>;
            for (const [cacheKey, savedDetail] of classifiedDetails) {
              const separator = cacheKey.indexOf('\0');
              if (separator < 0) continue;
              const record = receiptMap[cacheKey.slice(0, separator)];
              const channels = record !== null && typeof record === 'object'
                ? (record as Record<string, unknown>)['channels']
                : undefined;
              const rawChannel = channels !== null && typeof channels === 'object'
                ? (channels as Record<string, unknown>)[cacheKey.slice(separator + 1)]
                : undefined;
              if (rawChannel === null || typeof rawChannel !== 'object') continue;
              const ch = rawChannel as StoredPartialChannel;
              if (ch.status === 'partial' && ch.detail !== savedDetail) {
                ch.detail = savedDetail;
                modified = true;
              }
            }
          }
          if (modified) outgoing = JSON.stringify(parsedState);
        }
      } catch {}
      await options.ports.save(outgoing);
      latestRawState = outgoing;
      if (parsedState !== undefined) {
        syncBindingsFromState(parsedState, bindingsByChannelId);
        bindingsSyncedRaw = outgoing;
      }
    };
    const wrappedPorts = new Proxy(options.ports, {
      get: (target, prop) => {
        if (prop === 'load') return wrappedLoad;
        if (prop === 'save') return wrappedSave;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    super({
      ...options,
      ports: wrappedPorts,
      factories: proxyFactories(options.factories, sendTextContext),
    } as ConstructorParameters<typeof CoreImSessionBridge>[0]);
    this.sendTextContext = sendTextContext;
    this.bindingsByChannelId = bindingsByChannelId;
    this.classifiedDetails = classifiedDetails;
    this.readCredential = readCredential;
    this.ensureBindingsSynced = ensureBindingsSynced;
  }

  override async sendUserMessage(
    input: Parameters<CoreImSessionBridge['sendUserMessage']>[0],
  ): Promise<Awaited<ReturnType<CoreImSessionBridge['sendUserMessage']>>> {
    const receiptKey = JSON.stringify([input.sessionId, input.toolCallId]);
    const outcomes: TextSendOutcomes = {
      receiptKey,
      textEmpty: input.text.length === 0,
      delivered: new Set(),
      failed: new Set(),
    };
    const receipt = await this.sendTextContext.run(outcomes, async () => {
      try {
        return await super.sendUserMessage(input);
      } catch (error) {
        if (error instanceof MessageRoutingError) {
          throw new Error2(ErrorCodes.REQUEST_INVALID, error.message, { details: error.details, cause: error });
        }
        throw error;
      }
    });
    if (receipt.channels === undefined || !receipt.channels.some((channel) => channel.status === 'partial')) {
      return receipt;
    }
    this.ensureBindingsSynced();
    const channels = receipt.channels.map((channel) => {
      if (channel.status !== 'partial') return channel;
      const cacheKey = `${receiptKey}\0${channel.channelId}`;
      const key = bindingTargetKey(channel.channelId, this.bindingsByChannelId, this.readCredential);
      const hasOutcome = key !== undefined && (outcomes.delivered.has(key) || outcomes.failed.has(key));
      if (outcomes.textEmpty || hasOutcome) {
        const nextDetail = classifyPartialDetail(
          channel.channelId,
          channel.detail,
          channel.messageIds?.length ?? 0,
          channel.unsupported?.length ?? 0,
          outcomes,
          this.bindingsByChannelId,
          this.readCredential,
        );
        if (nextDetail !== undefined && nextDetail.length > 0) {
          rememberClassifiedDetail(this.classifiedDetails, cacheKey, nextDetail);
          if (nextDetail !== channel.detail) return { ...channel, detail: nextDetail };
        }
        return channel;
      }
      const cached = this.classifiedDetails.get(cacheKey);
      if (cached !== undefined && cached !== channel.detail) {
        return { ...channel, detail: cached };
      }
      return channel;
    });
    return { ...receipt, channels };
  }
}
