import { createHash } from 'node:crypto';

import { imSessionAdmitted, type ImBinding, type ImCatalog, type ImCheckResult, type ImConfirmRequest, type ImDiscovery, type ImInstanceView, type ImPasteResult, type ImPolicy, type ImProviderKind, type ImSessionSnapshot, type ImStranger, type MessageContent } from '@kiki/protocol';

import type { ImAdapterFactory, ImInboundEvent, ImInboundIdentity, ImSessionAdapter } from './adapter';
import { parseImPaste } from './paste';
import type { ImQuestionAnswer, ImSessionBridgeOptions, ImSessionPorts } from './ports';
import { segmentText } from './segment';

interface BindingRecord {
  id: string;
  providerInstanceId: string;
  providerKind: ImProviderKind;
  accountId: string;
  identity: ImInboundIdentity;
  sessionId: string;
  personaId?: string;
  enabled: boolean;
  sessionEnabled?: boolean;
  busy: 'queue' | 'steer';
  reply: 'final' | 'edit';
  mobileInteractions: boolean;
}

interface DiscoveryRecord {
  id: string;
  providerInstanceId: string;
  providerKind: ImProviderKind;
  accountId: string;
  identity: ImInboundIdentity;
  preview: string;
  at: number;
}

interface InstanceMeta {
  id: string;
  providerKind: ImProviderKind;
  label?: string;
  listening: boolean;
  virtual: boolean;
  accountId?: string;
  conflict?: 'webhook';
  busy?: 'queue' | 'steer';
  reply?: 'final' | 'edit';
  persona?: string;
}

interface TicketRecord {
  id: string;
  sessionId: string;
  interactionId: string;
  bindingId: string;
  senderKey: string;
  expiresAt: number;
  consumed: boolean;
  action: 'approve' | 'reject' | 'host_yes' | 'host_no' | 'single' | 'toggle' | 'multi_done' | 'other';
  questionKey?: string;
  optionId?: string;
  group?: string;
}

interface StrangerRecord {
  providerInstanceId: string;
  identity: ImInboundIdentity;
  preview: string;
  count: number;
}

interface ReplyLedger {
  messageIds: string[];
  fileSent: boolean;
  lastText: string;
}

interface Stored {
  policy: { allowed: boolean; defaultEnabled: boolean };
  instances: InstanceMeta[];
  discoveries: DiscoveryRecord[];
  bindings: BindingRecord[];
  strangers: StrangerRecord[];
  seen: string[];
  tickets: TicketRecord[];
  selections: Record<string, string[]>;
  awaiting: Record<string, { interactionId: string; questionKey: string; expiresAt: number; sessionId: string }>;
  voiceFallbacks: number;
  cursors: Record<string, number>;
  notices: string[];
}

interface Poller {
  tokenHash: string;
  ownerId: string;
  instances: Set<string>;
  adapter: ImSessionAdapter;
}

const COPY = {
  en: {
    queued: 'Queued.',
    expired: 'Expired.',
    resolved: 'Already answered.',
    noTurn: 'No turn is in progress.',
    desktopSsh: 'This sign-in stays on the desktop SSH screen.',
    crossSession: 'That action belongs to another conversation.',
    rejected: 'That file was not saved.',
    switched: 'Target updated.',
    allow: 'Allow',
    refuse: 'Refuse',
    done: 'Done',
    other: 'Other',
    trust: 'Trust',
    status: (busy: boolean, pending: string, queue: number) => `Busy: ${busy ? 'yes' : 'no'}. Waiting: ${pending}. Queue: ${queue}.`,
  },
  zh: {
    queued: '已排队。',
    expired: '已过期。',
    resolved: '已经处理过。',
    noTurn: '没有进行中的回合。',
    desktopSsh: '这次登录留在桌面的 SSH 界面。',
    crossSession: '这个操作属于另一个会话。',
    rejected: '没有收下这个文件。',
    switched: '已切换目标。',
    allow: '同意',
    refuse: '拒绝',
    done: '完成',
    other: '其他',
    trust: '信任',
    status: (busy: boolean, pending: string, queue: number) => `忙：${busy ? '是' : '否'}。等待：${pending}。队列：${queue}。`,
  },
} as const;

function kindOf(providerId: string): ImProviderKind | undefined {
  if (providerId === 'telegram' || providerId === 'feishu_app' || providerId === 'onebot_v11' || providerId === 'wechat_bridge') return providerId;
  return undefined;
}

function sameIdentity(left: ImInboundIdentity, right: ImInboundIdentity): boolean {
  return left.chatId === right.chatId && left.senderId === right.senderId && left.topicId === right.topicId;
}

function senderKey(instanceId: string, identity: ImInboundIdentity): string {
  return `${instanceId}:${identity.chatId}:${identity.senderId}:${identity.topicId}`;
}

