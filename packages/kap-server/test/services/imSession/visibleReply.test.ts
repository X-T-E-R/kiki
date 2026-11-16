import { describe, expect, it, vi } from 'vitest';
import { IAgentContextMemoryService, IAgentLifecycleService, IAgentLoopService, IAgentPromptService, IAgentStateService,
  ISessionManager, ISessionMediaStore, type Scope } from '@kiki/agent-core-v2';
import { IAgentToolExecutorService } from '@kiki/agent-core-v2/agent/toolExecutor/toolExecutor';
import type { ToolDidExecuteContext } from '@kiki/agent-core-v2/agent/toolExecutor/toolHooks';
import { OrderedHookSlot } from '@kiki/agent-core-v2/hooks';
import { IPluginHostService } from '@kiki/agent-core-v2/app/plugin/pluginHostService';
import type { NotificationService } from '../../../src/services/notifications/notificationService';
import type { ImSessionPorts } from '../../../src/services/imSession/ports';

import type { ImBinding, ImMessageMetadata } from '@nb-corp/im-bridge-core/imSession';
import { createImSessionHost, replyChannelIds, visibleReplyMessages } from '../../../src/services/imSession/host';

const hostPorts = vi.hoisted(() => ({ current: undefined as ImSessionPorts | undefined }));
vi.mock('../../../src/services/imSession/bridge', () => ({ ImSessionBridge: class {
  constructor({ ports }: { ports: ImSessionPorts }) { hostPorts.current = ports; }
  async whenReady() {}
  async snapshot() { return { policy: { allowed: true, default_enabled: true }, bindings: [
    { id: 'origin', session_id: 'session', provider_instance_id: 'instance', account_id: 'account',
      identity: { chat_id: 'chat', sender_id: 'sender', topic_id: '0' } },
  ] }; }
  async setPolicy() {}
  async close() {}
} }));

