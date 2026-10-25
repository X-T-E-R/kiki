import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import type { ImSessionSnapshot, OptionalCapabilitySessionResponse, ImTargetChannels } from '@kiki/protocol';
import { I18nProvider } from '../src/i18n';
import { ConnectionScope, type ConnectionValue } from '../src/state/connection';
import { SessionChannelsRail } from '../src/components/im/SessionChannelsRail';
import '../src/index.css';

// Fixture state
const initialSnapshot: ImSessionSnapshot = {
  policy: { allowed: true, default_enabled: true, allow_channel_borrowing: false } as any,
  instances: [
    { id: 'tg-main', provider_kind: 'telegram', label: 'Telegram Bot', listening: true, configured: true, adapter: 'running' },
    { id: 'wx-main', provider_kind: 'wechat_bridge', label: 'WeChat Personal', listening: true, configured: true, adapter: 'running' },
  ],
  discoveries: [
    {
      id: 'd-slack-builds',
      provider_instance_id: 'slack-main',
      provider_kind: 'slack',
      account_id: 'slack-bot',
      identity: { chat_id: 'C123', topic_id: '0', sender_id: 'U999', chat_title: 'Slack #builds-feed', sender_name: 'CI Bot' },
      preview: 'Build succeeded',
      at: new Date().toISOString(),
    },
  ],
  bindings: [
    {
      id: 'b-tg-41',
      provider_instance_id: 'tg-main',
      provider_kind: 'telegram',
      account_id: 'bot-1',
      identity: { chat_id: '-1001', topic_id: '41', sender_id: 'u-ada', chat_title: 'Release room #41', sender_name: 'Ada' },
      session_id: 'sess_release_044',
      enabled: true,
      session_enabled: true,
      input_enabled: true,
      output_enabled: true,
      busy: 'queue',
      reply: 'final',
      mobile_interactions: true,
    },
    {
      id: 'b-wx-chenmo',
      provider_instance_id: 'wx-main',
      provider_kind: 'wechat_bridge',
      account_id: 'wx-1',
      identity: { chat_id: 'wxid_chenmo', topic_id: '0', sender_id: 'wxid_chenmo', sender_name: '陈默' },
      session_id: 'sess_release_044',
      enabled: true,
      session_enabled: true,
      input_enabled: false,
      output_enabled: true,
      busy: 'queue',
      reply: 'final',
      mobile_interactions: false,
    },
    {
      id: 'b-tg-42',
      provider_instance_id: 'tg-main',
      provider_kind: 'telegram',
      account_id: 'bot-1',
      identity: { chat_id: '-1001', topic_id: '42', sender_id: 'u-ada', chat_title: 'Release room #42', sender_name: 'Ada' },
      session_id: 'sess_incident_09',
      enabled: true,
      session_enabled: true,
      input_enabled: true,
      output_enabled: true,
      busy: 'queue',
      reply: 'final',
      mobile_interactions: true,
    },
    {
      id: 'b-orphan-wechat',
      provider_instance_id: 'wx-main',
      provider_kind: 'wechat_bridge',
      account_id: 'wx-1',
      identity: { chat_id: 'wxid_ops', topic_id: '0', sender_id: 'wxid_ops', chat_title: '运维群', sender_name: 'Ops' },
      pending_reanchor: true,
      enabled: true,
      session_enabled: true,
      input_enabled: true,
      output_enabled: true,
      busy: 'queue',
      reply: 'final',
      mobile_interactions: false,
    },
  ],
  strangers: [],
  voice_fallbacks: 0,
};

let currentSnapshot = structuredClone(initialSnapshot);
let optionalChoice: 'inherit' | 'on' | 'off' = 'inherit';
let notifyMailEnabled = false;

