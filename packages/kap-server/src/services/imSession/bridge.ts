import { createHash, randomBytes } from 'node:crypto';

import { imSessionAdmitted, type ImBinding, type ImCatalog, type ImCheckResult, type ImConfirmRequest, type ImDiscovery, type ImInstanceView, type ImPasteResult, type ImPolicy, type ImProviderKind, type ImSessionSnapshot, type ImStranger, type MessageContent } from '@kiki/protocol';

import { ImSendError, type ImAdapterFactory, type ImInboundEvent, type ImInboundIdentity, type ImSessionAdapter } from './adapter';
import { parseImPaste } from './paste';
import type { ImAnswerResult, ImPendingQuestion, ImQuestionAnswer, ImSessionBridgeOptions, ImSessionPorts } from './ports';
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
  questionIndex?: number;
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
  failedText?: string;
  tooLongNotice?: string;
  undelivered?: boolean;
  deliveredText?: string;
}

interface OpenReply {
  bindingId: string;
  promptId: string;
  turnId?: number;
  messageIds: string[];
  lastText: string;
  deliveredText?: string;
  failedText?: string;
  tooLongNotice?: string;
  fileSent: boolean;
  undelivered?: boolean;
  open: boolean;
}

interface OutboxButton {
  id: string;
  label: string;
}

interface OutboxRecord {
  key: string;
  bindingId: string;
  senderKey: string;
  sessionId: string;
  interactionId: string;
  questionIndex?: number;
  kind: 'approval' | 'host_key' | 'question' | 'desktop_ssh';
  expiresAt: number;
  text: string;
  code: string;
  buttons: OutboxButton[];
  delivery: 'pending' | 'sent';
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
  awaiting: Record<string, { interactionId: string; questionKey: string; questionIndex?: number; expiresAt: number; sessionId: string }>;
  voiceFallbacks: number;
  cursors: Record<string, number>;
  notices: string[];
  questionAnswers: Record<string, Record<string, string | true>>;
  answeredQuestions: Record<string, string[]>;
  replies: OpenReply[];
  outbox: OutboxRecord[];
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
    numbers: 'Send the number of a choice.',
    fileUnsupported: 'This platform cannot take that file.',
    tooLong: 'This platform rejected the message as too long and cannot take a file.',
    unknown: 'That action is not pending.',
    wechatAuth: 'This WeChat connection needs a new scan.',
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
    numbers: '发送选项的数字。',
    fileUnsupported: '这个平台收不了这个文件。',
    tooLong: '这个平台认为消息过长，而且不能接收文件。',
    unknown: '没有这项待处理。',
    wechatAuth: '这个微信连接需要重新扫码。',
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
  private readonly locale: () => 'en' | 'zh';
  private readonly editIntervalMs: number;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private state: Stored = emptyState();
  private readonly pollers = new Map<string, Poller>();
  private readonly jobs = new Set<Promise<void>>();
  private readonly wechatLogin: ImSessionBridgeOptions['wechatLogin'];
  private readonly liveReplies = new Set<string>();
  private projection: Promise<void> = Promise.resolve();
  private ready: Promise<void>;

  constructor(options: ImSessionBridgeOptions) {
    this.ports = options.ports;
    this.factories = options.factories;
    const locale = options.locale;
    this.locale = typeof locale === 'function' ? locale : () => locale ?? 'en';
    this.editIntervalMs = options.editIntervalMs ?? 2_000;
    this.now = options.now ?? (() => Date.now());
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
    this.wechatLogin = options.wechatLogin;
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
    if (policy.allowed) await this.resumeReplies();
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
    if (listening) await this.resumeReplies(instanceId);
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
    const discovery = this.only(this.state.discoveries, discoveryId);
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
    const existing = this.state.bindings.find((item) => item.providerInstanceId === discovery.providerInstanceId && sameIdentity(item.identity, discovery.identity));
    if (existing !== undefined) {
      existing.accountId = discovery.accountId;
      existing.identity = discovery.identity;
      existing.sessionId = sessionId;
      if (personaId === undefined) delete existing.personaId;
      else existing.personaId = personaId;
      existing.enabled = true;
      delete existing.sessionEnabled;
      existing.busy = request.busy ?? meta.busy ?? existing.busy;
      existing.reply = request.reply ?? meta.reply ?? existing.reply;
      existing.mobileInteractions = request.mobile_interactions ?? existing.mobileInteractions;
    } else {
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
    }
    await this.persist();
    return this.snapshot();
  }

  async dismiss(discoveryId: string): Promise<ImSessionSnapshot> {
    await this.ready;
    if (this.only(this.state.discoveries, discoveryId) === undefined) throw new Error('unknown_discovery');
    this.state.discoveries = this.state.discoveries.filter((item) => item.id !== discoveryId);
    await this.persist();
    return this.snapshot();
  }

  async updateBinding(id: string, patch: { enabled?: boolean; sessionEnabled?: boolean | null; busy?: 'queue' | 'steer'; reply?: 'final' | 'edit'; mobileInteractions?: boolean; sessionId?: string }): Promise<ImSessionSnapshot> {
    await this.ready;
    const binding = this.only(this.state.bindings, id);
    if (binding === undefined) throw new Error('unknown_binding');
    if (patch.enabled !== undefined) binding.enabled = patch.enabled;
    if (patch.sessionEnabled === null) delete binding.sessionEnabled;
    else if (patch.sessionEnabled !== undefined) binding.sessionEnabled = patch.sessionEnabled;
    if (patch.busy !== undefined) binding.busy = patch.busy;
    if (patch.reply !== undefined) binding.reply = patch.reply;
    if (patch.mobileInteractions !== undefined) binding.mobileInteractions = patch.mobileInteractions;
    if (patch.sessionId !== undefined) binding.sessionId = patch.sessionId;
    await this.persist();
    await this.resumeReplies(binding.providerInstanceId);
    return this.snapshot();
  }

