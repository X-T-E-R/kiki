import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  ConfigTarget, IConfigService, ISessionManager, ISessionActivityView,
  ISessionInteractionService, IAgentLifecycleService, IAgentPromptService,
  IInstantiationService, IAgentTaskService, IAgentLoopService, IAgentActivityView, IEventBus, IAgentExecutionService, IAgentGoalService,
  type Scope, type ISessionScopeHandle, type IAgentScopeHandle,
} from '@kiki/agent-core-v2';
import {
  DEFAULT_NOTIFICATIONS_CONFIG, NOTIFICATIONS_SECTION, NotificationsConfigSchema,
  type NotificationsConfig,
} from '@kiki/agent-core-v2/app/notifications/configSection';
import type { NotificationChannel, NotificationCredentialSlot, NotificationDelivery, NotificationGlobalSettings, NotificationInstance, NotificationProviderDescriptor, NotificationSettings } from '@kiki/klient';
import {
  Runtime, PROVIDERS, validateConfig, telegramProvider, wecomWebhookProvider, wecomHttps, createSafeHttpTransport,
  webhookProvider, type Config, type CredentialScope, type DeliveryView,
} from '@nb-im/core';

type Settings = NotificationsConfig;
type RuntimeState = { runtime: Runtime };
const idPattern = /^[a-zA-Z0-9_.:-]{1,120}$/u;
const sceneKeys = ['work_complete', 'question_pending'] as const;
type Scene = typeof sceneKeys[number];
type Watched = {
  session: ISessionScopeHandle;
  subscriptions: { dispose(): void }[];
  startedAt?: number;
  cycle: string;
  questions: Map<string, { timer: ReturnType<typeof setTimeout>; deliveries: string[] }>;
  completion?: ReturnType<typeof setTimeout>;
  completed?: { session_id: string; episode_id: string; completed_at: number };
  agents: Set<string>;
  reconcileQueued?: boolean;
};

const fields = (id: string): NotificationProviderDescriptor['instance_fields'] => {
  const text = (key: string, label: string, required = true) => ({ key, label, kind: 'text' as const, required });
  const secret = (key: string, label: string, purpose: string, required = true) => ({ key, label, kind: 'secret' as const, purpose, required });
  switch (id) {
    case 'telegram': return [secret('token_slot', 'Bot token', 'telegram_bot')];
    case 'wecom_webhook': return [secret('key_slot', 'Webhook key', 'wecom_key')];
    case 'discord_webhook': return [text('webhook_id', 'Webhook ID'), secret('token_slot', 'Webhook token', 'discord_token')];
    case 'slack_webhook': return [secret('path_slot', 'Webhook path', 'slack_path')];
    case 'dingtalk_webhook': return [secret('token_slot', 'Webhook token', 'dingtalk_token'), secret('secret_slot', 'Signing secret', 'signing_secret', false), text('keyword', 'Keyword', false)];
    case 'feishu_webhook': return [secret('token_slot', 'Webhook token', 'feishu_token'), secret('secret_slot', 'Signing secret', 'signing_secret', false)];
    case 'http': return [text('endpoint', 'Endpoint'), { key: 'format', label: 'Body format', kind: 'select', required: true, options: ['json', 'form', 'xml'] }, secret('auth_slot', 'Bearer token', 'http_bearer', false), secret('path_slot', 'Private path', 'http_path', false), { key: 'private_grant', label: 'Private endpoint grant', kind: 'json', required: false }];
    default: return [];
  }
};

export const notificationProviders: readonly NotificationProviderDescriptor[] = [
  ...Object.entries(PROVIDERS).map(([id, capabilities]): NotificationProviderDescriptor => ({
    id, can_send: capabilities.can_send && id !== 'windows_toast', can_receive: false,
    status: id === 'script' || id === 'windows_toast' ? 'dependency_missing' : 'unverified',
    status_reason: id === 'script' ? 'protected_script_execution_unavailable' : id === 'windows_toast' ? 'desktop_host_unavailable' : 'real_account_not_tested',
    instance_fields: fields(id),
    target_fields: id === 'telegram' ? [
      { key: 'chat_id', label: 'Chat ID', kind: 'text', required: true },
      { key: 'message_thread_id', label: 'Topic ID', kind: 'number', required: false },
    ] : id === 'script' ? [{ key: 'key', label: 'Target key', kind: 'text', required: true }] : [],
  })),
  ...['smtp', 'matrix'].map((id): NotificationProviderDescriptor => ({
    id, can_send: false, can_receive: false, status: 'dependency_missing',
    status_reason: 'adapter_not_installed', instance_fields: [], target_fields: [],
  })),
];

