/**
 * External clients — Settings › Connection Services (`connection-services`).
 *
 * Inbound clients driving Kiki through MCP or stdio. Settings manages access
 * and authorization only (client authorization tokens, permissions, tools,
 * listener configuration and remote MCP URLs). Working directories, active
 * workspaces and session parameters belong to conversation drafts, not a
 * global settings operation table.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { copyTextToClipboard } from '../../lib/clipboard';
import {
  epochToIso,
  EXTERNAL_CLIENT_DEFAULT_TOOLS,
  externalClientsFacade,
  listenerReadiness,
  sessionHref,
  type ExternalClientAuthorization,
  type ExternalClientConnection,
  type ExternalClientListener,
  type ExternalClientSession,
  type ExternalConnectionMode,
  type ExternalConnectionPatch,
  type ExternalHistoryScope,
  type ExternalMemoryScope,
} from '../../lib/externalClients';
import { PERMISSION_MODES, permissionModeDef } from '../../lib/permissionModes';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, Toggle, type Feedback } from '../controls';
import { DisclosureChevron, Icon } from '../icons';
import { INPUT, SECONDARY_BUTTON } from '../ui';
import { ListEmpty } from './list';
import { SectionCard } from './SectionCard';

const CLIENTS_QUERY_KEY = ['external-clients'] as const;
const AUTHORIZATIONS_QUERY_KEY = ['external-clients', 'authorizations'] as const;
const SESSIONS_QUERY_KEY = ['external-clients', 'sessions'] as const;

type Facade = NonNullable<ReturnType<typeof externalClientsFacade>>;

const STATUS_KEY: Record<ExternalClientConnection['status'], I18nKey> = {
  active: 'st.xc.statusActive',
  paused: 'st.xc.statusPaused',
  revoked: 'st.xc.statusRevoked',
};

const MEMORY_SCOPES: readonly ExternalMemoryScope[] = ['workspace', 'global'];
const HISTORY_SCOPES: readonly ExternalHistoryScope[] = ['current', 'connection', 'workspace'];

function toggleValue<T>(list: readonly T[], value: T): readonly T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** A monospace block with its own copy button: the thing a person pastes. */
function CopyBlock({ value, label, wrap = false }: { value: string; label: string; wrap?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div data-xc-copy className="flex min-w-0 max-w-full items-center gap-1 rounded-md border border-hairline bg-paper pl-2">
      <code className={`min-w-0 font-mono text-[11.5px] text-ink ${wrap ? 'break-all py-1.5 leading-4' : 'truncate py-1.5'}`}
        title={value}>{value}</code>
      <button type="button" data-xc-copy-button aria-label={label}
        onClick={() => { void copyTextToClipboard(value).then(() => { setCopied(true); setTimeout(() => { setCopied(false); }, 1500); }); }}
        className="inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-r-md px-1.5 text-[11.5px] text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink">
        {copied ? t('st.xc.localCopied') : <Icon name="notes" size={12} />}
      </button>
    </div>
  );
}

/** Label / value line. Labels share one column on desktop, stack on mobile. */
function Fact({ label, children, fact }: { label: string; children: React.ReactNode; fact?: string }) {
  return (
    <div data-xc-fact={fact} className="grid min-w-0 gap-x-4 gap-y-0.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
      <dt className="text-[12px] text-ink-faint">{label}</dt>
      <dd className="min-w-0 text-[12.5px] leading-5 text-ink">{children}</dd>
    </div>
  );
}

function Field({ label, hint, htmlFor, children }: {
  label: string; hint?: string; htmlFor: string; children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-[12px] text-ink-soft" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint !== undefined ? <p className="text-[12px] leading-4 text-ink-faint">{hint}</p> : null}
    </div>
  );
}

/** A labelled group of choices; the label is not itself a form control. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="block text-[12px] text-ink-soft">{label}</span>
      {children}
    </div>
  );
}

// ---- the grant editor, shared by the create flow and the per-row edit ----

interface ConnectionDraft {
  readonly name: string;
  readonly mode: ExternalConnectionMode;
  readonly tools: readonly string[];
  readonly toolPreset: 'default' | 'custom';
  readonly allowCommands: boolean;
  readonly memoryScopes: readonly ExternalMemoryScope[];
  readonly historyScope: ExternalHistoryScope;
}

/** Whether a grant is exactly the template, which is worth naming as such. */
function toolsMatchTemplate(tools: readonly string[]): boolean {
  return tools.length === EXTERNAL_CLIENT_DEFAULT_TOOLS.length
    && EXTERNAL_CLIENT_DEFAULT_TOOLS.every((tool) => tools.includes(tool));
}

