/**
 * 浏览器控制 → the browsers themselves. Every saved connection is one row: may
 * the Agent use it (the box), what it is and where it runs, the state the
 * control service last reported, and a quiet tag on the default. The default
 * itself is chosen in one place, the select on the list's header line.
 *
 * The card shows one thing at a time. Pressing a row replaces the list with
 * that connection as a flat form, with a back row; Add replaces it with the
 * ways to get a browser — the sources Kiki can prepare, then a manual form.
 * The same sources stay manageable (switch, prepare, check) in a fold under
 * the list.
 *
 * Allowed and default are written straight from the list; they are two
 * separate facts, and the default tag never ticks the box. A connection whose
 * source is switched off keeps its box as stored, greyed, so turning the source
 * back on restores exactly what was there.
 *
 * Three things stay apart in the form on purpose:
 *
 *   config   name / id / type / driver and profile paths or CDP endpoint —
 *            saved by the draft footer, never by a runtime action;
 *   runtime  check / connect / disconnect, which use the *saved* config and are
 *            therefore offered only while the draft is clean;
 *   state    the control service's own `status`, worded as the service words it
 *            and shown only when the service said something. No state is
 *            inferred here, and a connection that is not running is drawn as
 *            normal, not as a problem.
 *
 * The page itself never starts a driver or opens a browser: only a person
 * pressing check / connect does that.
 */

import { useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import type { I18nKey } from '@kiki/session-core/i18n';
import { experimentalCardId, experimentalSectionForFlag, type BrowserSourceId } from '@kiki/session-core/settings';
import type { BrowserStatus } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import {
  AGENT_BROWSER_MARKERS, AGENT_BROWSER_VERSION, LIVE_BLOCKING_CONNECT, LIVE_STATES, browserApi, browserFailureOf, browserKeys, endpointHost,
  isFlagDisabled, whenText,
} from '../../../lib/browserRest';
import type { BrowserConnection, BrowserConnectionRow, BrowserConnectionType, BrowserOwnership } from '../../../lib/browserRest';
import { ConfirmDialog } from '../../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, SaveStatus, Toggle, type Feedback } from '../../controls';
import { useDirtyGuard } from '../../dirtyGuard';
import { Icon } from '../../icons';
import { Tag } from '../../capabilities/primitives';
import { DANGER_GHOST_BUTTON, INPUT, SECONDARY_BUTTON } from '../../ui';
import { AdvancedDetails } from '../fields';
import { SecretField } from '../SecretField';
import { SettingsCardMountContext, SettingsFlashContext } from '../SectionCard';
import { FieldIssue, FORM_LABEL, SettingsDraftFooter, SettingsSelect } from '../SettingsPrimitives';
import { useInstantSave } from '../useInstantSave';
import { useSavedTick } from '../useSavedTick';
import { BrowserRuntimeDetails, BrowserStateMark, OtherBrowserEcosystems } from './BrowserBits';
import { BrowserSetupWizard } from './BrowserSetupWizard';
import { SOURCE_NAME_KEYS, useBrowserAllowance } from './browserAllowance';
import {
  browserConnectionInput, draftIssues, draftOf, hasIssues, isDirtyDraft, isNewDraft, newBrowserDraft, parseBrowserInput,
  type BrowserDraft,
} from './browserDraft';

type RuntimeAction = 'check' | 'connect' | 'disconnect';

/**
 * The development-candidate flag that gates a run
 * (`agent-core-v2/src/app/browser/flag.ts`; the flag row carries its own label
 * and lives on the Developer settings page).
 */
const NATIVE_BROWSER_FLAG = 'native_browser';

/**
 * Where that flag's row lives. Developer hosts the flags no other page claims,
 * so the trip this page offers is the same shape as the SSH page's own switch
 * trip: the Settings section, plus the anchor of its Experimental rows.
 */
const NATIVE_BROWSER_FLAG_HOME = experimentalSectionForFlag(NATIVE_BROWSER_FLAG);
const NATIVE_BROWSER_FLAG_TRIP = `/settings/${NATIVE_BROWSER_FLAG_HOME}#${experimentalCardId(NATIVE_BROWSER_FLAG_HOME)}`;

function typeLabel(t: ReturnType<typeof useI18n>['t'], type: BrowserConnectionType): string {
  if (type === 'ego-lite') return t('st.browser.type.ego-lite');
  if (type === 'kimi-webbridge' || type === 'webbridge-command') return t('st.browser.type.kimi-webbridge');
  return t(type === 'codex-extension' ? 'st.browser.type.codex-extension' : type === 'agent-browser-cdp' ? 'st.browser.type.cdp' : 'st.browser.type.profile');
}

/**
 * The styles this connection may be saved as.
 *
 * A record whose stored shape has no second reading keeps its own style as the
 * only choice: the extension's runtime root and pipe, Ego Lite's CLI fields, and
 * the bridge, which has no address at all. Those three are locks, not routes —
 * the Kimi route only probes the local bridge and never saves a connection, so
 * this picker is the one place a person creates a bridge record. A profile or a
 * CDP record may be switched to any of the three, including to the bridge; that
 * is an explicit choice on a saved id, never an automatic rewrite.
 */
function typeChoices(
  t: ReturnType<typeof useI18n>['t'],
  original: BrowserConnection | undefined,
): readonly { value: BrowserConnectionType; label: string; hint: string }[] {
  if (original?.type === 'codex-extension') {
    return [{ value: 'codex-extension', label: t('st.browser.type.codexExtensionLong'), hint: t('st.browser.type.codexExtensionHint') }];
  }
  if (original?.type === 'ego-lite') {
    return [{ value: 'ego-lite', label: t('st.browser.type.egoLiteLong'), hint: t('st.browser.type.egoLiteHint') }];
  }
  if (original?.type === 'kimi-webbridge') {
    return [{ value: 'kimi-webbridge', label: t('st.browser.type.kimi-webbridge'), hint: t('st.browser.type.webbridgeHint') }];
  }
  if (original?.type === 'webbridge-command') {
    return [{ value: 'webbridge-command', label: t('st.browser.type.kimi-webbridge'), hint: t('st.browser.type.webbridgeHint') }];
  }
  return [
    { value: 'agent-browser-profile', label: t('st.browser.type.profileLong'), hint: t('st.browser.type.profileHint') },
    { value: 'agent-browser-cdp', label: t('st.browser.type.cdpLong'), hint: t('st.browser.type.cdpHint') },
    { value: 'kimi-webbridge', label: t('st.browser.type.kimi-webbridge'), hint: t('st.browser.type.webbridgeHint') },
  ];
}

/**
 * What the two run actions are called on this branch, and what the check really
 * does. The words differ per type because the work does: a profile starts the
 * managed driver, a CDP connection tests a driver before attaching to an
 * address, Ego Lite runs its own check, and the bridge only asks its local
 * daemon whether the extension is there.
 */
function runtimeLabels(t: ReturnType<typeof useI18n>['t'], type: BrowserConnectionType): { check: string; checkHint: string; connect: string } {
  if (type === 'ego-lite') {
    return { check: t('st.browser.checkEgo'), checkHint: t('st.browser.checkHintEgo'), connect: t('st.browser.connectEgo') };
  }
  if (type === 'kimi-webbridge' || type === 'webbridge-command') {
    return { check: t('st.browser.checkWebbridge'), checkHint: t('st.browser.checkHintWebbridge'), connect: t('st.browser.connectWebbridge') };
  }
  if (type === 'agent-browser-cdp') {
    return { check: t('st.browser.checkCdp'), checkHint: t('st.browser.checkHintCdp'), connect: t('st.browser.connectCdp') };
  }
  return { check: t('st.browser.checkProfile'), checkHint: t('st.browser.checkHintProfile'), connect: t('st.browser.connectProfile') };
}

/** What survives deleting this connection, in the branch's own terms. */
function deleteConsequenceKey(type: BrowserConnectionType): I18nKey {
  if (type === 'agent-browser-cdp') return 'st.browser.deleteConsequenceCdp';
  if (type === 'ego-lite') return 'st.browser.deleteConsequenceEgo';
  if (type === 'kimi-webbridge' || type === 'webbridge-command') return 'st.browser.deleteConsequenceWebbridge';
  return 'st.browser.deleteConsequenceProfile';
}

/**
 * Where the browser actually is: a role word for a connection Kiki drives on
 * its own server (the literal hostname belongs in the detail, not on every
 * row), the bridge that carries a Kimi connection, and the endpoint's own host
 * for a borrowed browser, which is the fact that tells two CDP connections
 * apart.
 */
function locationLabel(t: ReturnType<typeof useI18n>['t'], row: BrowserConnectionRow): string {
  if (row.type === 'codex-extension') return row.browserId ?? t('st.browser.location.unknown');
  if (row.type === 'ego-lite') return row.cliPath ?? t('st.browser.type.ego-lite');
  if (row.type === 'agent-browser-profile') return t('st.browser.location.server');
  if (row.type === 'kimi-webbridge' || row.type === 'webbridge-command') return t('st.browser.location.webbridge');
  return endpointHost(row.endpointDisplay) ?? t('st.browser.location.unknown');
}

/**
 * One stacked form field: label, input, the issue that belongs to it, then the
 * help line. `aria-invalid` / `aria-describedby` are wired here so an error is
 * announced with the field it is about.
 */
function DraftField({ id, label, value, onChange, issue, hint, placeholder, mono = false, dataAttr }: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly issue: string | null;
  readonly hint?: string;
  readonly placeholder?: string;
  readonly mono?: boolean;
  readonly dataAttr: string;
}) {
  const issueId = `${id}-issue`;
  return (
    <div className="space-y-1.5">
      <label className={FORM_LABEL} htmlFor={id}>{label}</label>
      <input id={id} className={`${INPUT} ${mono ? 'font-mono' : ''} ${issue === null ? '' : 'border-danger'}`}
        value={value} spellCheck={false} autoComplete="off" placeholder={placeholder}
        aria-invalid={issue !== null} aria-describedby={issue === null ? undefined : issueId}
        {...{ [dataAttr]: '' }}
        onChange={(event) => { onChange(event.target.value); }} />
      <FieldIssue id={issueId} text={issue} />
      {hint === undefined ? null : <Hint>{hint}</Hint>}
    </div>
  );
}

