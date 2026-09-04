import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import { mcpConfigFromDraft, type McpEditorDraft } from '@kiki/session-core/settings';
import type { GlobalMcpServerConfig } from '@moonshot-ai/klient';
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
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';

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
    return { name: '', transport: 'stdio', command: '', args: '', env: '', url: '' };
  }
  const config = entry.config;
  return {
    original: entry,
    name: entry.name,
    transport: config.transport,
    command: config.transport === 'stdio' ? config.command : '',
    args: config.transport === 'stdio' ? (config.args ?? []).join('\n') : '',
    env: config.transport === 'stdio'
      ? Object.entries(mcpSecretMap(config, 'env') ?? {}).map(([key, value]) => `${key}=${value}`).join('\n')
      : '',
    url: config.transport === 'stdio' ? '' : config.url,
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
  const { klient } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [draft, setDraft] = useState<McpEditorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pendingDelete, setPendingDelete] = useState<McpManagedServer | null>(null);

  const scope = cwd === '' ? undefined : cwd;

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
    setTesting(true);
    setFeedback(null);
    try {
      const config = draftConfig();
      if (config === null) return;
      // Probes the draft as typed — nothing has to be saved first.
      const result = await klient.global.mcp.test({ server: klientMcpServer(config, name), cwd: scope });
      setFeedback(
        result.success
          ? { tone: 'success', text: t('st.mcp.testOk', { output: result.output }) }
          : { tone: 'error', text: t('st.mcp.testFailed', { output: result.output }) },
      );
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    const entry = pendingDelete;
    if (entry === null) return;
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

  return (
    <div className="space-y-3 border-t border-hairline pt-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{t('st.mcp.configTitle')}</p>
          <Hint>{t('st.mcp.configHint')}</Hint>
        </div>
        <button type="button" className={SECONDARY_BUTTON} disabled={saving} onClick={() => { setDraft(mcpDraft()); setFeedback(null); }}>{t('st.mcp.add')}</button>
      </div>
      <div className="space-y-2">
        {entries.map((entry) => (
          <div key={`${entry.source}:${entry.name}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline bg-paper px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-ink">
                {entry.name}
                {entry.mutable ? null : (
                  <span className="ml-2 rounded border border-hairline px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-ink-faint">
                    {t('st.mcp.readOnly')}
                  </span>
                )}
              </p>
              <p className="truncate font-mono text-[10.5px] text-ink-faint" title={entry.origin}>
                {entry.plugin?.name ?? entry.origin} · {entry.config.transport}
              </p>
              {entry.plugin !== undefined ? (
                <Link
                  to={{ pathname: '/settings/plugins', search: location.search }}
                  className="mt-0.5 inline-block text-[10px] font-medium text-accent hover:underline"
                >
                  {t('st.plugins.manageLink')}
                </Link>
              ) : null}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className={SECONDARY_BUTTON}
                disabled={saving || !entry.mutable}
                title={entry.mutable ? undefined : t('st.mcp.readOnlyHint')}
                onClick={() => { setDraft(mcpDraft(entry)); setFeedback(null); }}
              >{t('st.mcp.edit')}</button>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                disabled={saving || !entry.mutable}
                title={entry.mutable ? undefined : t('st.mcp.readOnlyHint')}
                onClick={() => { setPendingDelete(entry); }}
              >{t('st.mcp.delete')}</button>
            </div>
          </div>
        ))}
        {loading ? <Hint>{t('st.mcp.configLoading')}</Hint> : null}
        {!loading && entries.length === 0 ? <Hint>{t('st.mcp.empty')}</Hint> : null}
        {error !== null ? <InlineError error={error} /> : null}
      </div>
      {draft !== null ? (
        <fieldset className="space-y-3 rounded-xl border border-hairline bg-paper p-3" disabled={saving}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-[11px] font-medium text-ink-soft">
              {t('st.mcp.name')}
              <input className={INPUT} value={draft.name} onChange={(event) => { setDraft({ ...draft, name: event.target.value }); }} />
            </label>
            <label className="space-y-1 text-[11px] font-medium text-ink-soft">
              {t('st.mcp.transport')}
              <select className={INPUT} value={draft.transport} onChange={(event) => { setDraft({ ...draft, transport: event.target.value as McpTransport }); }}>
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
            <label className="block space-y-1 text-[11px] font-medium text-ink-soft">
              {t('st.mcp.url')}
              <input className={`${INPUT} font-mono`} value={draft.url} onChange={(event) => { setDraft({ ...draft, url: event.target.value }); }} placeholder="https://mcp.example.com" />
            </label>
          )}
          <div className="flex gap-2">
            <button type="button" className={PRIMARY_BUTTON} onClick={() => void save()}>{saving ? t('common.saving') : t('common.save')}</button>
            <button type="button" className={SECONDARY_BUTTON} disabled={testing} onClick={() => void test()}>{testing ? t('st.mcp.testing') : t('st.mcp.test')}</button>
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { setDraft(null); }}>{t('common.cancel')}</button>
          </div>
        </fieldset>
      ) : null}
      <FeedbackLine feedback={feedback} />
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