function donorConfig(settings: Settings): Config {
  const channels = Object.fromEntries(Object.entries(settings.channels).map(([id, value]) => {
    const { scenes: _scenes, label: _label, health: _health, ...channel } = value as NotificationChannel;
    return [id, channel];
  }));
  const provider_instances = Object.fromEntries(Object.entries(settings.provider_instances).map(([id, value]) => {
    const { label: _label, health: _health, ...instance } = value as NotificationInstance;
    return [id, instance];
  }));
  return { schema_version: '1', provider_instances: provider_instances as Config['provider_instances'],
    channels, credential_slots: settings.credential_slots as Config['credential_slots'] };
}
function validateSettings(settings: Settings): void {
  NotificationsConfigSchema.parse(settings);
  validateConfig(donorConfig(settings));
  for (const [id, raw] of Object.entries(settings.channels)) {
    if (!idPattern.test(id)) throw new Error('invalid_channel_id');
    const channel = raw as NotificationChannel;
    if (!channel.scenes || Object.keys(channel.scenes).toSorted().join(',') !== 'question_pending,work_complete' ||
      sceneKeys.some((scene) => typeof channel.scenes[scene] !== 'boolean')) throw new Error('invalid_channel_scenes');
  }
  for (const [id, value] of Object.entries(settings.credential_values)) {
    if (!Object.hasOwn(settings.credential_slots, id) || typeof value.token !== 'string' ||
      value.token.length > 8192) throw new Error('invalid_credential');
  }
  const quiet = settings.global.quiet_hours;
  if (quiet) {
    if (![quiet.start, quiet.end].every((time) => /^([01][0-9]|2[0-3]):[0-5][0-9]$/u.test(time))) throw new Error('invalid_quiet_hours');
    try { new Intl.DateTimeFormat('en-US', { timeZone: quiet.time_zone }).format(new Date()); }
    catch { throw new Error('invalid_time_zone'); }
  }
}
function publicSettings(settings: Settings): NotificationSettings {
  return {
    global: structuredClone(settings.global),
    provider_instances: structuredClone(settings.provider_instances) as Record<string, NotificationInstance>,
    channels: structuredClone(settings.channels) as Record<string, NotificationChannel>,
    credential_slots: Object.fromEntries(Object.entries(settings.credential_slots).map(([id, slot]) =>
      [id, { ...(slot as Omit<NotificationCredentialSlot, 'configured'>), configured: Boolean(settings.credential_values[id]?.token) }])),
  };
}

function accountEpoch(settings: Settings, id: string): string | undefined {
  const slots = Object.entries(settings.credential_slots)
    .filter(([, slot]) => (slot as NotificationCredentialSlot).provider_instance_id === id)
    .map(([slot]) => [slot, settings.credential_values[slot]?.epoch_token]);
  if (slots.some(([, epoch]) => !epoch)) return undefined;
  return createHash('sha256').update(JSON.stringify([id, slots.toSorted(([left], [right]) => left!.localeCompare(right!))])).digest('hex');
}

