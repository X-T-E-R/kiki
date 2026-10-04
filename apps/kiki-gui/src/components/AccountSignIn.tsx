/**
 * Signing in with an account — the methods the server offers, each a task a
 * person can act on: Kimi Code, a ChatGPT subscription, a Grok Build login.
 *
 * This is a *catalog of ways in*, not a list of what is connected. It appears
 * inside "Add connection", and the result of a successful sign-in is a
 * connection in the list on the page: one row per account, managed there. A
 * method that already has its connection is therefore named here but not
 * re-managed — signing in again or out belongs to that row.
 *
 * Each row answers which account, whether it is connected, and what to press.
 * The mechanism — a device code, a verification page — appears only in the
 * state that needs it. At most one flow runs at a time; its card opens under
 * the method that started it and polls at the server-suggested interval.
 */

import { useQuery } from '@tanstack/react-query';

import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
import { OAuthDeviceCard } from './OAuthDeviceCard';
import {
  accountState,
  accountStateDetail,
  accountStateKey,
  accountStateTone,
  needsSignInAction,
  type AccountStateFacts,
} from './accountSignInState';
import { useOAuthFlow } from './useOAuthFlow';
import { isOriginalSourceMethod, OriginalSourcePanel } from './OriginalSourcePanel';
import { FeedbackLine, InlineError } from './controls';
import { Icon } from './icons';
import { SECONDARY_BUTTON } from './ui';

export const OAUTH_METHODS_QUERY_KEY = ['oauth-methods'] as const;

/**
 * The state word with a mark beside it. An account that was never signed in
 * gets no mark at all: it is a starting position, not a result, and a dot
 * there would say "working" in the same green as a live connection.
 */
export function AccountStateMark({ facts }: { facts: AccountStateFacts }) {
  const { t } = useI18n();
  const tone = accountStateTone(facts);
  return (
    <span
      data-account-state={facts.state}
      data-account-state-tone={tone}
      className={`inline-flex shrink-0 items-center gap-1.5 text-[12px] ${
        tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-amber-ink' : 'text-ink-faint'}`}
    >
      {tone === undefined
        ? null
        : <span aria-hidden data-account-state-mark className={`h-1.5 w-1.5 rounded-full ${
          tone === 'bad' ? 'bg-danger' : tone === 'warn' ? 'bg-amber-rule' : 'bg-success'}`} />}
      {t(accountStateKey(facts))}
    </span>
  );
}

export function AccountSignIn({
  onChanged,
  compact = false,
  configuredProviderIds,
}: {
  /** Called after a sign-in completes, so the page can re-read its data. */
  onChanged?: () => Promise<void> | void;
  /** Onboarding density: no account line. */
  compact?: boolean;
  /**
   * Provider ids the page already lists. A method whose connection is among
   * them is not offered here: that connection is managed in its own row, and
   * a spent credential is recovered there rather than by adding a second one.
   */
  configuredProviderIds?: ReadonlySet<string>;
}) {
  const { client } = useConnection();
  const { t } = useI18n();
  const flow = useOAuthFlow(onChanged);

  const methodsQuery = useQuery({
    queryKey: OAUTH_METHODS_QUERY_KEY,
    queryFn: () => client.listOAuthMethods(),
    staleTime: 10_000,
  });
  const snapshot = flow.snapshot;
  const showing = flow.showing;

  // A method is offered only while its connection does not exist yet. The test
  // is the configured provider id, not the credential: a method holding a
  // spent token still has a connection, and that row is where it is recovered,
  // so re-adding it here would show the same account twice.
  const all = methodsQuery.data ?? [];
  const methods = configuredProviderIds === undefined
    ? all
    : all.filter((method) => !configuredProviderIds.has(method.provider));

  return (
    <div className="space-y-2" data-account-sign-in>
      <ul className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-panel">
        {methods.map((method) => {
          const pending = showing && snapshot !== null && snapshot.provider === method.provider;
          const facts = accountState(method, pending ? snapshot.status : undefined);
          const detail = pending ? null : accountStateDetail(facts);
          const working = flow.busy === method.provider;
          return (
            <li key={method.id} data-oauth-method={method.id} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink">
                    {method.label}
                    <AccountStateMark facts={facts} />
                  </p>
                  {compact ? null : (
                    <p className="truncate text-[11.5px] text-ink-faint">
                      {t(`st.account.method.${method.id}` as 'st.account.method.kimi-code')}
                      {method.account.state === 'known' ? <> · <span data-account-identity className="text-ink-soft">{method.account.id}</span></> : null}
                    </p>
                  )}
                  {detail !== null ? (
                    <p data-account-detail={facts.state} className="mt-1 text-[12px] leading-4 text-ink-soft">
                      {t(detail)}
                    </p>
                  ) : null}
                </div>
                {facts.state === 'waiting' ? (
                  <span className="text-[12px] text-ink-faint">{t('st.account.inProgress')}</span>
                ) : needsSignInAction(facts) ? (
                  working ? (
                    <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-faint">
                      <span aria-hidden className="status-dot-busy inline-block h-2 w-2 rounded-full bg-accent" />
                      {t('st.auth.working')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      data-account-sign-in-button
                      className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`}
                      disabled={flow.busy !== null}
                      aria-label={t('st.account.signInWith', { method: method.label })}
                      onClick={() => { void flow.start(method); }}
                    >
                      <Icon name="arrowRight" size={12} />
                      {facts.state === 'signIn' ? t('st.account.signIn') : t('st.account.signInAgain')}
                    </button>
                  )
                ) : null}
              </div>
              {pending ? (
                <div className="mt-3">
                  <OAuthDeviceCard
                    snapshot={snapshot}
                    label={method.label}
                    cancelling={flow.cancelling}
                    onCancel={() => { void flow.cancel(); }}
                    onDismiss={() => { flow.dismiss(snapshot.flow_id); }}
                  />
                </div>
              ) : null}
              {/* A machine that already has this account signed in can be
                  attached instead of running a device flow. It is offered here
                  because this is the one place a new connection is made, and
                  the connection it creates is the one this page manages. */}
              {!pending && facts.state !== 'connected' && isOriginalSourceMethod(method) ? (
                <div className="mt-3">
                  <OriginalSourcePanel method={method} onChanged={onChanged} />
                </div>
              ) : null}
            </li>
          );
        })}
        {methodsQuery.isLoading ? (
          <li className="px-3 py-3 text-[12px] text-ink-faint">{t('st.account.loading')}</li>
        ) : null}
        {methods.length === 0 && methodsQuery.isSuccess ? (
          <li data-account-empty className="px-3 py-3 text-[12px] text-ink-faint">
            {all.length === 0 ? t('st.account.none') : t('st.account.allConnected')}
          </li>
        ) : null}
      </ul>
      {flow.feedback !== null ? <FeedbackLine feedback={flow.feedback.value} /> : null}
      {methodsQuery.isError ? <InlineError error={methodsQuery.error} /> : null}
    </div>
  );
}