function draftOf(connection: ExternalClientConnection | undefined): ConnectionDraft {
  if (connection === undefined) {
    return {
      name: '',
      mode: 'manual',
      tools: EXTERNAL_CLIENT_DEFAULT_TOOLS,
      toolPreset: 'default',
      allowCommands: false,
      memoryScopes: ['workspace'],
      historyScope: 'current',
    };
  }
  const tools = [...connection.tools];
  return {
    name: connection.name,
    mode: connection.mode,
    tools,
    toolPreset: toolsMatchTemplate(tools) ? 'default' : 'custom',
    allowCommands: connection.allowCommands,
    memoryScopes: connection.memoryScopes.filter((scope) => MEMORY_SCOPES.includes(scope)),
    historyScope: connection.historyScope,
  };
}

function draftToPatch(draft: ConnectionDraft, saved: ExternalClientConnection | undefined): ExternalConnectionPatch {
  const patch: {
    name?: string;
    mode?: ExternalConnectionMode;
    tools?: string[];
    allowCommands?: boolean;
    memoryScopes?: ExternalMemoryScope[];
    historyScope?: ExternalHistoryScope;
  } = {};
  const name = draft.name.trim();
  if (saved === undefined || name !== saved.name) patch.name = name;
  if (saved === undefined || draft.mode !== saved.mode) patch.mode = draft.mode;
  if (draft.allowCommands !== (saved?.allowCommands ?? false)) patch.allowCommands = draft.allowCommands;
  if (saved === undefined || draft.historyScope !== saved.historyScope) patch.historyScope = draft.historyScope;
  const tools = draft.toolPreset === 'default' ? EXTERNAL_CLIENT_DEFAULT_TOOLS : [...draft.tools];
  if (saved === undefined || !sameSet([...tools].toSorted(), [...saved.tools].toSorted())) patch.tools = [...tools];
  if (saved === undefined || !sameSet([...draft.memoryScopes].toSorted(), [...saved.memoryScopes].toSorted())) {
    patch.memoryScopes = [...draft.memoryScopes];
  }
  return patch;
}

const POLICY_FIELDS = ['mode', 'allowCommands', 'historyScope'] as const;

export type PolicyChange = 'pause' | 'access' | 'none';

type PendingConfirm = { readonly kind: Exclude<PolicyChange, 'none'>; readonly action: 'save' | 'pause' };

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

export function policyChangeOf(
  saved: ExternalClientConnection,
  next: ExternalConnectionPatch,
): PolicyChange {
  if (next.enabled === false && saved.status === 'active') return 'pause';
  if (next.enabled === true && saved.status === 'paused') return 'pause';
  const narrowed = POLICY_FIELDS.some((field) => next[field] !== undefined && next[field] !== saved[field])
    || (next.tools !== undefined && !sameSet([...next.tools].toSorted(), [...saved.tools].toSorted()))
    || (next.memoryScopes !== undefined && !sameSet([...next.memoryScopes].toSorted(), [...saved.memoryScopes].toSorted()));
  return narrowed ? 'access' : 'none';
}