describe('visible IM reply messages', () => {
  it.each([undefined, 14])('bounds five steered prompts without stopping at internal records (%s)', (turnId) => {
    const messages = [
      ...Array.from({ length: 5 }, (_, index) => ({ id: `P${index + 1}`, role: 'user', origin: { kind: 'user' }, source: { turnId } })),
      ...['branch_fold', 'retry', 'injection', 'task', 'hook_result', 'compaction_summary', 'system_trigger', 'skill_activation', 'plugin_command', 'shell_command', 'cron_missed'].map(kind => ({ id: kind, role: 'user', origin: { kind }, source: { turnId } })),
      { id: 'final', role: 'assistant', source: { turnId } },
    ];
    for (let index = 1; index < 5; index++) expect(visibleReplyMessages(messages, `P${index}`, turnId)).toEqual([]);
    expect(visibleReplyMessages(messages, 'P5', turnId).map(message => message.id)).toEqual(['final']);
  });

  it('keeps the pre-steer reply with its original prompt', () => {
    const messages = [
      { id: 'P1', role: 'user', source: { turnId: 14 } },
      { id: 'first', role: 'assistant', source: { turnId: 14 } },
      { id: 'P2', role: 'user', source: { turnId: 14 } },
      { id: 'final', role: 'assistant', source: { turnId: 14 } },
    ];
    expect(visibleReplyMessages(messages, 'P1', 14).map(message => message.id)).toEqual(['first']);
  });

  it('does not claim a compacted prompt when a newer prompt survives', () => {
    const messages = [
      { id: 'P2', role: 'user', source: { turnId: 14 }, origin: { kind: 'user' } },
      { id: 'final', role: 'assistant', source: { turnId: 14 } },
    ];
    expect(visibleReplyMessages(messages, 'P1', 14)).toEqual([]);
  });

  it('allows only the latest prompt to claim orphan replies after compaction', () => {
    const messages = [
      { role: 'user', origin: { kind: 'compaction_summary' } },
      { id: 'final', role: 'assistant', source: { turnId: 14 } },
    ];
    expect(visibleReplyMessages(messages, 'P1', 14, 'P5')).toEqual([]);
    expect(visibleReplyMessages(messages, 'P5', 14, 'P5').map(message => message.id)).toEqual(['final']);
  });

  it.each([
    { delivered_to: ['user'], channels: [{ channel_id: 'im:bound', status: 'delivered' }] },
    { messages: Array.from({ length: 2 }, () => ({ delivered_to: ['user'], channels: [{ channel_id: 'im:bound', status: 'delivered' }] })) },
  ])('suppresses fallback text and media after confirmed delivery: %j', output => {
    const messages = sendMessages(output);
    expect(visibleReplyMessages(messages, 'P1', 14)).toEqual([]);
  });

  it.each([
    { output: { delivered_to: ['Peer Bot'] }, isError: false },
    { output: { delivered_to: ['user'] }, isError: true },
    { output: { delivered_to: [] }, isError: false },
  ])('preserves fallback after handoff or failure: %j', ({ output, isError }) => {
    const messages = sendMessages(output, isError);
    expect(visibleReplyMessages(messages, 'P1', 14).map(message => message.id)).toEqual(['send', 'closing']);
  });

  it('does not suppress a later steered prompt after an earlier SendMessage', () => {
    const messages = [
      ...sendMessages({ delivered_to: ['user'], channels: [{ channel_id: 'im:bound', status: 'delivered' }] }),
      { id: 'P2', role: 'user', source: { turnId: 14 } },
      { id: 'ordinary', role: 'assistant', source: { turnId: 14 } },
    ];
    expect(visibleReplyMessages(messages, 'P2', 14).map(message => message.id)).toEqual(['ordinary']);
  });

  it.each([
    { channels: [{ channel_id: 'internal', status: 'delivered' }, { channel_id: 'im:bound', status: 'failed' }] },
    { channels: [{ channel_id: 'internal', status: 'delivered' }, { channel_id: 'im:bound', status: 'unsupported' }] },
    { channels: [{ channel_id: 'im:other', status: 'delivered', borrowed: true }] },
    { channels: [{ channel_id: 'notify:example', status: 'delivered' }, { channel_id: 'internal', status: 'delivered' }] },
    { channels: [] },
    { messages: [{ delivered_to: ['user'], channels: [{ channel_id: 'im:bound', status: 'delivered' }] },
      { delivered_to: ['user'], channels: [{ channel_id: 'im:bound', status: 'failed' }] }] },
  ])('retains fallback unless every message reaches its bound IM output: %j', receipt => {
    expect(visibleReplyMessages(sendMessages({ delivered_to: ['user'], ...receipt }), 'P1', 14).map(message => message.id))
      .toEqual(['send', 'closing']);
  });

  it('retains confirmed prompt delivery after mid-turn compaction without suppressing a newer steer', () => {
    const messages = [{ role: 'user', origin: { kind: 'compaction_summary' } },
      { role: 'assistant', id: 'closing', source: { turnId: 14 } }];
    expect(visibleReplyMessages(messages, 'P1', 14, 'P1', true)).toEqual([]);
    expect(visibleReplyMessages(messages, 'P2', 14, 'P2', false)).toEqual([messages[1]]);
  });

  it('keeps the originating binding fallback when another bound destination succeeds', () => {
    const messages = sendMessages({ delivered_to: ['user'], channels: [
      { channel_id: 'im:other', status: 'delivered' }, { channel_id: 'im:origin', status: 'failed' },
    ] });
    expect(visibleReplyMessages(messages, 'P1', 14, 'P1', false, ['im:origin']).map(message => message.id)).toEqual(['send', 'closing']);
    expect(visibleReplyMessages(messages, 'P1', 14, 'P1', false, ['im:other'])).toEqual([]);
  });

  it('requires each batch item to reach the same originating destination', () => {
    const messages = sendMessages({ messages: [
      { delivered_to: ['user'], channels: [{ channel_id: 'im:origin', status: 'delivered' }] },
      { delivered_to: ['user'], channels: [{ channel_id: 'im:other', status: 'delivered' }] },
    ] });
    expect(visibleReplyMessages(messages, 'P1', 14, 'P1', false, ['im:origin']).map(message => message.id)).toEqual(['send', 'closing']);
  });

  it('resolves sender, topic and chat destinations only within the session and account', () => {
    const metadata: ImMessageMetadata = { provider_kind: 'telegram', provider_instance_id: 'instance', account_id: 'account',
      identity: { chat_id: 'chat', sender_id: 'sender', topic_id: '42', chat_kind: 'group' } };
    const binding = { session_id: 'session', provider_instance_id: 'instance', account_id: 'account', identity: metadata.identity };
    const bindings = [
      { ...binding, id: 'sender' },
      { ...binding, id: 'other-sender', identity: { ...metadata.identity, sender_id: 'other' } },
      { ...binding, id: 'topic', binding_scope: 'topic', identity: { ...metadata.identity, sender_id: 'other' } },
      { ...binding, id: 'chat', binding_scope: 'chat', identity: { ...metadata.identity, topic_id: '0', sender_id: 'other' } },
      { ...binding, id: 'other-session', session_id: 'other' },
      { ...binding, id: 'other-account', account_id: 'other' },
    ] as ImBinding[];
    expect(replyChannelIds('session', metadata, bindings)).toEqual(['im:sender', 'im:topic', 'im:chat']);
  });

  it('observes bound delivery before compaction and retains it for only that prompt', async () => {
    const hook = new OrderedHookSlot<ToolDidExecuteContext>();
    const im: ImMessageMetadata = { provider_kind: 'telegram', provider_instance_id: 'instance', account_id: 'account',
      identity: { chat_id: 'chat', sender_id: 'sender', topic_id: '0' } };
    let messages = [{ id: 'P1', role: 'user', origin: { kind: 'user', im }, source: { turnId: 14 }, content: [] },
      { id: 'closing', role: 'assistant', source: { turnId: 14 }, content: [{ type: 'text', text: 'closing' }] }];
    const identities = new Map([['P1', { promptId: 'P1', turnId: 14 }]]);
    const agent = { accessor: { get: (key: unknown) => {
      if (key === IAgentToolExecutorService) return { hooks: { onDidExecuteTool: hook } };
      if (key === IAgentPromptService) return { lookup: () => ({ turnId: 14, terminal: true }), list: () => ({ pending: [] }) };
      if (key === IAgentLoopService) return { status: () => ({ activeTurnId: undefined }) };
      if (key === IAgentContextMemoryService) return { get: () => messages };
      if (key === IAgentStateService) return { get: () => identities };
      throw new Error('unexpected_agent_service');
    } } };
    const session = { accessor: { get: (key: unknown) => {
      if (key === IAgentLifecycleService) return { get: () => agent, create: async () => agent };
      if (key === ISessionMediaStore) return {};
      throw new Error('unexpected_session_service');
    } } };
    const core = { instantiation: { provide() {} }, accessor: { get: (key: unknown) => {
      if (key === IPluginHostService) return { attachImAdapters: async () => {} };
      if (key === ISessionManager) return { acquire: async () => ({ handle: session, dispose() {} }) };
      throw new Error('unexpected_app_service');
    } } } as unknown as Scope;
    const bridge = await createImSessionHost({ core, homeDir: '/fixture', notifications: {} as NotificationService, factories: [], logger: { info() {} } });
    try {
      const ports = hostPorts.current!;
      expect((await ports.sessions.readVisible('session', 'P1', 14)).text).toBe('closing');
      const context: ToolDidExecuteContext = { turnId: 14, signal: new AbortController().signal, args: { to: 'user' },
        outcome: 'executed', toolCalls: [], toolCall: { id: 'send', type: 'function', name: 'SendMessage', arguments: '{}' },
        result: { output: JSON.stringify({ delivered_to: ['user'], channels: [{ channel_id: 'im:other', status: 'delivered' }] }) } };
      await hook.run(context);
      messages = [messages[1]!];
      expect((await ports.sessions.readVisible('session', 'P1', 14)).text).toBe('closing');
      messages = [{ ...messages[0]!, id: 'P1', role: 'user', origin: { kind: 'user', im }, content: [] }, ...messages];
      context.result = { output: JSON.stringify({ delivered_to: ['user'], channels: [{ channel_id: 'im:origin', status: 'delivered' }] }) };
      await hook.run(context);
      messages = [messages[1]!];
      expect((await ports.sessions.readVisible('session', 'P1', 14)).text).toBe('');
      identities.set('P2', { promptId: 'P2', turnId: 14 });
      expect((await ports.sessions.readVisible('session', 'P2', 14)).text).toBe('closing');
    } finally { await bridge.close(); }
  });

  it('ignores unrelated tool receipts and invalid JSON', () => {
    const messages = sendMessages({ delivered_to: ['user'] });
    const tool = messages[2]!;
    expect(visibleReplyMessages([...messages.slice(0, 2), { ...tool, toolCallId: 'other' }, messages[3]!], 'P1', 14)).toHaveLength(2);
    expect(visibleReplyMessages([...messages.slice(0, 2), { ...tool, content: [{ type: 'text', text: 'failed' }] }, messages[3]!], 'P1', 14)).toHaveLength(2);
  });
  it('returns the assistant text for the prompt turn after an injected reminder', () => {
    const messages = [
      { id: 'im:1', role: 'user', origin: { kind: 'user' }, source: { turnId: 0 }, content: [{ type: 'text', text: 'turn-hello' }] },
      { id: 'reminder', role: 'user', origin: { kind: 'injection', variant: 'runtime_snapshot' }, content: [{ type: 'text', text: '<system-reminder>\nworkspace\n</system-reminder>' }] },
      { id: 'assistant', role: 'assistant', source: { turnId: 0 }, content: [{ type: 'text', text: 'reply-turn-hello' }] },
    ];
    expect(visibleReplyMessages(messages, 'im:1').map((item) => item.content[0]?.text)).toEqual(['reply-turn-hello']);
  });

  it.each([undefined, 0])('does not fall back to another turn when the requested turn has no reply (%s)', (turnId) => {
    const messages = [
      { id: 'im:1', role: 'user', source: { turnId: 0 } },
      { id: 'other-reply', role: 'assistant', source: { turnId: 1 } },
    ];
    expect(visibleReplyMessages(messages, 'im:1', turnId)).toEqual([]);
  });

  it('skips an injection when the prompt has no turn id yet and stops at the next person', () => {
    const messages = [
      { id: 'im:1', role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'a' }] },
      { id: 'reminder', role: 'user', origin: { kind: 'injection' }, content: [{ type: 'text', text: '<system-reminder>\nx\n</system-reminder>' }] },
      { id: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'one' }] },
      { id: 'im:2', role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'b' }] },
      { id: 'later', role: 'assistant', content: [{ type: 'text', text: 'two' }] },
    ];
    expect(visibleReplyMessages(messages, 'im:1').map((item) => item.id)).toEqual(['assistant']);
  });

  it('returns only assistant replies generated after an accepted steer prompt in the same turn', () => {
    const messages = [
      { id: 'im:1', role: 'user', origin: { kind: 'user' }, source: { turnId: 0 }, content: [{ type: 'text', text: 'first' }] },
      { id: 'step-1', role: 'assistant', source: { turnId: 0 }, content: [{ type: 'text', text: 'step-one-reply' }] },
      { id: 'im:2', role: 'user', origin: { kind: 'user' }, source: { turnId: 0 }, content: [{ type: 'text', text: 'steered' }] },
      { id: 'reminder', role: 'user', origin: { kind: 'injection' }, content: [{ type: 'text', text: '<system-reminder>\nx\n</system-reminder>' }] },
      { id: 'step-2', role: 'assistant', source: { turnId: 0 }, content: [{ type: 'text', text: 'step-two-reply' }] },
      { id: 'turn-1', role: 'assistant', source: { turnId: 1 }, content: [{ type: 'text', text: 'other-turn' }] },
    ];
    expect(visibleReplyMessages(messages, 'im:2', 0).map((item) => item.id)).toEqual(['step-2']);
    expect(visibleReplyMessages(messages, 'im:2').map((item) => item.id)).toEqual(['step-2']);
  });
});

function sendMessages(output: unknown, isError = false) {
  return [
    { id: 'P1', role: 'user', source: { turnId: 14 } },
    { id: 'send', role: 'assistant', source: { turnId: 14 }, toolCalls: [{ id: 'call', function: { name: 'SendMessage' } }, { id: 'edit', name: 'Edit' }] },
    { role: 'tool', toolCallId: 'call', source: { turnId: 14 }, isError, content: [{ type: 'text', text: JSON.stringify(output) }] },
    { id: 'closing', role: 'assistant', source: { turnId: 14 }, content: [{ type: 'text', text: 'See the delivery above.' }, { type: 'image_url' }] },
  ];
}
