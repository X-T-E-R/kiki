/**
 * 浏览器控制 → the browsers themselves. Every saved connection is one row in
 * an accordion: the summary says its name, where it runs in plain words, a
 * status word with a dot, and a quiet tag on the default; pressing it opens
 * that connection's editor inline under the row — the list stays visible —
 * and never changes state. Every state change lives on an explicit control:
 * the row's 允许 switch, or the ⋯ menu's own items (设为默认, 检查, 连接或
 * 断开, 删除).
 *
 * Allowed and default are two separate facts, written from their own places:
 * the switch from the row, the default only from 设为默认, shown only by the
 * tag. A connection whose source is switched off keeps its stored allowance,
 * greyed, so turning the source back on restores exactly what was there.
 *
 * Three things stay apart in the form on purpose:
 *
 *   config   name / id / type / driver and profile paths or CDP endpoint —
 *            saved by the draft footer, never by a runtime action;
 *   runtime  check / connect / disconnect, which use the *saved* config and
 *            are therefore offered only while the draft is clean;
 *   state    the control service's own `status`, worded as the service words
 *            it and shown only when the service said something. No state is
 *            inferred here, and a connection that is not running is drawn as
 *            normal, not as a problem.
 *
 * The page itself never starts a driver or opens a browser: only a person
 * pressing check / connect does that.
 */