export class NotificationService {
  private settings: Settings = structuredClone(DEFAULT_NOTIFICATIONS_CONFIG);
  private state?: RuntimeState;
  private readonly epochs = new Map<string, string>();
  private readonly watched = new Map<string, Watched>();
  private readonly retired = new WeakSet<ISessionScopeHandle>();
  private readonly subscriptions: { dispose(): void }[] = [];
  private readonly lastSent = new Map<string, number>();
  private readonly health = new Map<string, { state: import('@kiki/klient').NotificationHealth; at: number }>();
  private setHealth(id: string, state: import('@kiki/klient').NotificationHealth, at = Date.now()): void {
    if (at >= (this.health.get(id)?.at ?? 0)) this.health.set(id, { state, at });
  }
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private readonly quietTimers = new Set<ReturnType<typeof setTimeout>>();
  private writes: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly core: Scope, private readonly homeDir: string,
    private readonly isViewing: (sessionId: string) => boolean,
    private readonly onError: () => void) {}

  async start(): Promise<void> {
    const config = this.core.accessor.get(IConfigService);
    await config.ready;
    this.settings = structuredClone(config.get<Settings>(NOTIFICATIONS_SECTION) ?? DEFAULT_NOTIFICATIONS_CONFIG);
    try { validateSettings(this.settings); } catch { this.settings = structuredClone(DEFAULT_NOTIFICATIONS_CONFIG); this.onError(); }
    this.openRuntime();
    const sessions = this.core.accessor.get(ISessionManager);
    for (const session of sessions.list()) this.watch(session);
    if (sessions.onDidCreateSession) this.subscriptions.push(sessions.onDidCreateSession((event) => {
      const session = sessions.get(event.sessionId);
      if (session) this.watch(session);
    }));
    if (sessions.onDidCloseSession) this.subscriptions.push(sessions.onDidCloseSession(({ sessionId }) => { this.unwatch(sessionId); }));
    if (sessions.onDidArchiveSession) this.subscriptions.push(sessions.onDidArchiveSession(({ sessionId }) => { this.unwatch(sessionId); }));
    this.reconcileTimer = setInterval(() => { this.reconcile(); }, 30_000);
  }

  private openRuntime(): void {
    const settings = structuredClone(this.settings);
    const config = donorConfig(settings);
    const adapters = [telegramProvider(), wecomWebhookProvider(wecomHttps),
      ...(['discord_webhook', 'slack_webhook', 'dingtalk_webhook', 'feishu_webhook', 'http'] as const)
        .map((id) => webhookProvider(id))];
    for (const id of Object.keys(settings.provider_instances)) {
      this.epochs.set(id, accountEpoch(settings, id) ?? randomUUID());
    }
    const runtime = new Runtime(config, join(this.homeDir, 'notifications', 'outbox.sqlite'), adapters,
      (slot: string, scope: CredentialScope) => {
        const spec = config.credential_slots[slot];
        if (!spec || spec.provider_id !== scope.provider_id ||
          spec.provider_instance_id !== scope.provider_instance_id || spec.purpose !== scope.purpose) throw new Error('credential_scope_violation');
        const value = settings.credential_values[slot]?.token;
        if (!value) throw new Error('credential_unavailable');
        return value;
      }, (id) => this.epochs.get(id) ?? 'unavailable');
    runtime.outbox.db.exec('CREATE INDEX IF NOT EXISTS notifications_created_at_idx ON deliveries (created_at DESC, delivery_id DESC)');
    runtime.outbox.db.exec('CREATE INDEX IF NOT EXISTS notifications_channel_created_idx ON deliveries (channel_id, created_at DESC, delivery_id DESC)');
    runtime.start(() => { this.onError(); });
    this.state = { runtime };
  }

  getSettings(): NotificationSettings {
    if (this.state) this.listDeliveries();
    const settings = publicSettings(this.settings);
    for (const [id, instance] of Object.entries(settings.provider_instances)) {
      settings.provider_instances[id] = { ...instance, health: this.health.get(id)?.state ?? 'unknown' };
    }
    for (const [id, channel] of Object.entries(settings.channels)) {
      settings.channels[id] = { ...channel, health: this.health.get(id)?.state ?? 'unknown' };
    }
    return settings;
  }
  listProviders(): readonly NotificationProviderDescriptor[] { return notificationProviders; }
  revealCredential(id: string): string | undefined {
    if (!idPattern.test(id) || !Object.hasOwn(this.settings.credential_slots, id)) throw new Error('unknown_credential_slot');
    return this.settings.credential_values[id]?.token;
  }

  private mutate(change: (draft: Settings) => void): Promise<NotificationSettings> {
    let interrupted = false;
    const write = this.writes.then(async () => {
      if (this.stopped) throw new Error('notifications_stopped');
      const draft = structuredClone(this.settings);
      change(draft);
      validateSettings(draft);
      const config = this.core.accessor.get(IConfigService);
      for (const id of Object.keys({ ...this.settings.provider_instances, ...draft.provider_instances })) {
        const oldSlots = Object.entries(this.settings.credential_slots).filter(([, slot]) => (slot as NotificationCredentialSlot).provider_instance_id === id);
        const nextSlots = Object.entries(draft.credential_slots).filter(([, slot]) => (slot as NotificationCredentialSlot).provider_instance_id === id);
        const oldBinding = [this.settings.provider_instances[id], oldSlots, oldSlots.map(([slot]) => this.settings.credential_values[slot]?.epoch_token)];
        const nextBinding = [draft.provider_instances[id], nextSlots, nextSlots.map(([slot]) => draft.credential_values[slot]?.epoch_token)];
        if (JSON.stringify(oldBinding) !== JSON.stringify(nextBinding)) this.epochs.set(id, randomUUID());
      }
      interrupted = true;
      this.state?.runtime.stop();
      await config.replaceSections({ [NOTIFICATIONS_SECTION]: draft }, ConfigTarget.User);
      this.settings = draft;
      this.health.clear();
      const old = this.state?.runtime;
      if (old) {
        for (let i = 0; i < 100; i++) {
          try { old.close(); break; } catch (error) {
            if (!(error instanceof Error && error.message === 'send_in_progress')) throw error;
            await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
          }
        }
      }
      this.openRuntime();
      interrupted = false;
      return this.getSettings();
    });
    this.writes = write.catch(() => { if (interrupted) { this.state?.runtime.stop(); this.onError(); } });
    return write;
  }

  updateSettings(global: NotificationGlobalSettings): Promise<NotificationSettings> {
    return this.mutate((draft) => { draft.global = global; });
  }
  upsertInstance(id: string, instance: NotificationInstance, slots: Record<string, Omit<NotificationCredentialSlot, 'configured'>>): Promise<NotificationSettings> {
    if (!idPattern.test(id)) throw new Error('invalid_instance_id');
    return this.mutate((draft) => {
      const original = { ...draft.credential_slots };
      for (const [slotId, old] of Object.entries(original)) {
        if ((old as NotificationCredentialSlot).provider_instance_id === id) delete draft.credential_slots[slotId];
      }
      const { health: _health, ...persisted } = instance;
      draft.provider_instances[id] = persisted;
      for (const [slotId, spec] of Object.entries(slots)) {
        if (!idPattern.test(slotId) || spec.provider_instance_id !== id || spec.provider_id !== instance.provider_id ||
            Object.hasOwn(draft.credential_slots, slotId)) throw new Error('invalid_slot_scope');
        draft.credential_slots[slotId] = spec;
        const old = original[slotId] as NotificationCredentialSlot | undefined;
        if (!old || old.provider_id !== spec.provider_id || old.provider_instance_id !== spec.provider_instance_id ||
            old.purpose !== spec.purpose || old.env !== spec.env) delete draft.credential_values[slotId];
      }
      for (const [slotId, old] of Object.entries(original)) if ((old as NotificationCredentialSlot).provider_instance_id === id &&
        !Object.hasOwn(slots, slotId)) delete draft.credential_values[slotId];
    });
  }
  deleteInstance(id: string): Promise<NotificationSettings> {
    return this.mutate((draft) => {
      delete draft.provider_instances[id];
      for (const [key, raw] of Object.entries(draft.channels)) if ((raw as NotificationChannel).provider_instance_id === id) delete draft.channels[key];
      for (const [key, raw] of Object.entries(draft.credential_slots)) if ((raw as NotificationCredentialSlot).provider_instance_id === id) {
        delete draft.credential_slots[key]; delete draft.credential_values[key];
      }
    });
  }
  upsertChannel(id: string, channel: NotificationChannel): Promise<NotificationSettings> {
    if (!idPattern.test(id)) throw new Error('invalid_channel_id');
    return this.mutate((draft) => { draft.channels[id] = channel; });
  }
  deleteChannel(id: string): Promise<NotificationSettings> { return this.mutate((draft) => { delete draft.channels[id]; }); }
  async setCredential(id: string, value: string | null): Promise<{ configured: boolean }> {
    if (!idPattern.test(id)) throw new Error('invalid_credential_id');
    await this.mutate((draft) => {
      if (!Object.hasOwn(draft.credential_slots, id)) throw new Error('unknown_credential_slot');
      if (value === null) delete draft.credential_values[id];
      else draft.credential_values[id] = { token: value, epoch_token: randomUUID() };
    });
    return { configured: value !== null && value.length > 0 };
  }

  async checkCredential(id: string): Promise<import('@kiki/klient').NotificationCredentialCheck> {
    const instance = this.settings.provider_instances[id] as NotificationInstance | undefined;
    if (!idPattern.test(id) || !instance) throw new Error('unknown_instance');
    if (instance.provider_id !== 'telegram') return { result: 'requires_test_send', health: 'unknown' };
    const slot = instance.options['token_slot'];
    const token = typeof slot === 'string' ? this.settings.credential_values[slot]?.token : undefined;
    if (!token || !/^[0-9]{1,20}:[A-Za-z0-9_-]{20,128}$/u.test(token)) {
      this.setHealth(id, 'unauthorized');
      return { result: 'failed', health: 'unauthorized', error_kind: 'auth' };
    }
    try {
      const response = await createSafeHttpTransport().post({
        url: `https://api.telegram.org/bot${token}/getMe`, body: '{}', content_type: 'application/json',
      }, () => 'ready');
      if ('blocked' in response) throw new Error('check_blocked');
      const data: unknown = JSON.parse(response.body);
      const valid = typeof data === 'object' && data !== null && !Array.isArray(data) &&
        (data as { ok?: unknown; result?: { id?: unknown } }).ok === true &&
        Number.isSafeInteger((data as { result?: { id?: unknown } }).result?.id);
      const health = valid ? 'ok' : response.status === 401 || response.status === 403 ? 'unauthorized' : 'connection_failed';
      this.setHealth(id, health);
      return valid ? { result: 'ok', health } : { result: 'failed', health,
        error_kind: health === 'unauthorized' ? 'auth' : 'unknown' };
    } catch {
      this.setHealth(id, 'connection_failed');
      return { result: 'failed', health: 'connection_failed', error_kind: 'transient' };
    }
  }

  sendTest(channelId: string): DeliveryView {
    const channel = this.settings.channels[channelId] as NotificationChannel | undefined;
    if (!channel?.enabled) throw new Error('channel_unavailable');
    return this.state!.runtime.enqueue({ idempotency_key: `test:${randomUUID()}`, channel_id: channelId,
      category: 'work_complete', expires_at: new Date(Date.now() + 60_000).toISOString() });
  }
  listDeliveries(channelId?: string): readonly NotificationDelivery[] {
    const rows = this.state?.runtime.outbox.db.prepare(`SELECT delivery_id, channel_id, status, attempt,
      created_at, expires_at, result, account_epoch, channel_revision FROM deliveries
      ${channelId === undefined ? '' : 'WHERE channel_id = ?'}
      ORDER BY created_at DESC, delivery_id DESC LIMIT 100`).all(...(channelId === undefined ? [] : [channelId])) as unknown as Array<Omit<DeliveryView, 'result'> & {
      result: string | null; account_epoch: string | null; channel_revision: string;
    }>;
    const deliveries = rows.map(({ account_epoch: _epoch, channel_revision: _revision, ...row }) =>
      ({ ...row, result: row.result === null ? null : JSON.parse(row.result) as DeliveryView['result'] }));
    const channels = donorConfig(this.settings).channels;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      const delivery = deliveries[i]!;
      const instanceId = (this.settings.channels[row.channel_id] as NotificationChannel | undefined)?.provider_instance_id;
      if (!instanceId || row.account_epoch !== this.epochs.get(instanceId) ||
        row.channel_revision !== createHash('sha256').update(JSON.stringify(channels[row.channel_id])).digest('hex')) continue;
      const health = delivery.status === 'accepted_by_provider' ? 'ok' :
        delivery.result?.error_kind === 'auth' || delivery.result?.error_kind === 'forbidden' ? 'unauthorized' :
        delivery.status === 'unknown' || delivery.result?.error_kind === 'transient' ? 'connection_failed' : undefined;
      if (health) {
        const at = Date.parse(row.created_at);
        this.setHealth(row.channel_id, health, at);
        this.setHealth(instanceId, health, at);
      }
    }
    return deliveries;
  }

  private watch(session: ISessionScopeHandle): void {
    if (this.watched.has(session.id) || this.retired.has(session) || this.stopped) return;
    const activity = session.accessor.get(ISessionActivityView);
    const interactions = session.accessor.get(ISessionInteractionService);
    const state: Watched = { session, subscriptions: [], startedAt: activity.state().mainTurnActive ? Date.now() : undefined,
      cycle: randomUUID(), questions: new Map(), agents: new Set() };
    this.watched.set(session.id, state);
    state.subscriptions.push(session.accessor.get(IInstantiationService).onWillDispose(() => {
      this.retired.add(session);
      this.unwatch(session.id);
    }));
    state.subscriptions.push(activity.onDidChange(() => { this.reconcileSession(state); }));
    state.subscriptions.push(interactions.onDidChangePending(() => { this.reconcileSession(state); }));
    state.subscriptions.push(interactions.onDidResolve(({ id }) => { this.cancelQuestion(state, id); }));
    const agents = session.accessor.get(IAgentLifecycleService);
    const attach = (agent: IAgentScopeHandle) => {
      if (state.agents.has(agent.id)) return;
      state.agents.add(agent.id);
      state.subscriptions.push(agent.accessor.get(IEventBus).subscribe((event) => {
        if (!/^(turn\.|task\.|prompt\.|compaction\.|goal\.)/u.test(event.type)) return;
        this.queueReconcile(state);
        if (event.type === 'turn.ended') void Promise.all([
          agent.accessor.get(IAgentLoopService).settled(),
          agent.accessor.get(IAgentExecutionService).settled(),
        ]).then(() => { this.queueReconcile(state); }, this.onError);
      }));
    };
    for (const agent of agents.list()) attach(agent);
    state.subscriptions.push(agents.onDidCreate(attach));
    state.subscriptions.push(agents.onDidDispose((id) => {
      state.agents.delete(id);
      this.queueReconcile(state);
    }));
    this.reconcileSession(state);
  }
  private queueReconcile(state: Watched): void {
    if (state.reconcileQueued) return;
    state.reconcileQueued = true;
    queueMicrotask(() => {
      state.reconcileQueued = false;
      if (this.watched.get(state.session.id) === state && !this.stopped) this.reconcileSession(state);
    });
  }
  private workPending(state: Watched): boolean {
    for (const agent of state.session.accessor.get(IAgentLifecycleService).list()) {
      const loop = agent.accessor.get(IAgentLoopService).status();
      const prompt = agent.accessor.get(IAgentPromptService);
      const queue = prompt.list();
      const activity = agent.accessor.get(IAgentActivityView).state();
      const execution = agent.accessor.get(IAgentExecutionService).status();
      if (execution.state === 'starting' || execution.state === 'running' || execution.state === 'cancelling' ||
        loop.state === 'running' || loop.finalizing || loop.persistenceFailure || loop.hasPendingRequests ||
        loop.pendingTurnIds.length > 0 || prompt.hasReadyPending() || queue.active !== undefined ||
        queue.launching !== undefined || queue.pending.length > 0 ||
        activity.turn !== undefined || activity.background.some((item) => item.kind === 'compaction') ||
        agent.accessor.get(IAgentTaskService).hasUnfinishedWork() ||
        agent.accessor.get(IAgentGoalService).getGoal().goal?.status === 'active') return true;
    }
    return false;
  }
  private completeReady(state: Watched): boolean {
    const activity = state.session.accessor.get(ISessionActivityView).state();
    return !activity.mainTurnActive && activity.pendingInteraction === 'none' &&
      activity.lastTurnReason === 'completed' && !this.workPending(state);
  }
  listCompletions(): readonly { session_id: string; episode_id: string; completed_at: number }[] {
    return [...this.watched.values()].flatMap((state) => state.completed !== undefined &&
      Date.now() - state.completed.completed_at < 600_000 && this.completeReady(state) ? [state.completed] : []);
  }
  private unwatch(id: string): void {
    const state = this.watched.get(id);
    if (!state) return;
    for (const sub of state.subscriptions) sub.dispose();
    if (state.completion) clearTimeout(state.completion);
    for (const [question] of state.questions) this.cancelQuestion(state, question);
    this.watched.delete(id);
  }
  private reconcile(): void {
    for (const session of this.core.accessor.get(ISessionManager).list()) this.watch(session);
    for (const state of this.watched.values()) this.reconcileSession(state);
  }
  private reconcileSession(state: Watched): void {
    const activity = state.session.accessor.get(ISessionActivityView).state();
    const interaction = state.session.accessor.get(ISessionInteractionService);
    const pending = interaction.listPending('question');
    for (const question of pending) if (!state.questions.has(question.id)) {
      const job = { timer: undefined as unknown as ReturnType<typeof setTimeout>, deliveries: [] as string[] };
      state.questions.set(question.id, job);
      job.timer = setTimeout(() => {
        this.dispatch(state, 'question_pending', `q:${question.id}`, () =>
          interaction.listPending('question').some((item) => item.id === question.id), job.deliveries);
      }, this.settings.global.question_delay_ms);
    }
    for (const id of state.questions.keys()) if (!pending.some((question) => question.id === id)) this.cancelQuestion(state, id);
    if (activity.mainTurnActive && state.startedAt === undefined) {
      state.startedAt = Date.now();
      state.cycle = randomUUID();
      state.completed = undefined;
    }
    if (!this.completeReady(state)) {
      if (state.completion) { clearTimeout(state.completion); state.completion = undefined; }
      if (!activity.mainTurnActive && (activity.pendingInteraction !== 'none' ||
        activity.lastTurnReason === 'failed' || activity.lastTurnReason === 'cancelled')) {
        state.startedAt = undefined;
        state.completed = undefined;
      }
      return;
    }
    if (state.startedAt === undefined || state.completion !== undefined) return;
    const cycle = state.cycle;
    state.completion = setTimeout(() => {
      state.completion = undefined;
      if (state.cycle !== cycle || !this.completeReady(state) || state.startedAt === undefined) return;
      const elapsed = Date.now() - state.startedAt;
      state.startedAt = undefined;
      state.completed = { session_id: state.session.id, episode_id: cycle, completed_at: Date.now() };
      if (elapsed >= this.settings.global.min_work_ms) this.dispatch(state, 'work_complete', `w:${cycle}`, () =>
        state.cycle === cycle && state.startedAt === undefined && this.completeReady(state));
    }, this.settings.global.work_stable_ms);
  }
  private cancelQuestion(state: Watched, id: string): void {
    const job = state.questions.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    for (const delivery of job.deliveries) this.state?.runtime.cancel(delivery);
    state.questions.delete(id);
  }
  private inQuietHours(): boolean {
    const quiet = this.settings.global.quiet_hours;
    if (!quiet) return false;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: quiet.time_zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    const now = Number(parts.slice(0, 2)) * 60 + Number(parts.slice(3, 5));
    const parse = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    const from = parse(quiet.start), to = parse(quiet.end);
    return from === to ? false : from < to ? now >= from && now < to : now >= from || now < to;
  }
  private dispatch(state: Watched, scene: Scene, key: string, valid: () => boolean, deliveries?: string[]): void {
    if (this.stopped || !this.settings.global.enabled || !this.watched.has(state.session.id) || !valid()) return;
    if (this.inQuietHours()) {
      const timer = setTimeout(() => {
        this.quietTimers.delete(timer);
        this.dispatch(state, scene, key, valid, deliveries);
      }, 30_000);
      this.quietTimers.add(timer);
      return;
    }
    if (this.settings.global.suppress_viewing_session && this.isViewing(state.session.id)) return;
    for (const [channelId, raw] of Object.entries(this.settings.channels)) {
      const channel = raw as NotificationChannel;
      if (!channel.enabled || !channel.scenes[scene]) continue;
      const rateKey = `${scene}:${channelId}`;
      if (Date.now() - (this.lastSent.get(rateKey) ?? 0) < 60_000) continue;
      try {
        const result = this.state!.runtime.enqueue({
          idempotency_key: createHash('sha256').update(JSON.stringify([scene, state.session.id, key, channelId])).digest('hex'),
          channel_id: channelId, category: scene,
          expires_at: new Date(Date.now() + (scene === 'question_pending' ? 60 * 60_000 : 10 * 60_000)).toISOString(),
        });
        deliveries?.push(result.delivery_id);
        this.lastSent.set(rateKey, Date.now());
      } catch { this.onError(); }
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const timer of this.quietTimers) clearTimeout(timer);
    this.quietTimers.clear();
    for (const id of this.watched.keys()) this.unwatch(id);
    for (const sub of this.subscriptions) sub.dispose();
    await this.writes;
    const runtime = this.state?.runtime;
    runtime?.stop();
    if (runtime) {
      for (let i = 0; i < 100; i++) {
        try { runtime.close(); break; } catch (error) {
          if (!(error instanceof Error && error.message === 'send_in_progress')) throw error;
          await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
        }
      }
    }
  }
}
