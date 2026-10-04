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
});
