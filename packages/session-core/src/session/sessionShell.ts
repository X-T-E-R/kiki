import type { SessionViewState } from './transcript/types';

/**
 * What a session view holds for the session rather than for one agent: the
 * session record and its event cursor, the roster, resync state, and whether
 * the session loaded. `SessionViewState` still carries these fields so its
 * consumers keep working, but the controller keeps them here, once, and lays
 * them over main's own view to publish `getState()`. Another agent's view of
 * the same type never receives them (its copies stay at their defaults, or at
 * whatever its last projection carried).
 */
export type SessionShell = Pick<SessionViewState,
  | 'version'
  | 'session'
  | 'cursor'
  | 'snapshotSubagents'
  | 'agentCounts'
  | 'resyncing'
  | 'resyncFailed'
  | 'resyncAttempt'
  | 'resyncError'
  | 'loaded'
  | 'loadError'
  | 'durableIngress'>;

const SHELL_FIELDS = [
  'session', 'cursor', 'snapshotSubagents', 'agentCounts', 'resyncing', 'resyncFailed',
  'resyncAttempt', 'resyncError', 'loaded', 'loadError', 'durableIngress',
] as const satisfies readonly Exclude<keyof SessionShell, 'version'>[];

/** The shell of a session view that has not loaded anything yet (matches `createViewState`). */
export function createSessionShell(): SessionShell {
  return {
    version: 0,
    session: undefined,
    cursor: { seq: 0, epoch: undefined },
    snapshotSubagents: [],
    agentCounts: undefined,
    resyncing: false,
    resyncFailed: false,
    resyncAttempt: 0,
    resyncError: undefined,
    loaded: false,
    loadError: undefined,
    durableIngress: [],
  };
}

/**
 * Take the shell fields of a whole session view — one a helper computed from
 * the composed view, such as applying a session snapshot — as the next shell.
 * Returns `shell` itself when none of them changed, otherwise a new shell one
 * version on.
 */
export function adoptSessionShell(shell: SessionShell, state: SessionViewState): SessionShell {
  if (SHELL_FIELDS.every((field) => state[field] === shell[field])) return shell;
  return {
    version: shell.version + 1,
    session: state.session,
    cursor: state.cursor,
    snapshotSubagents: state.snapshotSubagents,
    agentCounts: state.agentCounts,
    resyncing: state.resyncing,
    resyncFailed: state.resyncFailed,
    resyncAttempt: state.resyncAttempt,
    resyncError: state.resyncError,
    loaded: state.loaded,
    loadError: state.loadError,
    durableIngress: state.durableIngress,
  };
}

/**
 * The session view `getState()` publishes: main's own view with the shell laid
 * over it. Its version moves whenever either part does.
 */
export function withSessionShell(view: SessionViewState, shell: SessionShell): SessionViewState {
  return {
    ...view,
    version: view.version + shell.version,
    session: shell.session,
    cursor: shell.cursor,
    snapshotSubagents: shell.snapshotSubagents,
    agentCounts: shell.agentCounts,
    resyncing: shell.resyncing,
    resyncFailed: shell.resyncFailed,
    resyncAttempt: shell.resyncAttempt,
    resyncError: shell.resyncError,
    loaded: shell.loaded,
    loadError: shell.loadError,
    durableIngress: shell.durableIngress,
  };
}
