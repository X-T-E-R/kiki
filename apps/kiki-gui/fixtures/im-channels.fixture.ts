import type { ImBindingPatch, ImCatalog, ImConfirmRequest, ImProviderKind, ImSessionSnapshot } from '@kiki/protocol';

export const imFixtureCatalog: ImCatalog = {
  personas: [
    { id: 'lin', name: 'Lin', home_session_id: 'lin-daily' },
    { id: 'mei', name: 'Mei', home_session_id: 'mei-daily' },
  ],
  sessions: [
    { id: 'release-notes', title: 'Release notes' },
    { id: 'reading-list', title: 'Reading list' },
    { id: 'lin-daily', title: 'Lin daily', persona_id: 'lin' },
  ],
};

export function imChannelSnapshot(kind: ImProviderKind = 'wechat_bridge'): ImSessionSnapshot {
  return {
    policy: { allowed: true, default_enabled: true },
    instances: [{ id: 'account-a', provider_kind: kind, label: 'Studio', account_id: 'studio-account', listening: true, configured: true, adapter: 'running' }],
    discoveries: [],
    bindings: [
      { id: 'binding-contact', provider_instance_id: 'account-a', provider_kind: kind, account_id: 'studio-account', identity: { chat_id: 'contact-lin', sender_id: 'lin', sender_name: 'Lin', topic_id: '0' }, persona_id: 'lin', session_id: 'lin-daily', enabled: true, session_enabled: true, busy: 'queue', reply: 'final', mobile_interactions: true },
      { id: 'binding-group', provider_instance_id: 'account-a', provider_kind: kind, account_id: 'studio-account', identity: { chat_id: kind === 'wechat_bridge' ? 'contact-mei' : 'release-group', chat_title: kind === 'wechat_bridge' ? undefined : 'Release team', sender_id: 'mei', sender_name: 'Mei', topic_id: '0' }, session_id: 'release-notes', enabled: true, session_enabled: false, busy: 'steer', reply: 'final', mobile_interactions: false },
    ],
    strangers: [],
    voice_fallbacks: 0,
  };
}

export function imSettingsSnapshot(): ImSessionSnapshot {
  const base = imChannelSnapshot();
  return {
    ...base,
    instances: [
      { ...base.instances[0]!, connection: 'reconnecting', connection_detail: { code: 'transport_error', failure_count: 3, retry_in_ms: 2000 } },
      { id: 'account-tg', provider_kind: 'telegram', label: 'Research', account_id: 'research-bot', listening: true, configured: true, adapter: 'running' },
      { id: 'account-feishu', provider_kind: 'feishu_app', account_id: 'team-app', listening: true, configured: true, adapter: 'shared' },
      { id: 'account-qq', provider_kind: 'onebot_v11', account_id: 'study-account', listening: false, configured: true, adapter: 'stopped' },
    ],
    bindings: [
      ...base.bindings,
      { ...base.bindings[0]!, id: 'binding-topic', provider_instance_id: 'account-tg', provider_kind: 'telegram', account_id: 'research-bot', identity: { chat_id: 'research-group', chat_title: 'Research group', sender_id: 'lin', sender_name: 'Lin', topic_id: '42', topic_title: 'Paper reviews' }, session_id: 'reading-list', persona_id: undefined, reply: 'edit' },
    ],
  };
}