  async removeBinding(id: string): Promise<ImSessionSnapshot> {
    await this.ready;
    if (this.only(this.state.bindings, id) === undefined) throw new Error('unknown_binding');
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

  async startWechatQr(): Promise<{ login_id: string; image: string }> {
    await this.ready;
    if (this.wechatLogin === undefined) throw new Error('wechat_login_unavailable');
    return this.wechatLogin.start();
  }

  async pollWechatQr(id: string, verifyCode?: string): Promise<{ status: string; provider_instance_id?: string; account_id?: string }> {
    await this.ready;
    if (this.wechatLogin === undefined) throw new Error('wechat_login_unavailable');
    return this.wechatLogin.poll(id, verifyCode);
  }

  async cancelWechatQr(id: string): Promise<Record<string, never>> {
    await this.ready;
    if (this.wechatLogin !== undefined) await this.wechatLogin.cancel(id);
    return {};
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
    if (!Array.isArray(this.state.replies)) this.state.replies = [];
    if (!Array.isArray(this.state.outbox)) this.state.outbox = [];
    if (typeof this.state.questionAnswers !== 'object' || this.state.questionAnswers === null) this.state.questionAnswers = {};
    if (typeof this.state.answeredQuestions !== 'object' || this.state.answeredQuestions === null) this.state.answeredQuestions = {};
  }

  private async persist(): Promise<void> {
    await this.ports.save(JSON.stringify(this.state));
  }

  private copy(key: keyof typeof COPY.en): string {
    return COPY[this.locale()][key] as string;
  }

  private admitted(binding: BindingRecord): boolean {
    return binding.enabled && imSessionAdmitted({ allowed: this.state.policy.allowed, defaultEnabled: this.state.policy.defaultEnabled, sessionEnabled: binding.sessionEnabled });
  }

  private next(prefix: string): string {
    const used = new Set<string>([
      ...this.state.bindings.map((item) => item.id),
      ...this.state.discoveries.map((item) => item.id),
      ...this.state.tickets.map((item) => item.id),
    ]);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = `${prefix}${randomBytes(8).toString('hex')}`;
      if (!used.has(id)) return id;
    }
    throw new Error('id_exhausted');
  }

  private only<T extends { id: string }>(items: readonly T[], id: string): T | undefined {
    const matches = items.filter((item) => item.id === id);
    return matches.length === 1 ? matches[0] : undefined;
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

  private join(poller: Poller, instanceId: string): void {
    const canonical = poller.adapter.canonicalInstanceId ?? poller.ownerId;
    poller.instances.add(instanceId);
    if (poller.ownerId !== canonical) {
      this.retarget(poller.ownerId, canonical);
      poller.ownerId = canonical;
    }
    this.retarget(instanceId, canonical);
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
      this.join(existing, instanceId);
      return;
    }
    const factory = this.factories.find((item) => item.providerKind === meta.providerKind);
    if (factory === undefined) return;
    let adapter: ImSessionAdapter;
    try {
      adapter = factory.create({ instanceId, credential });
    } catch {
      meta.listening = false;
      return;
    }
    const canonical = adapter.canonicalInstanceId ?? instanceId;
    const shared = [...this.pollers.values()].find((item) => item.adapter === adapter || item.ownerId === canonical || item.adapter.canonicalInstanceId === canonical);
    if (shared !== undefined) {
      this.join(shared, instanceId);
      this.pollers.set(tokenHash, shared);
      return;
    }
    if (await adapter.describeConflict() === 'webhook') {
      meta.conflict = 'webhook';
      return;
    }
    const poller: Poller = { tokenHash, ownerId: canonical, instances: new Set([instanceId]), adapter };
    this.pollers.set(tokenHash, poller);
    this.retarget(instanceId, canonical);
    try {
      const started = await adapter.start(async (event) => {
        await this.ingest(poller.ownerId, event);
      }, { offset: this.state.cursors[poller.ownerId] });
      if (started.conflict === 'webhook' || started.failed === 'auth') {
        if (started.conflict === 'webhook') meta.conflict = 'webhook';
        meta.listening = started.conflict !== 'webhook' ? false : meta.listening;
        await adapter.stop();
        this.pollers.delete(tokenHash);
        return;
      }
      meta.accountId = started.accountId;
      meta.conflict = undefined;
    } catch {
      meta.listening = false;
      await adapter.stop().catch(() => undefined);
      this.pollers.delete(tokenHash);
    }
  }

  private retarget(from: string, to: string): void {
    if (from === to) return;
    for (const binding of this.state.bindings) if (binding.providerInstanceId === from) binding.providerInstanceId = to;
    for (const discovery of this.state.discoveries) if (discovery.providerInstanceId === from) discovery.providerInstanceId = to;
    for (const stranger of this.state.strangers) if (stranger.providerInstanceId === from) stranger.providerInstanceId = to;
  }

  private async release(instanceId: string): Promise<void> {
    const seen = new Set<Poller>();
    for (const poller of this.pollers.values()) {
      if (seen.has(poller) || !poller.instances.has(instanceId)) continue;
      seen.add(poller);
      poller.instances.delete(instanceId);
      if (poller.instances.size > 0) continue;
      await poller.adapter.stop();
      for (const [key, item] of [...this.pollers]) if (item === poller) this.pollers.delete(key);
    }
  }

