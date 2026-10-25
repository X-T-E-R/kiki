import {
  Error2,
  IAgentActivityView,
  IAgentFullCompactionService,
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentPromptService,
  ISessionActivityView,
  ISessionInteractionService,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
} from '@kiki/agent-core-v2';
import { describe, expect, it } from 'vitest';

import { promptExecutionOverridesSchema } from '../../../src/protocol/rest-prompt';
import { assertSessionIdle, prepareExecutionOverrides } from '../../../src/services/messages/messageActions';

interface BusyFixture {
  readonly turn?: boolean;
  readonly queued?: boolean;
  readonly background?: boolean;
  readonly compaction?: boolean;
  readonly pending?: boolean;
}

function fixture(options: BusyFixture): ISessionScopeHandle {
  const agent = {
    id: 'main',
    accessor: {
      get(id: unknown): unknown {
        if (id === IAgentActivityView) {
          return {
            state: () => ({
              lifecycle: 'ready',
              turn: options.turn ? { turnId: 1 } : undefined,
              background: options.background ? [{ kind: 'task', id: 'task_1', since: 1 }] : [],
            }),
          };
        }
        if (id === IAgentPromptService) {
          return {
            list: () => ({
              active: undefined,
              pending: options.queued ? [{ id: 'prompt_1' }] : [],
            }),
          };
        }
        if (id === IAgentFullCompactionService) {
          return { compacting: options.compaction ? {} : null };
        }
        throw new Error('unexpected agent service');
      },
    },
  };
  return {
    id: 'session_test',
    accessor: {
      get(id: unknown): unknown {
        if (id === IAgentLifecycleService) return { list: () => [agent] };
        if (id === ISessionActivityView) {
          return {
            state: () => ({
              busy: options.turn || options.background || options.compaction || false,
              mainTurnActive: options.turn || false,
              pendingInteraction: options.pending ? 'question' : 'none',
            }),
          };
        }
        if (id === ISessionInteractionService) {
          return { listPending: () => options.pending ? [{ id: 'question_1' }] : [] };
        }
        throw new Error('unexpected session service');
      },
    },
  } as unknown as ISessionScopeHandle;
}

function reasonOf(options: BusyFixture): string | undefined {
  try {
    assertSessionIdle(fixture(options));
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(Error2);
    return (error as Error2).details?.['reason'] as string | undefined;
  }
}

describe('assertSessionIdle', () => {
  it.each([
    [{ turn: true }, 'active_turn'],
    [{ queued: true }, 'queued_prompt'],
    [{ background: true }, 'background_work'],
    [{ pending: true }, 'pending_interaction'],
    [{ compaction: true }, 'compaction'],
  ] as const)('classifies %o as %s', (options, expected) => {
    expect(reasonOf(options)).toBe(expected);
  });

  it('accepts a completely idle session', () => {
    expect(reasonOf({})).toBeUndefined();
  });
});

function overrideAgent(executorId = 'native') {
  const calls = {
    prepare: [] as Array<{ model: string; thinking: string | undefined }>,
    validate: [] as Array<{ modelAlias?: string; thinkingEffort?: string }>,
  };
  const agent = {
    accessor: {
      get(id: unknown): unknown {
        if (id !== IAgentProfileService) throw new Error('unexpected agent service');
        return {
          data: () => ({ executorId, modelAlias: 'raw', profileName: 'agent', thinkingLevel: 'high' }),
          prepareModelSwitchBinding: async (model: string, thinking?: string) => {
            calls.prepare.push({ model, thinking });
            return { assertCurrent: () => undefined };
          },
          validateBinding: (binding: { modelAlias?: string; thinkingEffort?: string }) => {
            calls.validate.push(binding);
            return { ok: true as const, binding };
          },
        };
      },
    },
  } as unknown as IAgentScopeHandle;
  return { agent, calls };
}

describe('prepareExecutionOverrides thinking null', () => {
  it('rejects an empty queued effort and keeps an explicit null', () => {
    expect(promptExecutionOverridesSchema.safeParse({ thinking: '' }).success).toBe(false);
    expect(promptExecutionOverridesSchema.parse({ thinking: null }).thinking).toBeNull();
    expect(promptExecutionOverridesSchema.parse({}).thinking).toBeUndefined();
  });

  it('carries null without preparing a model switch or keeping the old effort', async () => {
    const { agent, calls } = overrideAgent();
    const execution = await prepareExecutionOverrides(agent, { thinking: null });
    expect(execution?.thinking).toBeNull();
    expect(calls.prepare).toEqual([]);
    expect(calls.validate).toEqual([]);
  });

  it('omits a preserved effort instead of sending null or an empty string', async () => {
    const { agent, calls } = overrideAgent();
    expect(await prepareExecutionOverrides(agent, {})).toBeUndefined();
    expect(calls.prepare).toEqual([]);
  });

  it('prepares a real model change with only a concrete effort', async () => {
    const { agent, calls } = overrideAgent();
    const execution = await prepareExecutionOverrides(agent, { model: 'axon/gpt-6.1-sol', thinking: 'xhigh' });
    expect(calls.prepare).toEqual([{ model: 'axon/gpt-6.1-sol', thinking: 'xhigh' }]);
    expect(execution?.thinking).toBe('xhigh');
  });

  it('validates a model change beside a null clear without passing null as the effort', async () => {
    const { agent, calls } = overrideAgent();
    const execution = await prepareExecutionOverrides(agent, { model: 'axon/gpt-6.1-sol', thinking: null });
    expect(calls.prepare).toEqual([{ model: 'axon/gpt-6.1-sol', thinking: undefined }]);
    expect(calls.prepare[0]?.thinking).not.toBeNull();
    expect(execution?.model).toBe('axon/gpt-6.1-sol');
    expect(execution?.thinking).toBeNull();
  });

  it('does not ask an external engine to validate a null effort', async () => {
    const { agent, calls } = overrideAgent('claude-acp');
    const execution = await prepareExecutionOverrides(agent, { thinking: null });
    expect(execution?.thinking).toBeNull();
    expect(calls.validate).toEqual([]);
    const withModel = await prepareExecutionOverrides(agent, { model: 'vendor/sonnet', thinking: null });
    expect(calls.validate).toEqual([{ modelAlias: 'vendor/sonnet', thinkingEffort: undefined }]);
    expect(calls.validate[0]?.thinkingEffort).not.toBeNull();
    expect(withModel?.thinking).toBeNull();
    expect(calls.prepare).toEqual([]);
  });
});