/** In-memory fixture only. It never connects an account or sends a platform message. */
export function createImSettingsFixture(initial: ImSessionSnapshot = imSettingsSnapshot()) {
  let state = structuredClone(initial);
  const calls: { operation: string; id?: string; body?: unknown }[] = [];
  const clone = () => structuredClone(state);
  const resolve = (target: ImConfirmRequest['target']) => target.kind === 'persona'
    ? { session_id: `${target.persona_id}-daily`, persona_id: target.persona_id }
    : { session_id: target.session_id, persona_id: undefined };
  const imSessions = {
    snapshot: async () => clone(),
    catalog: async () => structuredClone(imFixtureCatalog),
    setPolicy: async (policy: ImSessionSnapshot['policy']) => { calls.push({ operation: 'policy', body: policy }); state.policy = policy; return clone(); },
    check: async (id: string) => { calls.push({ operation: 'check', id }); return { ok: true, account_id: id }; },
    listen: async (id: string, listening: boolean) => {
      calls.push({ operation: 'listen', id, body: listening });
      state.instances = state.instances.map((item) => item.id === id ? { ...item, listening, adapter: listening ? 'running' : 'stopped', connection: undefined, connection_detail: undefined } : item);
      return clone();
    },
    updateBinding: async (id: string, patch: ImBindingPatch) => {
      calls.push({ operation: 'updateBinding', id, body: structuredClone(patch) });
      state.bindings = state.bindings.map((item) => {
        if (item.id !== id) return item;
        const { target, session_enabled, ...rest } = patch;
        const next = { ...item, ...rest, ...(target === undefined ? {} : resolve(target)) };
        if (session_enabled === null) delete next.session_enabled;
        else if (session_enabled !== undefined) next.session_enabled = session_enabled;
        return next;
      });
      return clone();
    },
    confirm: async (id: string, body: ImConfirmRequest) => {
      calls.push({ operation: 'confirm', id, body: structuredClone(body) });
      const discovery = state.discoveries.find((item) => item.id === id);
      if (discovery === undefined) throw new Error('Fixture channel no longer exists. Refresh and try again.');
      const existing = state.bindings.find((item) => item.provider_instance_id === discovery.provider_instance_id && item.identity.chat_id === discovery.identity.chat_id && item.identity.sender_id === discovery.identity.sender_id && item.identity.topic_id === discovery.identity.topic_id);
      const options = { busy: body.busy ?? existing?.busy ?? 'queue', reply: body.reply ?? existing?.reply ?? 'final', mobile_interactions: body.mobile_interactions ?? existing?.mobile_interactions ?? true };
      if (existing === undefined) state.bindings.push({ ...discovery, ...resolve(body.target), ...options, id: `bound-${id}`, enabled: true });
      else Object.assign(existing, resolve(body.target), options);
      state.discoveries = state.discoveries.filter((item) => item.id !== id);
      return clone();
    },
    dismiss: async (id: string) => { calls.push({ operation: 'dismiss', id }); state.discoveries = state.discoveries.filter((item) => item.id !== id); return clone(); },
    removeBinding: async (id: string) => { calls.push({ operation: 'removeBinding', id }); state.bindings = state.bindings.filter((item) => item.id !== id); return clone(); },
    paste: async (_text: string, id?: string) => { calls.push({ operation: 'paste', id }); return { provider_instance_id: id ?? 'account-a', provider_kind: 'wechat_bridge' as const, ignored_keys: [], chat_hint_ignored: false }; },
    startWechatQr: async () => { calls.push({ operation: 'startWechatQr' }); return { login_id: 'fixture-login', image: 'fixture-qr-not-for-authorization' }; },
    pollWechatQr: async (_id: string, _code?: string): Promise<{ status: string; provider_instance_id?: string }> => ({ status: 'wait' }),
    cancelWechatQr: async (id: string) => { calls.push({ operation: 'cancelWechatQr', id }); return {}; },
  };
  return {
    client: { imSessions, listSessions: async ({ q }: { q?: string }) => ({ items: imFixtureCatalog.sessions.filter((item) => item.title.toLowerCase().includes((q ?? '').toLowerCase())) }) },
    calls,
    read: clone,
    replace: (next: ImSessionSnapshot) => { state = structuredClone(next); },
    discover: (accountId = 'account-a', id = 'discovery-new') => {
      const account = state.instances.find((item) => item.id === accountId)!;
      state.discoveries.push({ id, provider_instance_id: accountId, provider_kind: account.provider_kind, account_id: account.account_id ?? accountId, identity: { chat_id: `chat-${id}`, chat_title: account.provider_kind === 'wechat_bridge' ? undefined : 'Design circle', sender_id: 'rui', sender_name: 'Rui', topic_id: '0', chat_kind: account.provider_kind === 'wechat_bridge' ? 'private' : 'group' }, preview: 'Can we review the draft here?', at: '2026-10-23T03:15:00.000Z' });
    },
  };
}