  private async stopAll(): Promise<void> {
    const seen = new Set<ImSessionAdapter>();
    for (const poller of this.pollers.values()) {
      if (seen.has(poller.adapter)) continue;
      seen.add(poller.adapter);
      await poller.adapter.stop();
    }
    this.pollers.clear();
  }

  private adapterFor(instanceId: string): ImSessionAdapter | undefined {
    return [...this.pollers.values()].find((item) => item.ownerId === instanceId || item.instances.has(instanceId))?.adapter;
  }

  private async ingest(instanceId: string, event: ImInboundEvent): Promise<void> {
    if (!this.state.policy.allowed) return;
    const key = `${instanceId}:${event.eventId}`;
    if (this.state.seen.includes(key)) return;
    const meta = this.requireMeta(instanceId);
    const accountId = meta.accountId ?? instanceId;
    this.rememberChatKind(instanceId, event);
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
    const matches = this.state.bindings.filter((item) => item.providerInstanceId === instanceId && sameIdentity(item.identity, event.identity));
    const binding = matches.find((item) => this.admitted(item)) ?? matches[0];
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
      await this.ask(binding.sessionId, waiting.interactionId, { kind: 'other', questionKey: waiting.questionKey, ...(waiting.questionIndex === undefined ? {} : { questionIndex: waiting.questionIndex }), text, method: 'number_key' });
      if (waiting.questionIndex !== undefined) this.markQuestion(binding, waiting.interactionId, waiting.questionIndex);
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
      await this.send(adapter, binding.identity, COPY[this.locale()].status(activity.busy, activity.pending, activity.queueLength), 'status');
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
    const pending = await this.ports.sessions.listInteractions(binding.sessionId);
    const question = pending.questions.find((item) => !this.questionAnswered(binding, item));
    if (question === undefined) return false;
    const numeric = /^[0-9]+(?:\s+[0-9]+)*$/u.test(text);
    if (numeric) {
      const numbers = text.split(/\s+/u).map((item) => Number(item));
      const options = numbers.map((number) => question.options[number - 1]);
      const valid = options.length > 0 && options.every((item) => item !== undefined) && (!question.multi ? numbers.length === 1 : true);
      if (valid) {
        const response: ImQuestionAnswer = question.multi
          ? { kind: 'multi', questionKey: question.questionKey, questionIndex: question.questionIndex, optionIds: options.map((item) => item!.id), method: 'number_key' }
          : { kind: 'single', questionKey: question.questionKey, questionIndex: question.questionIndex, optionIds: [options[0]!.id], method: 'number_key' };
        await this.ask(binding.sessionId, question.id, response);
        this.markQuestion(binding, question.id, question.questionIndex);
        return true;
      }
    }
    if (!numeric && question.allowOther && text.length > 0) {
      await this.ask(binding.sessionId, question.id, { kind: 'other', questionKey: question.questionKey, questionIndex: question.questionIndex, text, method: 'number_key' });
      this.markQuestion(binding, question.id, question.questionIndex);
      return true;
    }
    const kind = this.adapterFor(binding.providerInstanceId)?.providerKind;
    return (kind === 'onebot_v11' || kind === 'wechat_bridge') && text.length > 0;
  }

  private questionAnswered(binding: BindingRecord, question: { id: string; questionIndex: number }): boolean {
    const key = senderKey(binding.providerInstanceId, binding.identity);
    const token = `${question.id}:${question.questionIndex}`;
    if ((this.state.answeredQuestions[key] ?? []).includes(token)) return true;
    return this.state.tickets.some((ticket) => ticket.bindingId === binding.id && ticket.senderKey === key && this.sameQuestion(ticket, question) && ticket.consumed && ticket.action !== 'toggle');
  }

  private markQuestion(binding: BindingRecord, interactionId: string, questionIndex: number): void {
    const key = senderKey(binding.providerInstanceId, binding.identity);
    const token = `${interactionId}:${questionIndex}`;
    const list = this.state.answeredQuestions[key] ?? [];
    if (!list.includes(token)) this.state.answeredQuestions[key] = [...list, token];
  }

  private async ask(sessionId: string, interactionId: string, response: ImQuestionAnswer): Promise<ImAnswerResult> {
    const previous = this.state.questionAnswers[interactionId];
    const result = await this.ports.sessions.answerQuestion({ sessionId, interactionId, response, ...(previous === undefined ? {} : { previous }) });
    if (typeof result === 'object') {
      if (result.result === 'partial') this.state.questionAnswers[interactionId] = { ...result.answers };
      else delete this.state.questionAnswers[interactionId];
    }
    return result;
  }