export class ImSessionBridge {
  private readonly ports: ImSessionPorts;
  private readonly factories: readonly ImAdapterFactory[];
  private readonly locale: 'en' | 'zh';
  private readonly editIntervalMs: number;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private state: Stored = emptyState();
  private readonly pollers = new Map<string, Poller>();
  private readonly jobs = new Set<Promise<void>>();
  private seq = 0;
  private ready: Promise<void>;

  constructor(options: ImSessionBridgeOptions) {
    this.ports = options.ports;
    this.factories = options.factories;
    this.locale = options.locale ?? 'en';
    this.editIntervalMs = options.editIntervalMs ?? 2_000;
    this.now = options.now ?? (() => Date.now());
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
    this.ready = this.restore();
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  async snapshot(): Promise<ImSessionSnapshot> {
    await this.ready;
    return {
      policy: { allowed: this.state.policy.allowed, default_enabled: this.state.policy.defaultEnabled },
      instances: this.instanceViews(),
      discoveries: this.state.discoveries.map(toDiscovery),
      bindings: this.state.bindings.map(toBinding),
      strangers: this.state.strangers.map(toStranger),
      voice_fallbacks: this.state.voiceFallbacks,
    };
  }

  async catalog(): Promise<ImCatalog> {
    const [personas, sessions] = await Promise.all([this.ports.sessions.listPersonas(), this.ports.sessions.listSessions()]);
    return {
      personas: personas.map((persona) => ({ id: persona.id, name: persona.name, ...(persona.homeSessionId === undefined ? {} : { home_session_id: persona.homeSessionId }) })),
      sessions: sessions.map((session) => ({ id: session.id, title: session.title, ...(session.personaId === undefined ? {} : { persona_id: session.personaId }) })),
    };
  }

  async setPolicy(policy: ImPolicy): Promise<ImSessionSnapshot> {
    await this.ready;
    this.state.policy = { allowed: policy.allowed, defaultEnabled: policy.default_enabled };
    if (!policy.allowed) await this.stopAll();
    else await this.ensureListening();
    await this.persist();
    return this.snapshot();
  }

  async paste(input: { instanceId?: string; text: string }): Promise<ImPasteResult> {
    await this.ready;
    const parsed = parseImPaste(input.text);
    if (parsed.providerKind === undefined || parsed.credential === undefined) throw new Error('paste_unrecognized');
    let instanceId = input.instanceId;
    if (instanceId === undefined) {
      if (this.ports.credentials.create === undefined) throw new Error('instance_required');
      const created = await this.ports.credentials.create({ providerKind: parsed.providerKind, credential: parsed.credential });
      instanceId = created.instanceId;
      this.state.instances.push({ id: instanceId, providerKind: parsed.providerKind, label: created.label, listening: false, virtual: true });
    } else {
      await this.ports.credentials.write(instanceId, parsed.credential);
      const meta = this.meta(instanceId, parsed.providerKind);
      meta.providerKind = parsed.providerKind;
    }
    const meta = this.meta(instanceId, parsed.providerKind);
    if (parsed.busy !== undefined) meta.busy = parsed.busy;
    if (parsed.reply !== undefined) meta.reply = parsed.reply;
    if (parsed.persona !== undefined) meta.persona = parsed.persona;
    this.ports.logger.info({ provider_kind: parsed.providerKind, instance_id: instanceId, ignored: parsed.ignoredKeys.length }, 'im paste stored');
    await this.persist();
    return { provider_instance_id: instanceId, provider_kind: parsed.providerKind, ignored_keys: [...parsed.ignoredKeys], chat_hint_ignored: parsed.chatHintIgnored };
  }

  async setListening(instanceId: string, listening: boolean): Promise<ImSessionSnapshot> {
    await this.ready;
    const meta = this.requireMeta(instanceId);
    meta.listening = listening;
    if (!listening) await this.release(instanceId);
    else await this.ensureOne(instanceId);
    await this.persist();
    return this.snapshot();
  }

  async check(instanceId: string): Promise<ImCheckResult> {
    await this.ready;
    const result = await this.ports.credentials.check(instanceId);
    const meta = this.requireMeta(instanceId);
    if (result.conflict === 'webhook') {
      meta.conflict = 'webhook';
      await this.release(instanceId);
      await this.persist();
      return { ok: false, conflict: 'webhook', ...(result.detail === undefined ? {} : { detail: result.detail }) };
    }
    meta.conflict = undefined;
    if (result.accountId !== undefined && meta.accountId !== undefined && meta.accountId !== result.accountId) {
      for (const binding of this.state.bindings) if (binding.providerInstanceId === instanceId) binding.enabled = false;
    }
    if (result.accountId !== undefined) meta.accountId = result.accountId;
    await this.persist();
    return { ok: result.ok, ...(result.accountId === undefined ? {} : { account_id: result.accountId }), ...(result.detail === undefined ? {} : { detail: result.detail }) };
  }

  async confirm(discoveryId: string, request: ImConfirmRequest): Promise<ImSessionSnapshot> {
    await this.ready;
    const discovery = this.state.discoveries.find((item) => item.id === discoveryId);
    if (discovery === undefined) throw new Error('unknown_discovery');
    const meta = this.requireMeta(discovery.providerInstanceId);
    let sessionId: string;
    let personaId: string | undefined;
    if (request.target.kind === 'persona') {
      const home = await this.ports.sessions.ensureHome(request.target.persona_id);
      if (home.homeSessionId === undefined || home.homeSessionId.length === 0) throw new Error('home_session_missing');
      sessionId = home.homeSessionId;
      personaId = request.target.persona_id;
      if (request.also_home === true) await this.ports.sessions.setHome?.(personaId, sessionId);
    } else {
      if (!await this.ports.sessions.owns(request.target.session_id)) throw new Error('unknown_session');
      sessionId = request.target.session_id;
    }
    this.state.discoveries = this.state.discoveries.filter((item) => item.id !== discoveryId);
    this.state.bindings.push({
      id: this.next('b'),
      providerInstanceId: discovery.providerInstanceId,
      providerKind: discovery.providerKind,
      accountId: discovery.accountId,
      identity: discovery.identity,
      sessionId,
      ...(personaId === undefined ? {} : { personaId }),
      enabled: true,
      busy: request.busy ?? meta.busy ?? 'queue',
      reply: request.reply ?? meta.reply ?? 'final',
      mobileInteractions: request.mobile_interactions ?? true,
    });
    await this.persist();
    return this.snapshot();
  }

  async dismiss(discoveryId: string): Promise<ImSessionSnapshot> {
    await this.ready;
    this.state.discoveries = this.state.discoveries.filter((item) => item.id !== discoveryId);
    await this.persist();
    return this.snapshot();
  }

  async updateBinding(id: string, patch: { enabled?: boolean; sessionEnabled?: boolean | null; busy?: 'queue' | 'steer'; reply?: 'final' | 'edit'; mobileInteractions?: boolean; sessionId?: string }): Promise<ImSessionSnapshot> {
    await this.ready;
    const binding = this.state.bindings.find((item) => item.id === id);
    if (binding === undefined) throw new Error('unknown_binding');
    if (patch.enabled !== undefined) binding.enabled = patch.enabled;
    if (patch.sessionEnabled === null) delete binding.sessionEnabled;
    else if (patch.sessionEnabled !== undefined) binding.sessionEnabled = patch.sessionEnabled;
    if (patch.busy !== undefined) binding.busy = patch.busy;
    if (patch.reply !== undefined) binding.reply = patch.reply;
    if (patch.mobileInteractions !== undefined) binding.mobileInteractions = patch.mobileInteractions;
    if (patch.sessionId !== undefined) binding.sessionId = patch.sessionId;
    await this.persist();
    return this.snapshot();
  }

  async removeBinding(id: string): Promise<ImSessionSnapshot> {
    await this.ready;
    this.state.bindings = this.state.bindings.filter((item) => item.id !== id);
    await this.persist();
    return this.snapshot();
  }

  suppressChannel(input: { providerInstanceId: string; scene: 'work_complete' | 'question_pending'; target: Record<string, unknown> }): boolean {
    const chat = input.target['chat_id'];
    if (typeof chat !== 'string' && typeof chat !== 'number') return false;
    return this.state.bindings.some((binding) => binding.providerInstanceId === input.providerInstanceId && binding.identity.chatId === String(chat) && this.admitted(binding) && (input.scene === 'work_complete' || binding.mobileInteractions));
  }

  async syncInteractions(): Promise<void> {
    await this.ready;
    for (const binding of this.state.bindings) {
      if (!this.admitted(binding) || !binding.mobileInteractions) continue;
      const pending = await this.ports.sessions.listInteractions(binding.sessionId);
      await this.projectInteractions(binding, pending.approvals, pending.questions);
    }
  }

  async close(): Promise<void> {
    await this.stopAll();
    await Promise.all([...this.jobs]);
  }

  private async restore(): Promise<void> {
    const raw = await this.ports.load();
    if (raw === undefined || raw === '') return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) this.state = { ...emptyState(), ...(parsed as Stored) };
  }

