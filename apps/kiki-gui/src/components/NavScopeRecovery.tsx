/**
 * The surface shown while a return to another space/connection is being
 * re-established, and the short reason when it could not finish.
 *
 * It reports the state it is handed and nothing else: the boundary owns the
 * navigation, so there is no route, scope identifier, phase log or raw stack
 * here — one state line, one reason, an access token when the destination asks
 * for one, and the two ways out. A typed token lives in this component for one
 * attempt; it is never read back from storage and never leaves with the user.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../i18n';
import type { ScopeDestination, ScopeRestoreFailure, ScopeRestoreState } from '../lib/navScope';
import { FeedbackLine } from './controls';
import { LifeMark } from './LifeMark';

export interface NavScopeRecoveryProps {
  state: ScopeRestoreState;
  retry: (token?: string) => void;
  cancel: () => void;
}

/** What the user is told for each way the return can fail. */
const FAILURE_COPY: Record<ScopeRestoreFailure, { readonly title: I18nKey; readonly body: I18nKey }> = {
  offline: { title: 'nav.scope.failed.offline.title', body: 'nav.scope.failed.offline.body' },
  'auth-required': { title: 'nav.scope.failed.auth-required.title', body: 'nav.scope.failed.auth-required.body' },
  'scope-invalid': { title: 'nav.scope.failed.scope-invalid.title', body: 'nav.scope.failed.scope-invalid.body' },
  'identity-mismatch': { title: 'nav.scope.failed.identity-mismatch.title', body: 'nav.scope.failed.identity-mismatch.body' },
  'target-missing': { title: 'nav.scope.failed.target-missing.title', body: 'nav.scope.failed.target-missing.body' },
};

// Full-page action sizes (ConnectScreen / AppErrorBoundary); coarse pointers
// get the 44px target without changing the desktop density. The transparent
// border keeps the primary the same height as the outlined one beside it.
const PRIMARY_BUTTON =
  'rounded-lg border border-transparent bg-accent px-4 py-2 text-[13px] font-semibold text-on-accent transition-colors hover:bg-accent-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:bg-hairline disabled:text-ink-faint pointer-coarse:min-h-11';
const QUIET_BUTTON =
  'rounded-lg border border-hairline-strong bg-paper px-4 py-2 text-[13px] font-medium text-ink transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink pointer-coarse:min-h-11';
const TOKEN_INPUT =
  'min-w-0 flex-1 rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent';

/** Identity of one failed attempt: a typed token belongs to exactly one. */
function attemptKey(target: ScopeDestination, reason?: ScopeRestoreFailure): string {
  return `${target.scope.homeId}\u0000${target.scope.scopeId}\u0000${target.route}\u0000${reason ?? ''}`;
}

