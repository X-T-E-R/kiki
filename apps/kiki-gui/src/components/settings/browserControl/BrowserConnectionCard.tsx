/**
 * 浏览器控制 → the connections themselves. A short list on the left, the
 * selected connection as a flat form on the right (one column under `md`, with
 * a back row), the way the SSH hosts and identity pages work.
 *
 * Three things stay apart on purpose:
 *
 *   config   name / id / type / enable / driver and profile paths or CDP
 *            endpoint — saved by the draft footer, never by a runtime action;
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

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { experimentalCardId, experimentalSectionForFlag } from '@kiki/session-core/settings';
import type { BrowserStatus } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import {
  AGENT_BROWSER_MARKERS, AGENT_BROWSER_VERSION, LIVE_STATES, browserApi, browserFailureOf, browserKeys, endpointHost,
  isFlagDisabled, whenText,
} from '../../../lib/browserRest';
import type { BrowserConnectionRow, BrowserConnectionType, BrowserOwnership } from '../../../lib/browserRest';
import { ConfirmDialog } from '../../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../../controls';
import { useDirtyGuard } from '../../dirtyGuard';
import { Icon } from '../../icons';
import { Tag } from '../../capabilities/primitives';
import { DANGER_GHOST_BUTTON, INPUT, SECONDARY_BUTTON } from '../../ui';
import { AdvancedDetails } from '../fields';
import { SecretField } from '../SecretField';
import { FieldIssue, FORM_LABEL, SettingsDetailLayout, SettingsDraftFooter, SettingsSelect } from '../SettingsPrimitives';
import { useSavedTick } from '../useSavedTick';
import { BrowserRuntimeDetails, BrowserStateMark, OtherBrowserEcosystems } from './BrowserBits';
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
  return t(type === 'agent-browser-cdp' ? 'st.browser.type.cdp' : 'st.browser.type.profile');
}

/**
 * Where the browser actually is: a role word for a connection Kiki drives on
 * its own server (the literal hostname belongs in the detail, not on every
 * row), and the endpoint's own host for a borrowed browser, which is the fact
 * that tells two CDP connections apart.
 */
