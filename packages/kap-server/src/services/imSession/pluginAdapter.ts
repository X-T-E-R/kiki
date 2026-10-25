import { setTimeout as delay } from 'node:timers/promises';
import type { IPluginHostService, PluginImAdapterRegistration, PluginImConnection, PluginImAdapterSink } from '@kiki/agent-core-v2/app/plugin/pluginHostService';
import type { PluginImDeliveryReceipt, ImProviderKind } from '@kiki/protocol';
import { ImSendError, type ImAdapterFactory, type ImSessionAdapter, type ImOutboundText } from './adapter';
import { segmentText } from './segment';

export class PluginImAdapterBridge implements PluginImAdapterSink {
  private registrations: readonly PluginImAdapterRegistration[] = [];
  private reconcile: (kinds: readonly ImProviderKind[]) => Promise<void> = async () => undefined;

  constructor(readonly factories: ImAdapterFactory[]) {}

  async attach(hosts: IPluginHostService, reconcile: (kinds: readonly ImProviderKind[]) => Promise<void>): Promise<void> {
    this.reconcile = reconcile;
    await hosts.attachImAdapters(this);
  }

  credentials() {
    return this.registrations.map((entry) => ({ id: entry.instanceId, providerId: entry.providerKind, label: entry.definition.label, configured: true }));
  }

  credential(id: string): string | undefined {
    return this.registrations.find((entry) => entry.instanceId === id)?.revision;
  }

  async replace(entries: readonly PluginImAdapterRegistration[]): Promise<void> {
    const changed = [...new Set([...this.registrations, ...entries].filter((entry) => this.registrations.find((item) => item.providerKind === entry.providerKind)?.revision !== entries.find((item) => item.providerKind === entry.providerKind)?.revision).map((entry) => entry.providerKind))];
    const pluginKinds = new Set(this.registrations.map((entry) => entry.providerKind));
    const builtins = this.factories.filter((factory) => !pluginKinds.has(factory.providerKind as `plugin:${string}/${string}`));
    this.registrations = entries;
    this.factories.splice(0, this.factories.length, ...builtins, ...entries.map((entry) => this.factory(entry)));
    await this.reconcile(changed);
  }

  withdraw(pluginIds?: readonly string[]): Promise<void> {
    return this.replace(this.registrations.filter((entry) => pluginIds !== undefined && !pluginIds.includes(entry.pluginId)));
  }

  private factory(entry: PluginImAdapterRegistration): ImAdapterFactory {
    return { providerKind: entry.providerKind, inbound: entry.definition.inbound, outbound: entry.definition.outbound,
      minSendIntervalMs: entry.definition.minSendIntervalMs,
      mediaCapabilities: () => entry.definition.mediaCapabilities,
      create: () => createAdapter(entry),
    };
  }
}

function textResult(receipt: PluginImDeliveryReceipt | undefined) {
  if (receipt?.status !== 'delivered') throw new ImSendError(receipt?.detail ?? 'Plugin IM send outcome is unknown', receipt?.messageIds ?? [], undefined, receipt?.status === 'failed' || receipt?.status === 'unsupported' ? 'failed' : receipt?.status === 'partial' ? 'partial' : 'unknown');
  return { messageId: receipt.messageIds?.[0] ?? '', messageIds: [...(receipt.messageIds ?? [])] };
}

