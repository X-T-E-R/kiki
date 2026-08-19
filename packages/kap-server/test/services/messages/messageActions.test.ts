import {
  Error2,
  IAgentActivityView,
  IAgentFullCompactionService,
  IAgentLifecycleService,
  IAgentPromptService,
  ISessionActivityView,
  ISessionInteractionService,
  type ISessionScopeHandle,
} from '@moonshot-ai/agent-core-v2';
import { describe, expect, it } from 'vitest';

import { assertSessionIdle } from '../../../src/services/messages/messageActions';

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
