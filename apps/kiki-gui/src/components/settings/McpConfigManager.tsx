import { useEffect, useRef, useState, type SetStateAction } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { mcpConfigFromDraft, type McpEditorDraft } from '@kiki/session-core/settings';
import type { GlobalMcpFacade, GlobalMcpServerConfig } from '@kiki/klient';
import type { McpServer } from '@kiki/protocol';
import type {
  McpManagedServer,
  McpManagedServerConfig,
  McpServerConfig,
  McpTransport,
} from '@kiki/session-core/transport';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { DANGER_GHOST_BUTTON, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { useDirtyGuard, useDirtyReporter } from '../dirtyGuard';
import { CapabilityIcon } from '../capabilities/CapabilityIcon';
import { Disclosure, StatusDot, Tag } from '../capabilities/primitives';
import { McpBearerValue, McpSecretRows, mcpSecretLines, mcpSecretRows, type McpSecretRow } from './McpSecretRows';

/**
 * Listings arrive redacted (`envKeys` / `headerKeys`); an older server may
 * still send the values, which are then carried without a reveal round-trip.
 */
function mcpSecretMap(
  config: McpManagedServerConfig | undefined,
  field: 'env' | 'headers',
): Readonly<Record<string, string>> | undefined {
  if (config === undefined || !(field in config)) return undefined;
  const value = (config as unknown as Record<string, unknown>)[field];
  return value as Readonly<Record<string, string>> | undefined;
}

function mcpSecretKeys(config: McpManagedServerConfig, field: 'envKeys' | 'headerKeys'): readonly string[] | undefined {
  const value = (config as unknown as Record<string, unknown>)[field];
  return Array.isArray(value) ? value as readonly string[] : undefined;
}

/** The editor draft: the shared text draft plus per-row secret state. */
type McpDraft = McpEditorDraft & { readonly envRows: readonly McpSecretRow[]; readonly headerRows: readonly McpSecretRow[] };

function mcpDraft(entry?: McpManagedServer): McpDraft {
  if (entry === undefined) {
    return { name: '', transport: 'stdio', command: '', args: '', env: '', url: '', headers: '', bearerTokenEnvVar: '', envRows: [], headerRows: [] };
  }
  const config = entry.config;
  return {
    original: entry,
    name: entry.name,
    transport: config.transport,
    command: config.transport === 'stdio' ? config.command : '',
    args: config.transport === 'stdio' ? (config.args ?? []).join('\n') : '',
    env: '',
    url: config.transport === 'stdio' ? '' : config.url,
    headers: '',
    envRows: entry.mutable && config.transport === 'stdio'
      ? mcpSecretRows(mcpSecretKeys(config, 'envKeys'), mcpSecretMap(config, 'env')) : [],
    headerRows: entry.mutable && config.transport !== 'stdio'
      ? mcpSecretRows(mcpSecretKeys(config, 'headerKeys'), mcpSecretMap(config, 'headers')) : [],
    bearerTokenEnvVar: entry.mutable && config.transport !== 'stdio' ? config.bearerTokenEnvVar ?? '' : '',
    auth: entry.mutable && config.transport !== 'stdio' ? config.auth : undefined,
  };
}

function klientMcpServer(config: McpServerConfig, name: string): GlobalMcpServerConfig {
  const enabledTools = config.enabledTools === undefined ? undefined : [...config.enabledTools];
  const disabledTools = config.disabledTools === undefined ? undefined : [...config.disabledTools];
  if (config.transport === 'stdio') {
    return {
      ...config,
      name,
      args: config.args === undefined ? undefined : [...config.args],
      enabledTools,
      disabledTools,
    };
  }
  return { ...config, name, enabledTools, disabledTools };
}

function breakableOAuthUrl(url: string): string {
  if (url.length <= 36) return url;
  return Array.from(url).reduce((parts, character, index) => parts + character + ((index + 1) % 24 === 0 ? '\u200B' : ''), '');
}

function canonicalOAuthUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.toString();
}

function maskedOAuthUrl(url: string): string {
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return '…';
  }
}

type StoredOAuthCredential = Awaited<ReturnType<GlobalMcpFacade['listStoredOAuthCredentials']>>[number];

/** Live runtime state joined onto a configured entry by server name. */
export interface McpRuntimeView {
  readonly servers: readonly McpServer[];
  readonly toolsByServer: ReadonlyMap<string, readonly string[]>;
  readonly onRestart: (serverId: string) => Promise<void>;
}

