/**
 * `session` domain error codes — shared across the session layer
 * (`sessionLifecycle` / `sessionLegacy`).
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const SessionErrors = {
  codes: {
    SESSION_NOT_FOUND: 'session.not_found',
    SESSION_ALREADY_EXISTS: 'session.already_exists',
    SESSION_ID_INVALID: 'session.id_invalid',
    SESSION_CLOSED: 'session.closed',
    SESSION_FORK_ACTIVE_TURN: 'session.fork_active_turn',
    SESSION_FORK_EXTERNAL_DELEGATION: 'session.fork_external_delegation',
    SESSION_UNDO_UNAVAILABLE: 'session.undo_unavailable',
    SESSION_CURSOR_MISMATCH: 'session.cursor_mismatch',
    MESSAGE_ACTION_UNAVAILABLE: 'message.action_unavailable',
    SESSION_INIT_FAILED: 'session.init_failed',
    SESSION_PLAN_MODE_INVALID: 'session.plan_mode_invalid',
  },
  retryable: ['session.fork_active_turn'],
} as const satisfies ErrorDomain;

registerErrorDomain(SessionErrors);
