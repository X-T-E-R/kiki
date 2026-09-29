import { describe, expect, it } from 'vitest';

import {
  actualDelivery, deliveredBlocks, executorPromptBody, executorPromptDraftFrom, executorPromptIncludesValid, resolvedSection,
} from './executorPromptDraft';

describe('executor prompt draft', () => {
  it('round-trips the wire shape and clears to null when nothing is set', () => {
    const draft = executorPromptDraftFrom({ delivery: 'append', include: ['agents_md'], per_engine: { 'claude-acp': { include: [], body: 'x' } } });
    expect(executorPromptBody(draft)).toEqual({ delivery: 'append', include: ['agents_md'], per_engine: { 'claude-acp': { include: [], body: 'x' } } });
    expect(executorPromptBody({ include: [], body: '' })).toBeNull();
    expect(executorPromptDraftFrom(undefined)).toBeNull();
  });

  it('resolves per engine like the server: override keys win, delivery defaults to append', () => {
    const draft = { delivery: 'append' as const, include: ['agents_md'], append: 'tail', per_engine: { 'claude-acp': { delivery: 'replace' as const, include: [] } } };
    expect(resolvedSection(draft, 'codex-app-server')).toEqual({ delivery: 'append', include: ['agents_md'], body: undefined, append: 'tail' });
    expect(resolvedSection(draft, 'claude-acp')).toEqual({ delivery: 'replace', include: [], body: undefined, append: 'tail' });
    expect(resolvedSection(null, 'x').delivery).toBe('append');
  });

  it('downgrades to preamble, then the first supported method', () => {
    expect(actualDelivery('append', ['append', 'replace', 'preamble'])).toBe('append');
    expect(actualDelivery('append', ['replace', 'preamble'])).toBe('preamble');
    expect(actualDelivery('append', ['replace'])).toBe('replace');
    expect(actualDelivery('replace', undefined)).toBe('replace');
  });

  it('orders context before fields and folds ids a wildcard covers', () => {
    expect(deliveredBlocks(['system.rubric', 'workspace_info', 'system.*', 'agents_md', 'delegation.x']))
      .toEqual({ context: ['agents_md', 'workspace_info'], fields: ['system.*', 'delegation.x'] });
  });

  it('rejects include ids the server schema would refuse', () => {
    expect(executorPromptIncludesValid({ include: ['agents_md', 'system.review-rubric'] })).toBe(true);
    expect(executorPromptIncludesValid({ per_engine: { codex: { include: ['tools.list'] } } })).toBe(false);
  });
});