function createAdapter(entry: PluginImAdapterRegistration): ImSessionAdapter {
  const definition = entry.definition;
  let connection: PluginImConnection | undefined;
  let stopped = false;
  let starting: Promise<PluginImConnection> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let lifetime = new AbortController();
  const request = (action: 'sendText' | 'sendMedia' | 'editText' | 'answerCallback', input: unknown, requestSignal?: AbortSignal) => {
    if (stopped || connection === undefined || !definition.outbound) return Promise.reject(new Error('Plugin IM adapter is not available for output'));
    const current = connection;
    const signal = requestSignal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, requestSignal]);
    const work = queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        const receipt = await current.request(action, input);
        if (receipt?.status !== 'failed' || receipt.errorKind !== 'rate_limited' || (receipt.messageIds?.length ?? 0) > 0 || receipt.retryAfterMs === undefined || attempt >= 2) return receipt;
        await delay(receipt.retryAfterMs, undefined, { signal });
      }
    });
    queue = work.catch(() => undefined);
    return work;
  };
  const sendText = (message: ImOutboundText) => {
    if (message.replyToMessageId !== undefined && definition.supportsReply !== true) return Promise.reject(new ImSendError('reply_unsupported'));
    if ((message.mentionIds?.length ?? 0) > 0 && definition.supportsMentions !== true) return Promise.reject(new ImSendError('mentions_unsupported'));
    const { signal, ...wire } = message;
    return request('sendText', wire, signal).then(textResult);
  };
  return {
    providerKind: entry.providerKind, listenerRealm: definition.listenerRealm, textLimit: definition.textLimit, maxInboundBytes: definition.maxInboundBytes,
    supportsEdit: definition.supportsEdit === true, supportsButtons: definition.supportsButtons === true,
    supportsFile: definition.mediaCapabilities.some((item) => item.kind === 'file'), mediaCapabilities: definition.mediaCapabilities,
    supportsReply: definition.supportsReply === true, supportsMentions: definition.supportsMentions === true,
    get listenerAccountId() { return connection?.listenerAccountId; },
    get targets() { return connection?.targets; },
    describeConflict: async () => 'none', connectionPhase: () => stopped ? 'stopped' : connection === undefined ? 'starting' : 'running',
    splitText: (text) => definition.textLimit === undefined ? [text] : segmentText(text, definition.textLimit),
    acceptsVoice: (mime) => definition.mediaCapabilities.some((item) => (item.kind === 'voice' || item.kind === 'audio') && (item.mimeTypes === undefined || item.mimeTypes.some((type) => type === mime || type === 'audio/*'))),
    async start(listener, options) {
      stopped = false;
      lifetime = new AbortController();
      starting = entry.connect(listener, options?.offset);
      connection = await starting;
      if (stopped) { await connection.stop(); throw new Error('Plugin IM start was cancelled'); }
      return { accountId: connection.accountId };
    },
    async stop() {
      stopped = true;
      lifetime.abort();
      await queue;
      const current = connection ?? await starting?.catch(() => undefined);
      connection = undefined;
      await current?.stop();
    },
    async readHistory(input) {
      if (stopped || connection === undefined) throw new Error('Plugin IM adapter is not connected');
      if (!definition.inbound || definition.supportsHistory !== true || connection.readHistory === undefined) return { status: 'unsupported' };
      return connection.readHistory(input);
    },
    sendText,
    async sendTextParts(message) {
      const ids: string[] = [];
      for (const [index, text] of message.parts.entries()) {
        try { ids.push(...(await sendText({ identity: message.identity, text, code: message.code, signal: message.signal, replyToMessageId: message.replyToMessageId, mentionIds: index === 0 ? message.mentionIds : undefined })).messageIds); }
        catch (error) { if (error instanceof ImSendError) throw new ImSendError(error.message, [...ids, ...error.acceptedIds], index, index > 0 && error.outcome === 'failed' ? 'partial' : error.outcome); throw error; }
      }
      return { messageId: ids[0] ?? '', messageIds: ids };
    },
    async editText(message) {
      if (definition.supportsEdit !== true) throw new ImSendError('edit_unsupported');
      const { signal, ...wire } = message;
      const sent = textResult(await request('editText', wire, signal));
      return { messageId: sent.messageId, edited: true };
    },
    async sendMedia(message) {
      if (!definition.mediaCapabilities.some((item) => item.kind === message.kind && (item.maxBytes === undefined || message.bytes.byteLength <= item.maxBytes) && (item.mimeTypes === undefined || item.mimeTypes.some((mime) => mime === message.mediaType || mime.endsWith('/*') && message.mediaType.startsWith(mime.slice(0, -1)))))) return { status: 'unsupported', unsupported: [message.kind] };
      const { signal, bytes, ...wire } = message;
      return await request('sendMedia', { ...wire, base64: Buffer.from(bytes).toString('base64') }, signal) ?? { status: 'unknown' };
    },
    async sendFile(message) {
      const kind = message.asVoice ? 'voice' : message.asImage ? 'image' : 'file';
      const sent = textResult(await request('sendMedia', { identity: message.identity, name: message.name, mediaType: message.mediaType, kind, base64: Buffer.from(message.bytes).toString('base64') }, message.signal));
      return { messageId: sent.messageId, deliveredAs: kind };
    },
    async answerCallback(id) { await request('answerCallback', id); },
  };
}