  private async persist(): Promise<void> {
    await this.ports.save(JSON.stringify(this.state));
  }

  private copy(key: keyof typeof COPY.en): string {
    return COPY[this.locale][key] as string;
  }

  private admitted(binding: BindingRecord): boolean {
    return binding.enabled && imSessionAdmitted({ allowed: this.state.policy.allowed, defaultEnabled: this.state.policy.defaultEnabled, sessionEnabled: binding.sessionEnabled });
  }

  private next(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq.toString(36)}`;
  }

  private meta(instanceId: string, providerKind: ImProviderKind): InstanceMeta {
    const found = this.state.instances.find((item) => item.id === instanceId);
    if (found !== undefined) return found;
    const listed = this.ports.credentials.list().find((item) => item.id === instanceId);
    const kind = listed === undefined ? providerKind : kindOf(listed.providerId) ?? providerKind;
    const created: InstanceMeta = { id: instanceId, providerKind: kind, label: listed?.label, listening: false, virtual: listed === undefined };
    this.state.instances.push(created);
    return created;
  }

  private requireMeta(instanceId: string): InstanceMeta {
    const found = this.state.instances.find((item) => item.id === instanceId);
    if (found !== undefined) return found;
    const listed = this.ports.credentials.list().find((item) => item.id === instanceId);
    const kind = listed === undefined ? undefined : kindOf(listed.providerId);
    if (kind === undefined) throw new Error('unknown_instance');
    return this.meta(instanceId, kind);
  }

  private instanceViews(): ImInstanceView[] {
    const listed = new Map(this.ports.credentials.list().map((item) => [item.id, item]));
    const ids = new Set<string>([...listed.keys(), ...this.state.instances.map((item) => item.id)]);
    const views: ImInstanceView[] = [];
    for (const id of ids) {
      const remote = listed.get(id);
      const kind = this.state.instances.find((item) => item.id === id)?.providerKind ?? (remote === undefined ? undefined : kindOf(remote.providerId));
      if (kind === undefined) continue;
      const meta = this.meta(id, kind);
      if (remote?.label !== undefined) meta.label = remote.label;
      const poller = [...this.pollers.values()].find((item) => item.instances.has(id));
      views.push({
        id,
        provider_kind: kind,
        ...(meta.label === undefined ? {} : { label: meta.label }),
        listening: meta.listening,
        configured: remote?.configured === true || this.ports.credentials.read(id) !== undefined,
        ...(meta.accountId === undefined ? {} : { account_id: meta.accountId }),
        ...(meta.conflict === undefined ? {} : { conflict: meta.conflict }),
        adapter: poller === undefined ? (this.factories.some((factory) => factory.providerKind === kind) ? 'stopped' : 'missing') : poller.ownerId === id ? 'running' : 'shared',
      });
    }
    return views;
  }

  private async ensureListening(): Promise<void> {
    for (const meta of this.state.instances) if (meta.listening) await this.ensureOne(meta.id);
  }

  private async ensureOne(instanceId: string): Promise<void> {
    if (!this.state.policy.allowed) return;
    const meta = this.requireMeta(instanceId);
    if (!meta.listening || meta.conflict === 'webhook') return;
    const credential = this.ports.credentials.read(instanceId);
    if (credential === undefined || credential.length === 0) return;
    const tokenHash = createHash('sha256').update(credential).digest('hex');
    const existing = this.pollers.get(tokenHash);
    if (existing !== undefined) {
      existing.instances.add(instanceId);
      return;
    }
    const factory = this.factories.find((item) => item.providerKind === meta.providerKind);
    if (factory === undefined) return;
    const adapter = factory.create({ instanceId, credential });
    if (await adapter.describeConflict() === 'webhook') {
      meta.conflict = 'webhook';
      return;
    }
    const poller: Poller = { tokenHash, ownerId: instanceId, instances: new Set([instanceId]), adapter };
    this.pollers.set(tokenHash, poller);
    const started = await adapter.start(async (event) => {
      for (const member of poller.instances) await this.ingest(member, event);
    }, { offset: this.state.cursors[instanceId] });
    if (started.conflict === 'webhook') {
      meta.conflict = 'webhook';
      await adapter.stop();
      this.pollers.delete(tokenHash);
      return;
    }
    meta.accountId = started.accountId;
    meta.conflict = undefined;
  }

  private async release(instanceId: string): Promise<void> {
    for (const [hash, poller] of this.pollers) {
      poller.instances.delete(instanceId);
      if (poller.instances.size > 0) continue;
      await poller.adapter.stop();
      this.pollers.delete(hash);
    }
  }

  private async stopAll(): Promise<void> {
    for (const poller of this.pollers.values()) await poller.adapter.stop();
    this.pollers.clear();
  }

  private adapterFor(instanceId: string): ImSessionAdapter | undefined {
    return [...this.pollers.values()].find((item) => item.instances.has(instanceId))?.adapter;
  }

  private async ingest(instanceId: string, event: ImInboundEvent): Promise<void> {
    if (!this.state.policy.allowed) return;
    const key = `${instanceId}:${event.eventId}`;
    if (this.state.seen.includes(key)) return;
    const meta = this.requireMeta(instanceId);
    const accountId = meta.accountId ?? instanceId;
    try {
      if (event.kind === 'callback') await this.onCallback(instanceId, event);
      else await this.onMessage(instanceId, accountId, event);
      this.state.seen.push(key);
      if (event.cursor !== undefined) this.state.cursors[instanceId] = event.cursor + 1;
      this.ports.logger.info({ provider_kind: meta.providerKind, instance_id: instanceId, event_id: event.eventId }, 'im session event');
      await this.persist();
    } catch (error) {
      this.ports.logger.info({ provider_kind: meta.providerKind, instance_id: instanceId, event_id: event.eventId, failed: true }, 'im session event');
      throw error;
    }
  }

  private async onMessage(instanceId: string, accountId: string, event: ImInboundEvent): Promise<void> {
    const meta = this.requireMeta(instanceId);
    const binding = this.state.bindings.find((item) => item.providerInstanceId === instanceId && sameIdentity(item.identity, event.identity));
    const adapter = this.adapterFor(instanceId);
    if (binding !== undefined && !this.admitted(binding)) {
      this.noteDiscovery(meta, accountId, event);
      return;
    }
    if (binding === undefined) {
      const chatBound = this.state.bindings.some((item) => item.providerInstanceId === instanceId && item.identity.chatId === event.identity.chatId && item.identity.topicId === event.identity.topicId);
      if (chatBound) this.noteStranger(instanceId, event);
      else this.noteDiscovery(meta, accountId, event);
      return;
    }
    const text = event.text?.trim() ?? '';
    if (event.kind === 'text' && text.startsWith(':')) {
      await this.onCommand(binding, text, adapter);
      return;
    }
    const waiting = this.state.awaiting[senderKey(instanceId, event.identity)];
    if (waiting !== undefined && event.kind === 'text') {
      if (this.now() > waiting.expiresAt || waiting.sessionId !== binding.sessionId) {
        delete this.state.awaiting[senderKey(instanceId, event.identity)];
        if (adapter !== undefined) await this.send(adapter, event.identity, this.copy('expired'), 'expired');
        return;
      }
      await this.ports.sessions.answerQuestion({ sessionId: binding.sessionId, interactionId: waiting.interactionId, response: { kind: 'other', text, method: 'number_key' } });
      delete this.state.awaiting[senderKey(instanceId, event.identity)];
      return;
    }
    if (event.kind === 'text' && await this.answerNumbers(binding, text)) return;
    if (event.tooLarge === true) {
      if (adapter !== undefined) await this.send(adapter, event.identity, this.copy('rejected'), 'rejected');
      return;
    }
    const content: MessageContent[] = [];
    if (event.media !== undefined && adapter !== undefined) {
      if (event.media.bytes.byteLength > adapter.maxInboundBytes) {
        await this.send(adapter, event.identity, this.copy('rejected'), 'rejected');
        return;
      }
      const audio = event.kind === 'audio';
      const asAudio = audio && adapter.acceptsVoice(event.media.mediaType);
      if (audio && !asAudio) this.state.voiceFallbacks += 1;
      const saved = await this.ports.sessions.saveMedia({
        sessionId: binding.sessionId,
        kind: asAudio ? 'audio' : event.kind === 'image' ? 'image' : 'file',
        name: event.media.name,
        mediaType: event.media.mediaType,
        bytes: event.media.bytes,
        text: text === '' ? undefined : text,
      });
      content.push(...saved);
    } else if (text !== '') content.push({ type: 'text', text });
    if (content.length === 0) return;
    const promptId = `im:${instanceId}:${event.eventId}`;
    const submitted = await this.ports.sessions.submit({ sessionId: binding.sessionId, promptId, content, delivery: binding.busy });
    if (submitted.duplicate) return;
    if (binding.busy === 'steer') {
      const steered = await this.ports.sessions.steer(binding.sessionId, submitted.promptId);
      if (steered === 'queued' && adapter !== undefined) await this.send(adapter, event.identity, this.copy('queued'), 'queued');
    } else if (submitted.deliveryState === 'queued' && adapter !== undefined) await this.send(adapter, event.identity, this.copy('queued'), 'queued');
    if (adapter !== undefined) this.watchReply(binding, submitted.promptId, submitted.turnId, adapter);
  }

  private async onCommand(binding: BindingRecord, text: string, adapter: ImSessionAdapter | undefined): Promise<void> {
    if (adapter === undefined) return;
    const [name, arg] = text.split(/\s+/u);
    if (name === ':status') {
      const activity = await this.ports.sessions.activity(binding.sessionId);
      await this.send(adapter, binding.identity, COPY[this.locale].status(activity.busy, activity.pending, activity.queueLength), 'status');
      return;
    }
    if (name === ':abort') {
      const activity = await this.ports.sessions.activity(binding.sessionId);
      const aborted = await this.ports.sessions.abort(binding.sessionId, activity.activePromptId, activity.activeTurnId);
      if (!aborted) await this.send(adapter, binding.identity, this.copy('noTurn'), 'no_turn');
      return;
    }
    if (name === ':target') {
      const targets = this.state.bindings.filter((item) => item.providerInstanceId === binding.providerInstanceId && item.identity.senderId === binding.identity.senderId);
      if (arg === undefined) {
        const lines = targets.map((item, index) => `${index + 1}. ${item.sessionId}`);
        await this.send(adapter, binding.identity, lines.join('\n'), 'targets');
        return;
      }
      const index = Number(arg);
      const target = targets[index - 1];
      if (!Number.isInteger(index) || target === undefined) return;
      binding.sessionId = target.sessionId;
      await this.send(adapter, binding.identity, this.copy('switched'), 'switched');
    }
  }

  private async answerNumbers(binding: BindingRecord, text: string): Promise<boolean> {
    if (!/^[0-9]+(?:\s+[0-9]+)*$/u.test(text)) return false;
    const pending = await this.ports.sessions.listInteractions(binding.sessionId);
    const question = pending.questions[0];
    if (question === undefined) return false;
    const numbers = text.split(/\s+/u).map((item) => Number(item));
    const options = numbers.map((number) => question.options[number - 1]).filter((item) => item !== undefined);
    if (options.length !== numbers.length || options.length === 0) return false;
    const response: ImQuestionAnswer = question.multi
      ? { kind: 'multi', optionIds: options.map((item) => item.id), method: 'number_key' }
      : { kind: 'single', optionIds: [options[0]!.id], method: 'number_key' };
    await this.ports.sessions.answerQuestion({ sessionId: binding.sessionId, interactionId: question.id, response });
    return true;
  }

  private noteDiscovery(meta: InstanceMeta, accountId: string, event: ImInboundEvent): void {
    const preview = event.preview ?? event.text?.slice(0, 80) ?? '';
    const found = this.state.discoveries.find((item) => item.providerInstanceId === meta.id && sameIdentity(item.identity, event.identity));
    if (found !== undefined) {
      found.preview = preview;
      found.at = this.now();
      return;
    }
    this.state.discoveries.push({ id: this.next('d'), providerInstanceId: meta.id, providerKind: meta.providerKind, accountId, identity: event.identity, preview, at: this.now() });
  }

  private noteStranger(instanceId: string, event: ImInboundEvent): void {
    const found = this.state.strangers.find((item) => item.providerInstanceId === instanceId && sameIdentity(item.identity, event.identity));
    if (found !== undefined) {
      found.count += 1;
      found.preview = event.preview ?? event.text?.slice(0, 80) ?? found.preview;
      return;
    }
    this.state.strangers.push({ providerInstanceId: instanceId, identity: event.identity, preview: event.preview ?? event.text?.slice(0, 80) ?? '', count: 1 });
  }

  private watchReply(binding: BindingRecord, promptId: string, turnId: number | undefined, adapter: ImSessionAdapter): void {
    const ledger: ReplyLedger = { messageIds: [], fileSent: false, lastText: '' };
    const job = (async () => {
      try {
        while (this.state.policy.allowed) {
          await this.wait(this.editIntervalMs);
          const current = this.state.bindings.find((item) => item.id === binding.id) ?? binding;
          const visible = await this.ports.sessions.readVisible(current.sessionId, promptId, turnId);
          if (current.reply === 'edit' && visible.text.length > 0 && visible.text !== ledger.lastText) await this.publishText(adapter, current.identity, visible.text, ledger, true, visible.done);
          if (!visible.done) continue;
          if (current.reply === 'final' && visible.text.length > 0) await this.publishText(adapter, current.identity, visible.text, ledger, false, true);
          else if (current.reply === 'edit' && visible.text.length > 0 && visible.text !== ledger.lastText) await this.publishText(adapter, current.identity, visible.text, ledger, true, true);
          await this.publishMedia(adapter, current.identity, visible.media);
          return;
        }
      } catch {
        this.ports.logger.info({ instance_id: binding.providerInstanceId, failed: true }, 'im reply failed');
      }
    })();
    this.jobs.add(job);
    void job.finally(() => { this.jobs.delete(job); });
  }

  private async publishText(adapter: ImSessionAdapter, identity: ImInboundIdentity, text: string, ledger: ReplyLedger, edit: boolean, final: boolean): Promise<void> {
    const parts = segmentText(text, adapter.textLimit);
    if (parts.length === 0) return;
    const head = parts[0]!;
    if (ledger.messageIds.length === 0) ledger.messageIds.push((await adapter.sendText({ identity, text: head, code: 'reply' })).messageId);
    else if (edit) await this.editOrSend(adapter, identity, ledger, 0, head);
    if (parts.length > 4 && final && !ledger.fileSent) {
      try {
        await adapter.sendFile({ identity, name: 'reply.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode(text), asVoice: false, asImage: false });
        ledger.fileSent = true;
      } catch {
        for (let index = 1; index < parts.length; index += 1) {
          if (ledger.messageIds.length <= index) ledger.messageIds.push((await adapter.sendText({ identity, text: parts[index]!, code: 'reply' })).messageId);
          else if (edit) await this.editOrSend(adapter, identity, ledger, index, parts[index]!);
        }
      }
    } else if (parts.length > 1 && parts.length <= 4 && final) {
      for (let index = 1; index < parts.length; index += 1) {
        if (ledger.messageIds.length <= index) ledger.messageIds.push((await adapter.sendText({ identity, text: parts[index]!, code: 'reply' })).messageId);
        else if (edit) await this.editOrSend(adapter, identity, ledger, index, parts[index]!);
      }
    }
    ledger.lastText = text;
  }

  private async editOrSend(adapter: ImSessionAdapter, identity: ImInboundIdentity, ledger: ReplyLedger, index: number, text: string): Promise<void> {
    const messageId = ledger.messageIds[index];
    if (messageId === undefined) return;
    const edited = await adapter.editText({ identity, messageId, text, code: 'reply' });
    if (!edited.edited) ledger.messageIds[index] = (await adapter.sendText({ identity, text, code: 'reply' })).messageId;
  }

  private async publishMedia(adapter: ImSessionAdapter, identity: ImInboundIdentity, media: readonly { kind: 'image' | 'file' | 'audio'; name: string; mediaType: string; bytes: Uint8Array }[]): Promise<void> {
    for (const item of media) {
      const asVoice = item.kind === 'audio' && adapter.acceptsVoice(item.mediaType);
      const sent = await adapter.sendFile({ identity, name: item.name, mediaType: item.mediaType, bytes: item.bytes, asVoice, asImage: item.kind === 'image' });
      if (item.kind === 'audio' && sent.deliveredAs !== 'voice') this.state.voiceFallbacks += 1;
    }
  }

  private async send(adapter: ImSessionAdapter, identity: ImInboundIdentity, text: string, code: string, buttons?: readonly { id: string; label: string }[]): Promise<void> {
    await adapter.sendText({ identity, text, code, ...(buttons === undefined ? {} : { buttons }) });
  }

  private async projectInteractions(binding: BindingRecord, approvals: readonly { id: string; expiresAt: number; toolName: string; action: string; ssh?: 'login' | 'host_key' }[], questions: readonly { id: string; expiresAt: number; questionKey: string; options: readonly { id: string; label: string }[]; multi: boolean; allowOther: boolean }[]): Promise<void> {
    const adapter = this.adapterFor(binding.providerInstanceId);
    if (adapter === undefined) return;
    for (const approval of approvals) {
      if (this.state.notices.includes(approval.id) || this.state.tickets.some((ticket) => ticket.interactionId === approval.id)) continue;
      if (approval.ssh === 'login') {
        this.state.notices.push(approval.id);
        await this.send(adapter, binding.identity, this.copy('desktopSsh'), 'desktop_ssh');
        continue;
      }
      if (approval.ssh === 'host_key') {
        const yes = this.ticket(binding, approval.id, approval.expiresAt, 'host_yes');
        const no = this.ticket(binding, approval.id, approval.expiresAt, 'host_no');
        await this.send(adapter, binding.identity, `${approval.toolName}`, 'host_key', [{ id: yes, label: this.copy('trust') }, { id: no, label: this.copy('refuse') }]);
        continue;
      }
      const allow = this.ticket(binding, approval.id, approval.expiresAt, 'approve');
      const refuse = this.ticket(binding, approval.id, approval.expiresAt, 'reject');
      await this.send(adapter, binding.identity, `${approval.toolName} ${approval.action}`, 'approval', [{ id: allow, label: this.copy('allow') }, { id: refuse, label: this.copy('refuse') }]);
    }
    for (const question of questions) {
      if (this.state.tickets.some((ticket) => ticket.interactionId === question.id)) continue;
      const buttons = question.options.map((option, index) => ({ id: this.ticket(binding, question.id, question.expiresAt, question.multi ? 'toggle' : 'single', question.questionKey, option.id, question.id), label: `${index + 1}. ${option.label}` }));
      if (question.multi) buttons.push({ id: this.ticket(binding, question.id, question.expiresAt, 'multi_done', question.questionKey, undefined, question.id), label: this.copy('done') });
      if (question.allowOther) buttons.push({ id: this.ticket(binding, question.id, question.expiresAt, 'other', question.questionKey), label: this.copy('other') });
      await this.send(adapter, binding.identity, question.questionKey, 'question', buttons);
    }
  }

  private ticket(binding: BindingRecord, interactionId: string, expiresAt: number, action: TicketRecord['action'], questionKey?: string, optionId?: string, group?: string): string {
    const id = this.next('t');
    this.state.tickets.push({ id, sessionId: binding.sessionId, interactionId, bindingId: binding.id, senderKey: senderKey(binding.providerInstanceId, binding.identity), expiresAt, consumed: false, action, questionKey, optionId, group });
    return id;
  }

  private async onCallback(instanceId: string, event: ImInboundEvent): Promise<void> {
    const adapter = this.adapterFor(instanceId);
    const ticket = this.state.tickets.find((item) => item.id === event.callbackData);
    const binding = this.state.bindings.find((item) => item.providerInstanceId === instanceId && sameIdentity(item.identity, event.identity));
    if (event.callbackQueryId !== undefined && adapter !== undefined) await adapter.answerCallback(event.callbackQueryId);
    if (ticket === undefined || binding === undefined || adapter === undefined) return;
    if (ticket.sessionId !== binding.sessionId) {
      await this.send(adapter, event.identity, this.copy('crossSession'), 'cross_session');
      return;
    }
    if (this.now() > ticket.expiresAt) {
      await this.send(adapter, event.identity, this.copy('expired'), 'expired');
      return;
    }
    if (ticket.consumed && ticket.action !== 'toggle') {
      await this.send(adapter, event.identity, this.copy('resolved'), 'resolved');
      return;
    }
    if (ticket.action === 'approve' || ticket.action === 'reject') {
      const result = await this.ports.sessions.decideApproval({ sessionId: ticket.sessionId, interactionId: ticket.interactionId, decision: ticket.action === 'approve' ? 'approved' : 'rejected' });
      ticket.consumed = true;
      if (result === 'expired') await this.send(adapter, event.identity, this.copy('expired'), 'expired');
      else if (result === 'resolved') await this.send(adapter, event.identity, this.copy('resolved'), 'resolved');
      return;
    }
    if (ticket.action === 'host_yes' || ticket.action === 'host_no') {
      const result = await this.ports.sessions.decideHostKey({ sessionId: ticket.sessionId, interactionId: ticket.interactionId, decision: ticket.action === 'host_yes' ? 'approved' : 'rejected' });
      ticket.consumed = true;
      if (result === 'expired') await this.send(adapter, event.identity, this.copy('expired'), 'expired');
      else if (result === 'resolved') await this.send(adapter, event.identity, this.copy('resolved'), 'resolved');
      return;
    }
    if (ticket.action === 'single' && ticket.optionId !== undefined) {
      await this.ports.sessions.answerQuestion({ sessionId: ticket.sessionId, interactionId: ticket.interactionId, response: { kind: 'single', optionIds: [ticket.optionId], method: 'number_key' } });
      ticket.consumed = true;
      return;
    }
    if (ticket.action === 'toggle' && ticket.group !== undefined && ticket.optionId !== undefined) {
      const selected = new Set(this.state.selections[ticket.group] ?? []);
      if (selected.has(ticket.optionId)) selected.delete(ticket.optionId);
      else selected.add(ticket.optionId);
      this.state.selections[ticket.group] = [...selected];
      return;
    }
    if (ticket.action === 'multi_done' && ticket.group !== undefined) {
      const optionIds = this.state.selections[ticket.group] ?? [];
      if (optionIds.length === 0) return;
      await this.ports.sessions.answerQuestion({ sessionId: ticket.sessionId, interactionId: ticket.interactionId, response: { kind: 'multi', optionIds, method: 'number_key' } });
      ticket.consumed = true;
      return;
    }
    if (ticket.action === 'other' && ticket.questionKey !== undefined) {
      this.state.awaiting[senderKey(instanceId, event.identity)] = { interactionId: ticket.interactionId, questionKey: ticket.questionKey, expiresAt: ticket.expiresAt, sessionId: ticket.sessionId };
      ticket.consumed = true;
    }
  }
}

function emptyState(): Stored {
  return { policy: { allowed: true, defaultEnabled: true }, instances: [], discoveries: [], bindings: [], strangers: [], seen: [], tickets: [], selections: {}, awaiting: {}, voiceFallbacks: 0, cursors: {}, notices: [] };
}

function toDiscovery(record: DiscoveryRecord): ImDiscovery {
  return { id: record.id, provider_instance_id: record.providerInstanceId, provider_kind: record.providerKind, account_id: record.accountId, identity: wireIdentity(record.identity), preview: record.preview, at: new Date(record.at).toISOString() };
}

function toBinding(record: BindingRecord): ImBinding {
  return {
    id: record.id,
    provider_instance_id: record.providerInstanceId,
    provider_kind: record.providerKind,
    account_id: record.accountId,
    identity: wireIdentity(record.identity),
    session_id: record.sessionId,
    ...(record.personaId === undefined ? {} : { persona_id: record.personaId }),
    enabled: record.enabled,
    ...(record.sessionEnabled === undefined ? {} : { session_enabled: record.sessionEnabled }),
    busy: record.busy,
    reply: record.reply,
    mobile_interactions: record.mobileInteractions,
  };
}

function toStranger(record: StrangerRecord): ImStranger {
  return { provider_instance_id: record.providerInstanceId, identity: wireIdentity(record.identity), preview: record.preview, count: record.count };
}

function wireIdentity(identity: ImInboundIdentity): ImDiscovery['identity'] {
  return {
    chat_id: identity.chatId,
    sender_id: identity.senderId,
    topic_id: identity.topicId,
    ...(identity.chatTitle === undefined ? {} : { chat_title: identity.chatTitle }),
    ...(identity.senderName === undefined ? {} : { sender_name: identity.senderName }),
    ...(identity.topicTitle === undefined ? {} : { topic_title: identity.topicTitle }),
  };
}
