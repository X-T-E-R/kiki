import {
  sessionAgentConfigCreateSchema as engineCreateSchema,
  sessionAgentConfigPartialSchema as enginePatchSchema,
  sessionAgentConfigSchema as engineReadSchema,
} from '@kiki/agent-core-v2/app/sessionLegacy/sessionProtocol';
import {
  sessionAgentConfigCreateSchema as protocolCreateSchema,
  sessionAgentConfigPartialSchema as protocolPatchSchema,
  sessionAgentConfigSchema as protocolReadSchema,
} from '@kiki/protocol';
import { describe, expect, it } from 'vitest';

const PAIRS = [
  ['read', engineReadSchema, protocolReadSchema],
  ['update patch', enginePatchSchema, protocolPatchSchema],
  ['create patch', engineCreateSchema, protocolCreateSchema],
] as const;

describe('agent_config schema drift between the engine and the protocol package', () => {
  it.each(PAIRS)('%s carries the same fields on both sides', (_label, engine, protocol) => {
    expect(Object.keys(engine.shape).sort()).toEqual(Object.keys(protocol.shape).sort());
  });

  it.each(PAIRS.slice(1))('%s rejects an unknown key on both sides', (_label, engine, protocol) => {
    expect(engine.safeParse({ not_a_field: 'x' }).success).toBe(false);
    expect(protocol.safeParse({ not_a_field: 'x' }).success).toBe(false);
  });

  it('keeps the write-only controls out of the read shape', () => {
    for (const key of ['thinking', 'goal_objective', 'goal_control']) {
      expect(engineReadSchema.shape).not.toHaveProperty(key);
      expect(protocolReadSchema.shape).not.toHaveProperty(key);
    }
  });
});
