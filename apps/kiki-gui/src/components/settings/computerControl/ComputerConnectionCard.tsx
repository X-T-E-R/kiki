/**
 * 电脑控制 → the connections. The header line chooses which connection runs
 * and adds one by hand; pressing a row replaces the list with that connection
 * as a flat form, with a back row, so the form never squeezes the list.
 *
 * Everything the form shows is read back from the server's MCP management
 * plane and written through it — no local mirror, no default the installer
 * would not have written. Live actions (test, stop) report the service's own
 * output instead of a predicted state: `stop` says what happened to this
 * process's computer MCP children and whether the write behind it persisted.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import type { McpManagedServer } from '@kiki/session-core/transport';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { ConfirmDialog } from '../../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, Toggle, type Feedback } from '../../controls';
import { Icon } from '../../icons';
import { Tag } from '../../capabilities/primitives';
import { DANGER_GHOST_BUTTON, INPUT, SECONDARY_BUTTON } from '../../ui';
import { useDirtyGuard } from '../../dirtyGuard';
import { McpSecretRows, mcpSecretLines } from '../McpSecretRows';
import { AdvancedDetails } from '../fields';
import { RowFrame } from '../RowFrame';
import {
  FORM_LABEL,
  SettingsDraftFooter,
  SettingsSelect,
} from '../SettingsPrimitives';
import { useSavedTick } from '../useSavedTick';
import {
  commandSummary,
  computerExecutorKind,
  computerMcpQueryKey,
  computerServerConfig,
  draftForEntry,
  isComputerConnection,
  isComputerMcpConfig,
  isDirtyDraft,
  isNewDraft,
  newComputerDraft,
  pluginLink,
  windowsMcpServeReadiness,
  type ComputerDraft,
  type ComputerExecutor,
} from './computerMcp';

/** One live result the service returned, kept verbatim. */
interface StopResult {
  readonly state: 'idle' | 'stopped' | 'unconfirmed';
  readonly output: string;
}

function entryKey(entry: Pick<McpManagedServer, 'source' | 'name'>): string {
  return `${entry.source}:${entry.name}`;
}

/**
 * The connections heading row owns the visible 添加 button; the card renders
 * a hidden one that opens the same view, so the add flow stays one
 * implementation. The heading's click reaches the card through this context.
 */
const ComputerAddContext = createContext<(() => void) | null>(null);