function createMockClient() {
  return {
    imSessions: {
      snapshot: async () => structuredClone(currentSnapshot),
      updateBinding: async (id: string, patch: any) => {
        currentSnapshot.bindings = currentSnapshot.bindings.map((b) => {
          if (b.id !== id) return b;
          return { ...b, ...patch, pending_reanchor: false };
        });
        return structuredClone(currentSnapshot);
      },
      removeBinding: async (id: string) => {
        currentSnapshot.bindings = currentSnapshot.bindings.filter((b) => b.id !== id);
        return structuredClone(currentSnapshot);
      },
      confirm: async (id: string, body: any) => {
        const d = currentSnapshot.discoveries.find((item) => item.id === id);
        if (d) {
          currentSnapshot.bindings.push({
            ...d,
            session_id: body.target.session_id,
            enabled: true,
            session_enabled: true,
            input_enabled: true,
            output_enabled: true,
            busy: 'queue',
            reply: 'final',
            mobile_interactions: true,
          });
          currentSnapshot.discoveries = currentSnapshot.discoveries.filter((item) => item.id !== id);
        }
        return structuredClone(currentSnapshot);
      },
      setPolicy: async (policy: any) => {
        currentSnapshot.policy = policy;
        return structuredClone(currentSnapshot);
      },
      channelViews: async (sessionId: string): Promise<ImTargetChannels> => ({
        target: { kind: 'session', session_id: sessionId },
        internal_enabled: true,
        channels: [
          {
            id: 'internal',
            kind: 'internal',
            bound: true,
            enabled: true,
            title: '会话内 (internal)',
          },
          ...currentSnapshot.bindings
            .filter((b) => b.session_id === sessionId)
            .map((b) => ({
              id: `im:${b.id}`,
              kind: 'im' as const,
              bound: true,
              enabled: b.enabled && b.session_enabled !== false,
              title: b.identity.chat_title || b.identity.chat_id,
            })),
          {
            id: 'notify:feishu-duty',
            kind: 'notify',
            bound: true,
            enabled: true,
            title: '飞书值班群 Webhook',
          },
          {
            id: 'notify:mail',
            kind: 'notify',
            bound: true,
            enabled: notifyMailEnabled,
            title: '邮件运维通知 (Mail)',
          },
          {
            id: 'notify:slack-ops',
            kind: 'notify',
            bound: false,
            enabled: false,
            title: 'Slack 告警推送',
          },
        ],
      }),
      setNotificationChannel: async (_sessionId: string, channelId: string, enabled: boolean) => {
        if (channelId === 'mail') {
          notifyMailEnabled = enabled;
        }
      },
      removeNotificationChannel: async (_sessionId: string, _channelId: string) => {},
    },
    getSessionOptionalCapabilities: async (sessionId: string): Promise<OptionalCapabilitySessionResponse> => ({
      sessionId,
      revision: 1,
      rows: [
        {
          id: 'send_message',
          choice: optionalChoice,
          allowed: true,
          host_locked: false,
          default_on: false,
          unresolved: false,
          effective: optionalChoice === 'on',
          reason: optionalChoice === 'on' ? 'admitted' : 'default_off',
          source: optionalChoice === 'on' ? 'session' : 'default',
          applies: 'next-step',
        },
      ],
    }),
    setSessionOptionalCapability: async (sessionId: string, body: { id: string; choice: 'inherit' | 'on' | 'off' }) => {
      if (body.id === 'send_message') {
        optionalChoice = body.choice;
      }
      return {
        sessionId,
        revision: 2,
        rows: [
          {
            id: 'send_message',
            choice: optionalChoice,
            allowed: true,
            host_locked: false,
            default_on: false,
            unresolved: false,
            effective: optionalChoice === 'on',
            reason: optionalChoice === 'on' ? 'admitted' : 'default_off',
            source: optionalChoice === 'on' ? 'session' : 'default',
            applies: 'next-step',
          },
        ],
      };
    },
    getConfig: async () => ({
      optional_capabilities: {
        send_message: { allowed: true, default_on: false, unresolved: false, host_locked: false },
      },
    }),
    notifications: {
      getSettings: async () => ({
        channels: {
          'feishu-duty': { label: '飞书值班群 Webhook', enabled: true },
          mail: { label: '邮件运维通知 (Mail)', enabled: true },
          'slack-ops': { label: 'Slack 告警推送', enabled: true },
        },
      }),
    },
  };
}