function AccessEditor({ draft, onChange, disabled, idPrefix }: {
  draft: ConnectionDraft;
  onChange: (next: ConnectionDraft) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  const { t } = useI18n();
  const custom = draft.toolPreset === 'custom';
  return (
    <div className="space-y-4">
      <Group label={t('st.xc.mode')}>
        <div className="flex flex-wrap items-center gap-1.5">
          {PERMISSION_MODES.map((mode) => {
            const active = draft.mode === mode.id;
            return (
              <button key={mode.id} type="button" data-xc-mode={mode.id} disabled={disabled}
                aria-pressed={active} title={t(mode.hintKey)}
                onClick={() => { onChange({ ...draft, mode: mode.id }); }}
                className={`min-h-7 rounded-md border px-2.5 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  active
                    ? 'border-hairline-strong bg-paper font-medium text-ink'
                    : 'border-hairline text-ink-soft hover:border-hairline-strong hover:text-ink'
                }`}>
                {t(mode.labelKey)}
              </button>
            );
          })}
        </div>
        <p className="text-[12px] leading-4 text-ink-faint">{t('st.xc.modeHint')}</p>
      </Group>
      <Group label={t('st.xc.tools')}>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" data-xc-tools="default" disabled={disabled} aria-pressed={draft.toolPreset === 'default'}
            onClick={() => { onChange({ ...draft, toolPreset: 'default', tools: EXTERNAL_CLIENT_DEFAULT_TOOLS }); }}
            className={`min-h-7 rounded-md border px-2.5 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              draft.toolPreset === 'default'
                ? 'border-hairline-strong bg-paper font-medium text-ink'
                : 'border-hairline text-ink-soft hover:border-hairline-strong hover:text-ink'
            }`}>
            {t('st.xc.toolsAll')}
          </button>
          <button type="button" data-xc-tools="custom" disabled={disabled} aria-pressed={custom}
            onClick={() => { onChange({ ...draft, toolPreset: 'custom' }); }}
            className={`min-h-7 rounded-md border px-2.5 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              custom
                ? 'border-hairline-strong bg-paper font-medium text-ink'
                : 'border-hairline text-ink-soft hover:border-hairline-strong hover:text-ink'
            }`}>
            {t('st.xc.toolsCustom')}
          </button>
        </div>
        {custom ? (
          <div data-xc-tool-list className="space-y-1 pt-1">
            {EXTERNAL_CLIENT_DEFAULT_TOOLS.map((tool) => (
              <label key={tool} className="flex min-h-7 cursor-pointer items-center gap-2 text-[12.5px] text-ink">
                <input type="checkbox" data-xc-tool={tool} checked={draft.tools.includes(tool)} disabled={disabled}
                  onChange={() => { onChange({ ...draft, tools: toggleValue(draft.tools, tool) }); }}
                  className="h-3.5 w-3.5 cursor-pointer accent-[var(--color-ink)]" />
                <span className="font-mono text-[11.5px]">{tool}</span>
              </label>
            ))}
            {draft.tools.length === 0 ? <p className="text-[12px] text-ink-faint">{t('st.xc.toolsNone')}</p> : null}
          </div>
        ) : null}
        <p className="text-[12px] leading-4 text-ink-faint">{t('st.xc.toolsHint')}</p>
      </Group>
      <div className="space-y-1">
        <Toggle id={`${idPrefix}-commands`} layout="row" disabled={disabled}
          checked={draft.allowCommands} onChange={(value) => { onChange({ ...draft, allowCommands: value }); }}
          label={t('st.xc.commands')} />
        <p data-xc-commands-hint className={`text-[12px] leading-4 ${draft.allowCommands ? 'text-amber-ink' : 'text-ink-faint'}`}>
          {t('st.xc.commandsHint')}
        </p>
      </div>
      <Group label={t('st.xc.memory')}>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {MEMORY_SCOPES.map((scope) => (
            <label key={scope} className="flex min-h-7 cursor-pointer items-center gap-2 text-[12.5px] text-ink">
              <input type="checkbox" data-xc-memory={scope} disabled={disabled}
                checked={draft.memoryScopes.includes(scope)}
                onChange={() => { onChange({ ...draft, memoryScopes: toggleValue(draft.memoryScopes, scope) }); }}
                className="h-3.5 w-3.5 cursor-pointer accent-[var(--color-ink)]" />
              <span>{t(`st.xc.memory.${scope}`)}</span>
            </label>
          ))}
        </div>
        <p className="text-[12px] leading-4 text-ink-faint">{t('st.xc.memoryHint')}</p>
      </Group>
      <Field label={t('st.xc.history')} hint={t('st.xc.historyHint')} htmlFor={`${idPrefix}-history`}>
        <select id={`${idPrefix}-history`} data-xc-history className={`${INPUT} sm:w-auto sm:min-w-[16rem]`}
          value={draft.historyScope} disabled={disabled}
          onChange={(event) => { onChange({ ...draft, historyScope: event.target.value as ExternalHistoryScope }); }}>
          {HISTORY_SCOPES.map((scope) => <option key={scope} value={scope}>{t(`st.xc.history.${scope}`)}</option>)}
        </select>
      </Field>
    </div>
  );
}

// ---- the two ways in ----

function LocalAccess({ connectionId, api }: { connectionId: string; api: Facade }) {
  const { t, locale } = useI18n();
  const query = useQuery({
    queryKey: ['external-clients', 'stdio', connectionId],
    queryFn: () => api.stdio(connectionId),
    staleTime: 60_000,
    retry: false,
  });
  const command = query.data === undefined ? undefined : [query.data.command, ...query.data.args].join(' ');
  return (
    <div data-xc-local className="space-y-2">
      <p className="text-[12px] font-medium text-ink-soft">{t('st.xc.localTitle')}</p>
      <p className="max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('st.xc.localHint')}</p>
      {command !== undefined ? (
        <div className="space-y-1.5" data-xc-local-config>
          <p className="text-[12px] text-ink-faint">{t('st.xc.localConfig')}</p>
          <CopyBlock value={command} label={t('st.xc.localCopy')} wrap />
        </div>
      ) : null}
      {query.isLoading ? <Hint>{t('st.xc.loading')}</Hint> : null}
      {query.isError ? (
        <p data-xc-local-error className="text-[12px] leading-4 text-danger">
          {t('st.xc.error.stdio', { reason: errorText(locale, query.error) })}
        </p>
      ) : null}
      {command !== undefined ? (
        <p className="max-w-[62ch] text-[12px] leading-4 text-ink-faint">
          {t('st.xc.localConfigHint')}
          {' '}
          <span className="text-ink-soft">{t('st.xc.localToolNote')}</span>
        </p>
      ) : null}
    </div>
  );
}

function RemoteAccess({ listener }: { listener: ExternalClientListener | undefined }) {
  const { t } = useI18n();
  const mcpUrl = listener?.mcpUrl ?? listener?.publicUrl;
  return (
    <div data-xc-remote className="space-y-2">
      <p className="text-[12px] font-medium text-ink-soft">{t('st.xc.remoteTitle')}</p>
      <p className="max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('st.xc.remoteHint')}</p>
      {mcpUrl !== undefined && mcpUrl !== '' ? (
        <div className="space-y-1.5" data-xc-remote-url>
          <p className="text-[12px] text-ink-faint">{t('st.xc.remoteUrl')}</p>
          <CopyBlock value={mcpUrl} label={t('st.xc.remoteCopy')} wrap />
        </div>
      ) : (
        <p data-xc-remote-missing className="text-[12px] leading-4 text-ink-faint">{t('st.xc.remoteUrlMissing')}</p>
      )}
      <p className="max-w-[62ch] text-[12px] leading-4 text-ink-soft">{t('st.xc.remoteAddServer')}</p>
      <div className="space-y-1">
        <a data-xc-remote-help
          href="https://developers.openai.com/api/docs/guides/custom-mcp-server"
          target="_blank" rel="noreferrer noopener"
          className="inline-flex min-h-7 items-center gap-1 text-[12px] font-medium text-selected-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink">
          {t('st.xc.remoteHelp')}
          <Icon name="arrowUpRight" size={12} />
        </a>
        <p className="max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('st.xc.remoteHelpNote')}</p>
      </div>
    </div>
  );
}

const READINESS_KEY: Record<ReturnType<typeof listenerReadiness>, I18nKey> = {
  off: 'st.xc.readiness.off',
  bound: 'st.xc.readiness.bound',
  reachable: 'st.xc.readiness.reachable',
  unreachable: 'st.xc.readiness.unreachable',
  failed: 'st.xc.readiness.failed',
};

function ListenerPanel({ listener, api, onChanged }: {
  listener: ExternalClientListener;
  api: Facade;
  onChanged: () => void;
}) {
  const { t, locale } = useI18n();
  const [publicUrl, setPublicUrl] = useState(listener.publicUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  useEffect(() => { setPublicUrl(listener.publicUrl ?? ''); }, [listener.publicUrl]);
  const readiness = listenerReadiness(listener);

  const configure = async (body: Parameters<Facade['configureListener']>[0]) => {
    setBusy(true);
    setFeedback(null);
    try {
      await api.configureListener(body);
      setFeedback({ tone: 'success', text: t('st.xc.saved') });
      onChanged();
    } catch (error) {
      setFeedback({ tone: 'error', text: t('st.xc.error.listener', { reason: errorText(locale, error) }) });
    } finally {
      setBusy(false);
    }
  };

  const saveUrl = () => {
    const next = publicUrl.trim();
    if (next !== '' && !next.startsWith('https://')) {
      setFeedback({ tone: 'error', text: t('st.xc.publicUrlInvalid') });
      return;
    }
    void configure({ enabled: listener.enabled, publicUrl: next === '' ? undefined : next });
  };

  return (
    <div data-xc-listener data-xc-readiness={readiness} className="space-y-2">
      <p className="text-[12px] font-medium text-ink-soft">{t('st.xc.listenerTitle')}</p>
      <p className="max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('st.xc.listenerHint')}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Toggle id="xc-listener-toggle" layout="row" disabled={busy} checked={listener.enabled}
          onChange={(value) => { void configure({ enabled: value }); }}
          label={listener.enabled ? t('st.xc.listenerOn') : t('st.xc.listenerOff')} />
        <p data-xc-listener-state-label className="text-[12px] text-ink-faint">
          {t(READINESS_KEY[readiness])}
          {listener.origin !== undefined && listener.state === 'listening'
            ? <span className="ml-1.5 font-mono text-[11.5px]">{listener.origin}</span>
            : null}
        </p>
      </div>
      {listener.state === 'error' && listener.error !== undefined ? (
        <p data-xc-listener-error className="text-[12px] leading-4 text-danger">{listener.error}</p>
      ) : null}
      <p className="max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('st.xc.listenerDiscoveryHint')}</p>
      <Field label={t('st.xc.publicUrl')} hint={t('st.xc.publicUrlHint')} htmlFor="xc-public-url">
        <div className="flex flex-wrap items-center gap-2">
          <input id="xc-public-url" data-xc-public-url className={`${INPUT} min-w-0 flex-1 font-mono text-[11.5px]`}
            value={publicUrl} spellCheck={false} disabled={busy} placeholder="https://"
            onChange={(event) => { setPublicUrl(event.target.value); }} />
          <button type="button" data-xc-public-url-save className={SECONDARY_BUTTON} disabled={busy} aria-busy={busy}
            onClick={saveUrl}>
            {t('common.save')}
          </button>
        </div>
      </Field>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

// ---- pending authorizations ----

function AuthorizationPanel({ requests, api, onChanged }: {
  requests: readonly ExternalClientAuthorization[];
  api: Facade;
  onChanged: () => void;
}) {
  const { t, locale } = useI18n();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const respond = async (request: ExternalClientAuthorization, approved: boolean) => {
    setBusyId(request.id);
    setFeedback(null);
    try {
      await api.respondAuthorization(request.id, { connectionId: request.clientId, approved });
      onChanged();
    } catch (error) {
      setFeedback({ tone: 'error', text: t('st.xc.error.respond', { reason: errorText(locale, error) }) });
    } finally {
      setBusyId(null);
    }
  };
  return (
    <div data-xc-authorizations className="space-y-2">
      <p className="text-[12px] font-medium text-ink-soft">{t('st.xc.authTitle')}</p>
      <p className="max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('st.xc.authHint')}</p>
      {requests.map((request) => (
        <div key={request.id} data-xc-authorization={request.id}
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-hairline pt-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-ink">{request.clientName ?? request.clientId}</p>
            {request.scopes.length > 0 ? (
              <p className="truncate font-mono text-[11.5px] text-ink-faint">{request.scopes.join(' · ')}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" data-xc-auth-approve className={SECONDARY_BUTTON}
              disabled={busyId !== null} aria-busy={busyId === request.id}
              onClick={() => { void respond(request, true); }}>
              {t('st.xc.authApprove')}
            </button>
            <button type="button" data-xc-auth-deny disabled={busyId !== null}
              className="min-h-8 rounded-md px-2.5 text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50"
              onClick={() => { void respond(request, false); }}>
              {t('st.xc.authDeny')}
            </button>
          </div>
        </div>
      ))}
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

// ---- one connection row ----

function ConnectionRow({ connection, api, onChanged }: {
  connection: ExternalClientConnection;
  api: Facade;
  onChanged: () => void;
}) {
  const { t, locale, time } = useI18n();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<ConnectionDraft>(() => draftOf(connection));
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [confirming, setConfirming] = useState<PendingConfirm | null>(null);
  const [editing, setEditing] = useState(false);
  const revoked = connection.status === 'revoked';
  const paused = connection.status === 'paused';
  const modeDef = permissionModeDef(connection.mode);

  const signature = [connection.name, connection.mode, connection.status,
    connection.tools.join(','), String(connection.allowCommands), connection.historyScope,
    connection.memoryScopes.join(',')].join(' ');
  const [seenSignature, setSeenSignature] = useState(signature);
  if (seenSignature !== signature) {
    setSeenSignature(signature);
    setDraft(draftOf(connection));
    setEditing(false);
  }

  const save = async (confirmed = false) => {
    if (draft.name.trim() === '') {
      setFeedback({ tone: 'error', text: t('st.xc.nameRequired') });
      return;
    }
    if (draft.toolPreset === 'custom' && draft.tools.length === 0) {
      setFeedback({ tone: 'error', text: t('st.xc.toolsNoneHint') });
      return;
    }
    const change = policyChangeOf(connection, draftToPatch(draft, connection));
    if (change !== 'none' && !confirmed) {
      setConfirming({ kind: change, action: 'save' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      await api.update(connection.id, draftToPatch(draft, connection));
      setEditing(false);
      setConfirming(null);
      setFeedback({ tone: 'success', text: t('st.xc.saved') });
      onChanged();
    } catch (error) {
      setFeedback({ tone: 'error', text: t('st.xc.error.save', { reason: errorText(locale, error) }) });
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (enabled: boolean, confirmed = false) => {
    if (!enabled && !confirmed) {
      setConfirming({ kind: 'pause', action: 'pause' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      await api.update(connection.id, { enabled });
      setConfirming(null);
      setFeedback({ tone: 'success', text: t(enabled ? 'st.xc.statusActive' : 'st.xc.statusPaused') });
      onChanged();
    } catch (error) {
      setFeedback({ tone: 'error', text: t(enabled ? 'st.xc.error.resume' : 'st.xc.error.pause', { reason: errorText(locale, error) }) });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      await api.revoke(connection.id);
      onChanged();
    } catch (error) {
      setFeedback({ tone: 'error', text: t('st.xc.error.revoke', { reason: errorText(locale, error) }) });
    } finally {
      setBusy(false);
      setRevoking(false);
    }
  };

  const sessionsQuery = useQuery({
    queryKey: [...SESSIONS_QUERY_KEY, connection.id],
    queryFn: () => api.sessions(connection.id),
    staleTime: 30_000,
    retry: false,
  });
  const sessions = sessionsQuery.data?.sessions ?? [];
  const summaryFacts = [
    connection.workspace,
    modeDef === undefined ? connection.mode : t(modeDef.labelKey),
  ].filter(Boolean).join(' · ');

  return (
    <details data-xc-row={connection.id} data-xc-status={connection.status}
      className="group/xc border-b border-hairline last:border-b-0 [&[open]]:bg-paper">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-3 py-2 outline-none transition-colors hover:bg-ink/[0.03] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-selected-ink/40 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-ink/[0.05] text-ink-soft">
          <Icon name="external" size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13px] font-medium text-ink">{connection.name}</span>
          </span>
          <span data-xc-summary className="block truncate text-[12px] text-ink-faint">{summaryFacts}</span>
        </span>
        <span data-xc-status-label
          className={`inline-flex shrink-0 items-center gap-1.5 text-[12px] ${
            revoked ? 'text-danger' : paused ? 'text-amber-ink' : 'text-ink-faint'}`}>
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${
            revoked ? 'bg-danger' : paused ? 'bg-amber-rule' : 'bg-success'}`} />
          <span>{t(STATUS_KEY[connection.status])}</span>
        </span>
        <DisclosureChevron open={false} className="text-ink-faint transition-transform group-open/xc:rotate-90" />
      </summary>
      <div className="space-y-4 px-3 pb-4 pt-1 sm:pl-[3.25rem]">
        {paused ? <p data-xc-paused className="text-[12px] leading-4 text-amber-ink">{t('st.xc.pausedBody')}</p> : null}
        {revoked ? <p data-xc-revoked className="text-[12px] leading-4 text-danger">{t('st.xc.revokedBody')}</p> : null}
        {editing ? (
          <div data-xc-editor className="space-y-3">
            <Field label={t('st.xc.name')} hint={t('st.xc.nameHint')} htmlFor={`xc-name-${connection.id}`}>
              <input id={`xc-name-${connection.id}`} data-xc-name className={INPUT} value={draft.name} disabled={busy}
                placeholder={t('st.xc.namePlaceholder')}
                onChange={(event) => { setDraft({ ...draft, name: event.target.value }); }} />
            </Field>
            <AccessEditor idPrefix={`xc-${connection.id}`} draft={draft} disabled={busy} onChange={setDraft} />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" data-xc-save className={SECONDARY_BUTTON} disabled={busy} aria-busy={busy}
                onClick={() => { void save(); }}>
                {t('common.save')}
              </button>
              <button type="button" data-xc-cancel disabled={busy}
                className="min-h-8 rounded-md px-2.5 text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50"
                onClick={() => { setDraft(draftOf(connection)); setEditing(false); }}>
                {t('common.cancel')}
              </button>
            </div>
            <FeedbackLine feedback={feedback} />
          </div>
        ) : (
          <>
            <dl className="space-y-2">
              {connection.workspace ? (
                <Fact label={t('st.xc.workspace')} fact="workspace">
                  <span className="font-mono text-ink">{connection.workspace}</span>
                </Fact>
              ) : null}
              <Fact label={t('st.xc.mode')} fact="mode">
                {modeDef === undefined ? connection.mode : t(modeDef.labelKey)}
              </Fact>
              <Fact label={t('st.xc.tools')} fact="tools">
                {connection.tools.length === 0
                  ? <span className="text-ink-faint">{t('st.xc.toolsNone')}</span>
                  : <span className="min-w-0">
                    <span className="text-ink">{t(toolsMatchTemplate(connection.tools) ? 'st.xc.toolsAll' : 'st.xc.toolsCount', { count: connection.tools.length })}</span>
                    <span className="block truncate font-mono text-[11px] text-ink-faint" title={connection.tools.join(' · ')}>
                      {connection.tools.join(' · ')}
                    </span>
                  </span>}
              </Fact>
              <Fact label={t('st.xc.commands')} fact="commands">
                <span className={connection.allowCommands ? 'text-amber-ink' : 'text-ink-faint'}>
                  {connection.allowCommands ? t('st.xc.commandsOn') : t('st.xc.off')}
                </span>
              </Fact>
              <Fact label={t('st.xc.history')} fact="history">
                {t(`st.xc.history.${connection.historyScope}`)}
              </Fact>
              <Fact label={t('st.xc.updated')} fact="updated">
                <span className="text-ink-faint">{time.relativeTime(epochToIso(connection.updatedAt))}</span>
              </Fact>
            </dl>
            <LocalAccess connectionId={connection.id} api={api} />
            <div className="space-y-1 border-t border-hairline pt-3">
              <p className="text-[12px] font-medium text-ink-soft">{t('st.xc.sessions')}</p>
              {sessionsQuery.isLoading ? <Hint>{t('st.xc.loading')}</Hint> : null}
              {sessionsQuery.isError ? (
                <p data-xc-sessions-error className="text-[12px] leading-4 text-danger">
                  {t('st.xc.error.sessions', { reason: errorText(locale, sessionsQuery.error) })}
                </p>
              ) : null}
              {!sessionsQuery.isLoading && sessions.length === 0 ? (
                <p data-xc-sessions-empty className="text-[12px] leading-4 text-ink-faint">{t('st.xc.sessionsEmpty')}</p>
              ) : null}
              {sessions.length > 0 ? (
                <ul data-xc-sessions className="space-y-0.5">
                  {sessions.map((session: ExternalClientSession) => (
                    <li key={session.sessionId} data-xc-session={session.sessionId} className="flex min-w-0 items-center gap-2">
                      <button type="button" data-xc-session-open
                        onClick={() => { void navigate(sessionHref(session.sessionId)); }}
                        className="-ml-1.5 flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[12.5px] text-ink-soft transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink">
                        <Icon name="thread" size={12} className="shrink-0 text-ink-faint" />
                        <span className="min-w-0 truncate">{time.relativeTime(epochToIso(session.updatedAt))}</span>
                        <span className="shrink-0 text-[11.5px] text-ink-faint">
                          {t(`st.xc.sessionStatus.${session.status}`)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
              {!revoked ? (
                <>
                  <button type="button" data-xc-edit className={SECONDARY_BUTTON} disabled={busy}
                    onClick={() => { setEditing(true); setFeedback(null); }}>
                    {t('st.xc.detail')}
                  </button>
                  {paused ? (
                    <button type="button" data-xc-resume className={SECONDARY_BUTTON} disabled={busy} aria-busy={busy}
                      onClick={() => { void setStatus(true); }}>
                      {t('st.xc.resume')}
                    </button>
                  ) : (
                    <button type="button" data-xc-pause className={SECONDARY_BUTTON} disabled={busy} aria-busy={busy}
                      onClick={() => { void setStatus(false); }}>
                      {t('st.xc.pause')}
                    </button>
                  )}
                  <button type="button" data-xc-revoke disabled={busy}
                    className="min-h-8 rounded-md border border-danger/40 bg-paper px-3 py-1.5 text-[12px] text-danger transition-colors hover:bg-danger/5 disabled:opacity-50"
                    onClick={() => { setRevoking(true); }}>
                    {t('st.xc.revoke')}
                  </button>
                </>
              ) : null}
            </div>
            <FeedbackLine feedback={feedback} />
          </>
        )}
        <ConfirmDialog open={revoking} title={t('st.xc.revokeConfirmTitle', { name: connection.name })}
          body={t('st.xc.revokeConfirmBody', { name: connection.name })}
          confirmLabel={t('st.xc.revokeConfirm')} tone="danger" busy={busy}
          onConfirm={() => { void revoke(); }} onCancel={() => { setRevoking(false); }} />
        <ConfirmDialog
          open={confirming !== null}
          title={t(confirming?.kind === 'pause' ? 'st.xc.pauseConfirmTitle' : 'st.xc.policyConfirmTitle')}
          body={t(confirming?.kind === 'pause' ? 'st.xc.pauseConfirmBody' : 'st.xc.policyConfirmBody', { name: connection.name })}
          confirmLabel={t(confirming?.kind === 'pause' ? 'st.xc.pause' : 'st.xc.policyConfirm')}
          tone="danger" busy={busy}
          onConfirm={() => {
            if (confirming?.action === 'pause') void setStatus(false, true);
            else void save(true);
          }}
          onCancel={() => { setConfirming(null); }}
        />
      </div>
    </details>
  );
}

// ---- the create flow ----

function CreateConnection({ api, onCreated }: { api: Facade; onCreated: () => void }) {
  const { t, locale } = useI18n();
  const [access, setAccess] = useState<'local' | 'remote'>('local');
  const [draft, setDraft] = useState<ConnectionDraft>(() => draftOf(undefined));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const create = async () => {
    if (draft.name.trim() === '') {
      setFeedback({ tone: 'error', text: t('st.xc.nameRequired') });
      return;
    }
    if (draft.toolPreset === 'custom' && draft.tools.length === 0) {
      setFeedback({ tone: 'error', text: t('st.xc.toolsNoneHint') });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      await api.create({ ...draftToPatch(draft, undefined), name: draft.name.trim() });
      setDraft(draftOf(undefined));
      onCreated();
    } catch (error) {
      setFeedback({ tone: 'error', text: t('st.xc.error.create', { reason: errorText(locale, error) }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-xc-create className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" data-xc-access="local" aria-pressed={access === 'local'}
          onClick={() => { setAccess('local'); }}
          className={`min-h-7 rounded-md border px-2.5 text-[12px] transition-colors ${
            access === 'local' ? 'border-hairline-strong bg-paper font-medium text-ink' : 'border-hairline text-ink-soft hover:border-hairline-strong hover:text-ink'}`}>
          {t('st.xc.addLocal')}
        </button>
        <button type="button" data-xc-access="remote" aria-pressed={access === 'remote'}
          onClick={() => { setAccess('remote'); }}
          className={`min-h-7 rounded-md border px-2.5 text-[12px] transition-colors ${
            access === 'remote' ? 'border-hairline-strong bg-paper font-medium text-ink' : 'border-hairline text-ink-soft hover:border-hairline-strong hover:text-ink'}`}>
          {t('st.xc.addRemote')}
        </button>
      </div>
      <p className="max-w-[62ch] text-[12px] leading-4 text-ink-faint">
        {t(access === 'local' ? 'st.xc.localHint' : 'st.xc.remoteHint')}
      </p>
      <Field label={t('st.xc.name')} hint={t('st.xc.nameHint')} htmlFor="xc-new-name">
        <input id="xc-new-name" data-xc-new-name className={INPUT} value={draft.name} disabled={busy}
          placeholder={t('st.xc.namePlaceholder')}
          onChange={(event) => { setDraft({ ...draft, name: event.target.value }); }} />
      </Field>
      <AccessEditor idPrefix="xc-new" draft={draft} disabled={busy} onChange={setDraft} />
      <button type="button" data-xc-create-submit className={SECONDARY_BUTTON} disabled={busy} aria-busy={busy}
        onClick={() => { void create(); }}>
        {t('st.xc.add')}
      </button>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

// ---- the page ----

export function ExternalClientsSection() {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const api = useMemo(() => externalClientsFacade(client.klient), [client]);
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);

  const listQuery = useQuery({
    queryKey: CLIENTS_QUERY_KEY,
    queryFn: () => api!.list(),
    staleTime: 15_000,
    retry: false,
    enabled: api !== undefined,
  });
  const authQuery = useQuery({
    queryKey: AUTHORIZATIONS_QUERY_KEY,
    queryFn: () => api!.authorizations(),
    staleTime: 10_000,
    retry: false,
    enabled: api !== undefined,
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: CLIENTS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: AUTHORIZATIONS_QUERY_KEY });
  }, [queryClient]);

  const connections = listQuery.data?.connections ?? [];
  const listener = listQuery.data?.listener;
  const authorizations = authQuery.data?.authorizations ?? [];
  const empty = listQuery.isSuccess && connections.length === 0;

  return (
    <SectionCard id="st-card-external-clients" title={t('st.section.connectionServices')}>
      <div data-external-clients className="space-y-3">
        {api === undefined ? (
          <div role="alert" data-xc-unsupported className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2">
            <p className="text-[12px] leading-4 text-ink-soft">{t('st.xc.unsupported')}</p>
          </div>
        ) : null}
        {listQuery.isError ? (
          <div role="alert" data-xc-load-error className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2">
            <p className="text-[12px] leading-4 text-ink-soft">
              {t('st.xc.error.load', { reason: errorText(locale, listQuery.error) })}
            </p>
          </div>
        ) : null}
        {listQuery.isLoading ? <Hint>{t('st.xc.loading')}</Hint> : null}
        {connections.length > 0 ? (
          <div data-xc-list className="overflow-hidden rounded-lg border border-hairline bg-panel">
            {connections.map((connection) => (
              <ConnectionRow key={connection.id} connection={connection} api={api!} onChanged={refresh} />
            ))}
          </div>
        ) : null}
        {empty ? (
          <div data-xc-empty>
            <ListEmpty kind="none" title={t('st.xc.emptyListTitle')} body={t('st.xc.emptyListBody')}
              action={adding ? undefined : (
                <button type="button" data-xc-add className={SECONDARY_BUTTON} onClick={() => { setAdding(true); }}>
                  {t('st.xc.add')}
                </button>
              )} />
          </div>
        ) : null}
        {connections.length > 0 && !adding ? (
          <button type="button" data-xc-add className={SECONDARY_BUTTON} onClick={() => { setAdding(true); }}>
            <span className="inline-flex items-center gap-1.5">
              <Icon name="plus" size={12} />
              {t('st.xc.add')}
            </span>
          </button>
        ) : null}
        {adding && api !== undefined ? (
          <div data-xc-create-panel className="space-y-3 border-t border-hairline pt-4">
            <CreateConnection api={api} onCreated={() => { setAdding(false); refresh(); }} />
            <button type="button" data-xc-create-cancel
              className="min-h-8 rounded-md px-2.5 text-[12px] text-ink-faint transition-colors hover:bg-ink/[0.05] hover:text-ink"
              onClick={() => { setAdding(false); }}>
              {t('common.cancel')}
            </button>
          </div>
        ) : null}
        {authorizations.length > 0 && api !== undefined ? (
          <div className="border-t border-hairline pt-4">
            <AuthorizationPanel requests={authorizations} api={api} onChanged={refresh} />
          </div>
        ) : null}
        {listener !== undefined && api !== undefined ? (
          <div className="border-t border-hairline pt-4">
            <ListenerPanel listener={listener} api={api} onChanged={refresh} />
            <div className="mt-3 border-t border-hairline pt-3">
              <RemoteAccess listener={listener} />
            </div>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
