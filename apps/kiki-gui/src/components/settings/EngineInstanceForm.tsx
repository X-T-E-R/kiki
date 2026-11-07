import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { executorInstancePatchSchema, supportsExecutorPluginAccount, type ExecutorCatalogItem, type ExecutorInstanceConfiguration, type ExecutorInstanceResponse } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, type Feedback } from '../controls';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { executorCatalogQueryKey } from './profileEditor/engines';

const PROXY_KINDS = ['inherit', 'direct', 'url', 'env'] as const;
type Proxy = ExecutorInstanceResponse['proxy'];
type AuthorizationDraft = { mode: 'keep' | 'clear' } | { mode: 'set'; username: string; password: string };

export function EngineInstanceForm({ item, source, onCreated, onCancel, onSaved }: {
  item?: ExecutorCatalogItem;
  source?: ExecutorCatalogItem;
  onCreated?: (id: string) => void;
  onCancel?: () => void;
  onSaved?: () => void;
}) {
  const { t, locale } = useI18n();
  const { client, scopeId, meta } = useConnection();
  const queries = useQueryClient();
  const id = useId();
  const current = item?.instance;
  const [label, setLabel] = useState(current?.label ?? '');
  const [configuration, setConfiguration] = useState<ExecutorInstanceConfiguration>(current?.configuration ?? { kind: 'inherit' });
  const [proxy, setProxy] = useState<Proxy>(current?.proxy ?? { kind: 'inherit' });
  const [authorization, setAuthorization] = useState<AuthorizationDraft>({ mode: 'keep' });
  const hasAuthorization = proxy.kind === 'url' && proxy.has_authorization === true;
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const executors = client.klient?.rest?.executors;
  const supportedAccounts = source !== undefined && supportsExecutorPluginAccount(source) && executors !== undefined;
  const account = configuration.kind === 'plugin_account' ? configuration : undefined;
  const sourceQuery = useQuery({
    queryKey: ['engine-account-sources', scopeId, meta?.server_id, source?.id],
    queryFn: ({ signal }) => executors!.listAccountSources(source!.id, { signal }),
    enabled: supportedAccounts, retry: false,
  });
  const accountSources = sourceQuery.data?.items ?? [];
  const knownSource = accountSources.some((entry) => entry.id === account?.source);
  const accountsQuery = useQuery({
    queryKey: ['engine-accounts', scopeId, meta?.server_id, source?.id, account?.source],
    queryFn: ({ signal }) => executors!.listAccounts(source!.id, account!.source, { signal }),
    enabled: supportedAccounts && knownSource, retry: false,
  });
  const accounts = accountsQuery.data?.items ?? [];
  const selectedAccount = accounts.find((entry) => entry.id === account?.account_id);
  const readyAccount = account === undefined || (knownSource && !accountsQuery.isError && selectedAccount?.status === 'ready');
  const configOptions: ExecutorInstanceConfiguration['kind'][] = ['inherit'];
  if (source?.connection?.home_env !== undefined) configOptions.push('config_directory');
  if (source?.supports_claude_settings === true) configOptions.push('claude_settings');
  if (source?.connection?.api_key_env !== undefined) configOptions.push('credential_env');
  if (supportedAccounts && (accountSources.length > 0 || account !== undefined)) configOptions.push('plugin_account');
  const issue = item?.configuration_issue;
  const sourceLabel = source?.label ?? current?.source_executor ?? '';
  const unsupported = !configOptions.includes(configuration.kind);

  const save = async () => {
    if (saving || source === undefined || unsupported || !readyAccount) return;
    const proxyPatch = proxy.kind === 'url' ? {
      kind: proxy.kind, url: proxy.url,
      authorization: authorization.mode === 'clear' ? null : authorization.mode === 'set'
        ? { username: authorization.username, password: authorization.password } : undefined,
    } : proxy;
    const parsed = executorInstancePatchSchema.safeParse({ source_executor: source.id, label, configuration, proxy: proxyPatch });
    if (!parsed.success) {
      setFeedback({ tone: 'error', text: t('st.engines.instance.invalid') });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const instanceId = item?.id ?? `instance-${globalThis.crypto.randomUUID()}`;
      const echoed = await client.patchConfig({ agent_executor_instances: { [instanceId]: parsed.data } });
      const saved = echoed.agent_executor_instances?.[instanceId];
      if (saved !== undefined) setProxy(saved.proxy);
      setAuthorization({ mode: 'keep' });
      await Promise.all([
        queries.invalidateQueries({ queryKey: executorCatalogQueryKey(scopeId, meta?.server_id) }),
        queries.invalidateQueries({ queryKey: ['engine-discovery', scopeId, meta?.server_id ?? ''] }),
        queries.invalidateQueries({ queryKey: ['config'] }),
      ]);
      onSaved?.();
      if (item === undefined) onCreated?.(instanceId);
      else setFeedback({ tone: 'success', text: t('st.engines.instance.saved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally { setSaving(false); }
  };

  const selectConfiguration = (kind: ExecutorInstanceConfiguration['kind']) => {
    setFeedback(null);
    if (kind === 'config_directory' || kind === 'claude_settings') setConfiguration({ kind, path: '' });
    else if (kind === 'credential_env') setConfiguration({ kind, name: '' });
    else if (kind === 'plugin_account') setConfiguration({ kind, source: accountSources[0]?.id ?? '', account_id: '' });
    else setConfiguration({ kind });
  };
  const selectProxy = (kind: Proxy['kind']) => {
    setFeedback(null);
    setAuthorization({ mode: 'keep' });
    if (kind === 'url') setProxy(current?.proxy.kind === 'url' ? current.proxy : { kind, url: '' });
    else if (kind === 'env') setProxy({ kind, name: '' });
    else setProxy({ kind });
  };

  return (
    <form data-engine-instance-form={item === undefined ? 'create' : 'edit'} onSubmit={(event) => { event.preventDefault(); void save(); }}
      className="space-y-4 rounded-lg border border-hairline bg-panel p-3 sm:p-4">
      <div className="space-y-0.5">
        <h4 className="text-[13px] font-semibold text-ink">{t(item === undefined ? 'st.engines.instance.add' : 'st.engines.instance.edit')}</h4>
        <p className="break-words text-[12px] text-ink-soft">{t('st.engines.instance.source', { engine: sourceLabel })}</p>
      </div>
      {issue !== undefined ? <p role="alert" data-instance-issue={issue} className="text-[12px] leading-4 text-danger">{t(`st.engines.instance.issue.${issue}`)}</p> : null}
      <div className="space-y-1">
        <label htmlFor={`${id}-name`} className="text-[12px] font-medium text-ink-soft">{t('st.engines.instance.name')}</label>
        <input id={`${id}-name`} data-instance-name className={INPUT} value={label} required maxLength={80} disabled={saving}
          placeholder={t('st.engines.instance.namePlaceholder')} onChange={(event) => setLabel(event.target.value)} />
      </div>
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={`${id}-configuration`} className="text-[12px] font-medium text-ink-soft">{t('st.engines.instance.configuration')}</label>
          <select id={`${id}-configuration`} data-instance-configuration className={INPUT} value={configuration.kind} disabled={saving}
            onChange={(event) => selectConfiguration(event.target.value as ExecutorInstanceConfiguration['kind'])}>
            {unsupported ? <option value={configuration.kind} disabled>{t(`st.engines.instance.config.${configuration.kind}`)}</option> : null}
            {configOptions.map((kind) => <option key={kind} value={kind}>{t(`st.engines.instance.config.${kind}`)}</option>)}
          </select>
          {configuration.kind === 'config_directory' || configuration.kind === 'claude_settings' ? <>
            <input data-instance-configuration-value aria-label={t(`st.engines.instance.config.${configuration.kind}`)} className={`${INPUT} font-mono`}
              required spellCheck={false} disabled={saving || unsupported} value={configuration.path}
              onChange={(event) => setConfiguration({ kind: configuration.kind, path: event.target.value })} />
            <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.instance.config.pathHint')}</p>
            {configuration.kind === 'config_directory' ? <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.instance.config.directoryHint')}</p> : null}
          </> : configuration.kind === 'credential_env' ? <>
            <input data-instance-configuration-value aria-label={t('st.engines.instance.config.credential_env')} className={`${INPUT} font-mono`}
              required spellCheck={false} disabled={saving || unsupported} value={configuration.name} placeholder="WORK_API_KEY"
              onChange={(event) => setConfiguration({ kind: configuration.kind, name: event.target.value })} />
            <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.instance.config.envHint')}</p>
          </> : account !== undefined ? <>
            <label htmlFor={`${id}-account-source`} className="text-[12px] font-medium text-ink-soft">{t('st.engines.instance.account.source')}</label>
            <select id={`${id}-account-source`} data-instance-account-source className={INPUT} value={account.source} disabled={saving || unsupported}
              onChange={(event) => setConfiguration({ kind: 'plugin_account', source: event.target.value, account_id: '' })}>
              {!knownSource && account.source ? <option value={account.source} disabled>{account.source}</option> : null}
              {accountSources.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
            <label htmlFor={`${id}-account`} className="text-[12px] font-medium text-ink-soft">{t('st.engines.instance.account.label')}</label>
            <select id={`${id}-account`} data-instance-account className={INPUT} value={account.account_id} disabled={saving || !knownSource || accountsQuery.isPending || accountsQuery.isError}
              onChange={(event) => setConfiguration({ ...account, account_id: event.target.value })}>
              <option value="">{t('st.engines.instance.account.choose')}</option>
              {!selectedAccount && account.account_id ? <option value={account.account_id} disabled>{account.account_id}</option> : null}
              {accounts.map((entry) => <option key={entry.id} value={entry.id} disabled={entry.status !== 'ready'}>{entry.label}{entry.status !== 'ready' ? ` · ${t(`st.engines.instance.account.${entry.status}`)}` : ''}</option>)}
            </select>
            {sourceQuery.isLoading || (knownSource && accountsQuery.isPending)
              ? <p role="status" className="text-[12px] leading-4 text-ink-soft">{t('st.engines.instance.account.loading')}</p>
              : sourceQuery.isError || !knownSource || accountsQuery.isError
                ? <p role="alert" className="text-[12px] leading-4 text-danger">{t('st.engines.instance.account.unavailable')}</p>
                : accounts.every((entry) => entry.status !== 'ready') || (account.account_id && selectedAccount?.status !== 'ready')
                  ? <p role="alert" className="text-[12px] leading-4 text-danger">{t('st.engines.instance.account.reconnect')}</p>
                  : null}
          </> : configOptions.length === 1 ? <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.instance.config.unsupported')}</p> : null}
        </div>
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={`${id}-proxy`} className="text-[12px] font-medium text-ink-soft">{t('st.engines.instance.proxy')}</label>
          <select id={`${id}-proxy`} data-instance-proxy className={INPUT} value={proxy.kind} disabled={saving}
            onChange={(event) => selectProxy(event.target.value as Proxy['kind'])}>
            {PROXY_KINDS.map((kind) => <option key={kind} value={kind}>{t(`st.engines.instance.proxy.${kind}`)}</option>)}
          </select>
          {proxy.kind === 'url' || proxy.kind === 'env' ? <>
            <input data-instance-proxy-value aria-label={t(`st.engines.instance.proxy.${proxy.kind}`)} className={`${INPUT} font-mono`}
              required spellCheck={false} disabled={saving} value={proxy.kind === 'url' ? proxy.url : proxy.name}
              placeholder={proxy.kind === 'url' ? 'http://127.0.0.1:8080' : 'WORK_PROXY_URL'}
              onChange={(event) => setProxy(proxy.kind === 'url' ? { ...proxy, url: event.target.value } : { kind: 'env', name: event.target.value })} />
            <p className="text-[12px] leading-4 text-ink-faint">{t(proxy.kind === 'url' ? 'st.engines.instance.proxy.urlHint' : 'st.engines.instance.proxy.envHint')}</p>
          </> : null}
          {proxy.kind === 'url' ? <div className="space-y-2 pt-1" data-instance-authorization={authorization.mode}>
            {authorization.mode === 'set' ? <>
              <div className="space-y-1">
                <label htmlFor={`${id}-proxy-user`} className="text-[12px] font-medium text-ink-soft">{t('st.engines.instance.proxy.username')}</label>
                <input id={`${id}-proxy-user`} data-instance-proxy-username className={INPUT} autoComplete="off"
                  required spellCheck={false} disabled={saving} value={authorization.username}
                  onChange={(event) => setAuthorization({ ...authorization, username: event.target.value })} />
              </div>
              <div className="space-y-1">
                <label htmlFor={`${id}-proxy-password`} className="text-[12px] font-medium text-ink-soft">{t('st.engines.instance.proxy.password')}</label>
                <input id={`${id}-proxy-password`} data-instance-proxy-password className={INPUT} type="password" autoComplete="new-password"
                  required disabled={saving} value={authorization.password}
                  onChange={(event) => setAuthorization({ ...authorization, password: event.target.value })} />
              </div>
              <button type="button" className={SECONDARY_BUTTON} disabled={saving} data-instance-proxy-undo
                onClick={() => setAuthorization({ mode: 'keep' })}>{t('common.cancel')}</button>
            </> : authorization.mode === 'clear' ? <>
              <p className="text-[12px] leading-4 text-ink-soft" role="status">{t('st.engines.instance.proxy.clearPending')}</p>
              <button type="button" className={SECONDARY_BUTTON} disabled={saving} data-instance-proxy-undo
                onClick={() => setAuthorization({ mode: 'keep' })}>{t('st.secret.undoClear')}</button>
            </> : <>
              {hasAuthorization ? <p className="text-[12px] leading-4 text-ink-soft" role="status">{t('st.engines.instance.proxy.saved')}</p> : null}
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={SECONDARY_BUTTON} disabled={saving} data-instance-proxy-auth-edit
                  onClick={() => setAuthorization({ mode: 'set', username: '', password: '' })}>
                  {t(hasAuthorization ? 'st.engines.instance.proxy.replace' : 'st.engines.instance.proxy.add')}
                </button>
                {hasAuthorization ? <button type="button" className={SECONDARY_BUTTON} disabled={saving} data-instance-proxy-auth-clear
                  onClick={() => setAuthorization({ mode: 'clear' })}>{t('st.engines.instance.proxy.clear')}</button> : null}
              </div>
            </>}
          </div> : null}
        </div>
      </div>
      <div className="space-y-2 border-t border-hairline pt-3">
        <p className="text-[12px] leading-4 text-ink-soft">{t(item === undefined ? 'st.engines.instance.selectHint' : 'st.engines.instance.editHint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button data-instance-save type="submit" className={PRIMARY_BUTTON} disabled={saving || !label.trim() || unsupported || source === undefined || !readyAccount} aria-busy={saving}>
            {t(item === undefined ? 'st.engines.instance.create' : 'st.engines.instance.save')}
          </button>
          {onCancel === undefined ? null : <button type="button" className={SECONDARY_BUTTON} onClick={onCancel} disabled={saving}>{t('common.cancel')}</button>}
          <FeedbackLine feedback={feedback} />
        </div>
      </div>
    </form>
  );
}