export function NavScopeRecovery({ state, retry, cancel }: NavScopeRecoveryProps) {
  const { t } = useI18n();
  const [token, setToken] = useState('');
  const [revealed, setRevealed] = useState(false);
  const tokenId = useId();
  const tokenHelpId = useId();
  const tokenRef = useRef<HTMLInputElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);

  const attempt = state.phase === 'idle'
    ? ''
    : attemptKey(state.target, state.phase === 'failed' ? state.reason : undefined);
  const needsToken = state.phase === 'failed' && state.reason === 'auth-required';

  // A token outlives neither its attempt nor this surface: changing destination
  // or reason drops it, and so does leaving. Nothing is read back from storage,
  // and nothing is written anywhere.
  useEffect(() => {
    setToken('');
    setRevealed(false);
  }, [attempt]);

  // The field is the required next step when one is shown; otherwise the primary
  // action is where the eye already is. Focus never scrolls the surface.
  useEffect(() => {
    if (state.phase !== 'failed') return;
    const target = needsToken ? tokenRef.current : retryRef.current;
    target?.focus({ preventScroll: true });
  }, [state.phase, needsToken, attempt]);

  const handleCancel = useCallback(() => {
    setToken('');
    setRevealed(false);
    cancel();
  }, [cancel]);

  const handleRetry = useCallback(() => {
    if (state.phase !== 'failed') return;
    const typed = token.trim();
    if (needsToken && typed === '') return;
    // Cleared before the attempt: the secret does not sit in the field while the
    // boundary works, and a second failure starts from an empty field again.
    setToken('');
    setRevealed(false);
    retry(needsToken ? typed : undefined);
  }, [needsToken, retry, state.phase, token]);

  if (state.phase === 'idle') return null;

  if (state.phase !== 'failed') {
    const busy = state.phase;
    return (
      <Surface>
        <h1 className="font-display text-[18px] leading-6 text-ink">
          {t(busy === 'restoring' ? 'nav.scope.restoring.title' : 'nav.scope.verifying.title')}
        </h1>
        <p className="mt-2 flex items-start gap-2 text-[13px] leading-relaxed text-ink-soft">
          <LifeMark markId="nav-scope-recovery" life="working" className="mt-[7px] h-[7px] w-[7px]" />
          <span className="min-w-0">
            {t(busy === 'restoring' ? 'nav.scope.restoring.body' : 'nav.scope.verifying.body')}
          </span>
        </p>
        <div className="mt-6">
          <button type="button" className={QUIET_BUTTON} onClick={handleCancel}>
            {t('nav.scope.stay')}
          </button>
        </div>
      </Surface>
    );
  }

  const copy = FAILURE_COPY[state.reason];
  return (
    <Surface>
      <h1 className="font-display text-[18px] leading-6 text-ink">{t(copy.title)}</h1>
      <div className="mt-2">
        <FeedbackLine feedback={{ tone: 'error', text: t(copy.body) }} />
      </div>

      {needsToken ? (
        <div className="mt-5">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <label htmlFor={tokenId} className="text-[12px] font-medium text-ink-soft">
              {t('connect.accessToken')}
            </label>
            <span
              title={t('connect.accessTokenHelp')}
              className="cursor-help text-[12px] text-ink-faint underline decoration-dotted underline-offset-2"
            >
              {t('connect.accessTokenWhere')}
            </span>
          </div>
          <div className="flex gap-2">
            <input
              id={tokenId}
              ref={tokenRef}
              type={revealed ? 'text' : 'password'}
              value={token}
              aria-describedby={tokenHelpId}
              autoComplete="off"
              spellCheck={false}
              className={TOKEN_INPUT}
              onChange={(event) => { setToken(event.target.value); }}
            />
            <button
              type="button"
              aria-label={`${t(revealed ? 'st.providers.hideKey' : 'st.providers.showKey')} ${t('connect.accessToken')}`}
              onClick={() => { setRevealed((value) => !value); }}
              className="rounded-lg border border-hairline px-3 text-[12px] text-ink-soft transition-colors hover:border-accent hover:text-ink pointer-coarse:min-h-11"
            >
              {t(revealed ? 'st.providers.hideKey' : 'st.providers.showKey')}
            </button>
          </div>
          <p id={tokenHelpId} className="sr-only">{t('connect.accessTokenHelp')}</p>
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <button
          ref={retryRef}
          type="button"
          className={PRIMARY_BUTTON}
          disabled={needsToken && token.trim() === ''}
          onClick={handleRetry}
        >
          {t('nav.scope.retry')}
        </button>
        <button type="button" className={QUIET_BUTTON} onClick={handleCancel}>
          {t('nav.scope.stay')}
        </button>
      </div>
    </Surface>
  );
}

/**
 * The whole window: this surface stands in for the app while the return is
 * unresolved, so it carries its own paper ground rather than a box on top of
 * one. One narrow column, no card, no rule.
 */
function Surface({ children }: { children: ReactNode }) {
  return (
    <main className="flex h-full min-h-screen items-center justify-center bg-paper px-4 py-10 text-ink">
      <div className="anim-enter w-full max-w-[380px]">{children}</div>
    </main>
  );
}
