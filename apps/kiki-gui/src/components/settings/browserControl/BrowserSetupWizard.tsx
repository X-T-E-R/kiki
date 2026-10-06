/**
 * 浏览器控制 → the way in. One question, asked in the order a person has to
 * answer it: which browser should Kiki drive, then prepare it, then connect it.
 *
 * The named routes are the server's own (`app/browser/browserSetupService.ts`),
 * read from one `GET /browser/setup`. Every route is described by its own
 * readiness and its own actions, so the page never decides what "installed" or
 * "connected" means — it says what the server reported and offers the action the
 * server listed. A route whose components are all in place does not offer to
 * install them again; a route already connected says so and keeps its way out.
 *
 * Three route shapes exist and the page keeps them apart, because they are not
 * three versions of the same promise:
 *
 *   Kiki-managed  (independent-browser) — Kiki installs a verified driver and its
 *       own browser, then opens one connection. This is the whole flow, and the
 *       two actions are Set up and Connect.
 *   Extension     (kimi-webbridge)     — Kiki installs a plugin and a local
 *       bridge; the store extension is a person's click, so that step is a link
 *       to the store, never a button claiming to have crossed it.
 *   External      (codex-browser)      — another app owns the control surface.
 *       Nothing here is for Kiki to install or connect, so there is no Kiki
 *       button and no connected badge: only the official instructions, placed at
 *       this route's own action.
 *
 * Everything else — a manual CDP address, a hand-picked driver or executable —
 * stays in the advanced region below, for the browser this page cannot set up.
 *
 * The rows are a flat list, not a card wall: the settings page draws its own
 * sections as hairline-separated bands, and three rounded boxes stacked in a
 * column would read as a gallery rather than as three answers to one question.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import {
  blockingStep, browserApi, browserKeys, presetAction, presetReadiness, runningStep, warningStep, whenText,
  type BrowserSetupStatus, type PresetReadiness,
} from '../../../lib/browserRest';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../../controls';
import { Icon } from '../../icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { ConfirmDialog } from '../../ConfirmDialog';
import { AdvancedDetails } from '../fields';

const READINESS_TONE: Readonly<Record<PresetReadiness, { text: I18nKey; dot: string }>> = {
  preparing: { text: 'st.browser.route.preparing', dot: 'status-dot-busy bg-ink-soft' },
  'needs-action': { text: 'st.browser.route.needsAction', dot: 'bg-hairline-strong' },
  ready: { text: 'st.browser.route.ready', dot: 'bg-selected-ink' },
  connected: { text: 'st.browser.route.connected', dot: 'bg-success' },
  blocked: { text: 'st.browser.route.blocked', dot: 'bg-danger' },
  external: { text: 'st.browser.route.external', dot: 'bg-ink-soft' },
};

/**
 * The store a `install_extension` action names. The server sends the URL and the
 * browser it belongs to; the page says which store in its own words so a link
 * never opens a page the reader cannot recognise.
 */
const STORE_TARGET_KEYS: Readonly<Record<string, I18nKey>> = {
  chrome: 'st.browser.store.chrome',
  edge: 'st.browser.store.edge',
  documentation: 'st.browser.store.docs',
};

/**
 * Step ids the page names in its own words, as a phrase that reads after "Still
 * needs …". A step this does not know keeps the server's id rather than being
 * given a sentence it did not earn.
 */
const STEP_KEYS: Readonly<Record<string, I18nKey>> = {
  'daemon-binary': 'st.browser.step.daemonBinary',
  daemon: 'st.browser.step.daemon',
  skill: 'st.browser.step.skill',
  plugin: 'st.browser.step.plugin',
  extension: 'st.browser.step.extension',
  detect: 'st.browser.step.detect',
  compatibility: 'st.browser.step.compatibility',
  feature: 'st.browser.step.feature',
  'desktop-app': 'st.browser.step.desktopApp',
  driver: 'st.browser.step.driver',
  chrome: 'st.browser.step.chrome',
  install: 'st.browser.step.install',
};

/** A sentence about a step is one the page can back, or none at all. */
const REASON_KEYS: Readonly<Record<string, I18nKey>> = {
  feature_disabled: 'st.browser.reason.featureDisabled',
  version_mismatch: 'st.browser.reason.versionMismatch',
  external_app_required: 'st.browser.reason.externalApp',
  connection_conflict: 'st.browser.reason.connectionConflict',
};