/** Row-trailing Edit: quiet at rest so a list of servers is not a column of buttons. */
const QUIET_EDIT = 'inline-flex min-h-8 items-center rounded-md px-2.5 text-[13px] text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 pointer-coarse:min-h-11';

function runtimeDotState(status: McpServer['status'] | undefined): 'ok' | 'busy' | 'error' | 'off' {
  return status === 'connected' ? 'ok' : status === 'connecting' ? 'busy' : status === 'error' ? 'error' : 'off';
}

export function McpConfigManager({
  cwd,
  entries,
  loading,
  error,
  onEcho,
  runtime,
}: {
  cwd: string;
  entries: readonly McpManagedServer[];
  loading: boolean;
  error: unknown;
  onEcho: (servers: readonly McpManagedServer[]) => void;
  /** Runtime status, tools and restart; absent → configuration only. */
  runtime?: McpRuntimeView;
}) {
  const { klient, client, scopeId } = useConnection();
  const { t, tp, locale } = useI18n();
  const queryClient = useQueryClient();
  const testRevision = useRef(0);
  const resetRevision = useRef(0);
  const revealRevision = useRef(0);
  const [revealedUrl, setRevealedUrl] = useState<{ scopeId: typeof scopeId; credentialId: string; url: string | null } | null>(null);
  const [revealErrorId, setRevealErrorId] = useState<string | null>(null);
  const [draft, setDraftState] = useState<McpDraft | null>(null);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(mcpDraft(draft.original));
  useDirtyReporter(`mcp-editor:${scopeId}:${cwd}`, dirty);
  const guard = useDirtyGuard();
  const switchDraft = (next: McpDraft | null) => {
    const apply = () => { setDraft(next); };
    if (dirty && guard?.confirmDiscard !== undefined) guard.confirmDiscard(`mcp-editor:${scopeId}:${cwd}`, apply);
    else apply();
  };
  const [expanded, setExpanded] = useState<string | null>(null);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [oauthFeedback, setOauthFeedback] = useState<Feedback>(null);
  const [pendingDelete, setPendingDelete] = useState<McpManagedServer | null>(null);
  const [pendingReset, setPendingReset] = useState<McpManagedServer | null>(null);
  const [pendingStoredReset, setPendingStoredReset] = useState<StoredOAuthCredential | null>(null);
  const setDraft = (next: SetStateAction<McpDraft | null>) => {
    testRevision.current++;
    setTesting(false);
    setFeedback(null);
    setDraftState(next);
  };
  useEffect(() => {
    testRevision.current++;
    resetRevision.current++;
    revealRevision.current++;
    setRevealedUrl(null);
    setRevealErrorId(null);
    setDraftState(null);
    setTesting(false);
    setResetting(false);
    setPendingReset(null);
    setPendingStoredReset(null);
    setFeedback(null);
    setOauthFeedback(null);
    return () => { testRevision.current++; resetRevision.current++; revealRevision.current++; };
  }, [cwd, scopeId]);

  const scope = cwd === '' ? undefined : cwd;
  const savedCredentialsQuery = useQuery({
    queryKey: ['mcp-oauth-credentials', scopeId],
    queryFn: () => klient.global.mcp.listStoredOAuthCredentials(),
    staleTime: 10_000,
  });
  const savedCredentials = savedCredentialsQuery.isSuccess ? savedCredentialsQuery.data : undefined;
  const canResetOAuth = (entry: McpManagedServer) => {
    if (!entry.mutable || entry.source !== 'global' || entry.config.transport === 'stdio') return false;
    const matches = entries.filter((candidate) => candidate.name === entry.name);
    return matches.length === 1 && matches[0]!.source === 'global' && matches[0]!.mutable &&
      matches[0]!.config.transport === entry.config.transport && matches[0]!.config.url === entry.config.url;
  };
  const oldOAuthTarget = draft?.original;
  const oldOAuthTargetChanged = draft !== null && oldOAuthTarget !== undefined && canResetOAuth(oldOAuthTarget) &&
    (draft.name.trim() !== oldOAuthTarget.name || draft.transport !== oldOAuthTarget.config.transport ||
      (draft.transport !== 'stdio' && oldOAuthTarget.config.transport !== 'stdio' && draft.url !== oldOAuthTarget.config.url));
  const bearerRefActive = draft !== null && draft.transport !== 'stdio' && draft.bearerTokenEnvVar.trim() !== '';
  const hasAuthorizationHeader = (draft?.headerRows ?? []).some((row) => row.key.trim().toLowerCase() === 'authorization');
  // Saved values are read under the name the entry was listed with, so a
  // renamed draft still carries them forward.
  const originalName = draft?.original?.mutable === true ? draft.original.name : undefined;
  const revealMcp = (kind: 'mcp_env' | 'mcp_header') => originalName === undefined ? undefined
    : async (key: string) => (await client.revealSecret({ kind, server: originalName, key, cwd: scope })).value;
  const revealEnv = revealMcp('mcp_env');
  const revealHeader = revealMcp('mcp_header');
  const revealBearer = originalName === undefined || draft?.original?.config.transport === 'stdio'
    || draft?.original?.config.bearerTokenEnvVar === undefined ? undefined
    : async () => (await client.revealSecret({ kind: 'mcp_bearer_env', server: originalName, cwd: scope })).value;

  const draftConfig = async (): Promise<McpServerConfig | null> => {
    if (draft === null) return null;
    try {
      const noValue = async () => undefined;
      return mcpConfigFromDraft({
        ...draft,
        env: await mcpSecretLines(draft.envRows, revealEnv ?? noValue),
        headers: await mcpSecretLines(draft.headerRows, revealHeader ?? noValue),
      });
    } catch (error) {
      const key = error instanceof Error ? error.message as I18nKey : 'st.mcp.urlInvalid';
      setFeedback({ tone: 'error', text: t(key) });
      return null;
    }
  };

  const save = async () => {
    if (draft === null) return;
    const name = draft.name.trim();
    if (name === '') {
      setFeedback({ tone: 'error', text: t('st.mcp.nameRequired') });
      return;
    }
    testRevision.current++;
    setTesting(false);
    setSaving(true);
    setFeedback(null);
    try {
      const config = await draftConfig();
      if (config === null) return;
      const original = draft.original;
      // A rename cannot be expressed as one write: add the new identity first,
      // then drop the old one so a mid-flight failure never loses the entry.
      const server = klientMcpServer(config, name);
      let echoed = original === undefined || original.name !== name
        ? await klient.global.mcp.add({ server, cwd: scope })
        : await klient.global.mcp.update({ server, cwd: scope });
      onEcho(echoed);
      if (original !== undefined && original.name !== name) {
        echoed = await klient.global.mcp.remove({ name: original.name, cwd: scope });
        onEcho(echoed);
      }
      setDraft(null);
      setFeedback({ tone: 'success', text: t('st.mcp.saved') });
      await queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
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
    const revision = ++testRevision.current;
    setTesting(true);
    setFeedback(null);
    try {
      const config = await draftConfig();
      if (config === null || testRevision.current !== revision) return;
      // Probes the draft as typed — nothing has to be saved first.
      const result = await klient.global.mcp.test({ server: klientMcpServer(config, name), cwd: scope });
      if (testRevision.current === revision) {
        setFeedback(
          result.success
            ? { tone: 'success', text: t('st.mcp.testOk', { output: result.output }) }
            : { tone: 'error', text: t('st.mcp.testFailed', { output: result.output }) },
        );
      }
    } catch (error) {
      if (testRevision.current === revision) setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      if (testRevision.current === revision) setTesting(false);
    }
  };

  const remove = async () => {
    const entry = pendingDelete;
    if (entry === null) return;
    testRevision.current++;
    setTesting(false);
    setSaving(true);
    setFeedback(null);
    setPendingDelete(null);
    try {
      const echoed = await klient.global.mcp.remove({ name: entry.name, cwd: scope });
      onEcho(echoed);
      if (draft?.original?.name === entry.name) setDraft(null);
      setFeedback({ tone: 'success', text: t('st.mcp.deleted') });
      await queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const resetOAuth = async () => {
    const entry = pendingReset;
    if (entry === null || resetting) return;
    if (!canResetOAuth(entry)) {
      setPendingReset(null);
      setOauthFeedback({ tone: 'error', text: t('st.mcp.oauthTargetChanged') });
      return;
    }
    const revision = ++resetRevision.current;
    setResetting(true);
    setOauthFeedback(null);
    try {
      await klient.global.mcp.resetAuth({
        locator: { source: 'global', name: entry.name }, cwd: scope,
        expectedCanonicalUrl: canonicalOAuthUrl(entry.config.transport === 'stdio' ? '' : entry.config.url),
      });
      if (resetRevision.current === revision) {
        revealRevision.current++;
        setRevealedUrl(null);
        setRevealErrorId(null);
        setPendingReset(null);
        setOauthFeedback({ tone: 'success', text: t('st.mcp.oauthRemoved') });
      }
      void queryClient.invalidateQueries({ queryKey: ['mcp-servers'] }).catch(() => undefined);
      void queryClient.invalidateQueries({ queryKey: ['mcp-oauth-credentials', scopeId] }).catch(() => undefined);
    } catch {
      if (resetRevision.current === revision) {
        setPendingReset(null);
        setOauthFeedback({ tone: 'error', text: t('st.mcp.oauthResetError') });
      }
    } finally {
      if (resetRevision.current === revision) setResetting(false);
    }
  };

  const toggleStoredUrl = async (credential: StoredOAuthCredential) => {
    if (revealedUrl?.scopeId === scopeId && revealedUrl.credentialId === credential.credentialId) {
      revealRevision.current++;
      setRevealedUrl(null);
      setRevealErrorId(null);
      return;
    }
    const revision = ++revealRevision.current;
    setRevealedUrl({ scopeId, credentialId: credential.credentialId, url: null });
    setRevealErrorId(null);
    try {
      const result = await klient.global.mcp.revealStoredOAuthCredential({ credentialId: credential.credentialId });
      if (revealRevision.current === revision) {
        setRevealedUrl({ scopeId, credentialId: credential.credentialId, url: result.canonicalUrl });
      }
    } catch {
      if (revealRevision.current === revision) {
        setRevealedUrl(null);
        setRevealErrorId(credential.credentialId);
        void queryClient.invalidateQueries({ queryKey: ['mcp-oauth-credentials', scopeId] }).catch(() => undefined);
      }
    }
  };

  const revokeStoredOAuth = async () => {
    const target = pendingStoredReset;
    if (target === null || resetting) return;
    const revision = ++resetRevision.current;
    setResetting(true);
    setOauthFeedback(null);
    try {
      await klient.global.mcp.revokeStoredOAuthCredential({ credentialId: target.credentialId });
      if (resetRevision.current === revision) {
        revealRevision.current++;
        setRevealedUrl(null);
        setRevealErrorId(null);
        setPendingStoredReset(null);
        setOauthFeedback({ tone: 'success', text: t('st.mcp.oauthRemoved') });
      }
      void queryClient.invalidateQueries({ queryKey: ['mcp-oauth-credentials', scopeId] }).catch(() => undefined);
      void queryClient.invalidateQueries({ queryKey: ['mcp-servers'] }).catch(() => undefined);
    } catch {
      if (resetRevision.current === revision) {
        setPendingStoredReset(null);
        setOauthFeedback({ tone: 'error', text: t('st.mcp.oauthResetError') });
        void queryClient.invalidateQueries({ queryKey: ['mcp-oauth-credentials', scopeId] }).catch(() => undefined);
      }
    } finally {
      if (resetRevision.current === revision) setResetting(false);
    }
  };

  const editor = draft === null ? null : (
        <fieldset className="space-y-3 rounded-xl border border-hairline bg-paper p-3" disabled={saving || resetting}>
          <p className="text-[12px] font-semibold text-ink">
            {draft.original === undefined
              ? t('st.mcp.add')
              : t('st.mcp.formTitleEdit')}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-[11px] font-medium text-ink-soft">
              {t('st.mcp.name')}
              <input className={INPUT} value={draft.name} placeholder={t('st.mcp.namePlaceholder')} onChange={(event) => { setDraft({ ...draft, name: event.target.value }); }} />
              <Hint>{t('st.mcp.nameHint')}</Hint>
            </label>
            <label className="space-y-1 text-[11px] font-medium text-ink-soft">
              {t('st.mcp.transport')}
              <select className={INPUT} value={draft.transport} onChange={(event) => {
                setDraft({ ...draft, transport: event.target.value as McpTransport, headerRows: [], envRows: [], bearerTokenEnvVar: '', auth: undefined });
              }}>
                <option value="stdio">stdio</option>
                <option value="http">http</option>
                <option value="sse">sse</option>
              </select>
            </label>
          </div>
          {draft.transport === 'stdio' ? (
            <div className="space-y-3">
              <label className="block space-y-1 text-[11px] font-medium text-ink-soft">
                {t('st.mcp.command')}
                <input className={`${INPUT} font-mono`} value={draft.command} onChange={(event) => { setDraft({ ...draft, command: event.target.value }); }} />
              </label>
              <label className="block space-y-1 text-[11px] font-medium text-ink-soft">
                {t('st.mcp.args')}
                <textarea className={`${INPUT} min-h-20 font-mono`} value={draft.args} onChange={(event) => { setDraft({ ...draft, args: event.target.value }); }} placeholder={t('st.mcp.argsPlaceholder')} />
              </label>
              <McpSecretRows kind="env" rows={draft.envRows} reveal={revealEnv}
                onChange={(envRows) => { setDraft({ ...draft, envRows }); }} />
            </div>
          ) : (
            <div className="space-y-3">
              <label className="block space-y-1 text-[11px] font-medium text-ink-soft">
                {t('st.mcp.url')}
                <input className={`${INPUT} font-mono`} value={draft.url} onChange={(event) => {
                  if (event.target.value !== draft.url) {
                    setDraft({ ...draft, url: event.target.value, headerRows: [], bearerTokenEnvVar: '', auth: undefined });
                  }
                }} placeholder="https://mcp.example.com" spellCheck={false} />
              </label>
              <div className="space-y-2">
                <label className="block space-y-1 text-[11px] font-medium text-ink-soft">
                  {t('st.mcp.bearerEnv')}
                  <input data-mcp-bearer-env className={`${INPUT} font-mono`} value={draft.bearerTokenEnvVar} onChange={(event) => { setDraft({ ...draft, bearerTokenEnvVar: event.target.value }); }} spellCheck={false} autoComplete="off" />
                </label>
                {bearerRefActive ? (
                  <button type="button" className={SECONDARY_BUTTON} onClick={() => { setDraft({ ...draft, bearerTokenEnvVar: '' }); }}>{t('st.mcp.clearBearerEnv')}</button>
                ) : null}
                <Hint>{t('st.mcp.bearerEnvHint')}</Hint>
                {bearerRefActive && revealBearer !== undefined && draft.original?.config.transport !== 'stdio'
                  && draft.bearerTokenEnvVar.trim() === draft.original?.config.bearerTokenEnvVar ? (
                  <McpBearerValue label={t('st.secret.bearerValue')} envName={draft.bearerTokenEnvVar.trim()} reveal={revealBearer} />
                ) : null}
                <p role="status" className="border-l-2 border-accent pl-2 text-[11px] text-ink-soft">
                  {t(bearerRefActive ? 'st.mcp.authSourceEnv' : hasAuthorizationHeader ? 'st.mcp.authSourceHeader' : 'st.mcp.authSourceOAuth')}
                </p>
                {draft.auth === 'oauth' ? <Hint>{t('st.mcp.oauthConfigured')}</Hint> : null}
              </div>
              <div>
                <McpSecretRows kind="headers" rows={draft.headerRows} reveal={revealHeader}
                  disabledKey={bearerRefActive ? 'authorization' : undefined} disabledHint={t('st.mcp.headerOverridden')}
                  onChange={(headerRows) => { setDraft({ ...draft, headerRows }); }} />
              </div>
            </div>
          )}
          {oldOAuthTargetChanged && oldOAuthTarget?.config.transport !== 'stdio' ? (
            <p role="status" className="break-words border-l-2 border-danger pl-2 text-[11px] leading-relaxed text-ink-soft">
              {t('st.mcp.oauthOldTarget', { name: oldOAuthTarget.name, url: oldOAuthTarget.config.url })}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={PRIMARY_BUTTON} disabled={draft.name.trim() === ''} onClick={() => void save()}>{saving ? t('common.saving') : t('common.save')}</button>
            <button type="button" className={SECONDARY_BUTTON} disabled={testing || draft.name.trim() === ''} onClick={() => void test()}>{testing ? t('st.mcp.testing') : t('st.mcp.test')}</button>
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { setDraft(null); }}>{t('common.cancel')}</button>
          </div>
        </fieldset>
  );

  const runtimeFor = (entry: McpManagedServer) => {
    if (runtime === undefined) return undefined;
    const runtimeId = entry.source === 'plugin' && entry.plugin !== undefined ? undefined : entry.name;
    return runtime.servers.find((server) => server.name === entry.name || server.id === runtimeId);
  };

  // Servers that need attention lead; everything else keeps config order.
  const needsAttention = (entry: McpManagedServer) => {
    const status = runtimeFor(entry)?.status;
    return status === 'error' || status === 'disconnected';
  };
  const ordered = [...entries.filter(needsAttention), ...entries.filter((entry) => !needsAttention(entry))];
  const liveCount = entries.filter((entry) => runtimeFor(entry)?.status === 'connected').length;
  const failing = entries.filter(needsAttention).length;

  return (
    <div className="space-y-3" data-mcp-manager>
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline pb-1.5">
        <h2 className="text-[13px] font-medium text-ink">{t('st.mcp.configTitle')}</h2>
        {entries.length > 0 && runtime !== undefined ? (
          <p className="text-[12px] text-ink-faint tabular-nums" data-mcp-summary>
            {tp('cap.mcp.summary', entries.length, { connected: liveCount })}
            {failing > 0 ? <span className="text-danger"> · {tp('cap.mcp.failing', failing)}</span> : null}
          </p>
        ) : (
          <span className="text-[12px] text-ink-faint tabular-nums">{entries.length > 0 ? entries.length : ''}</span>
        )}
        <button
          type="button"
          className={`${SECONDARY_BUTTON} ms-auto shrink-0`}
          data-mcp-add
          disabled={saving || resetting}
          onClick={() => { switchDraft(mcpDraft()); }}
        >
          {t('st.mcp.add')}
        </button>
      </div>
      <Hint>{t('st.mcp.configHint')}</Hint>
      {draft !== null && draft.original === undefined ? editor : null}
      <div className="space-y-0.5">
        {ordered.map((entry) => {
          const live = runtimeFor(entry);
          const open = expanded === `${entry.source}:${entry.name}`;
          const tools = live === undefined ? [] : runtime?.toolsByServer.get(live.id) ?? [];
          const statusLabel = live === undefined ? t('st.mcp.status.notRunning') : t(`st.mcp.status.${live.status}`);
          const editing = draft?.original?.name === entry.name && draft.original.source === entry.source;
          return (
            <div key={`${entry.source}:${entry.name}`} data-mcp-server={entry.name} data-mcp-status={live?.status ?? 'unknown'}>
              <div className="group flex min-h-14 min-w-0 items-center gap-3 rounded-lg px-2 py-2 transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04]">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => { setExpanded(open ? null : `${entry.source}:${entry.name}`); }}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <CapabilityIcon kind="mcp" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-ink">{entry.name}</span>
                      {live !== undefined ? <StatusDot state={runtimeDotState(live.status)} label={statusLabel} /> : null}
                      {entry.mutable ? null : <Tag>{entry.plugin !== undefined ? t('st.mcp.fromPlugin', { name: entry.plugin.name }) : t('st.mcp.readOnly')}</Tag>}
                    </span>
                    <span className={`mt-0.5 block truncate text-[12px] leading-4 ${live?.status === 'error' ? 'text-danger' : 'text-ink-faint'}`}>
                      {live?.status === 'error' && live.last_error !== undefined
                        ? live.last_error
                        : [
                            entry.config.transport,
                            live === undefined ? statusLabel : live.status === 'connected' ? tp('cap.mcp.tools', live.tool_count) : statusLabel,
                            entry.config.transport === 'stdio' ? entry.config.command : entry.config.url,
                          ].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  {live !== undefined && runtime !== undefined && (live.status === 'error' || live.status === 'disconnected') ? (
                    <button type="button" className={SECONDARY_BUTTON} data-mcp-reconnect={entry.name}
                      onClick={() => { void runtime.onRestart(live.id); }}>{t('st.mcp.reconnect')}</button>
                  ) : null}
                  {entry.mutable ? (
                    <button
                      type="button"
                      className={QUIET_EDIT}
                      disabled={saving || resetting}
                      aria-label={`${t('st.mcp.edit')} ${entry.name}`}
                      onClick={() => { switchDraft(mcpDraft(entry)); }}
                    >{t('st.mcp.edit')}</button>
                  ) : null}
                </div>
              </div>
              {editing ? <div className="pl-2 pr-2 pb-3">{editor}</div> : null}
              <div className="expand-collapse grid" style={{ gridTemplateRows: open && !editing ? '1fr' : '0fr' }}>
                <div className="overflow-hidden" inert={!open || editing}>
                  <div className="space-y-4 pb-4 pl-14 pr-2 pt-1" data-mcp-server-detail={entry.name}>
                    {live?.status === 'error' && live.last_error !== undefined ? (
                      <div className="space-y-1" data-mcp-error={entry.name}>
                        <pre className="max-h-40 overflow-auto rounded-md bg-shell px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap text-shell-ink">{live.last_error}</pre>
                        <p className="text-[12px] leading-4 text-ink-faint">{t('st.mcp.errorHint')}</p>
                      </div>
                    ) : null}
                    <div>
                      <p className="text-[12px] font-medium text-ink-soft">{t('st.mcp.toolsTitle')}</p>
                      {tools.length > 0 ? (
                        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[12px] text-ink-soft">
                          {tools.map((tool) => <li key={tool}>{tool}</li>)}
                        </ul>
                      ) : (
                        <p className="mt-1 text-[12px] text-ink-faint">
                          {live?.status === 'connected' ? tp('cap.mcp.tools', live.tool_count) : t('st.mcp.toolsWhenConnected')}
                        </p>
                      )}
                    </div>
                    <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12px] leading-4">
                      <dt className="text-ink-faint">{t('st.mcp.transport')}</dt>
                      <dd className="font-mono text-ink-soft">{entry.config.transport}</dd>
                      <dt className="text-ink-faint">{entry.config.transport === 'stdio' ? t('st.mcp.command') : t('st.mcp.url')}</dt>
                      <dd className="min-w-0 break-all font-mono text-ink-soft">
                        {entry.config.transport === 'stdio' ? [entry.config.command, ...(entry.config.args ?? [])].join(' ') : entry.config.url}
                      </dd>
                      <dt className="text-ink-faint">{t('st.mcp.origin')}</dt>
                      <dd className="min-w-0 break-all font-mono text-ink-soft" title={entry.origin}>{entry.plugin?.name ?? entry.origin}</dd>
                    </dl>
                    <div className="flex flex-wrap gap-2">
                      {entry.plugin !== undefined ? (
                        <Link to={{ pathname: '/capabilities', search: `?tab=plugins&plugin=${encodeURIComponent(entry.plugin.id)}` }}
                          className="inline-flex min-h-8 items-center text-[13px] font-medium text-accent-ink hover:underline">
                          {t('st.plugins.manageLink')}
                        </Link>
                      ) : null}
                      {live !== undefined && runtime !== undefined && live.status === 'connected' ? (
                        <button type="button" className={SECONDARY_BUTTON} onClick={() => { void runtime.onRestart(live.id); }}>{t('st.mcp.restart')}</button>
                      ) : null}
                      {entry.mutable ? (
                        <button type="button" className={DANGER_GHOST_BUTTON} disabled={saving || resetting} onClick={() => { setPendingDelete(entry); }}>{t('st.mcp.delete')}</button>
                      ) : null}
                      {canResetOAuth(entry) ? (
                        <button
                          type="button"
                          className={DANGER_GHOST_BUTTON}
                          disabled={saving || resetting || loading || error !== null}
                          onClick={() => { setPendingReset(entry); setOauthFeedback(null); }}
                        >{t('st.mcp.oauthDisconnect')}</button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {loading ? <Hint>{t('st.mcp.configLoading')}</Hint> : null}
        {!loading && entries.length === 0 && draft === null ? (
          <div className="rounded-lg px-2 py-6" data-capability-empty>
            <p className="text-[13px] text-ink-soft">{t('st.mcp.empty')}</p>
            <p className="mt-1 max-w-[62ch] text-[12px] leading-4 text-ink-faint">{t('st.mcp.emptyBody')}</p>
          </div>
        ) : null}
        {error !== null ? <InlineError error={error} /> : null}
      </div>
      <section aria-label={t('st.mcp.storedOAuthTitle')} className="border-t border-hairline pt-3" data-mcp-credentials>
        <Disclosure
          label={savedCredentials !== undefined && savedCredentials.length > 0 ? `${t('st.mcp.storedOAuthTitle')} · ${savedCredentials.length}` : t('st.mcp.storedOAuthTitle')}
          open={credentialsOpen}
          onToggle={() => { setCredentialsOpen((value) => !value); }}
        >
        <div className="space-y-2">
        <Hint>{t('st.mcp.storedOAuthHint')}</Hint>
        {savedCredentialsQuery.isPending ? <Hint>{t('st.mcp.storedOAuthLoading')}</Hint> : null}
        {savedCredentialsQuery.isError ? (
          <div className="space-y-2">
            <p role="alert" className="text-[12px] text-danger">{t('st.mcp.storedOAuthError')}</p>
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { void savedCredentialsQuery.refetch(); }}>
              {t('st.mcp.storedOAuthRetry')}
            </button>
          </div>
        ) : null}
        {savedCredentials?.length === 0 ? <Hint>{t('st.mcp.storedOAuthEmpty')}</Hint> : null}
        {savedCredentials?.map((credential) => {
          const revealed = revealedUrl?.scopeId === scopeId && revealedUrl.credentialId === credential.credentialId
            ? revealedUrl : null;
          return (
            <div key={credential.credentialId} className="flex min-w-0 flex-col items-stretch gap-3 rounded-lg border border-hairline bg-paper px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink">{credential.serverName}</p>
                <p className="break-all font-mono text-[11px] text-ink-faint">{credential.displayUrl}</p>
                {revealed?.url !== null && revealed?.url !== undefined ? (
                  <p className="break-all font-mono text-[11px] text-ink">{breakableOAuthUrl(revealed.url)}</p>
                ) : null}
                {revealed?.url === null ? <p role="status" className="text-[11px] text-ink-soft">{t('st.mcp.storedOAuthRevealing')}</p> : null}
                {revealErrorId === credential.credentialId ? <p role="alert" className="text-[11px] text-danger">{t('st.mcp.storedOAuthRevealError')}</p> : null}
                <Hint>{t('st.mcp.storedOAuthOriginUnknown')} · {t('st.mcp.storedOAuthIdentity', { id: credential.credentialId.slice(0, 8) })}</Hint>
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <button
                  type="button"
                  className={`${SECONDARY_BUTTON} min-h-11`}
                  aria-pressed={revealed !== null}
                  disabled={saving || resetting}
                  onClick={() => { void toggleStoredUrl(credential); }}
                >{t(revealed !== null ? 'st.mcp.storedOAuthHide' : 'st.mcp.storedOAuthReveal')}</button>
                <button
                  type="button"
                  className={`${DANGER_GHOST_BUTTON} min-h-11`}
                  aria-label={t('st.mcp.storedOAuthClearLabel', { name: credential.serverName, url: `${credential.displayUrl} · ${credential.credentialId.slice(0, 8)}` })}
                  disabled={saving || resetting || savedCredentialsQuery.isFetching}
                  onClick={() => { setPendingStoredReset(credential); setOauthFeedback(null); }}
                >{t('st.mcp.storedOAuthClear')}</button>
              </div>
            </div>
          );
        })}
        </div>
        </Disclosure>
      </section>
      <FeedbackLine feedback={feedback} />
      <FeedbackLine feedback={oauthFeedback} />
      <ConfirmDialog
        open={pendingReset !== null}
        overlayId="confirm-mcp-oauth-reset"
        title={t('st.mcp.oauthConfirmTitle', { name: pendingReset?.name ?? '' })}
        body={t('st.mcp.oauthConfirmBody', { url: pendingReset?.config.transport === 'stdio' ? '' : maskedOAuthUrl(pendingReset?.config.url ?? '') })}
        confirmLabel={t('st.mcp.oauthConfirmAction')}
        tone="danger"
        busy={resetting}
        onConfirm={() => { void resetOAuth(); }}
        onCancel={() => { if (!resetting) setPendingReset(null); }}
      />
      <ConfirmDialog
        open={pendingStoredReset !== null}
        overlayId="confirm-mcp-stored-oauth-revoke"
        title={t('st.mcp.storedOAuthConfirmTitle', { name: pendingStoredReset?.serverName ?? '' })}
        body={t('st.mcp.storedOAuthConfirmBody', { url: pendingStoredReset === null ? '' : `${pendingStoredReset.displayUrl} · ${pendingStoredReset.credentialId.slice(0, 8)}` })}
        confirmLabel={t('st.mcp.oauthConfirmAction')}
        tone="danger"
        busy={resetting}
        onConfirm={() => { void revokeStoredOAuth(); }}
        onCancel={() => { if (!resetting) setPendingStoredReset(null); }}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        overlayId="confirm-mcp-delete"
        title={t('st.mcp.deleteTitle')}
        body={t('st.mcp.deleteBody', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('st.mcp.delete')}
        tone="danger"
        onConfirm={() => { void remove(); }}
        onCancel={() => { setPendingDelete(null); }}
      />
    </div>
  );
}
