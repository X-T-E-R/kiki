import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { executorPromptSchema as profileSchema, resolveExecutorPrompt } from '#/executorPrompt';
import { executorPromptSchema as protocolSchema } from '../../protocol/src/executorPrompt';

describe('executor prompt contract', () => {
  it('matches the protocol request and response schema', () => {
    expect(z.toJSONSchema(profileSchema, { io: 'input' })).toEqual(z.toJSONSchema(protocolSchema, { io: 'input' }));
    expect(z.toJSONSchema(profileSchema, { io: 'output' })).toEqual(z.toJSONSchema(protocolSchema, { io: 'output' }));
  });

  it('inherits common include for a body-only engine override', () => {
    const config = profileSchema.parse({
      include: ['agents_md', 'memory_snapshot'],
      per_engine: { codex: { body: 'Engine instructions' } },
    });
    expect(config.per_engine?.['codex']?.include).toBeUndefined();
    expect(resolveExecutorPrompt(config, 'codex').include).toEqual(['agents_md', 'memory_snapshot']);
  });

  it('keeps an explicit empty include override and defaults an absent include at resolution', () => {
    const config = profileSchema.parse({
      include: ['agents_md'],
      per_engine: { codex: { include: [] } },
    });
    expect(resolveExecutorPrompt(config, 'codex').include).toEqual([]);
    expect(resolveExecutorPrompt(profileSchema.parse({}), 'codex').include).toEqual([]);
    expect(resolveExecutorPrompt(undefined, 'codex').include).toEqual([]);
  });

  it('resolves per-engine delivery and include without changing other engines', () => {
    const config = profileSchema.parse({
      delivery: 'append',
      include: ['agents_md'],
      body: 'Common instructions',
      per_engine: {
        codex: { delivery: 'replace', include: ['workspace_info'], append: 'Codex only' },
      },
    });
    expect(resolveExecutorPrompt(config, 'codex')).toEqual({
      delivery: 'replace', include: ['workspace_info'], body: 'Common instructions', append: 'Codex only',
    });
    expect(resolveExecutorPrompt(config, 'claude')).toEqual({
      delivery: 'append', include: ['agents_md'], body: 'Common instructions', append: undefined,
    });
  });
});