/** One route. The name is the server's `displayName`; the rest is its own answer. */
function BrowserRoute({ preset, active, onSelect }: {
  readonly preset: BrowserSetupStatus;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  const { t, locale } = useI18n();
  const { client, scopeId } = useConnection();
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState<'prepare' | 'connect' | 'cancel' | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** Set by the forced-off line so its fold opens; the fold owns its state. */
  const [openDiagnostics, setDiagnosticsOpen] = useState(false);

  const readiness = presetReadiness(preset);
  const tone = READINESS_TONE[readiness];
  const prepare = presetAction(preset, 'prepare');
  const connect = presetAction(preset, 'connect');
  const cancel = presetAction(preset, 'cancel');
  const extension = presetAction(preset, 'install_extension');
  const instructions = presetAction(preset, 'open_instructions');
  const running = runningStep(preset);
  const blocking = blockingStep(preset);
  const external = preset.controlSurface === 'external-app';
  const step = (id: string): string => t(STEP_KEYS[id] ?? 'st.browser.step.install');
  const reason = (source: BrowserSetupStatus['steps'][number]): string | undefined =>
    source.reason === undefined ? undefined : REASON_KEYS[source.reason] === undefined ? undefined : t(REASON_KEYS[source.reason]!);

  // Three different waits, and each one gets its own line: something Kiki is
  // doing now, something it can install, and something only a person can do
  // (a store approval, the native flag, another app's install).
  const moving = running !== undefined;
  const installable = blocking !== undefined && blocking.state === 'missing';
  // A failed step is the other case where Set up is the next move: something
  // went wrong installing, and offering it again is the repair.
  const repairable = preset.steps.some((item) => item.state === 'failed');
  // The native flag is enabled by the same consented prepare, so a route whose
  // only gap is the flag still has an in-place action here — and it is the one
  // the reader wants, rather than a trip to another page to find a switch.
  const featureOnly = blocking !== undefined && blocking.id === 'feature' && !installable && !repairable
    && blocking.reason !== 'feature_forced_off';
  // Forced off is not a step this page can take: the server withholds every
  // action, because an environment or runtime override outranks anything
  // consented here. It is reported, never offered.
  const forcedOff = blocking !== undefined && blocking.reason === 'feature_forced_off';
  // Either one, and Set up is the action. A warning is none of these, so a route
  // that is only warned about is not treated as needing an install.
  const canPrepare = installable || repairable || featureOnly;
  // The next move is Set up only when something is missing, something failed,
  // or only the flag is left. Once every installable component is in place,
  // pushing "install" at the reader is the thing this page exists to stop.
  const personOwned = blocking !== undefined && (blocking.state === 'user_action' || blocking.id === 'feature');
  // Everything Kiki could install is in place and nothing failed: the honest
  // thing to say, and the reason Set up is not on offer. Only a route Kiki
  // itself fills in can be described that way — an external route has no such
  // work, and a forced-off route is not settled at all.
  const settled = !external && !moving && !installable && !repairable && !featureOnly && !forcedOff;
  // An external route has no Kiki action left, so "still needs X" would only
  // restate what its own action row already offers — and its reasons are the
  // other app's business, not something this page can move.
  // Forced off already says what is wrong and why, in its own line below.
  const needsLine = !external && !forcedOff && (installable || personOwned);
  // A step the server marked `warning` is not blocking — nothing is missing —
  // but it is the one thing a person should know before trusting the route, so
  // it gets its own line rather than hiding in the diagnostics fold. It is
  // gathered independently of the blocker so a warning ahead of a real
  // blocker does not displace it.
  const warned = warningStep(preset);
  const offeredExtension = extension;
  const offeredInstructions = instructions?.url;

  const reload = () => queryClient.invalidateQueries({ queryKey: browserKeys.presets(scopeId) });

  const act = async (action: 'prepare' | 'connect' | 'cancel') => {
    setBusy(action);
    setFeedback(null);
    try {
      const api = browserApi(client);
      if (action === 'prepare') await api.prepare(preset.preset, { consent: true });
      else if (action === 'connect') await api.connectPreset(preset.preset, {});
      else await api.cancelSetup(preset.preset);
      setConfirming(false);
      await reload();
      // The managed route's connect writes a real connection, so the list and
      // the default selector below have to be re-read from the server.
      if (preset.preset === 'independent-browser') {
        await queryClient.invalidateQueries({ queryKey: browserKeys.connections(scopeId) });
      }
      setFeedback({ tone: 'info', text: t(`st.browser.route.done.${action}`) });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <li
      data-browser-route={preset.preset}
      data-browser-route-state={readiness}
      data-browser-route-active={active ? 'true' : 'false'}
      className={`min-w-0 border-t border-hairline py-3.5 first:border-t-0 first:pt-1 ${active ? 'bg-ink/[0.02]' : ''}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <button type="button" data-browser-route-select
          aria-pressed={active}
          onClick={onSelect}
          className="mr-auto min-w-0 text-left text-[14px] font-medium text-ink hover:underline underline-offset-2">
          {preset.displayName}
        </button>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-ink-soft" data-browser-route-readiness={readiness}>
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
          {t(tone.text)}
        </span>
      </div>

      <p className="mt-1 max-w-[62ch] text-[12.5px] leading-5 text-ink-soft">
        {t(`st.browser.route.blurb.${preset.preset}`)}
      </p>

      {/* Progress while a preparation runs: the server's own step, its own
          percent. Nothing is invented, so the row can say what is moving
          without claiming which file is on the wire. */}
      {moving ? (
        <p role="status" className="mt-2 flex items-baseline gap-2 text-[12px] text-ink-soft" data-browser-route-progress={running.id}>
          <span>{t('st.browser.route.installing', { step: step(running.id) })}</span>
          {running.percent === undefined ? null : (
            <span className="font-mono tabular-nums text-ink-faint">{Math.round(running.percent)}%</span>
          )}
        </p>
      ) : null}

      {needsLine ? (
        <p className="mt-2 max-w-[62ch] text-[12px] leading-[18px] text-ink-soft" data-browser-route-blocker={blocking.id}>
          {t('st.browser.route.blocking', { step: step(blocking.id) })}
          {reason(blocking) === undefined ? '' : ` ${reason(blocking)}`}
        </p>
      ) : null}
      {/* An override that outranks this page: the headline says what that
          means, and the line the reader has to change to undo it goes in the
          diagnostics fold with the rest of the detector's prose. It is the one
          actionable fact here, so the fold is opened for it rather than
          leaving it to compete with the sentence above. */}
      {forcedOff ? (
        <p className="mt-2 max-w-[62ch] text-[12px] leading-[18px] text-danger" data-browser-route-forced-off>
          {t('st.browser.reason.forcedOff', { step: step(blocking.id) })}
          {blocking.detail === undefined ? null : (
            <>
              {' '}
              {/* Not decoration: naming the override is the only way back, so
                  this opens the fold that holds it rather than leaving the
                  reader to find it. */}
              <button type="button" className="text-ink-soft underline underline-offset-2"
                data-browser-route-forced-off-cause
                onClick={() => { setDiagnosticsOpen(true); }}>
                {t('st.browser.reason.forcedOffCause')}
              </button>
            </>
          )}
        </p>
      ) : null}      {settled ? (
        <p className="mt-2 max-w-[62ch] text-[12px] leading-[18px] text-ink-faint" data-browser-route-settled>
          {t('st.browser.route.alreadyInstalled')}
        </p>
      ) : null}

      {warned === undefined ? null : (
        // A rule, because at phone width this wraps to two or three lines and
        // would otherwise read straight on from the settled line above it —
        // one grey sentence and one amber sentence as a single paragraph.
        <p className="mt-2.5 max-w-[62ch] border-l-2 border-amber-ink/45 pl-2.5 text-[12px] leading-[18px] text-amber-ink"
          data-browser-route-warning={warned.id}>
          {t('st.browser.route.warning', { step: step(warned.id) })}
          {reason(warned) === undefined ? '' : ` ${reason(warned)}`}
        </p>
      )}

      {preset.error === undefined ? null : (
        <p role="alert" className="mt-2 max-w-[72ch] break-words text-[12px] leading-[18px] text-danger" data-browser-route-error>
          {preset.error}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-2">
        {/* External control surfaces get no Kiki button: there is nothing here
            for Kiki to install or connect, so a primary button would promise a
            step this app does not perform. And Set up is only the headline while
            something is actually missing — once the components are in place the
            next move belongs to the person, and pushing "install" at them is the
            thing this page is here to stop doing. It stays available, quiet, for
            the case where a later check does find something to repair. */}
        {external || prepare === undefined || busy !== null || moving || readiness === 'connected' || !canPrepare ? null : (
          <button type="button" className={PRIMARY_BUTTON} data-browser-route-prepare
            disabled={busy !== null}
            onClick={() => { setConfirming(true); }}>
            {busy === 'prepare' ? t('st.browser.route.preparing')
              // Nothing is left to install when only the flag is, so the button
              // says what it actually does rather than claiming to set up.
              : featureOnly ? t('st.browser.route.turnOn') : t('st.browser.route.prepare')}
          </button>
        )}
        {external || connect === undefined || readiness !== 'ready' || busy !== null ? null : (
          <button type="button" className={PRIMARY_BUTTON} data-browser-route-connect
            disabled={busy !== null}
            onClick={() => { void act('connect'); }}>
            {busy === 'connect' ? t('st.browser.route.connecting') : t('st.browser.route.connect')}
          </button>
        )}
        {readiness === 'connected' ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-success" data-browser-route-connected>
            <Icon name="check" size={12} />
            {t('st.browser.route.connectedAt', { at: whenText(locale, preset.checkedAt) ?? t('st.browser.route.connectedNow') })}
          </span>
        ) : null}
        {cancel === undefined || busy !== null ? null : (
          <button type="button" className={SECONDARY_BUTTON} data-browser-route-cancel
            onClick={() => { void act('cancel'); }}>
            {t('st.browser.route.cancel')}
          </button>
        )}
        {/* The flag is enabled by the consented Set up above, so there is no
            second button and no trip to another page: the reader is told what
            is off, and the button they can already see turns it on. */}
        {offeredExtension?.url === undefined ? null : (
          <a className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`} href={offeredExtension.url} target="_blank" rel="noopener noreferrer"
            data-browser-route-extension={offeredExtension.target ?? 'chrome'}>
            <Icon name="external" size={12} />
            {t('st.browser.route.addExtension', { store: t(STORE_TARGET_KEYS[offeredExtension.target ?? ''] ?? 'st.browser.store.chrome') })}
          </a>
        )}
        {offeredInstructions === undefined ? null : (
          <a className="inline-flex items-center gap-1 text-[12px] text-selected-ink hover:underline" href={offeredInstructions}
            target="_blank" rel="noopener noreferrer" data-browser-route-instructions>
            {t('st.browser.route.instructions')}
          </a>
        )}
      </div>

      {preset.checkedAt === undefined ? null : (
        <p className="mt-2 text-[11px] text-ink-faint" data-browser-route-checked>
          {t('st.browser.route.checkedAt', { at: whenText(locale, preset.checkedAt) ?? '' })}
        </p>
      )}

      <FeedbackLine feedback={feedback} />

      {/* The detector's own sentences, folded. They explain the machine rather
          than the next action, so they are here and not in the row above. */}
      {preset.steps.every((item) => item.detail === undefined) ? null : (
        <AdvancedDetails summary={t('st.browser.route.diagnostics')} data-browser-route-diagnostics
          open={openDiagnostics || undefined}
          onToggle={(event) => { setDiagnosticsOpen((event.currentTarget as HTMLDetailsElement).open); }}>
          <dl className="space-y-1.5">
            {preset.steps.map((item) => (
              <div key={item.id} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                <dt className="text-ink-faint">{step(item.id)}</dt>
                <dd className="min-w-0 text-ink-soft">
                  {t(`st.browser.stepState.${item.state}`)}
                  {item.reason === undefined ? '' : ` · ${item.reason}`}
                  {item.detail === undefined ? '' : <span className="block text-ink-faint">{item.detail}</span>}
                </dd>
              </div>
            ))}
          </dl>
          <p className="font-mono text-ink-faint break-all" data-browser-route-source>{preset.sourceUrl}</p>
          <p className="text-ink-faint">
            {t('st.browser.route.hostLine')} <span className="font-mono break-all">{preset.executionHost}</span>
          </p>
        </AdvancedDetails>
      )}

      <ConfirmDialog open={confirming} overlayId={`confirm-browser-prepare-${preset.preset}`}
        title={t('st.browser.route.confirmTitle', { name: preset.displayName })}
        body={t('st.browser.route.confirmBody')}
        consequences={[
          t('st.browser.route.consequenceHost', { host: preset.executionHost }),
          ...(preset.skill === undefined ? [] : [t('st.browser.route.consequencePlugin', { name: preset.skill })]),
          // The consent covers switching browser control on, so it is listed as
          // a consequence rather than left to a sentence the reader has to
          // notice. The server only reports a `feature` step while the flag is
          // still off, so its absence is the signal that there is nothing to
          // enable — and the dialog never opens with no button behind it.
          ...(preset.steps.some((item) => item.id === 'feature') ? [t('st.browser.route.consequenceFeature')] : []),
          ...(preset.connectionId === undefined ? [] : [t('st.browser.route.consequenceConnection', { name: preset.connectionId })]),
        ]}
        confirmLabel={t('st.browser.route.prepare')}
        onCancel={() => { setConfirming(false); }}
        onConfirm={() => { void act('prepare'); }} />
    </li>
  );
}

