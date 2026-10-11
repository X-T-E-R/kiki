import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const LoopErrors = {
  codes: {
    LOOP_MAX_STEPS_EXCEEDED: 'loop.max_steps_exceeded',
    LOOP_EMPTY_COMPLETION: 'loop.empty_completion',
    TURN_AGENT_BUSY: 'turn.agent_busy',
  },
  retryable: ['turn.agent_busy'],
  info: {
    'loop.empty_completion': {
      title: 'Empty subagent completion',
      retryable: false,
      public: true,
      action:
        'Inspect the original turn and preserved work, then resume the same agent with a new prompt ID. An empty provider completion is not a task receipt.',
    },
    'loop.max_steps_exceeded': {
      title: 'Loop max steps exceeded',
      retryable: false,
      public: true,
      action:
        'Raise loop_control.max_steps_per_turn in config.toml, or run "/kiki-ops update loop_control.max_steps_per_turn" then "/reload".',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(LoopErrors);
