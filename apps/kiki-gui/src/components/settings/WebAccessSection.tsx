/**
 * Settings → Spaces: the browser entry point to this Kiki.
 *
 * This sits right below "Kikis allowed to connect to me" because that is where
 * a person looks when they ask "can something else get in here?", but the two
 * are deliberately kept apart. A remote Kiki is another Kiki with its own
 * identity, its own owner, and a per-source grant; a web link is a door into
 * *this* Kiki, owned by whoever owns this window. They are not two rows of the
 * same list, and merging them would be a lie about what the second one is.
 *
 * The shape answers three questions in order: is it on, how do I give someone
 * in, how do I stop it. The permission fact is said once, in one sentence, and
 * it is the same sentence whether the entry is temporary or always on —
 * "temporary" is about how long the door stays open, never about what can be
 * done through it.
 *
 * Address, bind host, and the unencrypted option live behind one disclosure:
 * nearly every use is "open the link on my phone", and a form to read past
 * would bury that. What is inside the fold is not decoration — it is how a
 * phone on the same network is reached at all, so it is a real editor that
 * sends the same fields the enable contract takes, and the address printed
 * above it is the one the server reported, not the one that was typed.
 */

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { durationUntil, relativeTime } from '@kiki/session-core/util/time';
import type { WebAccessLink, WebAccessStatus } from '@kiki/protocol';

import { useHost } from '../../host';
import { ExternalLink } from '../../host/ExternalLink';
import { useI18n } from '../../i18n';
import type { KikiClient } from '../../lib/client';
import {
  addressDraftFromStatus,
  addressIssue,
  draftReachesOtherDevices,
  emptyAddressDraft,
  enableInputFor,
  useWebAccessSession,
  useWebAccessStatus,
  webAccessApi,
  webAccessAddress,
  webAccessKeys,
  type Mode,
  type WebAccessAddressDraft,
} from '../../lib/webAccess';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../Dialog';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../controls';
import { DisclosureChevron, Icon } from '../icons';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { SectionCard } from './SectionCard';
import { SettingField } from './fields';
import { CopyField } from './remote/parts';

/**
 * What a browser signed in through a web link sees in this place: that it is
 * signed in, and a way to stop being. It is deliberately not the owner's card —
 * a permission error in settings would be a worse answer than saying plainly
 * that this window is a guest here.
 */
