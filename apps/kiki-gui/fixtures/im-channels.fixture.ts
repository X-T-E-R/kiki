import { imSessionAdmitted, type ImBindingPatch, type ImBindingTestResult, type ImCatalog, type ImConfirmRequest, type ImProviderKind, type ImSessionSnapshot, type ImSetupCatalog, type ImSetupRequest, type ImSetupResult, type ImTargetChannels } from '@kiki/protocol';

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

export const imFixtureSetupCatalog: ImSetupCatalog = {
  platforms: [
    {
      provider_kind: 'discord',
      methods: ['oauth_install', 'token'],
      portal_url: 'https://discord.com/developers/applications',
      fields: [{ key: 'bot_token', secret: true, required: true, label: 'Bot token' }],
      instructions: [
        'Create an application and copy its bot token once. User-account tokens are not supported.',
        'Enable Message Content Intent under Bot. Use discordInstallUrl(application_id) to choose a server and install the bot.',
      ],
      capabilities: {
        inbound: ['text', 'image', 'file', 'voice', 'audio', 'video'],
        outbound: ['text', 'image', 'file', 'audio', 'video'],
        threads: true,
        edit_text: true,
        callbacks: false,
        encrypted_rooms: false,
        voice_rendering: 'unsupported',
        audio_rendering: 'attachment',
        transport: 'gateway',
      },
    },
    {
      provider_kind: 'slack',
      methods: ['manifest', 'oauth_install', 'token'],
      portal_url: 'https://api.slack.com/apps',
      fields: [
        { key: 'bot_token', secret: true, required: true, label: 'Bot token (xoxb)' },
        { key: 'app_token', secret: true, required: true, label: 'App-level token (xapp)' },
      ],
      instructions: [
        'Open slackManifestInstallUrl() to create the app with scopes, message events and Socket Mode already filled in.',
        'Generate one app-level token with connections:write in Basic Information. Slack OAuth does not issue this token.',
      ],
      capabilities: {
        inbound: ['text', 'image', 'file', 'audio', 'video'],
        outbound: ['text', 'image', 'file', 'audio', 'video'],
        threads: true,
        edit_text: true,
        callbacks: false,
        encrypted_rooms: false,
        voice_rendering: 'unsupported',
        audio_rendering: 'attachment',
        transport: 'socket_mode',
      },
    },
    {
      provider_kind: 'matrix',
      methods: ['discovery', 'sso', 'password', 'token'],
      portal_url: 'https://matrix.org/ecosystem/clients/',
      fields: [
        { key: 'homeserver', secret: false, required: true, label: 'Homeserver URL' },
        { key: 'access_token', secret: true, required: true, label: 'Access token' },
      ],
      instructions: [
        'Pass your Matrix user ID or server domain to discoverMatrix() for .well-known and available login flows.',
        'Encrypted rooms and encrypted attachments are not supported in this batch; outbound plaintext into encrypted rooms is refused.',
      ],
      capabilities: {
        inbound: ['text', 'image', 'file', 'voice', 'audio', 'video'],
        outbound: ['text', 'image', 'file', 'audio', 'video'],
        threads: true,
        edit_text: true,
        callbacks: false,
        encrypted_rooms: false,
        voice_rendering: 'unsupported',
        audio_rendering: 'm.audio',
        transport: 'sync',
      },
    },
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
  const internalOff = new Set<string>();
  const calls: { operation: string; id?: string; body?: unknown }[] = [];
  const clone = () => structuredClone(state);
  const resolve = (target: ImConfirmRequest['target']) => target.kind === 'persona'
    ? { session_id: `${target.persona_id}-daily`, persona_id: target.persona_id }
    : { session_id: target.session_id, persona_id: undefined };
  const upsertSavedInstance = (providerKind: ImProviderKind, instanceId?: string) => {
    const id = instanceId ?? `account-${providerKind}`;
    if (!state.instances.some((item) => item.id === id)) {
      state.instances.push({
        id,
        provider_kind: providerKind,
        account_id: id,
        listening: false,
        configured: true,
        adapter: 'stopped',
      });
    }
    return { provider_instance_id: id, provider_kind: providerKind, ignored_keys: [], chat_hint_ignored: false };
  };
  const imSessions = {
    snapshot: async () => clone(),
    catalog: async () => structuredClone(imFixtureCatalog),
    setupCatalog: async () => structuredClone(imFixtureSetupCatalog),
    setup: async (request: ImSetupRequest): Promise<ImSetupResult> => {
      calls.push({ operation: 'setup', body: structuredClone(request) });
      if (request.action === 'save') {
        return { kind: 'saved', result: upsertSavedInstance(request.provider_kind, request.instance_id) };
      }
      if (request.action === 'discord_install') {
        return { kind: 'link', url: `https://discord.com/oauth2/authorize?client_id=${request.application_id}&scope=bot` };
      }
      if (request.action === 'slack_manifest') {
        return { kind: 'link', url: `https://api.slack.com/apps?new_app=1&name=${encodeURIComponent(request.name ?? 'Kiki')}` };
      }
      if (request.action === 'slack_oauth_begin') {
        return {
          kind: 'link',
          url: `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(request.client_id)}`,
          attempt_id: 'attempt-slack-1',
          callback_uri: request.redirect_uri,
        };
      }
      if (request.action === 'slack_oauth_complete') {
        return { kind: 'saved', result: upsertSavedInstance('slack') };
      }
      if (request.action === 'matrix_discover') {
        return {
          kind: 'discovery',
          homeserver: 'https://matrix.example.test',
          login_types: ['m.login.password', 'm.login.sso', 'm.login.token'],
          sso: true,
        };
      }
      if (request.action === 'matrix_sso_begin') {
        return {
          kind: 'link',
          url: `${request.homeserver}/_matrix/client/v3/login/sso/redirect`,
          attempt_id: 'attempt-matrix-1',
          callback_uri: `${request.redirect_uri}?kiki_im_state=fixture-state`,
        };
      }
      if (request.action === 'matrix_sso_complete') {
        return { kind: 'saved', result: upsertSavedInstance('matrix') };
      }
      return { kind: 'saved', result: upsertSavedInstance('matrix', request.instance_id) };
    },
    channelViews: async (sessionId: string): Promise<ImTargetChannels> => {
      const enabled = !internalOff.has(sessionId);
      return {
        internal_enabled: enabled,
        channels: [
          {
            id: 'internal',
            kind: 'internal',
            enabled,
            capabilities: [
              { kind: 'image' },
              { kind: 'file' },
              { kind: 'audio', rendering: 'audio_player' },
              { kind: 'voice', rendering: 'audio_player' },
              { kind: 'video', rendering: 'video_player' },
            ],
          },
          ...state.bindings.filter((item) => item.session_id === sessionId).map((item) => ({
            id: `im:${item.id}`,
            kind: 'im' as const,
            enabled: item.enabled && imSessionAdmitted({ allowed: state.policy.allowed, defaultEnabled: state.policy.default_enabled, sessionEnabled: item.session_enabled }),
            capabilities: item.provider_kind === 'onebot_v11'
              ? [{ kind: 'image' }, { kind: 'audio' }, { kind: 'voice' }, { kind: 'video' }]
              : item.provider_kind === 'discord' || item.provider_kind === 'slack' || item.provider_kind === 'matrix'
                ? [{ kind: 'image' }, { kind: 'file' }, { kind: 'audio', rendering: item.provider_kind === 'matrix' ? 'm.audio' : 'attachment' }, { kind: 'video' }]
                : [{ kind: 'image' }, { kind: 'file' }, { kind: 'audio' }, { kind: 'voice' }, { kind: 'video' }],
          })),
        ],
      };
    },
    setInternalChannel: async (sessionId: string, enabled: boolean) => {
      calls.push({ operation: 'setInternalChannel', id: sessionId, body: enabled });
      if (enabled) internalOff.delete(sessionId);
      else internalOff.add(sessionId);
      return { enabled };
    },
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
    testBinding: async (id: string): Promise<ImBindingTestResult> => {
      calls.push({ operation: 'testBinding', id });
      const b = state.bindings.find((item) => item.id === id);
      if (b === undefined) throw new Error('unknown_binding');
      const admitted = b.enabled && imSessionAdmitted({ allowed: state.policy.allowed, defaultEnabled: state.policy.default_enabled, sessionEnabled: b.session_enabled });
      if (!admitted) return { binding_id: id, status: 'failed', message_ids: [], detail: 'binding_disabled' };
      const inst = state.instances.find((item) => item.id === b.provider_instance_id);
      if (inst === undefined || !inst.listening || inst.adapter === 'stopped' || inst.adapter === 'missing') {
        return { binding_id: id, status: 'failed', message_ids: [], detail: 'channel_not_connected' };
      }
      return { binding_id: id, status: 'delivered', message_ids: [`msg-${id}`] };
    },
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
