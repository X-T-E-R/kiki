import { useEffect, useRef, useState, type SetStateAction } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { mcpConfigFromDraft, type McpEditorDraft } from '@kiki/session-core/settings';
import type { GlobalMcpFacade, GlobalMcpServerConfig } from '@kiki/klient';
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

/**
 * Read-only entries reach us redacted (`envKeys` / `headerKeys` instead of the
 * values), so secrets can only be carried forward for the writable entries the
 * editor actually opens.
 */
function mcpSecretMap(
  config: McpManagedServerConfig | undefined,
  field: 'env' | 'headers',
): Readonly<Record<string, string>> | undefined {
  if (config === undefined || !(field in config)) return undefined;
  const value = (config as unknown as Record<string, unknown>)[field];
  return value as Readonly<Record<string, string>> | undefined;
}

function mcpDraft(entry?: McpManagedServer): McpEditorDraft {
  if (entry === undefined) {
    return { name: '', transport: 'stdio', command: '', args: '', env: '', url: '', headers: '', bearerTokenEnvVar: '' };
  }
  const config = entry.config;
  return {
    original: entry,
    name: entry.name,
    transport: config.transport,
    command: config.transport === 'stdio' ? config.command : '',
    args: config.transport === 'stdio' ? (config.args ?? []).join('\n') : '',
    env: entry.mutable && config.transport === 'stdio'
      ? Object.entries(mcpSecretMap(config, 'env') ?? {}).map(([key, value]) => `${key}=${value}`).join('\n')
      : '',
    url: config.transport === 'stdio' ? '' : config.url,
    headers: entry.mutable && config.transport !== 'stdio'
      ? Object.entries(mcpSecretMap(config, 'headers') ?? {}).map(([key, value]) => `${key}=${value}`).join('\n')
      : '',
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

export function McpConfigManager({
  cwd,
  entries,
  loading,
  error,
  onEcho,
}: {
  cwd: string;
  entries: readonly McpManagedServer[];
  loading: boolean;
  error: unknown;
  onEcho: (servers: readonly McpManagedServer[]) => void;
}) {
  const { klient, scopeId } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const location = useLocation();
  const testRevision = useRef(0);
  const resetRevision = useRef(0);
  const revealRevision = useRef(0);
  const [revealedUrl, setRevealedUrl] = useState<{ scopeId: typeof scopeId; credentialId: string; url: string | null } | null>(null);
  const [revealErrorId, setRevealErrorId] = useState<string | null>(null);
  const [draft, setDraftState] = useState<McpEditorDraft | null>(null);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(mcpDraft(draft.original));
  useDirtyReporter(`mcp-editor:${scopeId}:${cwd}`, dirty);
  const guard = useDirtyGuard();
  const switchDraft = (next: McpEditorDraft | null) => {
    const apply = () => { setDraft(next); setShowHeaders(false); };
    if (dirty && guard?.confirmDiscard !== undefined) guard.confirmDiscard(`mcp-editor:${scopeId}:${cwd}`, apply);
    else apply();
  };
  const [showHeaders, setShowHeaders] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [oauthFeedback, setOauthFeedback] = useState<Feedback>(null);
  const [pendingDelete, setPendingDelete] = useState<McpManagedServer | null>(null);
  const [pendingReset, setPendingReset] = useState<McpManagedServer | null>(null);
  const [pendingStoredReset, setPendingStoredReset] = useState<StoredOAuthCredential | null>(null);
  const setDraft = (next: SetStateAction<McpEditorDraft | null>) => {
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
    setShowHeaders(false);
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
  const headerRows = draft?.headers ? draft.headers.split(/\r?\n/u) : [];
  const bearerRefActive = draft !== null && draft.transport !== 'stdio' && draft.bearerTokenEnvVar.trim() !== '';
  const hasAuthorizationHeader = headerRows.some((line) => {
    const separator = line.indexOf('=');
    return separator > 0 && line.slice(0, separator).trim().toLowerCase() === 'authorization';
  });
  const editHeader = (index: number, field: 'key' | 'value', value: string) => {
    setDraft((current) => {
      if (current === null) return null;
      const rows = current.headers.split(/\r?\n/u);
      const separator = rows[index]!.indexOf('=');
      const key = separator < 0 ? rows[index]! : rows[index]!.slice(0, separator);
      const entryValue = separator < 0 ? '' : rows[index]!.slice(separator + 1);
      rows[index] = field === 'key' ? `${value}=${entryValue}` : `${key}=${value}`;
      return { ...current, headers: rows.join('\n') };
    });
  };

  const draftConfig = (): McpServerConfig | null => {
    if (draft === null) return null;
    try {
      return mcpConfigFromDraft(draft);
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
      const config = draftConfig();
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
      const config = draftConfig();
      if (config === null) return;
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

  return (
    <div className="space-y-3 border-t border-hairline pt-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink">{t('st.mcp.configTitle')}</p>
          <Hint>{t('st.mcp.configHint')}</Hint>
        </div>
        <button type="button" className={`${SECONDARY_BUTTON} shrink-0`} disabled={saving || resetting} onClick={() => { switchDraft(mcpDraft()); }}>{t('st.mcp.add')}</button>
      </div>
      <div className="space-y-2">
        {entries.map((entry) => (
          <div key={`${entry.source}:${entry.name}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline bg-paper px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-ink">
                {entry.name}
                {entry.mutable ? null : (
                  <span
                    className="ml-2 rounded-[4px] bg-hairline/60 px-1.5 py-px text-[11px] font-normal text-ink-faint"
                    title={t('st.mcp.readOnlyHint')}
                  >
                    {t('st.mcp.readOnly')}
                  </span>
                )}
              </p>
              <p className="truncate font-mono text-[11px] text-ink-faint" title={entry.origin}>
                {entry.plugin?.name ?? entry.origin} · {entry.config.transport}
              </p>
              {entry.plugin !== undefined ? (
                <Link
                  to={{ pathname: '/settings/plugins', search: location.search }}
                  className="mt-0.5 inline-block text-[12px] font-medium text-accent-ink hover:underline"
                >
                  {t('st.plugins.manageLink')}
                </Link>
              ) : null}
            </div>
            {entry.mutable ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  disabled={saving || resetting}
                  onClick={() => { switchDraft(mcpDraft(entry)); }}
                >{t('st.mcp.edit')}</button>
                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  disabled={saving || resetting}
                  onClick={() => { setPendingDelete(entry); }}
                >{t('st.mcp.delete')}</button>
                {canResetOAuth(entry) ? (
                  <button
                    type="button"
                    className={DANGER_GHOST_BUTTON}
                    disabled={saving || resetting || loading || error !== null}
                    onClick={() => { setPendingReset(entry); setOauthFeedback(null); }}
                  >{t('st.mcp.oauthDisconnect')}</button>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        {loading ? <Hint>{t('st.mcp.configLoading')}</Hint> : null}
        {!loading && entries.length === 0 ? <Hint>{t('st.mcp.empty')}</Hint> : null}
        {error !== null ? <InlineError error={error} /> : null}
      </div>
      <section aria-label={t('st.mcp.storedOAuthTitle')} className="space-y-2 border-t border-hairline pt-3">
        <div>
          <p className="text-[13px] font-medium text-ink">{t('st.mcp.storedOAuthTitle')}</p>
          <Hint>{t('st.mcp.storedOAuthHint')}</Hint>
        </div>
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
      </section>
      {draft !== null ? (
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
                setDraft({ ...draft, transport: event.target.value as McpTransport, headers: '', env: '', bearerTokenEnvVar: '', auth: undefined });
                setShowHeaders(false);
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
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-[11px] font-medium text-ink-soft">
                  {t('st.mcp.args')}
                  <textarea className={`${INPUT} min-h-24 font-mono`} value={draft.args} onChange={(event) => { setDraft({ ...draft, args: event.target.value }); }} placeholder={t('st.mcp.argsPlaceholder')} />
                </label>
                <label className="space-y-1 text-[11px] font-medium text-ink-soft">
                  {t('st.mcp.env')}
                  <textarea className={`${INPUT} min-h-24 font-mono`} value={draft.env} onChange={(event) => { setDraft({ ...draft, env: event.target.value }); }} placeholder={t('st.mcp.envPlaceholder')} />
                </label>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <label className="block space-y-1 text-[11px] font-medium text-ink-soft">
                {t('st.mcp.url')}
                <input className={`${INPUT} font-mono`} value={draft.url} onChange={(event) => {
                  if (event.target.value !== draft.url) {
                    setDraft({ ...draft, url: event.target.value, headers: '', bearerTokenEnvVar: '', auth: undefined });
                    setShowHeaders(false);
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
                <p role="status" className="border-l-2 border-accent pl-2 text-[11px] text-ink-soft">
                  {t(bearerRefActive ? 'st.mcp.authSourceEnv' : hasAuthorizationHeader ? 'st.mcp.authSourceHeader' : 'st.mcp.authSourceOAuth')}
                </p>
                {draft.auth === 'oauth' ? <Hint>{t('st.mcp.oauthConfigured')}</Hint> : null}
              </div>
              <div className="space-y-2" role="group" aria-label={t('st.mcp.headers')}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[11px] font-medium text-ink-soft">{t('st.mcp.headers')}</p>
                    <Hint>{t('st.mcp.headersHint')}</Hint>
                  </div>
                  {headerRows.length > 0 ? (
                    <button type="button" className={SECONDARY_BUTTON} aria-pressed={showHeaders} onClick={() => { setShowHeaders((shown) => !shown); }}>
                      {t(showHeaders ? 'st.mcp.hideHeaders' : 'st.mcp.showHeaders')}
                    </button>
                  ) : null}
                </div>
                {headerRows.map((line, index) => {
                  const separator = line.indexOf('=');
                  const key = separator < 0 ? line : line.slice(0, separator);
                  const value = separator < 0 ? '' : line.slice(separator + 1);
                  const overridden = bearerRefActive && key.trim().toLowerCase() === 'authorization';
                  return (
                    <div key={index} className="grid min-w-0 grid-cols-1 gap-2 rounded-lg border border-hairline bg-panel p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] sm:items-end">
                      <label className="min-w-0 space-y-1 text-[11px] font-medium text-ink-soft">
                        {t('st.mcp.headerName')} {index + 1}
                        <input className={`${INPUT} font-mono`} value={key} disabled={overridden} onChange={(event) => { editHeader(index, 'key', event.target.value); }} spellCheck={false} autoComplete="off" />
                      </label>
                      <label className="min-w-0 space-y-1 text-[11px] font-medium text-ink-soft">
                        {t('st.mcp.headerValue')} {index + 1}
                        <input className={`${INPUT} font-mono`} type={showHeaders ? 'text' : 'password'} value={value} disabled={overridden} onChange={(event) => { editHeader(index, 'value', event.target.value); }} spellCheck={false} autoComplete="off" />
                      </label>
                      <button type="button" className={SECONDARY_BUTTON} disabled={overridden} aria-label={`${t('st.mcp.removeHeader')} ${index + 1}`} onClick={() => {
                        setDraft({ ...draft, headers: headerRows.filter((_, row) => row !== index).join('\n') });
                      }}>{t('st.mcp.removeHeader')}</button>
                      {overridden ? <div className="sm:col-span-3"><Hint>{t('st.mcp.headerOverridden')}</Hint></div> : null}
                    </div>
                  );
                })}
                <button type="button" className={SECONDARY_BUTTON} onClick={() => { setDraft({ ...draft, headers: draft.headers === '' ? '=' : `${draft.headers}\n=` }); }}>{t('st.mcp.addHeader')}</button>
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
      ) : null}
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