const mockClient = createMockClient();
const connectionValue: ConnectionValue = {
  scopeId: 'proof-local',
  spaceKey: 'main',
  connectionId: null,
  client: mockClient as any,
  status: 'connected',
};

function ProofApp() {
  const [activeSessionId, setActiveSessionId] = useState('sess_release_044');
  const [hasPersona, setHasPersona] = useState(false);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas text-ink p-4 gap-4 max-md:flex-col max-md:overflow-y-auto">
      {/* Left session mock picker */}
      <div className="w-56 flex flex-col gap-2 p-2 bg-panel rounded-xl border border-hairline shrink-0 max-md:w-full">
        <h2 className="text-[12px] font-semibold text-ink-faint px-2 pt-1">测试场景切换</h2>
        <button
          type="button"
          data-switch-persona=""
          onClick={() => setHasPersona((v) => !v)}
          className={`p-2 rounded-lg text-left text-[12.5px] border ${
            hasPersona ? 'border-selected-ink bg-selected font-medium' : 'border-hairline bg-paper'
          }`}
        >
          {hasPersona ? '当前：角色模式 (林岚)' : '当前：纯线程 (无角色)'}
        </button>

        <button
          type="button"
          data-switch-session=""
          onClick={() => setActiveSessionId((id) => (id === 'sess_release_044' ? 'sess_incident_09' : 'sess_release_044'))}
          className="p-2 rounded-lg text-left text-[12px] border border-hairline bg-paper text-ink-soft hover:text-ink"
        >
          切换会话: {activeSessionId}
        </button>

        <div className="text-[11.5px] text-ink-faint px-2 pt-4">
          <p>• 纯线程: SendMessage 默认关，右栏可临时开启</p>
          <p>• 角色模式: 默认自动开启并扇出</p>
          <p>• 外部 IM: [•入] [•出] 独立胶囊</p>
          <p>• + 绑定: 包含转绑二次确认与待锚定</p>
          <p>• 通知: 关闭后仍常驻可见并支持重开</p>
        </div>
      </div>

      {/* Center placeholder */}
      <div className="flex-1 bg-paper rounded-xl border border-hairline p-6 flex flex-col justify-between max-md:min-h-64">
        <div>
          <h1 className="font-display text-xl font-bold">
            {activeSessionId === 'sess_release_044' ? '0.4.4 发布与多信道回归' : '线上故障排查值班'}
          </h1>
          <p className="text-[13px] text-ink-faint mt-1">
            {hasPersona ? '角色：林岚 · Kiki' : '无角色纯线程'} · session_id: {activeSessionId}
          </p>
        </div>

        <div className="rounded-lg border border-hairline bg-panel p-4 text-[13px] text-ink-soft leading-relaxed">
          已送达：Kiki 会话内 (internal)、Telegram · Release room #41、飞书值班群 Webhook。
          普通最终文本回复与基础对话常驻可见。
        </div>
      </div>

      {/* Right Rail Container */}
      <div className="w-80 bg-panel rounded-xl border border-hairline p-4 overflow-y-auto shrink-0 shadow-sm max-md:w-full" data-proof-rail>
        <SessionChannelsRail
          key={`${activeSessionId}-${hasPersona}`}
          sessionId={activeSessionId}
          sessionTitle={activeSessionId === 'sess_release_044' ? '0.4.4 发布与多信道回归' : '线上故障排查值班'}
          personaId={hasPersona ? 'lin' : undefined}
          personaName={hasPersona ? '林岚' : undefined}
          onOpenSettings={() => alert('Navigate to Settings')}
        />
      </div>
    </div>
  );
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const root = createRoot(document.getElementById('root')!);
root.render(
  <QueryClientProvider client={queryClient}>
    <I18nProvider>
      <ConnectionScope value={connectionValue}>
        <MemoryRouter>
          <ProofApp />
        </MemoryRouter>
      </ConnectionScope>
    </I18nProvider>
  </QueryClientProvider>
);
