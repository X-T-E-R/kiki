import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INDEPENDENT_DELEGATION_NOTICE,
  injectDelegationContext,
  resolveDelegationPosition,
  resolveDelegationSnippet,
} from '#/agent/profile/delegationContext';
import { TASK_AGENT_ROLE_PREFIX } from '#/app/agentProfileCatalog/profile-shared';
import { AgentsConfigSchema } from '#/session/agentCollaboration/configSection';

describe('resolveDelegationPosition', () => {
  it('classifies main, independent, and sub from agent id and delegator', () => {
    expect(resolveDelegationPosition('main', undefined)).toBe('main');
    expect(resolveDelegationPosition('main', { kind: 'external', delegationId: 'd1' })).toBe('main');
    expect(resolveDelegationPosition('agent-1', { kind: 'external', delegationId: 'd1' })).toBe(
      'independent',
    );
    expect(resolveDelegationPosition('agent-1', { kind: 'agent', agentId: 'main' })).toBe('sub');
    expect(resolveDelegationPosition('agent-1', undefined)).toBe('sub');
  });
});

describe('injectDelegationContext', () => {
  it('fills ${delegation_context} when the template already has the token', () => {
    expect(injectDelegationContext('HEAD\n${delegation_context}\nTAIL', 'NOTICE')).toBe(
      'HEAD\nNOTICE\nTAIL',
    );
  });

  it('prepends when the template does not have the token', () => {
    expect(injectDelegationContext('BODY', 'NOTICE')).toBe('NOTICE\n\nBODY');
  });

  it('strips the token when there is no snippet', () => {
    expect(injectDelegationContext('HEAD\n${delegation_context}\n\nTAIL', undefined)).toBe(
      'HEAD\n\nTAIL',
    );
  });
});

describe('resolveDelegationSnippet', () => {
  it('accepts boolean gates and rejects the removed file-path form', () => {
    expect(AgentsConfigSchema.safeParse({ delegation: { sub: false, independent: true } }).success).toBe(true);
    expect(AgentsConfigSchema.safeParse({ delegation: { sub: 'delegation/sub.md' } }).success).toBe(false);
  });

  it('returns no snippet for main, profile off, or a disabled slot', () => {
    expect(resolveDelegationSnippet({ position: 'main' })).toBeUndefined();
    expect(resolveDelegationSnippet({ position: 'sub', notice: 'off' })).toBeUndefined();
    expect(resolveDelegationSnippet({ position: 'sub', config: { sub: false } })).toBeUndefined();
  });

  it('uses built-in defaults and field overrides', () => {
    expect(resolveDelegationSnippet({ position: 'sub' })).toBe(TASK_AGENT_ROLE_PREFIX);
    expect(resolveDelegationSnippet({ position: 'independent' })).toBe(DEFAULT_INDEPENDENT_DELEGATION_NOTICE);
    expect(resolveDelegationSnippet({
      position: 'sub',
      fields: { 'delegation.sub.notice': 'CUSTOM SUB' },
    })).toBe('CUSTOM SUB');
    expect(resolveDelegationSnippet({
      position: 'independent',
      fields: { 'delegation.independent.notice': 'CUSTOM INDEPENDENT' },
    })).toBe('CUSTOM INDEPENDENT');
  });
});
