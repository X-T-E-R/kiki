import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { executorPromptSchema as profileSchema, resolveExecutorPrompt } from '#/executorPrompt';
import { executorPromptSchema as protocolSchema } from '../../protocol/src/executorPrompt';

describe('executor prompt contract', () => {
  it('matches the protocol request and response schema', () => {
    expect(z.toJSONSchema(profileSchema, { io: 'input' })).toEqual(z.toJSONSchema(protocolSchema, { io: 'input' }));
    expect(z.toJSONSchema(profileSchema, { io: 'output' })).toEqual(z.toJSONSchema(protocolSchema, { io: 'output' }));
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