function WebGuestSession({ client }: { client: KikiClient | null }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const session = useWebAccessSession(client);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const leave = () => {
    if (client === null) return;
    setBusy(true);
    setFeedback(null);
    void webAccessApi(client).logout()
      .then(() => {
        setFeedback({ tone: 'success', text: t('st.web.signedOut') });
        void queryClient.invalidateQueries({ queryKey: webAccessKeys.session() });
      })
      .catch((error: unknown) => { setFeedback({ tone: 'error', text: errorText(locale, error) }); })
      .finally(() => { setBusy(false); });
  };

  return (
    <SectionCard id="st-card-web-access" title={t('st.web.title')} scope="readOnly" aside={t('st.web.hint')}>
      <div className="space-y-2.5" data-web-access-guest>
        {session.isError ? <InlineError error={session.error} /> : null}
        {session.data?.authenticated === true && session.data.session !== null ? (
          <>
            <p className="text-[13px] text-ink" data-web-access-guest-session>
              {t('st.web.signedInAs', { name: session.data.session.label })}
              {session.data.session.expiresAt !== undefined ? (
                <span className="text-ink-faint">
                  {' · '}{t('st.web.expires', { duration: durationUntil(new Date(session.data.session.expiresAt).toISOString(), locale) })}
                </span>
              ) : null}
            </p>
            <p className="text-[11.5px] text-ink-faint">
              {t('st.web.lastUsed', { time: relativeTime(new Date(session.data.session.lastUsedAt).toISOString(), locale) })}
            </p>
            <div>
              <button type="button" data-web-access-sign-out className={SECONDARY_BUTTON} disabled={busy} onClick={leave}>
                {busy ? t('st.web.signingOut') : t('st.web.revoke')}
              </button>
            </div>
          </>
        ) : session.isLoading ? <Hint>{t('st.spaces.loading')}</Hint> : (
          <p className="text-[13px] text-ink" data-web-access-guest-none>{t('st.web.signedInNone')}</p>
        )}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

/** A confirmation that names what it is about to end. */
type Confirm =
  | { readonly kind: 'off' }
  | { readonly kind: 'revoke'; readonly id: string; readonly label: string }
  | { readonly kind: 'revokeAll' }
  | null;

/**
 * What this window is allowed to see here.
 *
 * The owner of the machine manages the entry point. A browser that came in
 * through a web link is a guest of it: it may see that it is signed in and
 * leave, but it cannot open the door for anyone else or shut it on the owner.
 * Asking it to try would only produce a permission error sitting in settings,
 * so the card is not shown to a web browser at all and is replaced by the one
 * thing that is genuinely its own.
 */
export function WebAccessSection() {
  const host = useHost();
  const { client, localClient, connectionSource } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  // A browser signed in through a web link owns nothing on this machine.
  const webGuest = connectionSource === 'web-cookie';
  // Only this machine's own server can hand out an entry link. A remote space
  // has its own; opening it from here would be configuring somebody else's.
  const control = host.kind === 'tauri' ? localClient : client;
  const status = useWebAccessStatus(control);
  const [busy, setBusy] = useState<null | Mode | 'off' | 'revoke' | 'link'>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [issued, setIssued] = useState<WebAccessLink | null>(null);
  const [details, setDetails] = useState(false);
  // The address editor is a draft, not a mirror: it starts from what the server
  // reports and only reaches it when the person saves.
  const [draft, setDraft] = useState<WebAccessAddressDraft>(emptyAddressDraft);
  const [draftTouched, setDraftTouched] = useState(false);

  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ['web-access'] }); };
  const state = status.data;

  // While untouched, the editor shows the live entry rather than a stale guess;
  // once edited, the person's text wins until they save or the entry changes.
  useEffect(() => {
    if (state === undefined || draftTouched) return;
    setDraft(addressDraftFromStatus(state));
  }, [state, draftTouched]);

  const run = async (
    key: NonNullable<typeof busy>,
    operation: () => Promise<WebAccessStatus>,
    onDone: (next: WebAccessStatus) => Feedback,
  ) => {
    if (control === null) return;
    setBusy(key);
    setFeedback(null);
    try {
      // The echoed status is what the card then shows: the server's answer, not
      // the optimistic guess that a click implies.
      setFeedback(onDone(await operation()));
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const enable = (mode: Mode, address?: WebAccessAddressDraft) => run(
    mode === 'temporary' ? 'temporary' : 'persistent',
    () => webAccessApi(control!).enable(enableInputFor(mode, address ?? emptyAddressDraft)),
    () => {
      setDraftTouched(false);
      return { tone: 'success', text: t('st.web.opened') };
    });

  /** Re-opening is how the address changes; there is no separate network call. */
  const applyAddress = () => {
    if (state === undefined) return;
    void enable(state.mode ?? 'persistent', draft);
  };

  const issueLink = () => {
    if (control === null) return;
    setBusy('link');
    setFeedback(null);
    void webAccessApi(control).issueLink()
      .then((link) => {
        setIssued(link);
        setFeedback({ tone: 'success', text: t('st.web.linkIssued') });
      })
      .catch((error: unknown) => { setFeedback({ tone: 'error', text: errorText(locale, error) }); })
      .finally(() => { setBusy(null); refresh(); });
  };

  if (webGuest) return <WebGuestSession client={client} />;

  return (
    <SectionCard id="st-card-web-access" title={t('st.web.title')} scope="server" aside={t('st.web.hint')}>
      <div className="space-y-3" data-web-access>
        {control === null ? <Hint>{t('st.remote.controlUnavailable')}</Hint> : null}
        {status.isError ? <InlineError error={status.error} /> : null}

        {state !== undefined ? (
          state.enabled ? (
            <OpenEntry state={state} busy={busy} details={details} onToggleDetails={() => { setDetails((open) => !open); }}
              onNewLink={issueLink} onTurnOff={() => { setConfirm({ kind: 'off' }); }}
              onRevoke={(entry) => { setConfirm({ kind: 'revoke', id: entry.id, label: entry.label }); }}
              onRevokeAll={() => { setConfirm({ kind: 'revokeAll' }); }}
              address={<AddressDisclosure open={details} onToggle={() => { setDetails((open) => !open); }}
                state={state} draft={draft}
                onDraft={(next) => { setDraft(next); setDraftTouched(true); }}
                onApply={applyAddress} applying={busy !== null} />} />
          ) : (
            <ClosedEntry mode={state.mode} busy={busy === 'temporary' || busy === 'persistent'}
              onEnable={(mode) => { void enable(mode); }} onToggleDetails={() => { setDetails((open) => !open); }} details={details} state={state}
              address={<AddressDisclosure open={details} onToggle={() => { setDetails((open) => !open); }}
                state={state} draft={draft}
                onDraft={(next) => { setDraft(next); setDraftTouched(true); }}
                onApply={applyAddress} applying={busy !== null} />} />
          )
        ) : status.isLoading ? <Hint>{t('st.spaces.loading')}</Hint> : null}

        {/* Said once, always, in the same words: the link is full use of this
            Kiki. It is not a read-only share and not a sandbox. */}
        {state !== undefined ? (
          <div data-web-access-powers>
            <Hint>{t('st.web.powers')}</Hint>
          </div>
        ) : null}

        <FeedbackLine feedback={feedback} />
      </div>

      {issued !== null ? (
        <WebLinkDialog link={issued} onClose={() => { setIssued(null); }} />
      ) : null}

      {confirm?.kind === 'off' && control !== null ? (
        <ConfirmDialog open overlayId="web-access-off-confirm" tone="danger"
          title={t('st.web.turnOffTitle')} body={t('st.web.turnOffBody')}
          confirmLabel={t('st.web.turnOff')}
          onCancel={() => { setConfirm(null); }}
          onConfirm={() => {
            setConfirm(null);
            void run('off', () => webAccessApi(control).disable(),
              () => ({ tone: 'success', text: t('st.web.turnedOff') }));
          }} />
      ) : null}

      {confirm?.kind === 'revoke' && control !== null ? (
        <ConfirmDialog open overlayId="web-access-revoke-confirm" tone="danger"
          title={t('st.web.revokeTitle', { name: confirm.label })} body={t('st.web.revokeBody')}
          confirmLabel={t('st.web.revoke')}
          onCancel={() => { setConfirm(null); }}
          onConfirm={() => {
            const id = confirm.id;
            setConfirm(null);
            void run('revoke', () => webAccessApi(control).revoke(id),
              () => ({ tone: 'success', text: t('st.web.revoked', { name: t('st.web.signedIn') }) }));
          }} />
      ) : null}

      {confirm?.kind === 'revokeAll' && control !== null ? (
        <ConfirmDialog open overlayId="web-access-revoke-all-confirm" tone="danger"
          title={t('st.web.revokeAllTitle')} body={t('st.web.revokeAllBody')}
          confirmLabel={t('st.web.revokeAll')}
          onCancel={() => { setConfirm(null); }}
          onConfirm={() => {
            setConfirm(null);
            void run('revoke', () => webAccessApi(control).revoke(),
              () => ({ tone: 'success', text: t('st.web.revokeAllDone') }));
          }} />
      ) : null}
    </SectionCard>
  );
}

/**
 * The entry is open. One status line says what is true, the two ways in sit
 * next to each other, and turning it off is last — it is the one action here
 * that ends other people's access.
 */
function OpenEntry({ state, busy, onNewLink, onTurnOff, onRevoke, onRevokeAll, address }: {
  state: WebAccessStatus;
  busy: null | Mode | 'off' | 'revoke' | 'link';
  details: boolean;
  onToggleDetails: () => void;
  onNewLink: () => void;
  onTurnOff: () => void;
  onRevoke: (entry: WebAccessStatus['sessions'][number]) => void;
  onRevokeAll: () => void;
  address: React.ReactNode;
}) {
  const { t, locale } = useI18n();
  // The link's own failure, not the section's: the address below is the way to
  // open it by hand, so a browser that refused must say so here — a button
  // that does nothing is indistinguishable from a dead one.
  const [openFailed, setOpenFailed] = useState(false);
  const expiring = state.mode === 'temporary' && state.expiresAt !== null;
  return (
    <div className="space-y-2.5" data-web-access-open>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5 text-[13px] text-ink" data-web-access-status={state.mode}>
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success" />
          {state.mode === 'temporary' ? t('st.web.temporary') : t('st.web.persistent')}
          {expiring ? (
            <span className="text-ink-faint">
              · {t('st.web.expires', { duration: durationUntil(new Date(state.expiresAt!).toISOString(), locale) })}
            </span>
          ) : null}
        </span>
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
          <button type="button" data-web-access-new-link className={SECONDARY_BUTTON}
            disabled={busy !== null} onClick={onNewLink}>
            <Icon name="copy" size={12} className="mr-1 inline-block align-[-1px]" />
            {busy === 'link' ? t('st.web.issuing') : t('st.web.newLink')}
          </button>
          {state.url !== null ? (
            <ExternalLink data-web-access-open-link href={state.url}
              onOpenFailed={() => { setOpenFailed(true); }}
              className={`${SECONDARY_BUTTON} no-underline`}>
              <Icon name="external" size={12} className="mr-1 inline-block align-[-1px]" />
              {t('st.web.openHere')}
            </ExternalLink>
          ) : null}
          <button type="button" data-web-access-off className={SECONDARY_BUTTON}
            disabled={busy !== null} onClick={onTurnOff}>
            {busy === 'off' ? t('st.web.turningOff') : t('st.web.turnOff')}
          </button>
        </div>
      </div>

      {/* Unencrypted is a fact about the connection, not a setting buried in
          settings: if this entry is plain HTTP on a network, say so here. */}
      {state.insecure ? (
        <p className="text-[12px] leading-snug text-amber-ink" data-web-access-insecure>{t('st.web.insecureLive')}</p>
      ) : null}

      {/* The one thing to do about a refused open: the address is right here. */}
      {openFailed && state.url !== null ? (
        <p role="alert" data-web-access-open-failed className="text-[12px] leading-snug text-danger">
          {t('st.web.openFailed')} <span className="font-mono text-[11px] break-all">{state.url}</span>
        </p>
      ) : null}

      {address}

      <BrowserList state={state} onRevoke={onRevoke} onRevokeAll={onRevokeAll} busy={busy} />
    </div>
  );
}

/** The entry is closed. Two ways to open it, and the address options behind a fold. */
function ClosedEntry({ state, busy, onEnable, address }: {
  state: WebAccessStatus;
  mode: WebAccessStatus['mode'];
  busy: boolean;
  details: boolean;
  onToggleDetails: () => void;
  onEnable: (mode: Mode) => void;
  address: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-2.5" data-web-access-closed>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="text-[13px] text-ink" data-web-access-status="off">{t('st.web.off')}</p>
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
          <button type="button" data-web-access-start-temporary className={SECONDARY_BUTTON}
            disabled={busy} onClick={() => { onEnable('temporary'); }}>
            {t('st.web.startTemporary')}
          </button>
          <button type="button" data-web-access-start-persistent className={PRIMARY_BUTTON}
            disabled={busy} onClick={() => { onEnable('persistent'); }}>
            {t('st.web.startPersistent')}
          </button>
        </div>
      </div>
      <p className="text-[12px] leading-snug text-ink-faint" data-web-access-mode-hint>
        {t(state.mode === 'persistent' ? 'st.web.modePersistent' : 'st.web.modeTemporary')}
      </p>
      {address}
    </div>
  );
}

/**
 * Where the entry can be reached, folded away until it is wanted.
 *
 * Two halves, in this order. First the address the server actually reports,
 * copyable, because typing an IP by hand is the failure mode this exists to
 * remove. Then the editor that changes it — the same four fields the enable
 * contract takes, checked against the listener's own rules so an unencrypted
 * bind cannot be requested by accident. Saving re-enables with the current
 * mode, which is the only way these values can change: there is no separate
 * "configure the network" call to keep in step with them.
 */
function AddressDisclosure({ open, onToggle, state, draft, onDraft, onApply, applying }: {
  open: boolean;
  onToggle: () => void;
  state: WebAccessStatus;
  draft: WebAccessAddressDraft;
  onDraft: (next: WebAccessAddressDraft) => void;
  onApply: () => void;
  applying: boolean;
}) {
  const { t } = useI18n();
  const address = webAccessAddress(state);
  const problem = addressIssue(draft);
  const problemText = problem === null ? null : t(problem);
  const needsTlsChoice = draftReachesOtherDevices(draft) || (draft.publicUrl.trim() !== '' && draft.publicUrl.trim().toLowerCase().startsWith('http://'));
  const set = (patch: Partial<WebAccessAddressDraft>) => { onDraft({ ...draft, ...patch }); };
  return (
    <div>
      <button type="button" data-web-access-details-toggle aria-expanded={open} aria-controls="web-access-details"
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 rounded-md py-1 text-[12px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink">
        <DisclosureChevron open={open} className="text-current" />
        {t(open ? 'st.web.hideDetails' : 'st.web.showDetails')}
      </button>
      <div id="web-access-details" hidden={!open} className="space-y-3 pt-2">
        {address === null ? <Hint>{t('st.web.addressPending')}</Hint> : (
          <CopyField id="web-access-address" dataAttr="web-access-address"
            label={t('st.web.reachableHere')} value={address}
            copyLabel={t('st.web.linkCopy')} copiedLabel={t('st.web.linkCopied')}
            hint={t('st.web.addressHint')} />
        )}
        {state.insecure ? <p className="text-[12px] leading-snug text-amber-ink" data-web-access-insecure-hint>{t('st.web.insecureHint')}</p> : null}

        <div className="space-y-2.5 border-t border-hairline pt-3" data-web-access-address-form>
          <SettingField label={t('st.web.hostField')} htmlFor="web-access-host" layout="stack" help={t('st.web.hostHint')}>
            <input id="web-access-host" data-web-access-host className={INPUT} inputMode="url" spellCheck={false}
              placeholder={t('st.web.hostPlaceholder')} value={draft.host}
              onChange={(event) => { set({ host: event.target.value }); }} />
          </SettingField>
          <SettingField label={t('st.web.portField')} htmlFor="web-access-port" layout="stack">
            <input id="web-access-port" data-web-access-port className={INPUT} inputMode="numeric" spellCheck={false}
              placeholder={t('st.web.portPlaceholder')} value={draft.port}
              onChange={(event) => { set({ port: event.target.value }); }} />
          </SettingField>
          <SettingField label={t('st.web.publicUrlField')} htmlFor="web-access-public-url" layout="stack" help={t('st.web.publicUrlHint')}>
            <input id="web-access-public-url" data-web-access-public-url className={INPUT} spellCheck={false}
              placeholder={t('st.web.publicUrlPlaceholder')} value={draft.publicUrl}
              onChange={(event) => { set({ publicUrl: event.target.value }); }} />
          </SettingField>

          {/* Appears only when the draft actually asks other devices in over an
              unencrypted address, so the option is never a standing invitation. */}
          {needsTlsChoice ? (
            <div data-web-access-insecure-option>
              <Toggle id="web-access-insecure" layout="row" label={t('st.web.insecureNoTls')}
                checked={draft.insecureNoTls} onChange={(next) => { set({ insecureNoTls: next }); }} />
              <p className="mt-1 max-w-[62ch] text-[12px] leading-snug text-amber-ink">{t('st.web.insecureHint')}</p>
            </div>
          ) : null}

          {problemText !== null ? <p className="text-[12px] text-danger" role="alert" data-web-access-address-problem>{problemText}</p> : null}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" data-web-access-apply-address className={SECONDARY_BUTTON}
              disabled={!state.enabled || applying || problem !== null} onClick={onApply}>
              {applying ? t('st.web.enabling') : t('st.web.applyAddress')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Which browsers are signed in right now. This is the only place the owner can
 * end one device's access without ending everyone's, so a session is a row with
 * a name and its own sign-out, not a checkbox list.
 */
function BrowserList({ state, onRevoke, onRevokeAll, busy }: {
  state: WebAccessStatus;
  onRevoke: (entry: WebAccessStatus['sessions'][number]) => void;
  onRevokeAll: () => void;
  busy: null | Mode | 'off' | 'revoke' | 'link';
}) {
  const { t, locale } = useI18n();
  const sessions = state.sessions;
  return (
    <div className="pt-1" data-web-access-browsers>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[12.5px] font-medium text-ink">{t('st.web.signedIn')}</p>
        {sessions.length > 0 ? (
          <button type="button" data-web-access-revoke-all className="text-[12px] text-ink-soft underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
            disabled={busy !== null} onClick={onRevokeAll}>
            {t('st.web.revokeAll')}
          </button>
        ) : null}
      </div>
      {sessions.length === 0 ? (
        <p className="mt-1 text-[12px] text-ink-faint" data-web-access-browsers-empty>{t('st.web.signedInNone')}</p>
      ) : (
        <div role="list" aria-label={t('st.web.signedIn')} className="mt-1.5 space-y-1">
          {sessions.map((entry) => (
            <div key={entry.id} role="listitem" data-web-access-session={entry.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-ink/[0.03] px-2.5 py-1.5">
              <Icon name="web" size={12} className="shrink-0 text-ink-faint" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] text-ink" title={entry.label}>{entry.label}</p>
                <p className="text-[11.5px] text-ink-faint">
                  {t('st.web.lastUsed', { time: relativeTime(new Date(entry.lastUsedAt).toISOString(), locale) })}
                </p>
              </div>
              <button type="button" data-web-access-revoke={entry.id} className={SECONDARY_BUTTON}
                disabled={busy !== null} onClick={() => { onRevoke(entry); }}>
                {t('st.web.revoke')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The one-time link, shown once. The server keeps only a digest, so there is
 * nothing to come back to; if the person loses it, the answer is a new link,
 * not a search through settings.
 */
function WebLinkDialog({ link, onClose }: { link: WebAccessLink; onClose: () => void }) {
  const { t, locale } = useI18n();
  const expiry = useRef(link.expiresAt);
  return (
    <Dialog onClose={onClose} overlayId="web-access-link-dialog" ariaLabel={t('st.web.linkTitle')}
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} max-h-[calc(100dvh-2rem)] overflow-y-auto`}>
      <div className="space-y-4" data-web-access-link>
        <div>
          <h2 className="text-[14px] font-medium text-ink">{t('st.web.linkTitle')}</h2>
          <p className="mt-1 max-w-[62ch] text-[12.5px] leading-snug text-ink-soft">{t('st.web.linkBody')}</p>
        </div>
        <CopyField id="web-access-link-value" dataAttr="web-access-link"
          label={t('st.web.linkLabel')} value={link.url}
          copyLabel={t('st.web.linkCopy')} copiedLabel={t('st.web.linkCopied')}
          hint={t('st.web.linkOnce')} />
        <div className="flex justify-end">
          <button type="button" data-web-access-link-done className={PRIMARY_BUTTON} onClick={onClose}>
            {t('st.web.linkDone')}
          </button>
        </div>
        {/* The code's own lifetime, for the record: it is a property of this
            link, not of the entry point the link opens. */}
        <p className="text-[11.5px] text-ink-faint" data-web-access-link-expires>
          {t('st.web.linkExpires', { duration: durationUntil(new Date(expiry.current).toISOString(), locale) })}
        </p>
      </div>
    </Dialog>
  );
}