/**
 * The wizard: the named routes first, in the order a reader can finish them,
 * and the advanced region — the things a person fills in only when none of the
 * routes is what they want — last.
 */
export function BrowserSetupWizard() {
  const { client, scopeId, sshLabel } = useConnection();
  const { t } = useI18n();
  const [picked, setPicked] = useState<string | null>(null);

  const query = useQuery({
    queryKey: browserKeys.presets(scopeId),
    queryFn: () => browserApi(client).setupPresets(),
    staleTime: 5_000,
    // The store approval happens in another window: the reader leaves for it,
    // comes back, and the row has to show the extension as connected. The app
    // turns focus refetch off globally, so this opts back in the way
    // `useSessionSshHosts` does for the same leave-and-return shape — one
    // re-read when the window regains focus and the data is stale, not a timer.
    refetchOnWindowFocus: true,
    // Only a preparation that is actually running is worth polling for; a
    // settled route is re-read on demand instead of on a timer forever.
    refetchInterval: (result) => result.state.data?.presets.some((preset) => preset.state === 'preparing') === true ? 1_500 : false,
  });

  const presets = query.data?.presets ?? [];
  const external = presets.filter((preset) => preset.controlSurface === 'external-app');
  const managed = presets.filter((preset) => preset.controlSurface !== 'external-app');
  // Preselect the route that is already furthest along, so a reader who came
  // back to a working setup lands on it rather than on the first row.
  const chosen = presets.find((preset) => preset.preset === picked)
    ?? managed.find((preset) => presetReadiness(preset) === 'connected' || presetReadiness(preset) === 'ready')
    ?? managed[0]
    ?? presets[0];

  return (
    <div className="space-y-3" data-browser-setup>
      <Hint>
        {sshLabel === null
          ? t('st.browser.setup.host')
          : t('st.browser.setup.hostSsh', { label: sshLabel })}
      </Hint>

      {query.isPending ? (
        <p role="status" className="text-[12px] text-ink-faint">{t('st.browser.setup.detecting')}</p>
      ) : query.isError ? (
        <div className="space-y-2">
          <InlineError error={query.error} />
          <button type="button" className={SECONDARY_BUTTON} onClick={() => { void query.refetch(); }}>{t('common.retry')}</button>
        </div>
      ) : presets.length === 0 ? (
        <Hint>{t('st.browser.route.none')}</Hint>
      ) : (
        <>
          <ul className="divide-y divide-hairline" data-browser-routes>
            {managed.map((preset) => (
              <BrowserRoute key={preset.preset} preset={preset} active={chosen?.preset === preset.preset}
                onSelect={() => { setPicked(preset.preset); }} />
            ))}
          </ul>
          {external.length === 0 ? null : (
            <>
              <p className="pt-1 text-[12px] font-medium text-ink-faint" data-browser-routes-external-label>
                {t('st.browser.route.otherApps')}
              </p>
              <ul className="divide-y divide-hairline" data-browser-routes-external>
                {external.map((preset) => (
                  <BrowserRoute key={preset.preset} preset={preset} active={false} onSelect={() => {}} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
