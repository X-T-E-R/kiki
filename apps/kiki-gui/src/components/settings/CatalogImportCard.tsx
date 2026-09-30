/**
 * Connections → "Add a provider from the directory": the models.dev catalog
 * the server reads, searchable, one row per provider. A row opens an inline
 * import form (local id, base URL when the entry has none, API key); entries
 * this version cannot reach stay listed, greyed, with the reason, so the user
 * learns why rather than wondering where they went. Importing an id that
 * already exists is a refresh, and the form says so before the press.
 */

import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { providerIdSchema, type CatalogProviderItem } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { SearchField, Tag } from '../capabilities/primitives';
import { FeedbackLine, Hint, type Feedback } from '../controls';
import { protocolLabel } from '../providerPresets';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { KEEP_SECRET, SecretField, type SecretDraft } from './SecretField';
import { SectionCard } from './SectionCard';
import { FORM_LABEL } from './SettingsPrimitives';

export const CATALOG_PROVIDERS_QUERY_KEY = ['catalog-providers'] as const;

function matches(item: CatalogProviderItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === '' || item.name.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle);
}

export function CatalogImportCard({
  configuredIds,
  onImported,
}: {
  /** Provider ids already configured: importing one of these refreshes it. */
  configuredIds: ReadonlySet<string>;
  onImported: () => Promise<void>;
}) {
  const { client } = useConnection();
  const { t, tp, locale } = useI18n();
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [result, setResult] = useState<Feedback>(null);
  const catalog = useQuery({
    queryKey: CATALOG_PROVIDERS_QUERY_KEY,
    queryFn: () => client.listCatalogProviders(),
    staleTime: 10 * 60_000,
  });
  // Importable first, alphabetical within each band; rejected entries last.
  const items = useMemo(
    () => (catalog.data?.items ?? [])
      .filter((item) => matches(item, query))
      .toSorted((a, b) => Number(a.rejected) - Number(b.rejected) || a.name.localeCompare(b.name)),
    [catalog.data, query],
  );
  const total = catalog.data?.items.length ?? 0;

  return (
    <SectionCard id="st-card-catalog-import" title={t('st.catalog.title')}>
      <div className="space-y-3">
        <Hint>{t('st.catalog.intro')}</Hint>
        {total > 0 ? (
          <div className="max-w-[420px]">
            <SearchField value={query} onChange={setQuery} placeholder={t('st.catalog.searchPlaceholder')} ariaLabel={t('st.catalog.searchAria')} />
          </div>
        ) : null}
        {catalog.isLoading ? <Hint>{t('st.catalog.loading')}</Hint> : null}
        {catalog.isError ? (
          <div className="flex flex-wrap items-center gap-3">
            <FeedbackLine feedback={{ tone: 'error', text: t('st.catalog.loadFailed', { detail: errorText(locale, catalog.error) }) }} />
            <button type="button" className={SECONDARY_BUTTON} onClick={() => void catalog.refetch()}>{t('common.retry')}</button>
          </div>
        ) : null}
        {catalog.isSuccess && total === 0 ? <Hint>{t('st.catalog.empty')}</Hint> : null}
        {total > 0 && items.length === 0 ? (
          <p data-catalog-no-match className="text-[12px] text-ink-faint">{t('st.catalog.noMatch', { query: query.trim() })}</p>
        ) : null}
        {items.length > 0 ? (
          <ul data-catalog-list className="max-h-[420px] overflow-y-auto rounded-lg border border-hairline bg-panel">
            {items.map((item) => (
              <CatalogRow
                key={item.id}
                item={item}
                exists={configuredIds.has(item.id)}
                configuredIds={configuredIds}
                open={openId === item.id}
                onOpen={() => { setOpenId(item.id); setResult(null); }}
                onClose={() => { setOpenId(null); }}
                onImported={async (name, count) => {
                  setOpenId(null);
                  setResult({ tone: 'success', text: tp('st.catalog.imported', count, { name }) });
                  await onImported();
                }}
              />
            ))}
          </ul>
        ) : null}
        <FeedbackLine feedback={result} />
      </div>
    </SectionCard>
  );
}
function CatalogRow({
  item, exists, configuredIds, open, onOpen, onClose, onImported,
}: {
  item: CatalogProviderItem;
  exists: boolean;
  configuredIds: ReadonlySet<string>;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onImported: (name: string, count: number) => Promise<void>;
}) {
  const { t, tp } = useI18n();
  const formId = useId();
  return (
    <li
      data-catalog-row={item.id}
      data-catalog-rejected={item.rejected ? 'true' : undefined}
      className={`border-t border-hairline first:border-t-0 ${open ? 'bg-paper' : ''}`}
    >
      <div className="flex min-h-12 items-center gap-3 px-3 py-2">
        <div className={`min-w-0 flex-1 ${item.rejected ? 'opacity-60' : ''}`}>
          <p className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13px] font-medium text-ink">{item.name}</span>
            <span className="truncate font-mono text-[11px] text-ink-faint">{item.id}</span>
            {exists ? <Tag tone="accent">{t('st.catalog.configured')}</Tag> : null}
          </p>
          <p className="mt-0.5 truncate text-[12px] text-ink-soft">
            {item.rejected
              ? item.reject_reason ?? t('st.catalog.rejectedFallback')
              : [
                  item.wire_type === null ? null : protocolLabel(item.wire_type),
                  tp('st.catalog.models', item.models.length),
                  item.guessed ? t('st.catalog.guessed') : null,
                ].filter((part) => part !== null).join(' · ')}
          </p>
        </div>
        {item.rejected ? (
          <span data-catalog-unavailable className="shrink-0 text-[12px] text-ink-faint">{t('st.catalog.unavailable')}</span>
        ) : !open ? (
          <button
            type="button"
            className={`${SECONDARY_BUTTON} shrink-0`}
            aria-expanded={false}
            aria-controls={formId}
            onClick={onOpen}
          >
            {exists ? t('st.catalog.reimport') : t('st.catalog.add')}
          </button>
        ) : null}
      </div>
      {open ? (
        <ImportForm id={formId} item={item} configuredIds={configuredIds} onCancel={onClose} onImported={onImported} />
      ) : null}
    </li>
  );
}
function ImportForm({
  id, item, configuredIds, onCancel, onImported,
}: {
  id: string;
  item: CatalogProviderItem;
  configuredIds: ReadonlySet<string>;
  onCancel: () => void;
  onImported: (name: string, count: number) => Promise<void>;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const [localId, setLocalId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState<SecretDraft>(KEEP_SECRET);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<Feedback>(null);
  const [baseUrlMissing, setBaseUrlMissing] = useState(false);
  const targetId = localId.trim() === '' ? item.id : localId.trim();
  const idInvalid = localId.trim() !== '' && !providerIdSchema.safeParse(localId.trim()).success;
  const refreshes = configuredIds.has(targetId);

  const submit = async () => {
    if (item.needs_base_url && baseUrl.trim() === '') { setBaseUrlMissing(true); return; }
    if (idInvalid) return;
    setImporting(true);
    setError(null);
    try {
      const response = await client.importCatalogProvider({
        catalog_id: item.id,
        ...(localId.trim() !== '' ? { id: localId.trim() } : {}),
        ...(baseUrl.trim() !== '' ? { base_url: baseUrl.trim() } : {}),
        ...(key.mode === 'set' && key.value !== '' ? { api_key: key.value } : {}),
      });
      await onImported(item.name, response.models_imported);
    } catch (failure) {
      setError({ tone: 'error', text: t('st.catalog.importFailed', { detail: errorText(locale, failure) }) });
    } finally {
      setImporting(false);
    }
  };

  return (
    <form
      id={id}
      data-catalog-form={item.id}
      noValidate
      className="space-y-3 border-t border-hairline px-3 pb-3 pt-3"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      {item.guessed ? <Hint>{t('st.catalog.guessedHint')}</Hint> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className={FORM_LABEL}>{t('st.catalog.localId')}</span>
          <input
            className={`${INPUT} font-mono ${idInvalid ? 'border-danger/60' : ''}`}
            value={localId}
            placeholder={item.id}
            aria-invalid={idInvalid || undefined}
            onChange={(event) => { setLocalId(event.target.value); }}
          />
          {idInvalid ? <span role="alert" className="block text-[12px] text-danger">{t('st.catalog.localIdInvalid')}</span> : null}
        </label>
        {item.needs_base_url ? (
          <label className="block space-y-1">
            <span className={FORM_LABEL}>{t('st.providers.baseUrl')}</span>
            <input
              data-catalog-base-url
              className={`${INPUT} font-mono ${baseUrlMissing ? 'border-danger/60' : ''}`}
              value={baseUrl}
              aria-required
              placeholder="https://"
              aria-invalid={baseUrlMissing || undefined}
              onChange={(event) => { setBaseUrl(event.target.value); setBaseUrlMissing(false); }}
            />
            <span className={`block text-[12px] ${baseUrlMissing ? 'text-danger' : 'text-ink-faint'}`} role={baseUrlMissing ? 'alert' : undefined}>
              {t('st.catalog.baseUrlRequired')}
            </span>
          </label>
        ) : null}
      </div>
      <SecretField
        label={t('st.providers.apiKey')}
        source="none"
        draft={key}
        onChange={setKey}
        placeholder={t('st.providers.keyNew')}
        hint={item.env_key !== null ? t('st.catalog.envHint', { name: item.env_key }) : undefined}
      />
      {refreshes ? <p data-catalog-refresh className="text-[12px] text-amber-ink">{t('st.catalog.refreshNotice', { id: targetId })}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" data-catalog-import className={PRIMARY_BUTTON} disabled={importing || idInvalid}>
          {importing ? t('st.catalog.importing') : refreshes ? t('st.catalog.reimportSubmit', { name: item.name }) : t('st.catalog.importSubmit', { name: item.name })}
        </button>
        <button type="button" className={SECONDARY_BUTTON} disabled={importing} onClick={onCancel}>{t('common.cancel')}</button>
      </div>
      <FeedbackLine feedback={error} />
    </form>
  );
}