function locationLabel(t: ReturnType<typeof useI18n>['t'], row: BrowserConnectionRow): string {
  if (row.type === 'agent-browser-profile') return t('st.browser.location.server');
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

  const query = useQuery({
    queryKey: browserKeys.connections(scopeId),
    queryFn: () => browserApi(client).list(),
    staleTime: 10_000,
  });
  const rows = query.data?.connections ?? [];

  const [draft, setDraft] = useState<BrowserDraft | null>(null);
  const [narrowPane, setNarrowPane] = useState<'list' | 'detail'>('list');
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<RuntimeAction | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
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

  const vanished = selectedId !== undefined && query.isSuccess && selectedRow === undefined;
  useEffect(() => {
    // Removed elsewhere: a clean draft has nothing to keep, an edited one stays
    // so the person can decide where to re-apply it.
    if (vanished && !dirty) { setDraft(null); setNarrowPane('list'); }
  }, [vanished, dirty]);

  /** Replace the open draft without asking: the caller already has an answer. */
  const apply = (next: BrowserDraft | null) => {
    setDraft(next);
    setNarrowPane(next === null ? 'list' : 'detail');
    setFeedback(null);
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
    setFlagOff(false);
    try {
      const input = parseBrowserInput(browserConnectionInput(draft));
      const id = draft.original?.id ?? draft.id.trim();
      const saved = await browserApi(client).upsert(id, input);
      // The draft becomes the server's own object, so a normalised field shows;
      // the row's state is re-read rather than carried over from before.
      setDraft(draftOf(saved.connection));
      setOutcome(null);
      pingSaved();
      await reload();
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

  const ownershipText = (ownership: BrowserOwnership | undefined): string =>
    ownership === 'external-browser' ? t('st.browser.disconnectMeaningExternal')
      : ownership === 'managed-profile' ? t('st.browser.disconnectMeaningManaged')
        : t('st.browser.disconnectMeaningUnknown');

  const list = (
    <nav aria-label={t('st.browser.connectionsTitle')} className="min-w-0 space-y-2">
      {query.isLoading ? <p className="text-[13px] text-ink-faint" role="status">{t('st.browser.loading')}</p> : null}
      {query.isError ? <InlineError error={query.error} /> : null}
      {query.isSuccess && rows.length === 0 ? (
        <div data-browser-empty className="space-y-1.5">
          <p className="text-[13px] text-ink">{t('st.browser.emptyTitle')}</p>
          <Hint>{t('st.browser.emptyBody')}</Hint>
        </div>
      ) : null}
      {rows.length > 0 ? (
        // A list with the editor closed is the whole card, so it keeps a
        // readable measure instead of stretching the state word to the far edge.
        <ul className="max-w-[30rem] space-y-0.5">
          {rows.map((row) => (
            <li key={row.id}>
              <button type="button" data-browser-connection={row.id}
                aria-current={selectedId === row.id ? 'true' : undefined}
                onClick={() => { open(draftOf(row)); }}
                className="row-interactive flex w-full min-w-0 flex-col items-start gap-0.5 py-1.5 pl-3 pr-2 text-left">
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={row.name}>{row.name}</span>
                  {row.status.currentCall === undefined ? null : <Tag tone="accent">{t('st.browser.currentControl')}</Tag>}
                </span>
                <span className="max-w-full truncate font-mono text-[11px] text-ink-faint">{row.id}</span>
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink-faint"
                    title={`${typeLabel(t, row.type)} · ${locationLabel(t, row)}`}>
                    {typeLabel(t, row.type)} · {locationLabel(t, row)}
                  </span>
                  <BrowserStateMark state={row.enabled ? row.status.state : 'disabled'} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </nav>
  );

  /** An issue is shown once the field has something in it, or once Save was pressed. */
  const issueText = (field: keyof typeof issues, hasContent: boolean): string | null => {
    const key = issues[field];
    return key !== undefined && (attempted || hasContent) ? t(key) : null;
  };

  const detail = draft === null ? null : (
    <div className="min-w-0 space-y-4" data-browser-detail={draft.original?.id ?? 'new'}>
      <button type="button" data-browser-back className={`${SECONDARY_BUTTON} md:hidden`} onClick={() => { open(null); }}>
        <span className="inline-flex items-center gap-1"><Icon name="arrowLeft" size={12} />{t('st.browser.connectionsTitle')}</span>
      </button>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-medium text-ink" data-browser-detail-name>
            {draft.name.trim() === '' ? t('st.browser.newTitle') : draft.name}
          </h3>
          <p className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-ink-faint">
            <span className="font-mono">{isNewDraft(draft) ? t('st.browser.idPending') : draft.id}</span>
            <span>{typeLabel(t, draft.type)}</span>
            {/* The location that differs: for a profile it is the server Kiki
                drives; for CDP the machine the endpoint names. */}
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
          <button type="button" className={DANGER_GHOST_BUTTON} data-browser-delete
            disabled={deleting || saving}
            onClick={() => { setConfirmingDelete(true); }}>
            {t('st.browser.delete')}
          </button>
        )}
      </div>

      {isNewDraft(draft) ? <Hint>{t('st.browser.createHint')}</Hint> : null}

      {isNewDraft(draft) || selectedStatus === undefined ? null : (
        <div className="space-y-2 border-t border-hairline pt-4" data-browser-runtime>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <BrowserStateMark state={draft.enabled ? selectedStatus.state : 'disabled'} />
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
                disabled={busy !== null || saving || dirty || !draft.enabled}
                title={t(draft.type === 'agent-browser-cdp' ? 'st.browser.checkHintCdp' : 'st.browser.checkHintProfile')}
                onClick={() => { void run('check', () => browserApi(client).check(draft.id)); }}>
                {busy === 'check' ? t('st.browser.checking')
                  : t(draft.type === 'agent-browser-cdp' ? 'st.browser.checkCdp' : 'st.browser.checkProfile')}
              </button>
              <button type="button" className={SECONDARY_BUTTON} data-browser-connect
                disabled={busy !== null || saving || dirty || !draft.enabled || LIVE_STATES.has(selectedStatus.state)}
                onClick={() => { void run('connect', () => browserApi(client).connect(draft.id)); }}>
                {busy === 'connect' ? t('st.browser.connecting')
                  : t(draft.type === 'agent-browser-cdp' ? 'st.browser.connectCdp' : 'st.browser.connectProfile')}
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
                {outcomeText(t, outcome.action, outcome.status)}
                {whenText(locale, outcome.status.checkedAt) === undefined ? '' : ` · ${whenText(locale, outcome.status.checkedAt)}`}
              </p>
              {outcome.action !== 'disconnect' || outcome.status.error !== undefined ? null : (
                <p className="max-w-[62ch] text-[12px] text-ink-faint">{ownershipText(outcome.status.ownership)}</p>
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
          {draft.enabled ? null : <Hint>{t('st.browser.disabledHint')}</Hint>}
          {dirty ? <Hint>{t('st.browser.dirtyRuntimeHint')}</Hint> : null}
          {/* What releasing this connection does to the browser itself, shown
              whenever there is something live to release — including under an
              edited draft, because that is when the enabled Disconnect button
              next to two disabled ones needs its own explanation. */}
          {LIVE_STATES.has(selectedStatus.state) ? <Hint>{ownershipText(selectedStatus.ownership)}</Hint> : null}
          {/* What checking really does, while pressing it is still a decision. */}
          {dirty || LIVE_STATES.has(selectedStatus.state) ? null : (
            <Hint>{t(draft.type === 'agent-browser-cdp' ? 'st.browser.checkHintCdp' : 'st.browser.checkHintProfile')}</Hint>
          )}
          {dirty && LIVE_STATES.has(selectedStatus.state) ? <Hint>{t('st.browser.saveEndsSession')}</Hint> : null}

          <BrowserRuntimeDetails id={draft.id} status={selectedStatus} />
          <FeedbackLine feedback={feedback} />
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
              choices={[
                { value: 'agent-browser-profile', label: t('st.browser.type.profileLong'), hint: t('st.browser.type.profileHint') },
                { value: 'agent-browser-cdp', label: t('st.browser.type.cdpLong'), hint: t('st.browser.type.cdpHint') },
              ]}
              onChange={(type) => { setDraft({ ...draft, type }); }} />
          </div>
          <div className="flex items-end pb-1">
            <Toggle label={t('st.browser.fieldEnabled')} checked={draft.enabled}
              onChange={(enabled) => { setDraft({ ...draft, enabled }); }} />
          </div>
        </div>

        {draft.original !== undefined && draft.original.type !== draft.type ? <Hint>{t('st.browser.typeChangeHint')}</Hint> : null}

        {draft.type === 'agent-browser-profile' ? (
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

      <FeedbackLine feedback={feedback} />

      <SettingsDraftFooter id={editorId} dirty={dirty} saving={saving} saved={justSaved}
        saveLabel={isNewDraft(draft) ? t('st.browser.create') : t('st.browser.save')}
        persistent={isNewDraft(draft)}
        onSave={() => { void save(); }}
        // Discard is the person answering the question already; asking again
        // through the guard would be a second confirmation for one decision.
        onDiscard={() => { apply(draft.original === undefined ? null : draftOf(draft.original)); }} />

      {/* Reference material for a new connection, after the commit row so the
          commit stays next to the fields it writes. */}
      {isNewDraft(draft) ? <OtherBrowserEcosystems /> : null}
      {isNewDraft(draft) ? <Hint>{t('st.browser.modelNotice')}</Hint> : null}

      <ConfirmDialog open={confirmingDelete} overlayId="confirm-browser-delete" busy={deleting}
        title={t('st.browser.deleteTitle', { name: draft.original?.name ?? '' })}
        body={t('st.browser.deleteBody')}
        consequences={[
          ...(draft.type === 'agent-browser-cdp' ? [t('st.browser.deleteConsequenceCdp')] : [t('st.browser.deleteConsequenceProfile')]),
          ...(selectedStatus !== undefined && LIVE_STATES.has(selectedStatus.state) ? [t('st.browser.deleteEndsSession')] : []),
          ...(query.data?.defaultBrowser === draft.original?.id ? [t('st.browser.deleteDefault')] : []),
        ]}
        confirmLabel={t('st.browser.delete')}
        onCancel={() => { setConfirmingDelete(false); }}
        onConfirm={() => { void remove(); }} />
    </div>
  );

  return (
    <div className="min-w-0 space-y-3" data-browser-connections>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="mr-auto max-w-[62ch] text-[13px] leading-5 text-ink-soft">{t('st.browser.intro')}</p>
        <button type="button" className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`} data-browser-add
          disabled={saving || deleting}
          onClick={() => { open(newBrowserDraft()); }}>
          <Icon name="plus" size={12} />
          {t('st.browser.add')}
        </button>
      </div>

      {detail === null
        ? list
        : <SettingsDetailLayout narrowPane={narrowPane} list={list} detail={detail} />}

      {draft === null ? <FeedbackLine feedback={feedback} /> : null}
    </div>
  );
}

/** What the last runtime action actually did, in the status it answered with. */
function outcomeText(t: ReturnType<typeof useI18n>['t'], action: RuntimeAction, status: BrowserStatus): string {
  if (status.state === 'failed') return t('st.browser.outcome.failed');
  if (status.state === 'unconfirmed') return t('st.browser.outcome.unconfirmed');
  if (action === 'check') return t('st.browser.outcome.checkOk', { version: status.driverVersion ?? t('st.browser.detail.driverUnknown') });
  if (action === 'connect') return status.state === 'ready' ? t('st.browser.outcome.connected') : t('st.browser.outcome.connectIncomplete');
  return status.state === 'disconnected' ? t('st.browser.outcome.disconnected') : t('st.browser.outcome.disconnectIncomplete');
}
