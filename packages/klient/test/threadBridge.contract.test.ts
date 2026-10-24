import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { ReadThreadResult } from '@kiki/agent-core-v2/app/threadCommunication/threadCommunication';
import { readThreadResultSchema } from '../src/contract/global/threads';
import type { MutableDeep } from './helpers/typeAssert';

const engineToWire = (value: MutableDeep<ReadThreadResult>): z.infer<typeof readThreadResultSchema> => value;
const wireToEngine = (value: z.infer<typeof readThreadResultSchema>): MutableDeep<ReadThreadResult> => value;
describe('thread bridge read contract', () => {
  it('preserves next-hop addressing and bounded content segments without permitting a producer', () => {
    const result: MutableDeep<ReadThreadResult> = { thread: { hostId: 'host-target', workspaceId: 'workspace-target', sessionId: 'same-session', bridgeId: 'a7dcc94f-470e-4bf5-88c9-0f57f21bded7' }, turns: [], view: { segment: {
      ref: { source: { kind: 'turn', id: 't0' }, revision: 'revision', path: ['prompt'], kind: 'text', offset: 0, total: 5 }, value: 'hello', contentRefs: [],
    } } };
    expect(wireToEngine(readThreadResultSchema.parse(engineToWire(result)))).toEqual(result);
  });

  it('preserves a preparation page and its opaque continuation cursor', () => {
    const result: MutableDeep<ReadThreadResult> = {
      thread: { hostId: 'host-target', workspaceId: 'workspace-target', sessionId: 'same-session' },
      turns: [], incomplete: 'history_preparing', nextCursor: 'opaque-preparation-cursor',
    };
    expect(wireToEngine(readThreadResultSchema.parse(JSON.parse(JSON.stringify(engineToWire(result)))))).toEqual(result);
  });

  it('preserves sender labels and every public completed-turn origin across JSON validation', () => {
    const origins: ReadThreadResult['turns'][number]['origin'][] = ['user', 'peer', 'bridged_peer', 'external', 'mixed', 'unknown', 'thread_created'];
    for (const origin of origins) {
      const thread = { hostId: 'host-target', workspaceId: 'workspace-target', sessionId: 'same-session',
        personaId: 'persona-example', name: 'Example sender', bridgeId: 'a7dcc94f-470e-4bf5-88c9-0f57f21bded7',
        connectionId: 'e382f4bc-1b2f-4eaa-b2c5-540b5f92891c' };
      const result: MutableDeep<ReadThreadResult> = { thread, turns: [{ turnId: 0, endedAt: 1, reason: 'completed', origin,
        peer: { source: thread, messageId: 'message-example' }, input: 'request', output: 'response' }] };
      expect(wireToEngine(readThreadResultSchema.parse(JSON.parse(JSON.stringify(engineToWire(result)))))).toEqual(result);
    }
  });

  it('retains bounded bridge transcript pages and mutable wire execution losses', () => {
    const result: MutableDeep<ReadThreadResult> = { thread: { hostId: 'host-target', workspaceId: 'workspace-target', sessionId: 'same-session' }, turns: [],
      view: { transcript: { session_id: 'same-session', agent_id: 'main', has_more: true, next_cursor: 'older-page',
        items: [{ kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'external' }, steps: [],
          execution: { executorId: 'example-executor', protocol: 'example-protocol', resumeMode: 'resume', profileDelivery: 'native', fidelity: 'degraded', losses: ['example-loss'] } }],
        tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {}, agents: [], pending_interactions: [],
        coverage: { kind: 'tail', hasMoreOlder: true }, cursor: { epoch: 'example-epoch', seq: 3 } } } };
    expect(wireToEngine(readThreadResultSchema.parse(JSON.parse(JSON.stringify(engineToWire(result)))))).toEqual(result);
  });

  it('rejects unknown origins, non-string labels, invalid bridge addresses and malformed segments', () => {
    const thread = { hostId: 'host-target', workspaceId: 'workspace-target', sessionId: 'same-session' };
    const turn = { turnId: 0, endedAt: 1, reason: 'completed', origin: 'unsupported-origin', input: 'request', output: 'response' };
    expect(readThreadResultSchema.safeParse({ thread, turns: [turn] }).success).toBe(false);
    expect(readThreadResultSchema.safeParse({ thread: { ...thread, personaId: 1 }, turns: [] }).success).toBe(false);
    expect(readThreadResultSchema.safeParse({ thread: { ...thread, name: 1 }, turns: [] }).success).toBe(false);
    expect(readThreadResultSchema.safeParse({ thread: { ...thread, bridgeId: 'not-a-uuid' }, turns: [] }).success).toBe(false);
    expect(readThreadResultSchema.safeParse({ thread, turns: [], view: { segment: { value: 'missing-ref' } } }).success).toBe(false);
  });
});
