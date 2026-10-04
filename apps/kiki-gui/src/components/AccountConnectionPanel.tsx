/**
 * The sign-in half of an account connection.
 *
 * An account connection is a connection like any other: it has an address, a
 * model list and a health. What makes it different is how it authenticates, and
 * that is what this renders — which account is behind it, whether the provider
 * still accepts that sign-in, and the one action that changes it. Everything
 * else about the connection stays in the row around it.
 *
 * A spent credential is not a new connection and not a missing one: the row
 * stays, this says the sign-in must be replaced, and re-running the flow brings
 * the same connection back. A cancelled or failed flow leaves whatever state
 * the server actually reports — it never becomes a connection of its own.
 */

import { useState } from 'react';

import type { OAuthMethodStatus } from '@kiki/klient';

import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
import { accountState, accountStateDetail } from './accountSignInState';
import { isOriginalSourceMethod, OriginalSourcePanel } from './OriginalSourcePanel';
import { OAuthDeviceCard } from './OAuthDeviceCard';
import { useOAuthFlow } from './useOAuthFlow';
import { FeedbackLine, type Feedback } from './controls';
import { AccountQuotaPanel } from './settings/AccountQuotaCard';
import { SECONDARY_BUTTON } from './ui';

export interface AccountConnectionPanelProps {
  /** The sign-in method behind this connection, as `methods()` reports it. */
  readonly method: OAuthMethodStatus;
  /** Re-reads the page after a sign-in, sign-out or cancel changes anything. */
  readonly onChanged: () => Promise<void> | void;
}

export function AccountConnectionPanel({ method, onChanged }: AccountConnectionPanelProps) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const flow = useOAuthFlow(onChanged);
  const [signingOut, setSigningOut] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  // The flow belongs to this connection when the server says so; a flow
  // started elsewhere on the page is not this row's to render.
  const mine = flow.active === method.provider;
  const snapshot = mine ? flow.snapshot : null;
  const showing = mine && flow.showing;
  const facts = accountState(method, showing && snapshot !== null ? snapshot.status : undefined);
  const detail = showing ? null : accountStateDetail(facts);
  const working = flow.busy === method.provider;
  // A credential Kiki is borrowing from this machine is released by the source
  // panel, which also states that the credential itself survives.
  const usingOriginal = method.auth_source?.kind === 'local_original';

  const signOut = async () => {
    setSigningOut(true);
    setFeedback(null);
    try {
      await client.logoutOAuth({ provider: method.id });
      await onChanged();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div data-connection-account-panel={method.id} className="space-y-3 rounded-lg border border-hairline bg-panel/50 p-3">
      {/* The row header already names the state, so this line carries only the
          one thing the header cannot: what the person can do about it. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="min-w-0 flex-1 text-[12px] text-ink-faint">{t('st.account.connectionLabel')}</p>
        {/* A connection attached to a credential on this machine is let go of
            by the source panel below, which also says what that does to the
            credential. Two buttons for one action would be the same mistake
            this page used to make with two lists. */}
        {facts.state === 'connected' && usingOriginal ? null : facts.state === 'connected' ? (
          <button
            type="button"
            data-connection-sign-out
            className={SECONDARY_BUTTON}
            disabled={signingOut}
            onClick={() => { void signOut(); }}
          >
            {signingOut ? t('st.auth.working') : t('st.connections.signOut')}
          </button>
        ) : facts.state === 'waiting' ? (
          <span className="text-[12px] text-ink-faint">{t('st.account.inProgress')}</span>
        ) : (
          <button
            type="button"
            data-connection-sign-in
            className={SECONDARY_BUTTON}
            disabled={working}
            onClick={() => { void flow.start(method); }}
          >
            {working
              ? t('st.auth.working')
              : facts.state === 'signIn' ? t('st.account.signIn') : t('st.account.signInAgain')}
          </button>
        )}
      </div>
      {detail !== null ? (
        <p data-connection-account-detail={facts.state} className="text-[12px] leading-4 text-ink-soft">
          {t(detail)}
        </p>
      ) : null}
      {/* What the account has left at its vendor, on the connection it belongs
          to. An account the vendor reports no allowance for says so quietly. */}
      {facts.state === 'connected' ? <AccountQuotaPanel method={method} /> : null}
      {/* Where this connection's sign-in comes from, when the machine can offer
          one. It is a property of this connection, so it lives here and nowhere
          else — there is no second place to manage a credential from. */}
      {isOriginalSourceMethod(method) ? (
        <OriginalSourcePanel method={method} onChanged={onChanged} />
      ) : null}
      {showing && snapshot !== null ? (
        <OAuthDeviceCard
          snapshot={snapshot}
          label={method.label}
          cancelling={flow.cancelling}
          onCancel={() => { void flow.cancel(); }}
          onDismiss={() => { flow.dismiss(snapshot.flow_id); }}
        />
      ) : null}
      {flow.feedback !== null && flow.feedback.provider === method.provider ? (
        <FeedbackLine feedback={flow.feedback.value} />
      ) : null}
      <FeedbackLine feedback={feedback} />
    </div>
  );
}