export function BrowserConnectionCard() {
  const { client, scopeId } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const guard = useDirtyGuard();
  const allowance = useBrowserAllowance();
  const defaultSave = useInstantSave();

  const query = allowance.connectionsQuery;
  const rows = allowance.connections;
  const defaultBrowser = allowance.defaultBrowser;

  // The routes name the Codex pipe whose approval is still unproven, read from
  // the cached setup read.
  const presetsQuery = useQuery({
    queryKey: browserKeys.presets(scopeId),
    queryFn: () => browserApi(client).setupPresets(),
    staleTime: 5_000,
  });
  const presets = presetsQuery.data?.presets ?? [];
  const codexPending = new Set(presets
    .filter((item) => item.preset === 'codex-browser' && item.reason === 'approval_unproven' && item.browserId !== undefined)
    .map((item) => item.browserId!));
  const sourceName = (source: BrowserSourceId): string => t(SOURCE_NAME_KEYS[source]);

  const [rowBusy, setRowBusy] = useState(false);
  const [rowFeedback, setRowFeedback] = useState<Feedback>(null);
  const rowWrite = async (write: () => Promise<void>) => {
    setRowBusy(true);
    setRowFeedback(null);
    try {
      await write();
    } catch (error) {
      setRowFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setRowBusy(false);
    }
  };
  const toggleAllowed = (row: BrowserConnectionRow, next: boolean) =>
    rowWrite(() => allowance.writeAllowed(row.id, next, { fallbackBrowserId: row.browserId }));

  const [draft, setDraft] = useState<BrowserDraft | null>(null);
  /** The add view: the sources Kiki can prepare, then the manual form. */
  const [adding, setAdding] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<RuntimeAction | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  /** Where the last feedback belongs: beside the run actions, or beside the save row. */
  const [feedbackAt, setFeedbackAt] = useState<'runtime' | 'form'>('form');
  /** Set when the run was refused by the development-candidate flag, not by the config. */
  const [flagOff, setFlagOff] = useState(false);
  const [outcome, setOutcome] = useState<{ readonly action: RuntimeAction; readonly status: BrowserStatus } | null>(null);
  const [justSaved, pingSaved] = useSavedTick();

  const dirty = draft !== null && isDirtyDraft(draft);
  const editorId = `browser-control:${scopeId}:${draft?.original?.id ?? 'new'}`;
  const issues = draft === null ? {} : draftIssues(draft, rows.map((row) => row.id));
  const selectedId = draft?.original?.id;
  const selectedRow = selectedId === undefined ? undefined : rows.find((row) => row.id === selectedId);
  const selectedStatus: BrowserStatus | undefined = selectedRow?.status;
  /** The stored switch, which the list's box writes; the form no longer edits it. */
  const liveEnabled = selectedRow?.enabled ?? draft?.enabled ?? true;

  const vanished = selectedId !== undefined && query.isSuccess && selectedRow === undefined;
  useEffect(() => {
    // Removed elsewhere: a clean draft has nothing to keep, an edited one stays
    // so the person can decide where to re-apply it.
    if (vanished && !dirty) setDraft(null);
  }, [vanished, dirty]);

  /** Replace the open draft without asking: the caller already has an answer. */
  const apply = (next: BrowserDraft | null) => {
    setDraft(next);
    setAdding(false);
    setFeedback(null);
    setFeedbackAt('form');
    setFlagOff(false);
    setOutcome(null);
    setAttempted(false);
  };

  const open = (next: BrowserDraft | null) => {
    // The guard only prompts for an id something reported; the draft footer is
    // that reporter, so the ask has to carry the same editorId or an edit is
    // dropped silently.
    if (dirty && draft !== null && guard?.confirmDiscard !== undefined) {
      guard.confirmDiscard(editorId, () => { apply(next); });
      return;
    }
    apply(next);
  };

  /**
   * A page-local rule reports its own i18n key; anything else is the server's text.
   * The one exception is the server's structured reason: `browser.disabled` with
   * `reason: 'feature_disabled'` is the development-candidate flag, and that is
   * repeated in the person's own language with a trip to where it lives. A
   * *connection* switched off in its own config shares the code but not the
   * reason, so its sentence is shown as the server wrote it. Nothing is turned
   * green by either, and the state stays whatever the service last said.
   */
  const reportFailure = (error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    const flagRefused = isFlagDisabled(browserFailureOf(error));
    setFlagOff(flagRefused);
    if (flagRefused) {
      setFeedback({ tone: 'error', text: t('st.browser.flagOff') });
      return;
    }
    setFeedback({ tone: 'error', text: message.startsWith('st.') ? t(message as Parameters<typeof t>[0]) : errorText(locale, error) });
  };

  const reload = () => queryClient.invalidateQueries({ queryKey: browserKeys.connections(scopeId) });

  const save = async () => {
    if (draft === null) return;
    if (hasIssues(issues)) { setAttempted(true); return; }
    setSaving(true);
    setFeedback(null);
    setFeedbackAt('form');
    setFlagOff(false);
    try {
      // The stored switch belongs to the list's box, not to this form: an edit
      // carries whatever the box last wrote rather than the value at open time.
      const input = parseBrowserInput(browserConnectionInput(isNewDraft(draft) ? draft : { ...draft, enabled: liveEnabled }));
      const id = draft.original?.id ?? draft.id.trim();
      const saved = await browserApi(client).upsert(id, input);
      // The draft becomes the server's own object, so a normalised field shows;
      // the row's state is re-read rather than carried over from before.
      await reload();
      setDraft(draftOf(saved.connection));
      setOutcome(null);
      pingSaved();
    } catch (error) {
      reportFailure(error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const connection = draft?.original;
    if (connection === undefined) return;
    setDeleting(true);
    setFeedback(null);
    setFeedbackAt('form');
    try {
      await browserApi(client).remove(connection.id);
      setConfirmingDelete(false);
      apply(null);
      await reload();
      setFeedback({ tone: 'success', text: t('st.browser.deleted', { name: connection.name }) });
    } catch (error) {
      setConfirmingDelete(false);
      reportFailure(error);
    } finally {
      setDeleting(false);
    }
  };

  const run = async (action: RuntimeAction, call: () => Promise<BrowserStatus>) => {
    setBusy(action);
    setFeedback(null);
    setFeedbackAt('runtime');
    setFlagOff(false);
    setOutcome(null);
    try {
      const status = await call();
      setOutcome({ action, status });
      // The list carries each connection's state, so re-read it instead of
      // patching a row from the answer.
      await reload();
    } catch (error) {
      reportFailure(error);
    } finally {
      setBusy(null);
    }
  };

  const currentCall = selectedStatus?.currentCall;

  /** Only an open draft has a branch; a closed card reads none of these words. */
  const runLabels = runtimeLabels(t, draft?.type ?? 'agent-browser-profile');

  /** What releasing this connection does to the browser itself. */
  const ownershipText = (ownership: BrowserOwnership | undefined, type: BrowserConnectionType): string =>
    type === 'kimi-webbridge' || type === 'webbridge-command' ? t('st.browser.disconnectMeaningWebbridge')
      : ownership === 'external-browser' ? t('st.browser.disconnectMeaningExternal')
        : ownership === 'managed-profile' ? t('st.browser.disconnectMeaningManaged')
          : t('st.browser.disconnectMeaningUnknown');

  const list = (
    <nav aria-label={t('st.browser.connectionsTitle')} className="min-w-0 space-y-2">
      {query.isLoading ? <p className="text-[13px] text-ink-faint" role="status">{t('st.browser.loading')}</p> : null}
      {query.isError ? <InlineError error={query.error} /> : null}
      {query.isSuccess && rows.length === 0 ? (
        <div data-browser-empty className="space-y-1.5 py-2">
          <p className="text-[13px] text-ink">{t('st.browser.emptyTitle')}</p>
          <Hint>{t('st.browser.emptyBody')}</Hint>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <ul className="divide-y divide-hairline/70" data-browser-list>
          {rows.map((row) => {
            const source = allowance.sourceOf(row);
            const sourceOn = allowance.sourceEnabled(source);
            const chosen = allowance.isChosen(row);
            const isDefault = defaultBrowser !== '' && defaultBrowser === row.id;
            const authUnknown = row.type === 'codex-extension' && codexPending.has(row.browserId ?? row.id);
            const selected = selectedId === row.id;
            return (
              <li key={row.id} data-browser-row={row.id} data-browser-row-allowed={allowance.isEffective(row) ? 'true' : 'false'}
                className={`flex min-w-0 items-start gap-2.5 py-2 pl-1 pr-1 ${selected ? 'bg-ink/[0.03]' : ''}`}>
                <input
                  type="checkbox"
                  className="mt-[3px] h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-hairline-strong text-selected-ink focus:ring-0 disabled:cursor-not-allowed"
                  data-browser-allow-checkbox={row.id}
                  aria-label={t('st.browser.row.allow', { name: row.name })}
                  checked={chosen}
                  disabled={rowBusy || !sourceOn}
                  onChange={(event) => { void toggleAllowed(row, event.target.checked); }}
                />
                <button type="button" data-browser-connection={row.id}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => { open(draftOf(row)); }}
                  className="group min-w-0 flex-1 text-left outline-none focus-visible:underline">
                  <span className="flex w-full min-w-0 items-baseline gap-2">
                    <span className="min-w-0 truncate text-[13px] text-ink group-hover:underline group-hover:underline-offset-2" title={row.name}>{row.name}</span>
                    {row.name === row.id ? null : <span className="min-w-0 shrink truncate font-mono text-[11px] text-ink-faint">{row.id}</span>}
                    <span className="ml-auto flex shrink-0 items-center gap-1.5">
                      {row.status.currentCall === undefined ? null : <Tag tone="accent">{t('st.browser.currentControl')}</Tag>}
                      {authUnknown ? (
                        <span data-browser-status-tag="auth_unknown"><Tag tone="warn">{t('st.browser.status.authUnknown')}</Tag></span>
                      ) : null}
                      <BrowserStateMark state={row.enabled ? row.status.state : 'disabled'} />
                      {isDefault ? <span data-browser-default-tag={row.id}><Tag tone="accent">{t('st.browser.defaultActive')}</Tag></span> : null}
                    </span>
                  </span>
                  <span className="mt-0.5 flex w-full min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12px] text-ink-faint">
                    <span className="shrink-0" data-browser-row-type={row.type}>{typeLabel(t, row.type)}</span>
                    <span aria-hidden>·</span>
                    <span className="min-w-0 max-w-full truncate" title={locationLabel(t, row)}
                      data-browser-identity={row.type === 'codex-extension' ? (row.browserId ?? row.id) : undefined}>
                      {locationLabel(t, row)}
                    </span>
                    {source === undefined || sourceOn ? null : (
                      <>
                        <span aria-hidden>·</span>
                        <span className="shrink-0 text-amber-ink" data-browser-source-tag={source}>
                          {t('st.browser.row.sourceOff', { source: sourceName(source) })}
                        </span>
                      </>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <FeedbackLine feedback={rowFeedback} />
    </nav>
  );

  /** An issue is shown once the field has something in it, or once Save was pressed. */
  const issueText = (field: keyof typeof issues, hasContent: boolean): string | null => {
    const key = issues[field];
    return key !== undefined && (attempted || hasContent) ? t(key) : null;
  };

  const detail = draft === null ? null : (
    <div className="min-w-0 space-y-4" data-browser-detail={draft.original?.id ?? 'new'}>
      <BackRow label={t('st.browser.connectionsTitle')} onBack={() => { open(null); }} />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-medium text-ink" data-browser-detail-name>
            {draft.name.trim() === '' ? t('st.browser.newTitle') : draft.name}
          </h3>
          <p className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-ink-faint">
            <span className="font-mono">{isNewDraft(draft) ? t('st.browser.idPending') : draft.id}</span>
            <span>{typeLabel(t, draft.type)}</span>
            {/* The location that differs: for a profile it is the server Kiki
                drives; for CDP the machine the endpoint names. The bridge has no
                address at all, so it shows the server whose daemon runs it. */}
            {selectedStatus === undefined ? null : (
              <span className="min-w-0 break-all font-mono" data-browser-execution-host>
                {draft.type === 'agent-browser-cdp'
                  ? endpointHost(draft.original?.endpointDisplay) ?? t('st.browser.location.unknown')
                  : selectedStatus.executionHost}
              </span>
            )}
          </p>
        </div>
        {isNewDraft(draft) ? null : (
          <div className="flex shrink-0 items-center gap-2.5">
            {selectedRow === undefined ? null : (
              <span data-browser-detail-allowed={allowance.isEffective(selectedRow) ? 'true' : 'false'}>
                <Tag tone={allowance.isEffective(selectedRow) ? 'accent' : 'faint'}>
                  {t(allowance.isEffective(selectedRow) ? 'st.browser.status.allowed' : 'st.browser.state.disabled')}
                </Tag>
              </span>
            )}
            <button type="button" className={DANGER_GHOST_BUTTON} data-browser-delete
              disabled={deleting || saving}
              onClick={() => { setConfirmingDelete(true); }}>
              {t('st.browser.delete')}
            </button>
          </div>
        )}
      </div>

      {isNewDraft(draft) ? <Hint>{t('st.browser.createHint')}</Hint> : null}

      {isNewDraft(draft) || selectedStatus === undefined ? null : (
        <div className="space-y-2 border-t border-hairline pt-4" data-browser-runtime>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <BrowserStateMark state={liveEnabled ? selectedStatus.state : 'disabled'} />
            {selectedStatus.driverVersion === undefined ? null : (
              <span className="text-[11px] text-ink-faint" data-browser-driver-line>
                {t('st.browser.driverLine', { version: selectedStatus.driverVersion })}
              </span>
            )}
            {selectedStatus.checkedAt === undefined ? null : (
              <span className="text-[11px] text-ink-faint">{t('st.browser.checkedAt', { at: whenText(locale, selectedStatus.checkedAt) ?? '' })}</span>
            )}
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <button type="button" className={SECONDARY_BUTTON} data-browser-check
                disabled={busy !== null || saving || dirty || !liveEnabled}
                title={runLabels.checkHint}
                onClick={() => { void run('check', () => browserApi(client).check(draft.id)); }}>
                {busy === 'check' ? t('st.browser.checking') : runLabels.check}
              </button>
              <button type="button" className={SECONDARY_BUTTON} data-browser-connect
                disabled={busy !== null || saving || dirty || !liveEnabled || LIVE_BLOCKING_CONNECT.has(selectedStatus.state)}
                onClick={() => { void run('connect', () => browserApi(client).connect(draft.id)); }}>
                {busy === 'connect' ? t('st.browser.connecting') : runLabels.connect}
              </button>
              {LIVE_STATES.has(selectedStatus.state) ? (
                // Releasing uses the connection as it is saved, not the form:
                // an edited draft is not a reason to keep someone holding a
                // running browser. Only this action's own flight, a save that
                // would end the session anyway, or an open delete stops it.
                <button type="button" className={SECONDARY_BUTTON} data-browser-disconnect
                  disabled={busy !== null || saving || deleting}
                  title={t('st.browser.disconnectHint')}
                  onClick={() => { void run('disconnect', () => browserApi(client).disconnect(draft.id)); }}>
                  {busy === 'disconnect' ? t('st.browser.disconnecting') : t('st.browser.disconnect')}
                </button>
              ) : null}
            </span>
          </div>

          {/* What the last action did, then the state's own reason once. */}
          {outcome === null ? null : (
            <div className="space-y-1.5" data-browser-outcome={`${outcome.action}:${outcome.status.state}`}>
              <p role="status" className={`text-[12px] ${outcome.status.state === 'failed' || outcome.status.state === 'unconfirmed' ? 'text-danger' : 'text-ink-soft'}`}>
                {outcomeText(t, outcome.action, outcome.status, draft.type)}
                {whenText(locale, outcome.status.checkedAt) === undefined ? '' : ` · ${whenText(locale, outcome.status.checkedAt)}`}
              </p>
              {outcome.action !== 'disconnect' || outcome.status.error !== undefined ? null : (
                <p className="max-w-[62ch] text-[12px] text-ink-faint">{ownershipText(outcome.status.ownership, draft.type)}</p>
              )}
              {outcome.status.error === undefined || outcome.status.error === selectedStatus.error ? null : (
                <p className="max-w-[72ch] break-words text-[12px] text-danger">{outcome.status.error}</p>
              )}
            </div>
          )}

          {/* The state's own reason, exactly once: the outcome above carries the
              same sentence only when it is news. */}
          {selectedStatus.error === undefined ? null : (
            <p role="alert" data-browser-error className="max-w-[72ch] break-words text-[12px] leading-[18px] text-danger">
              {selectedStatus.error}
            </p>
          )}
          {currentCall === undefined ? null : (
            <p className="text-[12px] text-ink-soft" data-browser-caller>
              {t('st.browser.callerLine', { session: currentCall.sessionId, agent: currentCall.agentId, tool: currentCall.tool })}
            </p>
          )}
          {selectedStatus.state === 'unconfirmed' ? <Hint>{t('st.browser.state.unconfirmedHint')}</Hint> : null}
          {liveEnabled ? null : <Hint>{t('st.browser.disabledHint')}</Hint>}
          {dirty ? <Hint>{t('st.browser.dirtyRuntimeHint')}</Hint> : null}
          {/* What releasing this connection does to the browser itself, shown
              whenever there is something live to release — including under an
              edited draft, because that is when the enabled Disconnect button
              next to two disabled ones needs its own explanation. */}
          {LIVE_STATES.has(selectedStatus.state) ? <Hint>{ownershipText(selectedStatus.ownership, draft.type)}</Hint> : null}
          {/* What checking really does, while pressing it is still a decision. */}
          {dirty || LIVE_STATES.has(selectedStatus.state) ? null : <Hint>{runLabels.checkHint}</Hint>}
          {dirty && LIVE_STATES.has(selectedStatus.state) ? <Hint>{t('st.browser.saveEndsSession')}</Hint> : null}

          <BrowserRuntimeDetails id={draft.id} type={draft.type} status={selectedStatus} />
          {feedbackAt === 'runtime' ? <FeedbackLine feedback={feedback} /> : null}
          {/* The refusal names the flag; this is the same trip the SSH page
              offers, to the rows that hold it. */}
          {flagOff ? (
            <button type="button" className={SECONDARY_BUTTON} data-browser-open-flag
              onClick={() => { void navigate(NATIVE_BROWSER_FLAG_TRIP); }}>
              {t('st.browser.flagOffAction')}
            </button>
          ) : null}
        </div>
      )}

      <fieldset disabled={saving || deleting} className="min-w-0 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {isNewDraft(draft) ? (
            <DraftField id="browser-id" label={t('st.browser.fieldId')} mono placeholder="research" dataAttr="data-browser-id-input"
              value={draft.id} issue={issueText('id', draft.id.trim() !== '')} hint={t('st.browser.fieldIdHint')}
              onChange={(id) => { setDraft({ ...draft, id }); }} />
          ) : null}
          <DraftField id="browser-name" label={t('st.browser.fieldName')} dataAttr="data-browser-name-input"
            value={draft.name} issue={issueText('name', draft.name.trim() !== '')}
            onChange={(name) => { setDraft({ ...draft, name }); }} />
          <div className="space-y-1.5">
            <span className={FORM_LABEL} id="browser-type-label">{t('st.browser.fieldType')}</span>
            <SettingsSelect<BrowserConnectionType> id="browser-type" variant="form"
              ariaLabel={t('st.browser.fieldType')} value={draft.type} dataAttr="data-browser-type"
              choices={typeChoices(t, draft.original)}
              onChange={(type) => { setDraft({ ...draft, type }); }} />
          </div>
        </div>

        {draft.original !== undefined && draft.original.type !== draft.type ? <Hint>{t('st.browser.typeChangeHint')}</Hint> : null}

        {draft.type === 'codex-extension' ? (
          <dl className="space-y-2 text-[12px]" data-browser-official-binding>
            <dt className={FORM_LABEL}>{t('st.browser.runtimeRoot')}</dt><dd className="break-all font-mono text-ink-soft">{draft.original?.runtimeRoot}</dd>
            <dt className={FORM_LABEL}>{t('st.browser.browserId')}</dt><dd className="break-all font-mono text-ink-soft">{draft.original?.browserId}</dd>
          </dl>
        ) : draft.type === 'ego-lite' ? (
          <AdvancedDetails summary={t('st.browser.advanced')} data-browser-advanced>
            <div className="space-y-3">
              <DraftField id="browser-cli-path" label={t('st.browser.fieldCliPath')} mono dataAttr="data-browser-cli-input"
                value={draft.cliPath} issue={issueText('cliPath', draft.cliPath.trim() !== '')}
                hint={t('st.browser.fieldCliPathHint')}
                onChange={(cliPath) => { setDraft({ ...draft, cliPath }); }} />
              <DraftField id="browser-profile-id" label={t('st.browser.fieldProfileId')} dataAttr="data-browser-profile-id-input"
                value={draft.profileId} issue={null} hint={t('st.browser.fieldProfileIdHint')}
                onChange={(profileId) => { setDraft({ ...draft, profileId }); }} />
              <DraftField id="browser-server-name" label={t('st.browser.fieldServerName')} dataAttr="data-browser-server-name-input"
                value={draft.serverName} issue={null} hint={t('st.browser.fieldServerNameHint')}
                onChange={(serverName) => { setDraft({ ...draft, serverName }); }} />
            </div>
          </AdvancedDetails>
        ) : draft.type === 'agent-browser-profile' ? (
          <div className="space-y-4">
            <div className="space-y-1" data-browser-headed>
              <Toggle label={t('st.browser.fieldHeaded')} checked={draft.headed}
                onChange={(headed) => { setDraft({ ...draft, headed }); }} />
              <Hint>{t('st.browser.fieldHeadedHint')}</Hint>
            </div>
            <DraftField id="browser-profile-path" label={t('st.browser.fieldProfilePath')} mono dataAttr="data-browser-profile-input"
              value={draft.profilePath} issue={issueText('profilePath', draft.profilePath.trim() !== '')}
              placeholder={t('st.browser.profilePlaceholder')}
              hint={t('st.browser.fieldProfilePathHint')}
              onChange={(profilePath) => { setDraft({ ...draft, profilePath }); }} />
            <AdvancedDetails summary={t('st.browser.advanced')} data-browser-advanced>
              <div className="space-y-3">
                <DraftField id="browser-executable-path" label={t('st.browser.fieldExecutablePath')} mono dataAttr="data-browser-executable-input"
                  value={draft.executablePath} issue={issueText('executablePath', draft.executablePath.trim() !== '')}
                  hint={t('st.browser.fieldExecutablePathHint')}
                  onChange={(executablePath) => { setDraft({ ...draft, executablePath }); }} />
                <DraftField id="browser-driver-path" label={t('st.browser.fieldDriverPath')} mono dataAttr="data-browser-driver-input"
                  value={draft.driverPath} issue={issueText('driverPath', draft.driverPath.trim() !== '')}
                  placeholder={t('st.browser.driverPlaceholder')}
                  hint={t('st.browser.fieldDriverPathHint', { version: AGENT_BROWSER_VERSION, markers: AGENT_BROWSER_MARKERS })}
                  onChange={(driverPath) => { setDraft({ ...draft, driverPath }); }} />
              </div>
            </AdvancedDetails>
          </div>
        ) : draft.type === 'kimi-webbridge' || draft.type === 'webbridge-command' ? (
          <div data-browser-bridge>
            <Hint>{t('st.browser.bridgeHint')}</Hint>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <SecretField label={t('st.browser.fieldEndpoint')} source={draft.original?.endpointConfigured === true ? 'kiki' : 'none'}
                draft={draft.endpoint} clearable={false}
                reveal={draft.original === undefined
                  ? undefined
                  : async () => (await client.revealSecret({ kind: 'browser_endpoint', browser_id: draft.original!.id })).value}
                onChange={(endpoint) => { setDraft({ ...draft, endpoint }); }}
                sourceText={draft.original?.endpointConfigured === true ? t('st.browser.endpointSource') : undefined}
                hint={t('st.browser.fieldEndpointHint')} />
              {draft.original?.endpointDisplay === undefined ? null : (
                <p className="font-mono text-[11px] text-ink-faint" data-browser-endpoint-host>
                  {t('st.browser.endpointHostLine', { host: endpointHost(draft.original.endpointDisplay) ?? draft.original.endpointDisplay })}
                </p>
              )}
              <FieldIssue id="browser-endpoint-issue" text={issueText('endpoint', draft.endpoint.mode === 'set')} />
            </div>
            <AdvancedDetails summary={t('st.browser.advanced')} data-browser-advanced>
              <DraftField id="browser-driver-path" label={t('st.browser.fieldDriverPath')} mono dataAttr="data-browser-driver-input"
                value={draft.driverPath} issue={issueText('driverPath', draft.driverPath.trim() !== '')}
                placeholder={t('st.browser.driverPlaceholder')}
                hint={t('st.browser.fieldDriverPathHint', { version: AGENT_BROWSER_VERSION, markers: AGENT_BROWSER_MARKERS })}
                onChange={(driverPath) => { setDraft({ ...draft, driverPath }); }} />
            </AdvancedDetails>
          </div>
        )}

      </fieldset>

      {feedbackAt === 'form' || isNewDraft(draft) ? <FeedbackLine feedback={feedback} /> : null}

      <SettingsDraftFooter id={editorId} dirty={dirty} saving={saving} saved={justSaved}
        saveLabel={isNewDraft(draft) ? t('st.browser.create') : t('st.browser.save')}
        persistent={isNewDraft(draft)}
        onSave={() => { void save(); }}
        // Discard is the person answering the question already; asking again
        // through the guard would be a second confirmation for one decision.
        onDiscard={() => { apply(draft.original === undefined ? null : draftOf(draft.original)); }} />

      <ConfirmDialog open={confirmingDelete} overlayId="confirm-browser-delete" busy={deleting}
        title={t('st.browser.deleteTitle', { name: draft.original?.name ?? '' })}
        body={t('st.browser.deleteBody')}
        consequences={[
          t(deleteConsequenceKey(draft.type)),
          ...(selectedStatus !== undefined && LIVE_STATES.has(selectedStatus.state) ? [t('st.browser.deleteEndsSession')] : []),
          ...(query.data?.defaultBrowser === draft.original?.id ? [t('st.browser.deleteDefault')] : []),
        ]}
        confirmLabel={t('st.browser.delete')}
        onCancel={() => { setConfirmingDelete(false); }}
        onConfirm={() => { void remove(); }} />
    </div>
  );

  const empty = query.isSuccess && rows.length === 0;

  const addView = (
    <div className="min-w-0 space-y-4" data-browser-add-view>
      <BackRow label={t('st.browser.connectionsTitle')} onBack={() => { setAdding(false); }} />
      <h3 className="text-[15px] font-medium text-ink">{t('st.browser.add')}</h3>
      <BrowserSetupWizard />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-hairline pt-3.5" data-browser-add-manual-row>
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-ink">{t('st.browser.addManual')}</p>
          <p className="mt-0.5 text-[12.5px] text-ink-soft">{t('st.browser.addManualHint')}</p>
        </div>
        <button type="button" className={SECONDARY_BUTTON} data-browser-add-manual
          onClick={() => { open(newBrowserDraft()); }}>
          {t('st.browser.addManual')}
        </button>
      </div>
      <div className="space-y-1.5">
        <OtherBrowserEcosystems />
        <Hint>{t('st.browser.modelNotice')}</Hint>
      </div>
    </div>
  );

  const listView = (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="mr-auto min-w-0">
          {empty || query.isError ? null : (
            <DefaultSelect allowance={allowance} save={defaultSave} />
          )}
        </div>
        <button type="button" className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`} data-browser-add
          disabled={saving || deleting}
          onClick={() => { setAdding(true); }}>
          <Icon name="plus" size={12} />
          {t('st.browser.add')}
        </button>
      </div>
      {list}
      <FeedbackLine feedback={feedback} />
      <SourcesFold defaultOpen={empty} />
    </div>
  );

  return (
    <div className="min-w-0" data-browser-connections data-browser-view={draft !== null ? 'detail' : adding ? 'add' : 'list'}>
      {draft !== null ? detail : adding ? addView : listView}
    </div>
  );
}

/** The back row of a view that replaced the list. */
function BackRow({ label, onBack }: { readonly label: string; readonly onBack: () => void }) {
  return (
    <button type="button" data-browser-back
      className="inline-flex items-center gap-1 rounded text-[12px] text-ink-soft transition-colors hover:text-ink focus-visible:underline"
      onClick={onBack}>
      <Icon name="arrowLeft" size={12} />{label}
    </button>
  );
}

/**
 * The one place the default is chosen. The select lists the allowed
 * connections plus the current default whatever its state; picking one never
 * allows it, and "choose each time" clears it.
 */
function DefaultSelect({ allowance, save }: {
  readonly allowance: ReturnType<typeof useBrowserAllowance>;
  readonly save: ReturnType<typeof useInstantSave>;
}) {
  const { t } = useI18n();
  const flashId = useContext(SettingsFlashContext);
  const onCardMount = useContext(SettingsCardMountContext);
  useEffect(() => { onCardMount?.('st-card-browser-default'); }, [onCardMount]);
  const { connections, defaultBrowser, connectionsQuery } = allowance;
  const choices = useMemo(() => [
    { value: '', label: t('st.browser.defaultNone'), hint: t('st.browser.defaultNoneHint') },
    ...connections
      .filter((connection) => connection.enabled || connection.id === defaultBrowser)
      .map((connection) => ({
        value: connection.id,
        label: connection.name,
        hint: connection.enabled ? connection.id : `${connection.id} · ${t('st.browser.state.disabled')}`,
      })),
  ], [connections, defaultBrowser, t]);
  return (
    <div
      className={`space-y-1.5 scroll-mt-4 ${flashId === 'st-card-browser-default' ? 'settings-card-flash' : ''}`}
      id="st-card-browser-default"
      data-settings-card="st-card-browser-default"
    >
      <span className="flex flex-wrap items-center gap-2 text-[12px] text-ink-soft">
        <span id="browser-default-label">{t('st.browser.defaultLabel')}</span>
        <SettingsSelect
          id="browser-default"
          ariaLabel={t('st.browser.defaultLabel')}
          dataAttr="data-browser-default"
          value={defaultBrowser}
          choices={choices}
          disabled={save.saving || connectionsQuery.isLoading}
          onChange={(next) => { void save.run(() => allowance.writeDefault(next, next === '')); }}
          variant="row"
        />
        <SaveStatus saving={save.saving} saved={save.saved} />
      </span>
      <FeedbackLine feedback={save.error} />
    </div>
  );
}

/**
 * The sources, folded under the list for management: each one's switch, the
 * preparation and the checks. A search hit on the old setup card opens it.
 */
function SourcesFold({ defaultOpen }: { readonly defaultOpen: boolean }) {
  const { t } = useI18n();
  const flashId = useContext(SettingsFlashContext);
  const onCardMount = useContext(SettingsCardMountContext);
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    onCardMount?.('st-card-browser-setup');
    onCardMount?.('st-card-webbridge');
  }, [onCardMount]);
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);
  useEffect(() => {
    if (flashId === 'st-card-browser-setup' || flashId === 'st-card-webbridge') setOpen(true);
  }, [flashId]);
  return (
    <details
      id="st-card-browser-setup"
      data-settings-card="st-card-browser-setup"
      data-browser-sources
      open={open}
      onToggle={(event) => { setOpen((event.currentTarget as HTMLDetailsElement).open); }}
      className={`scroll-mt-4 border-t border-hairline pt-3 ${flashId === 'st-card-browser-setup' ? 'settings-card-flash' : ''}`}
    >
      <summary className="cursor-pointer select-none text-[13px] text-ink-soft hover:text-ink">
        {t('st.browser.setup.title')}
      </summary>
      <div className="pt-3">
        {open ? <BrowserSetupWizard /> : null}
      </div>
    </details>
  );
}

/** What the last runtime action actually did, in the status it answered with. */
function outcomeText(t: ReturnType<typeof useI18n>['t'], action: RuntimeAction, status: BrowserStatus, type: BrowserConnectionType): string {
  if (status.state === 'failed') return t('st.browser.outcome.failed');
  if (status.state === 'unconfirmed') return t('st.browser.outcome.unconfirmed');
  // The bridge reports its own version; calling it a driver would name a component it does not use.
  if (action === 'check') {
    const version = status.driverVersion ?? t('st.browser.detail.driverUnknown');
    return t(type === 'kimi-webbridge' ? 'st.browser.outcome.checkOkWebbridge' : 'st.browser.outcome.checkOk', { version });
  }
  if (action === 'connect') return status.state === 'ready' ? t('st.browser.outcome.connected') : t('st.browser.outcome.connectIncomplete');
  return status.state === 'disconnected' ? t('st.browser.outcome.disconnected') : t('st.browser.outcome.disconnectIncomplete');
}
