/**
 * Scenario: nested subagent default-model ownership.
 *
 * Verifies that only durable subagent callers redirect an inherited spawn to
 * the live main-agent model context, and that the redirected context is marked
 * fixed so F1 resume semantics never reinterpret it as immediate-parent
 * inheritance.
 */

import { describe, expect, it } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { resolveNestedSubagentDefaultContext } from '#/session/subagent/bindingContext';

function lifecycleWithMain(
  modelAlias: string | undefined,
  thinkingLevel = 'high',
): IAgentLifecycleService {
  const main = {
    id: 'main',
    kind: LifecycleScope.Agent,
    accessor: {
      get: (id: unknown) => {
        if (id !== IAgentProfileService) return undefined as never;
        return {
          _serviceBrand: undefined,
          data: () => ({ modelAlias, thinkingLevel }),
        } as never;
      },
    },
    dispose: () => {},
  } as IAgentScopeHandle;
  return {
    _serviceBrand: undefined,
    get: (agentId) => (agentId === 'main' ? main : undefined),
  } as IAgentLifecycleService;
}

describe('resolveNestedSubagentDefaultContext', () => {
  it('uses the main agent live binding for a nested caller and disables inheritance', () => {
    expect(
      resolveNestedSubagentDefaultContext(lifecycleWithMain('provider/root'), {
        type: 'sub',
        labels: { parentAgentId: 'main' },
      }),
    ).toEqual({
      modelAlias: 'provider/root',
      thinkingLevel: 'high',
      inheritByDefault: false,
    });
  });

  it('leaves main and independent callers on their own binding path', () => {
    const lifecycle = lifecycleWithMain('provider/root');
    expect(resolveNestedSubagentDefaultContext(lifecycle, { type: 'main' })).toBeUndefined();
    expect(
      resolveNestedSubagentDefaultContext(lifecycle, {
        type: 'independent',
        delegator: { kind: 'external', delegationId: 'delegation-1' },
      }),
    ).toBeUndefined();
  });

  it('fails clearly when a nested caller has no live main binding', () => {
    const subagentMeta = { type: 'sub' as const, labels: { parentAgentId: 'main' } };
    expect(() =>
      resolveNestedSubagentDefaultContext(
        { _serviceBrand: undefined, get: () => undefined } as unknown as IAgentLifecycleService,
        subagentMeta,
      ),
    ).toThrow('Main agent does not exist');
    expect(() =>
      resolveNestedSubagentDefaultContext(lifecycleWithMain(undefined), subagentMeta),
    ).toThrow('Main agent has no model bound');
  });
});