import { useContext, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import type { I18nKey } from '@kiki/session-core/i18n';
import { experimentalCardId, experimentalSectionForFlag, experimentalTabForSection, type BrowserSourceId } from '@kiki/session-core/settings';
import type { BrowserStatus } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import {
  AGENT_BROWSER_MARKERS, AGENT_BROWSER_VERSION, LIVE_BLOCKING_CONNECT, LIVE_STATES, browserApi, browserFailureOf, browserKeys, endpointHost,
  isFlagDisabled, whenText,
} from '../../../lib/browserRest';
import type { BrowserConnection, BrowserConnectionRow, BrowserConnectionType, BrowserOwnership } from '../../../lib/browserRest';
import { ConfirmDialog } from '../../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../../controls';
import { useDirtyGuard } from '../../dirtyGuard';
import { Icon } from '../../icons';
import { Tag } from '../../capabilities/primitives';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { AdvancedDetails } from '../fields';
import { RowFrame } from '../RowFrame';
import { SpaceRowMenu, type SpaceMenuItem } from '../spaces/SpaceRowMenu';
import { SecretField } from '../SecretField';
import { SettingsCardMountContext, SettingsFlashContext } from '../SectionCard';
import { FieldIssue, FORM_LABEL, SettingsDraftFooter, SettingsSelect } from '../SettingsPrimitives';
import { useSavedTick } from '../useSavedTick';
import { BrowserRuntimeDetails, BrowserStateMark } from './BrowserBits';
import { BrowserSetupWizard } from './BrowserSetupWizard';
import { AddBrowserPanel } from './AddBrowserPanel';
import { SOURCE_NAME_KEYS, useBrowserAllowance } from './browserAllowance';
import {
  browserConnectionInput, draftIssues, draftOf, hasIssues, isDirtyDraft, isNewDraft, newBrowserDraft, parseBrowserInput,
  type BrowserDraft,
} from './browserDraft';

type RuntimeAction = 'check' | 'connect' | 'disconnect';

/**
 * The section heading's 添加浏览器 button. The heading renders outside the
 * card, so the page holds the panel's open state and hands it to both.
 */
export function AddBrowserAction({ onOpen }: { readonly onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <button type="button" className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`} data-browser-add data-browser-add-heading
      onClick={onOpen}>
      <Icon name="plus" size={12} />
      {t('st.browser.add')}
    </button>
  );
}

/**
 * The development-candidate flag that gates a run
 * (`agent-core-v2/src/app/browser/flag.ts`; the flag row carries its own label).
 */
const NATIVE_BROWSER_FLAG = 'native_browser';

/**
 * Where that flag's row lives: the Experimental rows at the bottom of this
 * page's 浏览器 tab once it is re-homed here, read from the same registry so
 * the trip follows the registry rather than hardcoding a page. A tabbed home
 * carries its `?tab=`, the way the SSH page's own switch trip does.
 */
const NATIVE_BROWSER_FLAG_HOME = experimentalSectionForFlag(NATIVE_BROWSER_FLAG);
const NATIVE_BROWSER_FLAG_TAB = experimentalTabForSection(NATIVE_BROWSER_FLAG_HOME);
const NATIVE_BROWSER_FLAG_TRIP = `/settings/${NATIVE_BROWSER_FLAG_HOME}${NATIVE_BROWSER_FLAG_TAB === undefined ? '' : `?tab=${NATIVE_BROWSER_FLAG_TAB}`}#${experimentalCardId(NATIVE_BROWSER_FLAG_HOME)}`;

function typeLabel(t: ReturnType<typeof useI18n>['t'], type: BrowserConnectionType): string {
  if (type === 'ego-lite') return t('st.browser.type.ego-lite');
  if (type === 'kimi-webbridge' || type === 'webbridge-command') return t('st.browser.type.kimi-webbridge');
  return t(type === 'codex-extension' ? 'st.browser.type.codex-extension' : type === 'agent-browser-cdp' ? 'st.browser.type.cdp' : 'st.browser.type.profile');
}

/**
 * The styles this connection may be saved as.
 *
 * A record whose stored shape has no second reading keeps its own style as the
 * only choice: the extension's runtime root and pipe, Ego Lite's CLI fields,
 * and the bridge, which has no address at all. Those three are locks, not
 * routes — the Kimi route only probes the local bridge and never saves a
 * connection, so this picker is the one place a person creates a bridge
 * record. A profile or a CDP record may be switched to any of the three,
 * including to the bridge; that is an explicit choice on a saved id, never an
 * automatic rewrite.
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
 * What the two run actions are called on this branch, and what the check
 * really does. The words differ per type because the work does: a profile
 * starts the managed driver, a CDP connection tests a driver before attaching
 * to an address, Ego Lite runs its own check, and the bridge only asks its
 * local daemon whether the extension is there.
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
 * Where the browser actually is, in plain words: Kiki's own managed browser on
 * this server, the person's own browser reached through the bridge, or the
 * machine a CDP endpoint names — never the storage type id. An id this page
 * cannot place stays as the endpoint's own host.
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

/** One accordion row: summary + switch + ⋯, and the editor inline when open. */
function BrowserRow({ row, card }: { readonly row: BrowserConnectionRow; readonly card: BrowserCardHandle }) {
  const { t } = useI18n();
  const { allowance, codexPending } = card;
  const source = allowance.sourceOf(row);
  const sourceOn = allowance.sourceEnabled(source);
  const chosen = allowance.isChosen(row);
  const isDefault = card.defaultBrowser !== '' && card.defaultBrowser === row.id;
  const authUnknown = row.type === 'codex-extension' && codexPending.has(row.browserId ?? row.id);
  const open = card.selectedId === row.id;
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);

  const live = LIVE_STATES.has(row.status.state);
  const canRun = row.enabled !== false && !card.busyAction;
  const labels = runtimeLabels(t, row.type);

  const items: SpaceMenuItem[] = [
    {
      key: 'default',
      label: isDefault ? t('st.browser.menu.clearDefault') : t('st.browser.menu.setDefault'),
      run: () => { if (isDefault) card.onClearDefault(row); else card.onSetDefault(row); },
    },
    {
      key: 'check',
      label: labels.check,
      blockedReason: !canRun ? t('st.browser.menu.runBlocked') : undefined,
      run: () => { card.onCheck(row); },
    },
    live
      ? {
        key: 'disconnect',
        label: t('st.browser.disconnect'),
        blockedReason: !canRun ? t('st.browser.menu.runBlocked') : undefined,
        run: () => { card.onDisconnect(row); },
      }
      : {
        key: 'connect',
        label: labels.connect,
        blockedReason: !canRun || LIVE_BLOCKING_CONNECT.has(row.status.state) ? t('st.browser.menu.runBlocked') : undefined,
        run: () => { card.onConnect(row); },
      },
    { key: 'delete', label: t('st.browser.delete'), danger: true, separatorBefore: true, run: () => { card.onDelete(row); } },
  ];

  return (
    <RowFrame
      data={{
        'data-browser-row': row.id,
        'data-browser-row-allowed': allowance.isEffective(row) ? 'true' : 'false',
        'data-browser-source-off': source !== undefined && !sourceOn ? 'true' : undefined,
      }}
      open={open}
      onToggle={() => { card.onToggleRow(row); }}
      bodyId={`browser-row-body-${row.id}`}
      expandLabel={t('st.browser.menu.openRow', { name: row.name })}
      name={row.name}
      marks={(
        <span className="flex shrink-0 items-center gap-1.5">
          {row.status.currentCall === undefined ? null : <Tag tone="accent">{t('st.browser.currentControl')}</Tag>}
          {authUnknown ? <span data-browser-status-tag="auth_unknown"><Tag tone="warn">{t('st.browser.status.authUnknown')}</Tag></span> : null}
          <BrowserStateMark state={row.enabled ? row.status.state : 'disabled'} />
          {isDefault ? <span data-browser-default-tag={row.id}><Tag tone="accent">{t('st.browser.defaultActive')}</Tag></span> : null}
        </span>
      )}
      subtitle={(
        <>
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
                {t('st.browser.row.sourceOff', { source: card.sourceName(source) })}
              </span>
            </>
          )}
        </>
      )}
      control={(
        <>
          <span data-browser-allow-switch={row.id} className="contents">
            <Toggle
              layout="bare"
              label={t('st.browser.row.allow', { name: row.name })}
              checked={chosen}
              disabled={card.rowBusy || !sourceOn}
              onChange={(next) => { card.onToggleAllowed(row, next); }}
            />
          </span>
          <button
            ref={anchorRef}
            type="button"
            data-browser-row-menu-button={row.id}
            aria-label={t('st.browser.menu.open', { name: row.name })}
            aria-haspopup="menu"
            aria-expanded={menuRect !== null}
            onClick={() => { setMenuRect(anchorRef.current?.getBoundingClientRect() ?? null); }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink"
          >
            <Icon name="more" size={14} />
          </button>
          {menuRect !== null ? (
            <SpaceRowMenu
              anchor={menuRect}
              anchorElement={anchorRef.current}
              items={items}
              ariaLabel={t('st.browser.menu.open', { name: row.name })}
              onClose={() => { setMenuRect(null); }}
            />
          ) : null}
        </>
      )}
    >
      {open ? card.renderDetail() : null}
    </RowFrame>
  );
}

/** The pieces of the card a row needs; the card builds it once. */
export interface BrowserCardHandle {
  readonly allowance: ReturnType<typeof useBrowserAllowance>;
  readonly codexPending: ReadonlySet<string>;
  readonly defaultBrowser: string;
  readonly selectedId: string | undefined;
  readonly rowBusy: boolean;
  readonly busyAction: RuntimeAction | null;
  readonly sourceName: (source: BrowserSourceId) => string;
  readonly onToggleRow: (row: BrowserConnectionRow) => void;
  readonly onToggleAllowed: (row: BrowserConnectionRow, next: boolean) => void;
  readonly onSetDefault: (row: BrowserConnectionRow) => void;
  readonly onClearDefault: (row: BrowserConnectionRow) => void;
  readonly onCheck: (row: BrowserConnectionRow) => void;
  readonly onConnect: (row: BrowserConnectionRow) => void;
  readonly onDisconnect: (row: BrowserConnectionRow) => void;
  readonly onDelete: (row: BrowserConnectionRow) => void;
  readonly renderDetail: () => React.ReactNode;
}

export function BrowserConnectionCard({ adding, onAddingChange }: {
  /** The add panel is open; the page's heading button sets this. */
  readonly adding: boolean;
  readonly onAddingChange: (open: boolean) => void;
}) {
  const { client, scopeId } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const guard = useDirtyGuard();
  const allowance = useBrowserAllowance();

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
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<RuntimeAction | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  /** Where the last feedback belongs: beside the run actions, or beside the save row. */
  const [feedbackAt, setFeedbackAt] = useState<'runtime' | 'form'>('form');
  /** Set when the run was refused by the development-candidate flag, not by the config. */
  const [flagOff, setFlagOff] = useState(false);
  const [outcome, setOutcome] = useState<{ readonly action: RuntimeAction; readonly status: BrowserStatus } | null>(null);
  const [justSaved, pingSaved] = useSavedTick();
  /** The row whose deletion is being confirmed, kept apart from the open draft. */
  const [deleteTarget, setDeleteTarget] = useState<BrowserConnectionRow | null>(null);

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
      // A new connection now has its own row: the panel that made it closes
      // and the row stays open where the person can see it.
      if (isNewDraft(draft)) onAddingChange(false);
    } catch (error) {
      reportFailure(error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const connection = deleteTarget;
    if (connection === null) return;
    setDeleting(true);
    setFeedback(null);
    setFeedbackAt('form');
    try {
      await browserApi(client).remove(connection.id);
      setDeleteTarget(null);
      // Deleting the open row closes its editor; the list keeps the rest open.
      if (draft?.original?.id === connection.id) apply(null);
      await reload();
      setFeedback({ tone: 'success', text: t('st.browser.deleted', { name: connection.name }) });
    } catch (error) {
      setDeleteTarget(null);
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

  /** An issue is shown once the field has something in it, or once Save was pressed. */
  const issueText = (field: keyof typeof issues, hasContent: boolean): string | null => {
    const key = issues[field];
    return key !== undefined && (attempted || hasContent) ? t(key) : null;
  };

  /** The editor an open row expands inline under itself: a continuation of the
   *  row, not a second card — no repeated name or id header (the row above
   *  says both), no allow tag (the row's own switch does), and no delete
   *  button (deletion lives only in the ⋯ menu). A new draft keeps one quiet
   *  title, since it has no row to speak for it yet. */
  const renderDetail = (): React.ReactNode => {
    if (draft === null) return null;
    return (
      <div className="min-w-0 space-y-4" data-browser-detail={draft.original?.id ?? 'new'}>
        {isNewDraft(draft) || selectedStatus === undefined ? null : (
          <div className="space-y-2" data-browser-runtime>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <BrowserStateMark state={liveEnabled ? selectedStatus.state : 'disabled'} />
              {selectedStatus.driverVersion === undefined ? null : (
                <span className="text-[11px] text-ink-faint" data-browser-driver-line>
                  {t('st.browser.driverLine', { version: selectedStatus.driverVersion })}
                </span>
              )}
              {/* Where the run happens, in plain words — the fact the old id
                  header line carried. */}
              <span className="min-w-0 break-all text-[11px] text-ink-faint" data-browser-execution-host>
                {draft.type === 'agent-browser-cdp'
                  ? endpointHost(draft.original?.endpointDisplay) ?? t('st.browser.location.unknown')
                  : selectedStatus.executionHost}
              </span>
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
                  <button type="button" className={SECONDARY_BUTTON} data-browser-disconnect
                    disabled={busy !== null || saving || deleting}
                    title={t('st.browser.disconnectHint')}
                    onClick={() => { void run('disconnect', () => browserApi(client).disconnect(draft.id)); }}>
                    {busy === 'disconnect' ? t('st.browser.disconnecting') : t('st.browser.disconnect')}
                  </button>
                ) : null}
              </span>
            </div>

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
            {LIVE_STATES.has(selectedStatus.state) ? <Hint>{ownershipText(selectedStatus.ownership, draft.type)}</Hint> : null}
            {dirty || LIVE_STATES.has(selectedStatus.state) ? null : <Hint>{runLabels.checkHint}</Hint>}
            {dirty && LIVE_STATES.has(selectedStatus.state) ? <Hint>{t('st.browser.saveEndsSession')}</Hint> : null}

            <BrowserRuntimeDetails id={draft.id} type={draft.type} status={selectedStatus} />
            {feedbackAt === 'runtime' ? <FeedbackLine feedback={feedback} /> : null}
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
              {/* Where the address comes from, above the field that asks for it. */}
              <ol className="max-w-[62ch] list-decimal space-y-0.5 pl-4 text-[12px] leading-[18px] text-ink-soft marker:text-ink-faint" data-browser-cdp-steps>
                <li>{t('st.browser.cdpSteps.1')}</li>
                <li>{t('st.browser.cdpSteps.2')}</li>
              </ol>
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
      </div>
    );
  };

  /** A row's open summary only expands it; the actions a ⋯ item asks for run
   *  against the saved record, never against a half-typed draft. */
  const card: BrowserCardHandle = {
    allowance,
    codexPending,
    defaultBrowser,
    selectedId,
    rowBusy,
    busyAction: busy,
    sourceName,
    onToggleRow: (row) => {
      // Clicking a row only ever opens or closes its editor; the guard's own
      // ask keeps an edited draft from being replaced silently.
      if (selectedId === row.id) open(null);
      else open(draftOf(row));
    },
    onToggleAllowed: (row, next) => { void toggleAllowed(row, next); },
    onSetDefault: (row) => { void rowWrite(() => allowance.writeDefault(row.id, false)); },
    onClearDefault: (row) => { void rowWrite(() => allowance.writeDefault(row.id, true)); },
    onCheck: (row) => { void run('check', () => browserApi(client).check(row.id)); },
    onConnect: (row) => { void run('connect', () => browserApi(client).connect(row.id)); },
    onDisconnect: (row) => { void run('disconnect', () => browserApi(client).disconnect(row.id)); },
    onDelete: (row) => { setDeleteTarget(row); },
    renderDetail,
  };

  const empty = query.isSuccess && rows.length === 0;

  const newDraft = draft !== null && isNewDraft(draft);
  const closeAdd = () => {
    const finish = () => { if (newDraft) apply(null); onAddingChange(false); };
    if (newDraft && dirty && guard?.confirmDiscard !== undefined) { guard.confirmDiscard(editorId, finish); return; }
    finish();
  };

  return (
    <div className="min-w-0" data-browser-connections data-browser-view={adding ? 'add' : 'list'}>
      <div className="min-w-0 space-y-3">
        <div aria-label={t('st.browser.connectionsTitle')} className="min-w-0">
          {query.isLoading ? <p className="text-[13px] text-ink-faint" role="status">{t('st.browser.loading')}</p> : null}
          {query.isError ? <InlineError error={query.error} /> : null}
          {empty ? (
            <div data-browser-empty className="space-y-2.5 py-2">
              <p className="text-[13px] text-ink">{t('st.browser.emptyTitle')}</p>
              <Hint>{t('st.browser.emptyBody')}</Hint>
              <button type="button" className={PRIMARY_BUTTON} data-browser-empty-add onClick={() => { onAddingChange(true); }}>
                {t('st.browser.add')}
              </button>
            </div>
          ) : null}
          {rows.length > 0 ? (
            <div className="divide-y divide-hairline/70" data-browser-list>
              {rows.map((row) => (
                <BrowserRow key={row.id} row={row} card={card} />
              ))}
            </div>
          ) : null}
          <FeedbackLine feedback={rowFeedback} />
        </div>
        {newDraft ? null : <FeedbackLine feedback={feedback} />}
        <SourcesFold />
      </div>
      {adding ? (
        <AddBrowserPanel
          onClose={closeAdd}
          onManual={() => { if (!newDraft) apply(newBrowserDraft()); }}
          manualForm={newDraft ? renderDetail() : null}
        />
      ) : null}
      {deleteTarget !== null ? (
        <ConfirmDialog open overlayId="confirm-browser-delete" busy={deleting}
          title={t('st.browser.deleteTitle', { name: deleteTarget.name })}
          body={t('st.browser.deleteBody')}
          consequences={[
            t(deleteConsequenceKey(deleteTarget.type)),
            ...(LIVE_STATES.has(deleteTarget.status.state) ? [t('st.browser.deleteEndsSession')] : []),
            ...(defaultBrowser === deleteTarget.id ? [t('st.browser.deleteDefault')] : []),
          ]}
          confirmLabel={t('st.browser.delete')}
          onCancel={() => { setDeleteTarget(null); }}
          onConfirm={() => { void remove(); }} />
      ) : null}
    </div>
  );
}

/**
 * The sources, folded under the list for management: the shared chevron fold,
 * and each source inside is one row of its own (name, status word, switch)
 * that opens its setup inline. A search hit on the old setup card opens the
 * fold; a hit on the bridge opens the Kimi row.
 */
function SourcesFold() {
  const { t } = useI18n();
  const flashId = useContext(SettingsFlashContext);
  const onCardMount = useContext(SettingsCardMountContext);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    onCardMount?.('st-card-browser-setup');
    onCardMount?.('st-card-webbridge');
  }, [onCardMount]);
  useEffect(() => {
    if (flashId === 'st-card-browser-setup' || flashId === 'st-card-webbridge') setOpen(true);
  }, [flashId]);
  return (
    <div
      id="st-card-browser-setup"
      data-settings-card="st-card-browser-setup"
      className={`scroll-mt-4 pt-3 ${flashId === 'st-card-browser-setup' ? 'settings-card-flash' : ''}`}
    >
      {/* Explicit state, not the DOM's own toggle: jsdom never fires the
          event, so a controlled `open` would always swallow the click. */}
      <AdvancedDetails
        summary={t('st.browser.setup.title')}
        data-browser-sources
        open={open || undefined}
        onToggle={(event) => { setOpen((event.currentTarget as HTMLDetailsElement).open); }}
      >
        {open ? (
          <div className="pt-2">
            <BrowserSetupWizard />
          </div>
        ) : null}
      </AdvancedDetails>
    </div>
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

