/**
 * How a connection reaches its models, and what a person needs to do about it
 * next — the vocabulary that lets the account sign-in surface speak about
 * Kimi Code, a ChatGPT subscription and a Grok Build login as three different
 * kinds of connection instead of one technical OAuth table.
 *
 * The states come from the server's own words, never from a guess: a method's
 * `signed_in` says whether a credential exists at all, and the optional
 * `connection_state` says whether that credential still works
 * (`ready` / `refresh_required`, both usable) or whether it must be replaced
 * (`reconnect_required` / `signed_out`). The sign-in surface renders words per
 * state; the model catalog is read back from the server after a sign-in, so
 * "which models can I use" is never answered from this module.
 */

import type { OAuthMethodStatus } from '@kiki/klient';
import type { I18nKey } from '@kiki/session-core/i18n';

/**
 * What the helpers below need from a method: the sign-in surface passes the
 * whole `OAuthMethodStatus`, a connection row the account and quota facts it
 * was handed. `connection_state` is 489's own optional field and is read as
 * it arrives — no second copy of the enum, and no guard against a value the
 * wire schema already constrains.
 */
export type AccountMethodFacts = Pick<OAuthMethodStatus, 'signed_in' | 'connection_state'>;

/**
 * The one state a person acts on. A due refresh is not one of them: the
 * credential still works and Kiki renews it itself, so it stays `connected`. A
 * credential the provider will no longer accept is `reconnect` rather than
 * `signIn`, because the account exists — only its sign-in is spent — and
 * telling those two apart is the whole point of showing the state.
 */
export type AccountState = 'connected' | 'reconnect' | 'signIn' | 'waiting' | 'failed';

export interface AccountStateFacts {
  readonly state: AccountState;
  /** A failure the person caused or must answer (denied, expired, cancelled). */
  readonly reason: FlowReason | null;
  /** True while the account holds a credential, including a due refresh. */
  readonly connected: boolean;
}

/** The terminal reasons a flow can end in besides success. */
type FlowReason = 'denied' | 'expired' | 'cancelled' | 'failed';

const FLOW_REASONS: ReadonlySet<string> = new Set<FlowReason>(['denied', 'expired', 'cancelled']);

/**
 * The state of one account row from the server's own two facts plus the flow
 * the user is running. A terminal status the server names is carried through as
 * the reason; any other terminal value stays a plain failure, so a status a
 * newer server adds still reads as "this did not finish" rather than slipping
 * into the vocabulary as something it is not.
 */
export function accountState(method: AccountMethodFacts, flowStatus: string | undefined): AccountStateFacts {
  const state = method.connection_state;
  if (flowStatus === 'pending') return { state: 'waiting', reason: null, connected: method.signed_in };
  if (flowStatus !== undefined && flowStatus !== 'authenticated') {
    const reason: FlowReason = FLOW_REASONS.has(flowStatus) ? flowStatus as FlowReason : 'failed';
    return { state: 'failed', reason, connected: method.signed_in };
  }
  // A stored credential the provider rejects is spent, not absent: the row
  // keeps the account it knows and asks for a fresh sign-in.
  if (state === 'reconnect_required' || (state === 'signed_out' && method.signed_in)) {
    return { state: 'reconnect', reason: null, connected: false };
  }
  if (state === 'signed_out') return { state: 'signIn', reason: null, connected: false };
  if (state === 'refresh_required') return { state: 'connected', reason: null, connected: true };
  if (method.signed_in) return { state: 'connected', reason: null, connected: true };
  return { state: 'signIn', reason: null, connected: false };
}

const STATE_KEYS: Readonly<Record<AccountState, I18nKey>> = {
  connected: 'st.account.state.connected',
  reconnect: 'st.account.state.reconnect',
  signIn: 'st.account.state.signIn',
  waiting: 'st.account.state.waiting',
  failed: 'st.account.state.failed',
};

/** The state as a person reads it: "Connected", "Sign in again", "…". */
export function accountStateKey(facts: AccountStateFacts): I18nKey {
  return STATE_KEYS[facts.state];
}

const STATE_TONE: Readonly<Record<AccountState, 'ok' | 'warn' | 'bad'>> = {
  connected: 'ok',
  reconnect: 'warn',
  signIn: 'warn',
  waiting: 'warn',
  failed: 'bad',
};

/**
 * One word of colour for a row. An account that was never signed in is a
 * starting position rather than a problem, so it carries no mark — the amber
 * is saved for a sign-in that has gone wrong or gone stale.
 */
export function accountStateTone(facts: AccountStateFacts): 'ok' | 'warn' | 'bad' | undefined {
  return facts.state === 'signIn' ? undefined : STATE_TONE[facts.state];
}

/**
 * The second line of a row: why a flow did not finish, why a credential is
 * spent, or what a running sign-in is waiting for. `null` when the row needs
 * no explanation. The recovery action lives on the row's own button, so this
 * text never names one.
 */
export function accountStateDetail(facts: AccountStateFacts): I18nKey | null {
  if (facts.state === 'reconnect') return 'st.account.detail.reconnect';
  if (facts.state === 'failed') {
    if (facts.reason === 'denied') return 'st.account.detail.denied';
    if (facts.reason === 'expired') return 'st.account.detail.expired';
    if (facts.reason === 'cancelled') return 'st.account.detail.cancelled';
    return 'st.account.detail.failed';
  }
  if (facts.state === 'waiting') return 'st.account.detail.waiting';
  return null;
}

/**
 * Whether the row still needs a credential the person must supply: a first
 * sign-in, a fresh one over a spent credential, or a retry after a failure.
 * A flow that is still running already shows its own card, so it does not
 * count here.
 */
export function needsSignInAction(facts: AccountStateFacts): boolean {
  return facts.state === 'signIn' || facts.state === 'reconnect' || facts.state === 'failed';
}