  private noteDiscovery(meta: InstanceMeta, accountId: string, event: ImInboundEvent): void {
    const preview = event.preview ?? event.text?.slice(0, 80) ?? '';
    const found = this.state.discoveries.find((item) => item.providerInstanceId === meta.id && sameIdentity(item.identity, event.identity));
    if (found !== undefined) {
      found.preview = preview;
      found.at = this.now();
      if (event.identity.chatKind !== undefined) found.identity = { ...found.identity, chatKind: event.identity.chatKind };
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

  private pendingReply(text: string, ledger: ReplyLedger, done: boolean): boolean {
    if (text.length === 0 || text === ledger.lastText) return false;
    return done || text !== ledger.failedText;
  }

  private watchReply(binding: BindingRecord, promptId: string, turnId: number | undefined, adapter: ImSessionAdapter): void {
    const live = `${binding.id}:${promptId}`;
    if (this.liveReplies.has(live)) return;
    this.liveReplies.add(live);
    const stored = this.state.replies.find((item) => item.bindingId === binding.id && item.promptId === promptId);
    const ledger: ReplyLedger = {
      messageIds: [...(stored?.messageIds ?? [])],
      fileSent: stored?.fileSent ?? false,
      lastText: stored?.lastText ?? '',
      ...(stored?.deliveredText === undefined ? {} : { deliveredText: stored.deliveredText }),
      ...(stored?.failedText === undefined ? {} : { failedText: stored.failedText }),
      ...(stored?.tooLongNotice === undefined ? {} : { tooLongNotice: stored.tooLongNotice }),
      ...(stored?.undelivered === undefined ? {} : { undelivered: stored.undelivered }),
    };
    const job = (async () => {
      try {
        while (this.state.policy.allowed) {
          await this.wait(this.editIntervalMs);
          const current = this.only(this.state.bindings, binding.id);
          if (current === undefined || !this.admitted(current)) return;
          const visible = await this.ports.sessions.readVisible(current.sessionId, promptId, turnId);
          const before = `${ledger.lastText}\n${ledger.deliveredText ?? ''}\n${ledger.messageIds.join('\n')}`;
          if (current.reply === 'edit' && this.pendingReply(visible.text, ledger, visible.done)) await this.publishText(adapter, current.identity, visible.text, ledger, true, visible.done);
          if (`${ledger.lastText}\n${ledger.deliveredText ?? ''}\n${ledger.messageIds.join('\n')}` !== before) {
            this.rememberReply(current, promptId, turnId, ledger, true);
            await this.persist();
          }
          if (!visible.done) continue;
          if (current.reply === 'final' && visible.text.length > 0) await this.publishText(adapter, current.identity, visible.text, ledger, false, true);
          else if (current.reply === 'edit' && this.pendingReply(visible.text, ledger, true)) await this.publishText(adapter, current.identity, visible.text, ledger, true, true);
          await this.publishMedia(adapter, current.identity, visible.media);
          this.rememberReply(current, promptId, turnId, ledger, false);
          await this.persist();
          return;
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'wechat_auth') {
          await this.send(adapter, binding.identity, this.copy('wechatAuth'), 'wechat_auth').catch(() => undefined);
        }
        this.ports.logger.info({ instance_id: binding.providerInstanceId, failed: true }, 'im reply failed');
      }
    })();
    this.jobs.add(job);
    void job.finally(() => { this.jobs.delete(job); this.liveReplies.delete(live); });
  }

  private rememberReply(binding: BindingRecord, promptId: string, turnId: number | undefined, ledger: ReplyLedger, open: boolean): void {
    const next: OpenReply = {
      bindingId: binding.id,
      promptId,
      ...(turnId === undefined ? {} : { turnId }),
      messageIds: [...ledger.messageIds],
      lastText: ledger.lastText,
      ...(ledger.deliveredText === undefined ? {} : { deliveredText: ledger.deliveredText }),
      ...(ledger.failedText === undefined ? {} : { failedText: ledger.failedText }),
      ...(ledger.tooLongNotice === undefined ? {} : { tooLongNotice: ledger.tooLongNotice }),
      fileSent: ledger.fileSent,
      ...(ledger.undelivered === undefined ? {} : { undelivered: ledger.undelivered }),
      open,
    };
    const index = this.state.replies.findIndex((item) => item.bindingId === binding.id && item.promptId === promptId);
    if (index < 0) this.state.replies.push(next);
    else this.state.replies[index] = next;
  }

  private async resumeReplies(instanceId?: string): Promise<void> {
    for (const reply of this.state.replies) {
      if (!reply.open) continue;
      const binding = this.only(this.state.bindings, reply.bindingId);
      if (binding === undefined || !this.admitted(binding)) continue;
      if (instanceId !== undefined && binding.providerInstanceId !== instanceId) continue;
      const adapter = this.adapterFor(binding.providerInstanceId);
      if (adapter === undefined) continue;
      this.watchReply(binding, reply.promptId, reply.turnId, adapter);
    }
  }

  private async publishText(adapter: ImSessionAdapter, identity: ImInboundIdentity, text: string, ledger: ReplyLedger, edit: boolean, final: boolean): Promise<void> {
    if (adapter.providerKind === 'feishu_app') {
      await this.publishFeishu(adapter, identity, text, ledger, edit);
      return;
    }
    if (adapter.providerKind === 'onebot_v11' && adapter.textLimit === undefined) {
      await this.publishQq(adapter, identity, text, ledger);
      return;
    }
    const parts = segmentText(text, adapter.textLimit);
    if (parts.length === 0) return;
    const head = parts[0]!;
    if (ledger.messageIds.length === 0) {
      const sent = await this.sendReply(adapter, identity, head, ledger, text);
      if (sent === undefined) return;
      ledger.messageIds.push(sent.messageId);
    } else if (edit) await this.editOrSend(adapter, identity, ledger, 0, head);
    if (parts.length > 4 && final && !ledger.fileSent) {
      try {
        await adapter.sendFile({ identity, name: 'reply.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode(text), asVoice: false, asImage: false });
        ledger.fileSent = true;
      } catch {
        for (let index = 1; index < parts.length; index += 1) {
          if (ledger.messageIds.length <= index) {
            const sent = await this.sendReply(adapter, identity, parts[index]!, ledger, text);
            if (sent === undefined) return;
            ledger.messageIds.push(sent.messageId);
          } else if (edit) await this.editOrSend(adapter, identity, ledger, index, parts[index]!);
        }
      }
    } else if (parts.length > 1 && parts.length <= 4 && final) {
      for (let index = 1; index < parts.length; index += 1) {
        if (ledger.messageIds.length <= index) {
          const sent = await this.sendReply(adapter, identity, parts[index]!, ledger, text);
          if (sent === undefined) return;
          ledger.messageIds.push(sent.messageId);
        } else if (edit) await this.editOrSend(adapter, identity, ledger, index, parts[index]!);
      }
    }
    if (ledger.undelivered === true) return;
    ledger.lastText = text;
  }

  private async publishFeishu(adapter: ImSessionAdapter, identity: ImInboundIdentity, text: string, ledger: ReplyLedger, edit: boolean): Promise<void> {
    const parts = [...adapter.splitText(text)];
    if (parts.length === 0) return;
    const next: string[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      const existing = ledger.messageIds[index];
      try {
        if (existing !== undefined && existing.length > 0) {
          if (!edit) {
            next.push(existing);
            continue;
          }
          const edited = await adapter.editText({ identity, messageId: existing, text: part, code: 'reply' });
          if (!edited.edited) {
            const sent = await adapter.sendText({ identity, text: part, code: 'reply' });
            const accepted = deliveryIds(sent);
            if (accepted.length === 0) {
              ledger.messageIds = next;
              return;
            }
            next.push(...accepted);
          } else next.push(edited.messageId.length > 0 ? edited.messageId : existing);
          continue;
        }
        const sent = await adapter.sendText({ identity, text: part, code: 'reply' });
        const accepted = deliveryIds(sent);
        if (accepted.length === 0) {
          ledger.messageIds = next;
          return;
        }
        next.push(...accepted);
      } catch (error) {
        const extra = error instanceof ImSendError ? error.acceptedIds.filter((id) => id.length > 0) : [];
        const failedPart = error instanceof ImSendError && error.failedPart !== undefined ? error.failedPart : extra.length;
        ledger.messageIds = [...next, ...extra.slice(0, failedPart)];
        return;
      }
    }
    if (edit && ledger.messageIds.length > parts.length) {
      for (let index = parts.length; index < ledger.messageIds.length; index += 1) {
        const existing = ledger.messageIds[index];
        if (existing === undefined || existing.length === 0) continue;
        try {
          const edited = await adapter.editText({ identity, messageId: existing, text: ' ', code: 'reply' });
          if (!edited.edited) return;
        } catch {
          return;
        }
      }
    }
    ledger.messageIds = next;
    ledger.lastText = text;
  }

  private async sendReply(adapter: ImSessionAdapter, identity: ImInboundIdentity, part: string, ledger: ReplyLedger, full: string): Promise<{ messageId: string } | undefined> {
    try {
      return await adapter.sendText({ identity, text: part, code: 'reply' });
    } catch (error) {
      if (await this.noteTooLong(adapter, identity, full, ledger, error)) return undefined;
      throw error;
    }
  }

  private async noteTooLong(adapter: ImSessionAdapter, identity: ImInboundIdentity, text: string, ledger: ReplyLedger, error: unknown): Promise<boolean> {
    if (!(error instanceof Error) || error.message !== 'too_long') return false;
    if (adapter.providerKind === 'wechat_bridge' && adapter.supportsFile) {
      try {
        await adapter.sendFile({ identity, name: 'reply.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode(text), asVoice: false, asImage: false });
        ledger.fileSent = true;
        ledger.undelivered = false;
        ledger.failedText = undefined;
        ledger.lastText = text;
      } catch {
        ledger.fileSent = false;
        ledger.undelivered = true;
        ledger.failedText = text;
      }
      return true;
    }
    if (adapter.providerKind === 'onebot_v11' && !adapter.supportsFile) {
      if (ledger.tooLongNotice !== text) {
        ledger.tooLongNotice = text;
        await this.send(adapter, identity, this.copy('tooLong'), 'too_long');
      }
      ledger.undelivered = true;
      ledger.failedText = text;
      return true;
    }
    return false;
  }

  private async publishQq(adapter: ImSessionAdapter, identity: ImInboundIdentity, text: string, ledger: ReplyLedger): Promise<void> {
    if (text.length === 0) return;
    const delivered = ledger.deliveredText ?? '';
    if (delivered.length > 0 && !text.startsWith(delivered)) ledger.deliveredText = '';
    const base = ledger.deliveredText ?? '';
    const pending = text.slice(base.length);
    if (pending.length === 0) {
      ledger.undelivered = false;
      ledger.failedText = undefined;
      ledger.lastText = text;
      return;
    }
    let knownTooLong = base.length === 0 && ledger.failedText === text;
    if (base.length === 0 && !knownTooLong) {
      try {
        const sent = await adapter.sendText({ identity, text, code: 'reply' });
        this.keepIds(ledger, deliveryIds(sent));
        ledger.deliveredText = text;
        ledger.undelivered = false;
        ledger.failedText = undefined;
        ledger.lastText = text;
        return;
      } catch (error) {
        if (!isTooLong(error)) throw error;
        knownTooLong = true;
      }
    }
    const outcome = await this.segmentQqRemainder(adapter, identity, pending, knownTooLong);
    ledger.deliveredText = base + outcome.delivered;
    this.keepIds(ledger, outcome.ids);
    if (outcome.complete && ledger.deliveredText === text) {
      ledger.undelivered = false;
      ledger.failedText = undefined;
      ledger.lastText = text;
      return;
    }
    if (outcome.unsplittable && ledger.tooLongNotice !== text) {
      ledger.tooLongNotice = text;
      await this.send(adapter, identity, this.copy('tooLong'), 'too_long');
    }
    ledger.undelivered = true;
    ledger.failedText = text;
  }

  private async segmentQqRemainder(adapter: ImSessionAdapter, identity: ImInboundIdentity, pending: string, knownTooLong: boolean): Promise<{ delivered: string; ids: string[]; complete: boolean; unsplittable: boolean }> {
    let rest = pending;
    let delivered = '';
    const ids: string[] = [];
    let shrink = knownTooLong;
    while (rest.length > 0) {
      const probe = await this.fittedQqPrefix(adapter, identity, rest, shrink);
      shrink = false;
      if (probe.kind === 'unsplittable') return { delivered, ids, complete: false, unsplittable: true };
      if (probe.kind === 'failed') return { delivered, ids, complete: false, unsplittable: false };
      delivered += probe.text;
      ids.push(...probe.ids);
      rest = rest.slice(probe.text.length);
      if (rest.length === 0) break;
      const parts = chunksOf(rest, codePoints(probe.text).length);
      try {
        const sent = await adapter.sendTextParts({ identity, parts, code: 'reply' });
        ids.push(...deliveryIds(sent));
        delivered += parts.join('');
        rest = '';
      } catch (error) {
        if (!(error instanceof ImSendError)) throw error;
        const failedPart = error.failedPart ?? 0;
        const acceptedText = parts.slice(0, failedPart).join('');
        delivered += acceptedText;
        ids.push(...error.acceptedIds.filter((id) => id.length > 0));
        rest = rest.slice(acceptedText.length);
        if (error.message !== 'too_long') return { delivered, ids, complete: false, unsplittable: false };
        shrink = failedPart === 0;
        if (rest.length === 0) return { delivered, ids, complete: false, unsplittable: true };
      }
    }
    return { delivered, ids, complete: rest.length === 0, unsplittable: false };
  }

  private async fittedQqPrefix(adapter: ImSessionAdapter, identity: ImInboundIdentity, rest: string, knownTooLong: boolean): Promise<{ kind: 'accepted'; text: string; ids: string[] } | { kind: 'failed' } | { kind: 'unsplittable' }> {
    let candidate = knownTooLong ? halfPrefix(rest) : rest;
    if (candidate === undefined) return { kind: 'unsplittable' };
    while (true) {
      try {
        const sent = await adapter.sendTextParts({ identity, parts: [candidate], code: 'reply' });
        return { kind: 'accepted', text: candidate, ids: deliveryIds(sent) };
      } catch (error) {
        if (error instanceof ImSendError && error.message !== 'too_long') return { kind: 'failed' };
        if (!isTooLong(error)) throw error;
        const next = halfPrefix(candidate);
        if (next === undefined) return { kind: 'unsplittable' };
        candidate = next;
      }
    }
  }

  private keepIds(ledger: ReplyLedger, ids: readonly string[]): void {
    for (const id of ids) if (id.length > 0 && !ledger.messageIds.includes(id)) ledger.messageIds.push(id);
  }

  private async editOrSend(adapter: ImSessionAdapter, identity: ImInboundIdentity, ledger: ReplyLedger, index: number, text: string): Promise<void> {
    const messageId = ledger.messageIds[index];
    if (messageId === undefined) return;
    if (!adapter.supportsEdit || messageId.length === 0) {
      const sent = await this.sendReply(adapter, identity, text, ledger, text);
      if (sent === undefined) return;
      ledger.messageIds[index] = sent.messageId;
      return;
    }
    const edited = await adapter.editText({ identity, messageId, text, code: 'reply' });
    if (!edited.edited) ledger.messageIds[index] = (await adapter.sendText({ identity, text, code: 'reply' })).messageId;
  }

  private async publishMedia(adapter: ImSessionAdapter, identity: ImInboundIdentity, media: readonly { kind: 'image' | 'file' | 'audio'; name: string; mediaType: string; bytes: Uint8Array }[]): Promise<void> {
    for (const item of media) {
      const asVoice = item.kind === 'audio' && adapter.acceptsVoice(item.mediaType);
      const asImage = item.kind === 'image';
      if (!asVoice && !asImage && !adapter.supportsFile) {
        if (item.kind === 'audio') this.state.voiceFallbacks += 1;
        await this.send(adapter, identity, this.copy('fileUnsupported'), 'file_unsupported');
        continue;
      }
      let counted = false;
      let sent: { deliveredAs: 'file' | 'image' | 'voice' };
      try {
        sent = await adapter.sendFile({ identity, name: item.name, mediaType: item.mediaType, bytes: item.bytes, asVoice, asImage });
      } catch (error) {
        if (asVoice && error instanceof Error && error.message === 'bad_format') {
          counted = true;
          this.state.voiceFallbacks += 1;
          if (!adapter.supportsFile) {
            await this.send(adapter, identity, this.copy('fileUnsupported'), 'file_unsupported');
            continue;
          }
          sent = await adapter.sendFile({ identity, name: item.name, mediaType: item.mediaType, bytes: item.bytes, asVoice: false, asImage: false });
        } else if (error instanceof Error && error.message === 'unsupported_file') {
          await this.send(adapter, identity, this.copy('fileUnsupported'), 'file_unsupported');
          continue;
        } else throw error;
      }
      if (item.kind === 'audio' && !counted && sent.deliveredAs !== 'voice') this.state.voiceFallbacks += 1;
    }
  }

  private async send(adapter: ImSessionAdapter, identity: ImInboundIdentity, text: string, code: string, buttons?: readonly { id: string; label: string }[]): Promise<void> {
    if (buttons !== undefined && buttons.length > 0 && !adapter.supportsButtons) {
      await adapter.sendText({ identity, text: [text, ...buttons.map((button) => button.label), this.copy('numbers')].join('\n'), code });
      return;
    }
    await adapter.sendText({ identity, text, code, ...(buttons === undefined ? {} : { buttons }) });
  }

  private enqueueProjection(work: () => Promise<void>): Promise<void> {
    const run = this.projection.then(work, work);
    this.projection = run.then(() => undefined, () => undefined);
    return run;
  }

  private async projectInteractions(binding: BindingRecord, approvals: readonly { id: string; expiresAt: number; toolName: string; action: string; ssh?: 'login' | 'host_key' }[], questions: readonly ImPendingQuestion[]): Promise<void> {
    await this.enqueueProjection(() => this.deliverInteractions(binding, approvals, questions));
  }

  private async deliverInteractions(binding: BindingRecord, approvals: readonly { id: string; expiresAt: number; toolName: string; action: string; ssh?: 'login' | 'host_key' }[], questions: readonly ImPendingQuestion[]): Promise<void> {
    const adapter = this.adapterFor(binding.providerInstanceId);
    if (adapter === undefined || !this.admitted(binding) || !binding.mobileInteractions) return;
    const jobs: OutboxRecord[] = [];
    let changed = this.retireOutbox(binding, approvals, questions);
    for (const approval of approvals) changed = this.stageApproval(binding, approval, jobs) || changed;
    for (const question of questions) changed = this.stageQuestion(binding, question, jobs) || changed;
    if (changed) await this.persist();
    for (const job of jobs) {
      await this.send(adapter, binding.identity, job.text, job.code, job.buttons.length > 0 ? job.buttons : undefined);
      job.delivery = 'sent';
      if (job.kind === 'desktop_ssh' && !this.state.notices.includes(job.interactionId)) this.state.notices.push(job.interactionId);
      await this.persist();
    }
  }

  private retireOutbox(binding: BindingRecord, approvals: readonly { id: string }[], questions: readonly ImPendingQuestion[]): boolean {
    const approvalIds = new Set(approvals.map((item) => item.id));
    const questionKeys = new Set(questions.filter((item) => !this.questionAnswered(binding, item)).map((item) => `${item.id}:${item.questionIndex}`));
    const next = this.state.outbox.filter((item) => {
      if (item.bindingId !== binding.id) return true;
      if (item.kind === 'question') return questionKeys.has(`${item.interactionId}:${item.questionIndex ?? 0}`);
      return approvalIds.has(item.interactionId);
    });
    if (next.length === this.state.outbox.length) return false;
    this.state.outbox = next;
    return true;
  }

  private stageApproval(binding: BindingRecord, approval: { id: string; expiresAt: number; toolName: string; action: string; ssh?: 'login' | 'host_key' }, jobs: OutboxRecord[]): boolean {
    const key = `interaction:${approval.id}`;
    const existing = this.state.outbox.find((item) => item.key === key);
    if (existing !== undefined) {
      if (existing.delivery === 'pending' && existing.bindingId === binding.id && existing.senderKey === senderKey(binding.providerInstanceId, binding.identity)) jobs.push(existing);
      return false;
    }
    if (approval.ssh === 'login' ? this.state.notices.includes(approval.id) : this.state.tickets.some((ticket) => ticket.interactionId === approval.id)) return false;
    const who = senderKey(binding.providerInstanceId, binding.identity);
    if (approval.ssh === 'login') {
      this.state.outbox.push({ key, bindingId: binding.id, senderKey: who, sessionId: binding.sessionId, interactionId: approval.id, kind: 'desktop_ssh', expiresAt: approval.expiresAt, text: this.copy('desktopSsh'), code: 'desktop_ssh', buttons: [], delivery: 'pending' });
    } else if (approval.ssh === 'host_key') {
      const yes = this.ticket(binding, approval.id, approval.expiresAt, 'host_yes');
      const no = this.ticket(binding, approval.id, approval.expiresAt, 'host_no');
      this.state.outbox.push({ key, bindingId: binding.id, senderKey: who, sessionId: binding.sessionId, interactionId: approval.id, kind: 'host_key', expiresAt: approval.expiresAt, text: approval.toolName, code: 'host_key', buttons: [{ id: yes, label: this.copy('trust') }, { id: no, label: this.copy('refuse') }], delivery: 'pending' });
    } else {
      const allow = this.ticket(binding, approval.id, approval.expiresAt, 'approve');
      const refuse = this.ticket(binding, approval.id, approval.expiresAt, 'reject');
      this.state.outbox.push({ key, bindingId: binding.id, senderKey: who, sessionId: binding.sessionId, interactionId: approval.id, kind: 'approval', expiresAt: approval.expiresAt, text: `${approval.toolName} ${approval.action}`, code: 'approval', buttons: [{ id: allow, label: this.copy('allow') }, { id: refuse, label: this.copy('refuse') }], delivery: 'pending' });
    }
    const staged = this.state.outbox[this.state.outbox.length - 1];
    if (staged !== undefined) jobs.push(staged);
    return true;
  }

  private stageQuestion(binding: BindingRecord, question: ImPendingQuestion, jobs: OutboxRecord[]): boolean {
    if (this.questionAnswered(binding, question)) return false;
    const key = `question:${question.id}:${question.questionIndex}`;
    const existing = this.state.outbox.find((item) => item.key === key);
    if (existing !== undefined) {
      if (existing.delivery === 'pending' && existing.bindingId === binding.id && existing.senderKey === senderKey(binding.providerInstanceId, binding.identity)) jobs.push(existing);
      return false;
    }
    if (this.state.tickets.some((ticket) => this.sameQuestion(ticket, question))) return false;
    const group = `${question.id}:${question.questionIndex}`;
    const buttons = question.options.map((option, index) => ({ id: this.ticket(binding, question.id, question.expiresAt, question.multi ? 'toggle' : 'single', question.questionKey, option.id, group, question.questionIndex), label: `${index + 1}. ${option.label}` }));
    if (question.multi) buttons.push({ id: this.ticket(binding, question.id, question.expiresAt, 'multi_done', question.questionKey, undefined, group, question.questionIndex), label: this.copy('done') });
    if (question.allowOther) buttons.push({ id: this.ticket(binding, question.id, question.expiresAt, 'other', question.questionKey, undefined, undefined, question.questionIndex), label: this.copy('other') });
    this.state.outbox.push({ key, bindingId: binding.id, senderKey: senderKey(binding.providerInstanceId, binding.identity), sessionId: binding.sessionId, interactionId: question.id, ...(question.questionIndex === undefined ? {} : { questionIndex: question.questionIndex }), kind: 'question', expiresAt: question.expiresAt, text: question.questionKey, code: 'question', buttons, delivery: 'pending' });
    const staged = this.state.outbox[this.state.outbox.length - 1];
    if (staged !== undefined) jobs.push(staged);
    return true;
  }

  private ticket(binding: BindingRecord, interactionId: string, expiresAt: number, action: TicketRecord['action'], questionKey?: string, optionId?: string, group?: string, questionIndex?: number): string {
    const id = this.next('t');
    this.state.tickets.push({ id, sessionId: binding.sessionId, interactionId, bindingId: binding.id, senderKey: senderKey(binding.providerInstanceId, binding.identity), expiresAt, consumed: false, action, questionKey, ...(questionIndex === undefined ? {} : { questionIndex }), optionId, group });
    return id;
  }

  private sameQuestion(ticket: TicketRecord, question: { id: string; questionIndex: number }): boolean {
    return ticket.interactionId === question.id && ticket.questionIndex === question.questionIndex;
  }

  private rememberChatKind(instanceId: string, event: ImInboundEvent): void {
    if (event.identity.chatKind === undefined) return;
    const binding = this.state.bindings.find((item) => item.providerInstanceId === instanceId && sameIdentity(item.identity, event.identity));
    if (binding !== undefined) binding.identity = { ...binding.identity, chatKind: event.identity.chatKind };
    const discovery = this.state.discoveries.find((item) => item.providerInstanceId === instanceId && sameIdentity(item.identity, event.identity));
    if (discovery !== undefined) discovery.identity = { ...discovery.identity, chatKind: event.identity.chatKind };
  }

  private async onCallback(instanceId: string, event: ImInboundEvent): Promise<void> {
    const adapter = this.adapterFor(instanceId);
    const tickets = this.state.tickets.filter((item) => item.id === event.callbackData);
    const ticket = tickets.length === 1 ? tickets[0] : undefined;
    const binding = this.state.bindings.find((item) => item.providerInstanceId === instanceId && sameIdentity(item.identity, event.identity));
    if (event.callbackQueryId !== undefined && adapter !== undefined) await adapter.answerCallback(event.callbackQueryId);
    if (ticket === undefined || binding === undefined || adapter === undefined) {
      if (ticket === undefined && binding !== undefined && adapter !== undefined) await this.send(adapter, event.identity, this.copy('unknown'), 'unknown');
      return;
    }
    if (ticket.senderKey !== senderKey(instanceId, event.identity) || ticket.bindingId !== binding.id || ticket.sessionId !== binding.sessionId) {
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
      await this.ask(ticket.sessionId, ticket.interactionId, { kind: 'single', questionKey: ticket.questionKey, ...(ticket.questionIndex === undefined ? {} : { questionIndex: ticket.questionIndex }), optionIds: [ticket.optionId], method: 'number_key' });
      ticket.consumed = true;
      if (ticket.questionIndex !== undefined) this.markQuestion(binding, ticket.interactionId, ticket.questionIndex);
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
      await this.ask(ticket.sessionId, ticket.interactionId, { kind: 'multi', questionKey: ticket.questionKey, ...(ticket.questionIndex === undefined ? {} : { questionIndex: ticket.questionIndex }), optionIds, method: 'number_key' });
      ticket.consumed = true;
      if (ticket.questionIndex !== undefined) this.markQuestion(binding, ticket.interactionId, ticket.questionIndex);
      return;
    }
    if (ticket.action === 'other' && ticket.questionKey !== undefined) {
      this.state.awaiting[senderKey(instanceId, event.identity)] = { interactionId: ticket.interactionId, questionKey: ticket.questionKey, ...(ticket.questionIndex === undefined ? {} : { questionIndex: ticket.questionIndex }), expiresAt: ticket.expiresAt, sessionId: ticket.sessionId };
      ticket.consumed = true;
    }
  }
}

function emptyState(): Stored {
  return { policy: { allowed: true, defaultEnabled: true }, instances: [], discoveries: [], bindings: [], strangers: [], seen: [], tickets: [], selections: {}, awaiting: {}, voiceFallbacks: 0, cursors: {}, notices: [], questionAnswers: {}, answeredQuestions: {}, replies: [], outbox: [] };
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

function deliveryIds(sent: { messageId: string; messageIds?: readonly string[] }): string[] {
  const ids = sent.messageIds ?? (sent.messageId.length > 0 ? [sent.messageId] : []);
  return ids.filter((id) => id.length > 0);
}

function isTooLong(error: unknown): boolean {
  return error instanceof Error && error.message === 'too_long';
}

function codePoints(text: string): string[] {
  return Array.from(text);
}

function halfPrefix(text: string): string | undefined {
  const units = codePoints(text);
  if (units.length < 2) return undefined;
  return units.slice(0, Math.floor(units.length / 2)).join('');
}

function chunksOf(text: string, unitWidth: number): string[] {
  const units = codePoints(text);
  const width = unitWidth < 1 ? units.length : unitWidth;
  const parts: string[] = [];
  for (let index = 0; index < units.length; index += width) parts.push(units.slice(index, index + width).join(''));
  return parts;
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
