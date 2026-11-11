import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';

export const StateErrors = {
  codes: {
    STATE_DUPLICATE_FOLD: 'state.duplicate_fold',
    STATE_DURABILITY_MISMATCH: 'state.durability_mismatch',
    STATE_CYCLE: 'state.cycle',
    PLUGIN_STATE_INVALID_FACT: 'plugin_state.invalid_fact',
    PLUGIN_STATE_REPLAY_REQUIRED: 'plugin_state.replay_required',
    PLUGIN_STATE_REQUIRED_UNRESOLVED: 'plugin_state.required_unresolved',
  },
  info: {
    'state.duplicate_fold': {
      title: 'Duplicate state fold',
      retryable: false,
      public: true,
      action: 'A state registered two folds for the same event; merge them.',
    },
    'state.durability_mismatch': {
      title: 'Transient state folds durable event',
      retryable: false,
      public: true,
      action: 'A non-durable state cannot fold a durable event; mark the state durable.',
    },
    'state.cycle': {
      title: 'Event dispatch cycle',
      retryable: false,
      public: true,
      action: 'A subscriber re-dispatches endlessly; break the event cycle.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(StateErrors);

export type StateErrorCode = (typeof StateErrors.codes)[keyof typeof StateErrors.codes];

export class StateError extends Error2 {
  constructor(code: StateErrorCode, message: string, options?: Error2Options) {
    super(code, message, options);
    this.name = 'StateError';
  }
}
