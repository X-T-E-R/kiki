import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { executorInstanceConfigSchema, type ExecutorCatalogItem, type ExecutorInstanceConfig, type ExecutorInstanceConfiguration, type ExecutorInstanceProxy } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { FeedbackLine, type Feedback } from '../controls';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { executorCatalogQueryKey } from './profileEditor/engines';

const PROXY_KINDS = ['inherit', 'direct', 'url', 'env'] as const;

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
  const [proxy, setProxy] = useState<ExecutorInstanceProxy>(current?.proxy ?? { kind: 'inherit' });
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configOptions: ExecutorInstanceConfiguration['kind'][] = ['inherit'];
  if (source?.connection?.home_env !== undefined) configOptions.push('config_directory');
  if (source?.supports_claude_settings === true) configOptions.push('claude_settings');
  if (source?.connection?.api_key_env !== undefined) configOptions.push('credential_env');
  const issue = item?.configuration_issue;
  const sourceLabel = source?.label ?? current?.source_executor ?? '';
  const unsupported = !configOptions.includes(configuration.kind);

  const save = async () => {
    if (saving || source === undefined || unsupported) return;
    const parsed = executorInstanceConfigSchema.safeParse({ source_executor: source.id, label, configuration, proxy });
    if (!parsed.success) {
      setFeedback({ tone: 'error', text: t('st.engines.instance.invalid') });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const instanceId = item?.id ?? `instance-${globalThis.crypto.randomUUID()}`;
      const next: ExecutorInstanceConfig = parsed.data;
      await client.patchConfig({ agent_executor_instances: { [instanceId]: next } });
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
    else setConfiguration({ kind });
  };
  const selectProxy = (kind: ExecutorInstanceProxy['kind']) => {
    setFeedback(null);
    if (kind === 'url') setProxy({ kind, url: '' });
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
          </> : configOptions.length === 1 ? <p className="text-[12px] leading-4 text-ink-faint">{t('st.engines.instance.config.unsupported')}</p> : null}
        </div>
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={`${id}-proxy`} className="text-[12px] font-medium text-ink-soft">{t('st.engines.instance.proxy')}</label>
          <select id={`${id}-proxy`} data-instance-proxy className={INPUT} value={proxy.kind} disabled={saving}
            onChange={(event) => selectProxy(event.target.value as ExecutorInstanceProxy['kind'])}>
            {PROXY_KINDS.map((kind) => <option key={kind} value={kind}>{t(`st.engines.instance.proxy.${kind}`)}</option>)}
          </select>
          {proxy.kind === 'url' || proxy.kind === 'env' ? <>
            <input data-instance-proxy-value aria-label={t(`st.engines.instance.proxy.${proxy.kind}`)} className={`${INPUT} font-mono`}
              required spellCheck={false} disabled={saving} value={proxy.kind === 'url' ? proxy.url : proxy.name}
              placeholder={proxy.kind === 'url' ? 'http://127.0.0.1:8080' : 'WORK_PROXY_URL'}
              onChange={(event) => setProxy(proxy.kind === 'url' ? { kind: 'url', url: event.target.value } : { kind: 'env', name: event.target.value })} />
            <p className="text-[12px] leading-4 text-ink-faint">{t(proxy.kind === 'url' ? 'st.engines.instance.proxy.urlHint' : 'st.engines.instance.proxy.envHint')}</p>
          </> : null}
        </div>
      </div>
      <div className="space-y-2 border-t border-hairline pt-3">
        <p className="text-[12px] leading-4 text-ink-soft">{t(item === undefined ? 'st.engines.instance.selectHint' : 'st.engines.instance.editHint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button data-instance-save type="submit" className={PRIMARY_BUTTON} disabled={saving || !label.trim() || unsupported || source === undefined} aria-busy={saving}>
            {t(item === undefined ? 'st.engines.instance.create' : 'st.engines.instance.save')}
          </button>
          {onCancel === undefined ? null : <button type="button" className={SECONDARY_BUTTON} onClick={onCancel} disabled={saving}>{t('common.cancel')}</button>}
          <FeedbackLine feedback={feedback} />
        </div>
      </div>
    </form>
  );
}