/** The 添加 button the computer connections heading row shows. */
export function AddComputerAction() {
  const { t } = useI18n();
  const openAdd = useContext(ComputerAddContext);
  return (
    <button type="button" className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`} data-computer-add-heading
      onClick={() => { openAdd?.(); }}>
      <Icon name="plus" size={12} />
      {t('st.computer.add')}
    </button>
  );
}

export function ComputerConnectionCard({ platform, planBinary, summary, footer }: {
  /** Server platform, used for a new entry's default args. */
  platform: string | undefined;
  /** Pinned executor path from the install plan, when one is available. */
  planBinary: string | undefined;
  /** Active connection selector drawn on the list's header line. */
  summary?: ReactNode;
  /** Optional registration fold rendered below the connection list. */
  footer?: ReactNode;
}) {
  const { client, klient, scopeId } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const guard = useDirtyGuard();

  const query = useQuery({
    queryKey: computerMcpQueryKey(scopeId),
    queryFn: () => klient.global.mcp.list(),
    staleTime: 30_000,
  });
  const entries = (query.data ?? []).filter((entry) => isComputerConnection(entry));

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<ComputerDraft | null>(null);
  /** The add view: the two ways in, one of which is the manual form. */
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; output: string } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [stopResult, setStopResult] = useState<StopResult | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();

  const dirty = draft !== null && isDirtyDraft(draft);
  const editorId = `computer-control:${scopeId}:${draft?.original === undefined ? 'new' : entryKey(draft.original)}`;

  const draftKey = draft?.original === undefined ? null : entryKey(draft.original);
  const vanished = draftKey !== null && query.isSuccess && !entries.some((entry) => entryKey(entry) === draftKey);
  useEffect(() => {
    // The connection is gone from the server (removed elsewhere). A clean draft
    // has nothing to keep; an edited one is left for the person to re-apply.
    if (vanished && !dirty) setDraft(null);
  }, [vanished, dirty]);

  /** Replace the open draft. The escape route for a new connection is Discard. */
  const applyDraft = (next: ComputerDraft | null) => {
    setDraft(next);
    setAdding(false);
    setSelectedKey(next?.original === undefined ? null : entryKey(next.original));
    setTestResult(null);
    setStopResult(null);
    setFeedback(null);
  };

  const open = (next: ComputerDraft | null) => {
    // The guard only prompts for an id something reported; the draft footer is
    // that reporter, so the ask has to carry the same id or the edit is dropped
    // silently.
    if (dirty && draft !== null && guard?.confirmDiscard !== undefined) {
      guard.confirmDiscard(editorId, () => { applyDraft(next); });
      return;
    }
    applyDraft(next);
  };

  const revealEnv = draft?.original?.mutable === true
    ? async (key: string) => (await client.revealSecret({ kind: 'mcp_env', server: draft.original!.name, key })).value
    : undefined;

  /** A value the page itself refuses to write is reported as its own key; a server failure as its text. */
  const reportFailure = (error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    setFeedback({ tone: 'error', text: message.startsWith('st.') ? t(message as I18nKey) : errorText(locale, error) });
  };

  const adopt = (servers: readonly McpManagedServer[], name: string) => {
    queryClient.setQueryData(computerMcpQueryKey(scopeId), servers);
    const saved = servers.find((entry) => entry.name === name && entry.source === 'global' && entry.mutable);
    if (saved !== undefined) {
      setDraft(draftForEntry(saved));
      setSelectedKey(entryKey(saved));
    }
  };

  const save = async () => {
    if (draft === null) return;
    const name = draft.name.trim();
    if (name === '') {
      setFeedback({ tone: 'error', text: t('st.mcp.nameRequired') });
      return;
    }
    setSaving(true);
    setFeedback(null);
    setTestResult(null);
    try {
      const envLines = await mcpSecretLines(draft.envRows, revealEnv ?? (async () => undefined));
      const server = computerServerConfig(draft, envLines, 'st.computer.timeoutInvalid');
      const original = draft.original;
      const renamed = original !== undefined && original.name !== name;
      // A rename is two writes: add the new identity first, then drop the old
      // one, so a mid-flight failure never leaves the entry nowhere.
      let echoed = original === undefined || renamed
        ? await klient.global.mcp.add({ server })
        : await klient.global.mcp.update({ server });
      if (renamed && original !== undefined) echoed = await klient.global.mcp.remove({ name: original.name });
      adopt(echoed, name);
      pingSaved();
      await queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    } catch (error) {
      reportFailure(error);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (draft === null) return;
    const name = draft.name.trim();
    if (name === '') {
      setFeedback({ tone: 'error', text: t('st.mcp.nameRequired') });
      return;
    }
    setTesting(true);
    setFeedback(null);
    setTestResult(null);
    try {
      const envLines = await mcpSecretLines(draft.envRows, revealEnv ?? (async () => undefined));
      // Probes the form as typed — nothing has to be saved first.
      const server = computerServerConfig(draft, envLines, 'st.computer.timeoutInvalid');
      setTestResult(await klient.global.mcp.test({ server }));
    } catch (error) {
      reportFailure(error);
    } finally {
      setTesting(false);
    }
  };

  const stop = async () => {
    const entry = draft?.original;
    setConfirmingStop(false);
    if (entry === undefined) return;
    setStopping(true);
    setFeedback(null);
    setStopResult(null);
    try {
      const result = await klient.global.mcp.stop({ name: entry.name });
      setStopResult(result);
      // Re-read instead of assuming: the service disables an editable global
      // entry as part of stopping, and its output says whether that stuck.
      const servers = await query.refetch();
      if (servers.data !== undefined) {
        const now = servers.data.find((candidate) => entryKey(candidate) === entryKey(entry));
        if (now !== undefined) setDraft(draftForEntry(now));
      }
      await queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    } catch (error) {
      reportFailure(error);
    } finally {
      setStopping(false);
    }
  };

  const readOnly = draft?.original !== undefined && !draft.original.mutable;
  const draftKind = draft?.original !== undefined ? computerExecutorKind(draft.original.config) : undefined;
  const draftWindowsReadiness = draftKind === 'windows-mcp' && draft?.original !== undefined
    ? windowsMcpServeReadiness(draft.original.config)
    : undefined;
  const draftWindowsNotReady = draftWindowsReadiness !== undefined && draftWindowsReadiness !== 'ready';
  const draftWindowsUnverified = draftWindowsReadiness === 'unverified';

  /**
   * One row per connection: the name, its kind and origin as quiet tags, and
   * the command it runs. Clicking the summary opens the editor inline under
   * the row — the list stays visible — and never changes state; the 添加 menu
   * at the top offers the two ways in (a manual entry, or registering an
   * already installed Windows-MCP environment on Windows).
   */
  /** The editor an open row expands inline under itself; a new connection's
   *  editor renders in place under the list header, since it has no row yet. */
  const renderDetail = (): ReactNode => {
    if (draft === null) return null;
    return (
      <div className="min-w-0 space-y-4" data-computer-detail={draft.original?.name ?? 'new'}>
        {draftWindowsNotReady ? (
          <p className="text-[12px] text-amber-ink" data-computer-windows-mcp-not-ready>
            {t(draftWindowsUnverified ? 'st.computer.windowsMcp.unverified' : 'st.computer.windowsMcp.notServeReady')}
          </p>
        ) : null}

        {/* Where the command comes from, before the form asks for it: the one
            click path first (the header's install writes this entry), then what
            a hand entry actually is. */}
        {draft.original !== undefined || planBinary !== undefined ? null : (
          <ol className="max-w-[62ch] list-decimal space-y-0.5 pl-4 text-[12px] leading-[18px] text-ink-soft marker:text-ink-faint" data-computer-mcp-steps>
            <li>{t('st.computer.mcpSteps.1')}</li>
            <li>{t('st.computer.mcpSteps.2')}</li>
          </ol>
        )}
        <fieldset disabled={saving || stopping || readOnly} className="min-w-0 space-y-4">
        <div className="space-y-1.5">
          <label className={FORM_LABEL} htmlFor="computer-name">{t('st.computer.fieldName')}</label>
          <div className="flex items-center gap-3">
            <input
              id="computer-name"
              className={`${INPUT} min-w-0 flex-1 font-mono`}
              data-computer-name-input
              value={draft.name}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => { setDraft({ ...draft, name: event.target.value }); }}
            />
            {/* The switch keeps its own width: a squeezed label wraps by
                character in Chinese and stops reading as a switch. */}
            <span className="shrink-0">
              <Toggle
                label={t('st.computer.fieldEnabled')}
                checked={draft.enabled}
                disabled={saving || readOnly}
                onChange={(enabled) => { setDraft({ ...draft, enabled }); }}
              />
            </span>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className={FORM_LABEL} htmlFor="computer-command">{t('st.computer.fieldCommand')}</label>
          <input
            id="computer-command"
            className={`${INPUT} font-mono`}
            data-computer-command-input
            value={draft.command}
            spellCheck={false}
            autoComplete="off"
            placeholder={t('st.computer.commandPlaceholder')}
            onChange={(event) => { setDraft({ ...draft, command: event.target.value }); }}
          />
        </div>

        <div className="space-y-1.5">
          <label className={FORM_LABEL} htmlFor="computer-args">{t('st.computer.fieldArgs')}</label>
          <textarea
            id="computer-args"
            className={`${INPUT} min-h-20 font-mono`}
            data-computer-args-input
            value={draft.args}
            spellCheck={false}
            onChange={(event) => { setDraft({ ...draft, args: event.target.value }); }}
          />
        </div>

        <div className="space-y-1.5">
          <label className={FORM_LABEL} id="computer-executor-label">{t('st.computer.fieldExecutor')}</label>
          <SettingsSelect<ComputerExecutor>
            id="computer-executor"
            variant="form"
            ariaLabel={t('st.computer.fieldExecutor')}
            value={draft.executor}
            dataAttr="data-computer-executor"
            choices={[
              { value: 'local', label: t('st.computer.executor.local') },
              { value: 'kaos', label: t('st.computer.executor.kaos') },
            ]}
            onChange={(executor) => { setDraft({ ...draft, executor }); }}
          />
        </div>

        <AdvancedDetails summary={t('st.computer.advanced')} data-computer-advanced>
          <div className="space-y-3 text-[12px] text-ink-soft">
            <McpSecretRows
              kind="env"
              rows={draft.envRows}
              reveal={revealEnv}
              onChange={(envRows) => { setDraft({ ...draft, envRows }); }}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className={FORM_LABEL}>{t('st.computer.startupTimeout')}</span>
                <input
                  className={`${INPUT} font-mono`}
                  inputMode="numeric"
                  data-computer-startup-timeout
                  value={draft.startupTimeoutMs}
                  onChange={(event) => { setDraft({ ...draft, startupTimeoutMs: event.target.value }); }}
                />
              </label>
              <label className="space-y-1.5">
                <span className={FORM_LABEL}>{t('st.computer.toolTimeout')}</span>
                <input
                  className={`${INPUT} font-mono`}
                  inputMode="numeric"
                  data-computer-tool-timeout
                  value={draft.toolTimeoutMs}
                  onChange={(event) => { setDraft({ ...draft, toolTimeoutMs: event.target.value }); }}
                />
              </label>
            </div>
            <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-1">
              <dt className="text-ink-faint">{t('st.mcp.transport')}</dt>
              <dd className="font-mono">stdio</dd>
              <dt className="text-ink-faint">{t('st.mcp.origin')}</dt>
              <dd className="min-w-0 break-all font-mono" data-computer-source
                title={draft.original?.origin}>
                {draft.original === undefined ? t('st.computer.sourceNew') : draft.original.origin}
              </dd>
              {draft.original === undefined ? null : (
                <>
                  <dt className="text-ink-faint">{t('st.computer.sourceField')}</dt>
                  <dd className="font-mono">{draft.original.source}</dd>
                </>
              )}
            </dl>
            {draft.original !== undefined && pluginLink(draft.original) !== undefined ? (
              <Link
                to={pluginLink(draft.original)!}
                className="inline-block text-[12px] font-medium text-selected-ink hover:underline"
                data-computer-plugin-link
              >
                {t('st.plugins.manageLink')}
              </Link>
            ) : null}
          </div>
        </AdvancedDetails>
      </fieldset>

      {readOnly ? <Hint>{t('st.computer.readOnly')}</Hint> : null}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={SECONDARY_BUTTON} data-computer-test-btn
          disabled={testing || saving || draft.name.trim() === ''}
          onClick={() => { void test(); }}>
          {testing ? t('st.computer.testing') : t('st.computer.testButton')}
        </button>
        {draft.original !== undefined && isComputerMcpConfig(draft.original.config) ? (
          <button type="button" className={DANGER_GHOST_BUTTON} data-computer-stop-btn
            disabled={stopping || saving}
            onClick={() => { setConfirmingStop(true); }}>
            {stopping ? t('st.computer.stopping') : t('st.computer.stopButton')}
          </button>
        ) : null}
      </div>

      {testResult !== null ? (
        <div className="space-y-1" data-computer-test-result={testResult.success ? 'ok' : 'error'}>
          <p role="status" className={`text-[12px] ${testResult.success ? 'text-ink-soft' : 'text-danger'}`}>
            {testResult.success ? t('st.computer.testOk') : t('st.computer.testFailed')}
          </p>
          <pre className="max-h-40 overflow-auto border-l-2 border-hairline-strong pl-2 font-mono text-[11px] leading-4 whitespace-pre-wrap text-ink-soft">{testResult.output}</pre>
        </div>
      ) : null}

      {stopResult !== null ? (
        <div className="space-y-1" data-computer-stop-result={stopResult.state}>
          <p role="status" className="text-[12px] text-ink-soft">
            {t(stopResult.state === 'stopped' ? 'st.computer.stop.stopped'
              : stopResult.state === 'idle' ? 'st.computer.stop.idle'
                : 'st.computer.stop.unconfirmed')}
          </p>
          <pre className="max-h-40 overflow-auto border-l-2 border-hairline-strong pl-2 font-mono text-[11px] leading-4 whitespace-pre-wrap text-ink-soft" data-computer-stop-output>{stopResult.output}</pre>
        </div>
      ) : null}

      <FeedbackLine feedback={feedback} />

      {readOnly ? null : (
        <SettingsDraftFooter
          id={editorId}
          dirty={dirty}
          saving={saving}
          saveLabel={isNewDraft(draft) ? t('st.computer.create') : undefined}
          persistent={isNewDraft(draft)}
          saved={justSaved}
          onSave={() => { void save(); }}
          // Discard is the user answering the question already; asking again
          // through the guard would be a second confirmation for one decision.
          onDiscard={() => { applyDraft(draft.original === undefined ? null : draftForEntry(draft.original)); }}
        />
      )}
      </div>
    );
  };

  const list = (
    <div aria-label={t('st.computer.connectionsTitle')} className="min-w-0">
      {query.isLoading ? <p className="text-[13px] text-ink-faint" role="status">{t('st.computer.loading')}</p> : null}
      {query.isError ? <InlineError error={query.error} /> : null}
      {query.isSuccess && entries.length === 0 ? (
        <div className="space-y-2 py-1" data-computer-empty>
          <p className="text-[13px] text-ink-soft">{t('st.computer.empty')}</p>
          <div>
            <button type="button" className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`} data-computer-empty-add
              onClick={() => { setAdding(true); }}>
              <Icon name="plus" size={12} />
              {t('st.computer.add')}
            </button>
          </div>
        </div>
      ) : null}
      {entries.length > 0 ? (
        <div className="divide-y divide-hairline/70" data-computer-list>
          {entries.map((entry) => {
            const kind = computerExecutorKind(entry.config);
            const openRow = selectedKey === entryKey(entry);
            return (
              <RowFrame
                key={entryKey(entry)}
                data={{
                  'data-computer-connection': entry.name,
                  'data-computer-connection-kind': kind,
                }}
                open={openRow}
                onToggle={() => { if (openRow) open(null); else open(draftForEntry(entry)); }}
                bodyId={`computer-row-body-${entry.source}-${entry.name}`}
                expandLabel={t('st.computer.menu.openRow', { name: entry.name })}
                name={entry.name}
                marks={(
                  <span className="flex shrink-0 items-center gap-1.5">
                    {kind === undefined ? null : (
                      <Tag>{t(kind === 'windows-mcp' ? 'st.computer.kind.windowsMcp' : 'st.computer.kind.cua')}</Tag>
                    )}
                    {entry.mutable ? null : (
                      <Tag>{entry.plugin !== undefined ? t('st.mcp.fromPlugin', { name: entry.plugin.name }) : t('st.mcp.readOnly')}</Tag>
                    )}
                  </span>
                )}
                subtitle={(
                  <span className="max-w-full truncate font-mono text-[11px] text-ink-faint" title={commandSummary(entry.config)}>
                    {commandSummary(entry.config)}
                  </span>
                )}
              >
                {openRow && draft !== null ? renderDetail() : null}
              </RowFrame>
            );
          })}
        </div>
      ) : null}
    </div>
  );


  const stopConsequences = draft?.original === undefined ? [] : [
    commandSummary(draft.original.config),
    draft.original.mutable ? t('st.computer.stop.disables') : t('st.computer.stop.readOnly'),
  ];

  return (
    <ComputerAddContext.Provider value={() => { setAdding(true); }}>
    <div className="min-w-0 space-y-3" data-computer-connections data-computer-view={adding ? 'add' : 'list'}>
      {adding ? (
        <div className="min-w-0 space-y-4" data-computer-add-view>
          <button type="button" data-computer-back
            className="inline-flex items-center gap-1 rounded text-[12px] text-ink-soft transition-colors hover:text-ink focus-visible:underline"
            onClick={() => { setAdding(false); }}>
            <Icon name="arrowLeft" size={12} />{t('st.computer.connectionsTitle')}
          </button>
          <div className="space-y-2">
            <button type="button" className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5`} data-computer-new
              onClick={() => { open(newComputerDraft(platform, planBinary)); }}>
              <Icon name="plus" size={12} />
              {t('st.computer.setupEntry')}
            </button>
            {footer}
          </div>
        </div>
      ) : (
        <>
          {/* The visible add button is the heading row's; this one opens the
              same view for deep links and tests, hidden from the page. */}
          <button type="button" className="hidden" data-computer-add aria-hidden="true" tabIndex={-1}
            disabled={saving || stopping}
            onClick={() => { setAdding(true); }} />
          {summary}
          {list}
        </>
      )}
      {/* A connection being created has no row yet: its editor renders in
          place under the list header, the way an existing one renders under
          its own row. */}
      {draft !== null && !adding && selectedKey === null ? renderDetail() : null}
      <ConfirmDialog
        open={confirmingStop}
        overlayId="confirm-computer-stop"
        title={t('st.computer.stop.confirmTitle', { name: draft?.original?.name ?? '' })}
        body={t('st.computer.stop.confirmBody')}
        consequences={stopConsequences}
        confirmLabel={t('st.computer.stopButton')}
        busy={stopping}
        onCancel={() => { setConfirmingStop(false); }}
        onConfirm={() => { void stop(); }}
      />
    </div>
    </ComputerAddContext.Provider>
  );
}
