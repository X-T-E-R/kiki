/**
 * Usage → Model prices: the side panel behind the usage page's "Model prices"
 * button. One row per model the server knows (configured models, overrides,
 * and any model the current usage view names), with where its price comes
 * from and the four unit prices per million tokens. A row opens in place to
 * set your own price (an override) or clear it back to the catalog; the
 * billing model a configured alias is priced as is edited on the same row.
 *
 * Units: the wire carries cost per token; everything on screen is per
 * million tokens. A missing cache price is unknown, never zero.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { I18nKey } from '@kiki/session-core/i18n';
import type { ModelPriceOverride, UsagePricingResponse } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { InlineError } from '../controls';
import { SidePanel } from '../SidePanel';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';

type PricingItem = UsagePricingResponse['items'][number];
type PriceField = 'input_cost_per_token' | 'output_cost_per_token' | 'cache_read_input_token_cost' | 'cache_creation_input_token_cost';

const PER_MILLION = 1_000_000;
const FIELDS: readonly { key: PriceField; labelKey: I18nKey; required: boolean }[] = [
  { key: 'input_cost_per_token', labelKey: 'usage.pricing.input', required: true },
  { key: 'output_cost_per_token', labelKey: 'usage.pricing.output', required: true },
  { key: 'cache_read_input_token_cost', labelKey: 'usage.pricing.cacheRead', required: false },
  { key: 'cache_creation_input_token_cost', labelKey: 'usage.pricing.cacheWrite', required: false },
];

const SOURCE_KEY: Record<PricingItem['source'], I18nKey> = {
  override: 'usage.pricing.source.override',
  'litellm-cache': 'usage.pricing.source.litellm',
  vendored: 'usage.pricing.source.vendored',
  unknown: 'usage.pricing.source.unknown',
};

/** Per-token → per-million, trimmed to what a price list prints. */
export function perMillion(value: number | undefined): string {
  if (value === undefined) return '';
  const scaled = value * PER_MILLION;
  return String(Number(scaled.toPrecision(6)));
}

/** A typed per-million figure → per-token; empty is "unknown" (undefined). */
export function perToken(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value / PER_MILLION : null;
}

function priceText(value: number | undefined, currency: string, unknown: string): string {
  if (value === undefined) return unknown;
  const figure = perMillion(value);
  return currency === 'USD' ? `$${figure}` : `${figure} ${currency}`;
}

interface Draft {
  readonly values: Record<PriceField, string>;
  readonly currency: string;
  readonly pricingModel: string;
}

function draftOf(item: PricingItem): Draft {
  const prices = item.prices;
  return {
    values: {
      input_cost_per_token: perMillion(prices?.input_cost_per_token),
      output_cost_per_token: perMillion(prices?.output_cost_per_token),
      cache_read_input_token_cost: perMillion(prices?.cache_read_input_token_cost),
      cache_creation_input_token_cost: perMillion(prices?.cache_creation_input_token_cost),
    },
    currency: prices?.currency ?? 'USD',
    pricingModel: item.pricing_model ?? '',
  };
}

/** The override a draft describes, or the field that makes it invalid. */
function overrideOf(draft: Draft): { price: ModelPriceOverride } | { invalid: PriceField | 'currency' } {
  const out: Partial<Record<PriceField, number>> = {};
  for (const field of FIELDS) {
    const value = perToken(draft.values[field.key]);
    if (value === null || (value === undefined && field.required)) return { invalid: field.key };
    if (value !== undefined) out[field.key] = value;
  }
  const currency = draft.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { invalid: 'currency' };
  // Both required fields were checked above, so the cast only narrows.
  return { price: { ...(out as Pick<ModelPriceOverride, 'input_cost_per_token' | 'output_cost_per_token'>), currency } };
}
const INPUT = 'h-8 w-full rounded-md border border-hairline bg-paper px-2 text-right font-mono text-[12.5px] text-ink tabular-nums outline-none transition-colors duration-[var(--kiki-motion-quick)] placeholder:text-ink-faint focus:border-selected-ink aria-[invalid=true]:border-danger';

export function PricingPanel({ onClose, models }: {
  onClose: () => void;
  /** Models the current usage view names, so unpriced ones are listed too. */
  models: readonly string[];
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const [openModel, setOpenModel] = useState<string | null>(null);
  const pricing = useQuery({
    queryKey: ['usage-pricing', models],
    queryFn: () => client.getUsagePricing(models),
    staleTime: 30_000,
  });
  // Configured aliases can name the model they are billed as.
  const catalog = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const configured = useMemo(() => new Set((catalog.data?.items ?? []).map((item) => item.id)), [catalog.data]);

  const items = pricing.data?.items ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = needle === '' ? items : items.filter((item) =>
    item.model.toLowerCase().includes(needle) || (item.matched_key ?? '').toLowerCase().includes(needle));
  const unknownCount = items.filter((item) => item.source === 'unknown').length;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['usage-pricing'] });
    // The dashboard's estimate moves with the prices.
    await queryClient.invalidateQueries({ queryKey: ['usage-v2'] });
    await queryClient.invalidateQueries({ queryKey: ['usage-v2-strip'] });
  };

  return (
    <SidePanel
      title={t('usage.pricing.title')}
      description={t('usage.pricing.description')}
      overlayId="usage-pricing-panel"
      onClose={onClose}
      width="lg"
      data={{ 'data-usage-pricing-panel': '' }}
    >
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <input
          type="search"
          value={filter}
          onChange={(event) => { setFilter(event.target.value); }}
          placeholder={t('usage.pricing.filter')}
          aria-label={t('usage.pricing.filter')}
          className="h-8 min-w-0 flex-1 rounded-md border border-hairline bg-paper px-2.5 text-[13px] text-ink outline-none transition-colors duration-[var(--kiki-motion-quick)] placeholder:text-ink-faint focus:border-selected-ink"
        />
        {unknownCount > 0 ? (
          <span data-pricing-unknown-count className="text-[12px] text-amber-ink">{t('usage.pricing.unknownCount', { count: unknownCount })}</span>
        ) : null}
      </div>
      {pricing.isPending ? (
        <p role="status" className="py-10 text-center text-[13px] text-ink-faint">{t('usage.pricing.loading')}</p>
      ) : pricing.isError ? (
        <div className="space-y-2 py-6">
          <p className="text-[13px] text-ink">{t('usage.pricing.loadFailed')}</p>
          <InlineError error={pricing.error} />
          <button type="button" className={SECONDARY_BUTTON} onClick={() => void pricing.refetch()}>{t('common.retry')}</button>
        </div>
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-ink-faint">{t('usage.pricing.empty')}</p>
      ) : (
        <div role="table" aria-label={t('usage.pricing.title')} className="text-[13px]">
          <div role="row" className="grid grid-cols-[minmax(0,1fr)_repeat(2,5.5rem)] items-end gap-x-3 border-b border-hairline pb-1.5 text-[11.5px] text-ink-faint sm:grid-cols-[minmax(0,1fr)_repeat(4,5.5rem)]">
            <span role="columnheader">{t('usage.pricing.model')}</span>
            {FIELDS.map((field, index) => (
              <span key={field.key} role="columnheader" className={`text-right ${index > 1 ? 'hidden sm:block' : ''}`}>{t(field.labelKey)}</span>
            ))}
          </div>
          {shown.length === 0 ? (
            <p className="py-6 text-center text-[12.5px] text-ink-faint">{t('usage.pricing.noMatch', { query: filter.trim() })}</p>
          ) : shown.map((item) => (
            <PricingRow
              key={item.model}
              item={item}
              open={openModel === item.model}
              configured={configured.has(item.model)}
              onToggle={() => { setOpenModel((current) => (current === item.model ? null : item.model)); }}
              onSaved={async () => { setOpenModel(null); await refresh(); }}
            />
          ))}
          <p className="pt-3 text-[12px] leading-5 text-ink-faint">{t('usage.pricing.unitNote')}</p>
        </div>
      )}
    </SidePanel>
  );
}
function PricingRow({ item, open, configured, onToggle, onSaved }: {
  item: PricingItem;
  open: boolean;
  configured: boolean;
  onToggle: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useI18n();
  const { client } = useConnection();
  const [draft, setDraft] = useState<Draft>(() => draftOf(item));
  const [invalid, setInvalid] = useState<PriceField | 'currency' | null>(null);
  const currency = item.prices?.currency ?? 'USD';
  const unknown = t('usage.pricing.unknownPrice');
  const editorId = `pricing-editor-${item.model}`;

  const save = useMutation({
    mutationFn: async () => {
      const parsed = overrideOf(draft);
      if ('invalid' in parsed) throw Object.assign(new Error('invalid'), { field: parsed.invalid });
      await client.setUsagePricing({ overrides: { [item.model]: parsed.price } });
      const billing = draft.pricingModel.trim();
      if (configured && billing !== (item.pricing_model ?? '')) {
        await client.updateModel(item.model, { pricing_model: billing === '' ? null : billing });
      }
    },
    onMutate: () => { setInvalid(null); },
    onError: (error) => {
      const field = (error as { field?: PriceField | 'currency' }).field;
      if (field !== undefined) setInvalid(field);
    },
    onSuccess: onSaved,
  });
  const clear = useMutation({
    mutationFn: () => client.setUsagePricing({ overrides: { [item.model]: null } }),
    onSuccess: onSaved,
  });
  const failure = save.error !== null && (save.error as { field?: unknown }).field === undefined ? save.error : clear.error;

  return (
    <div role="rowgroup" data-pricing-row={item.model} className="border-b border-hairline">
      <button
        type="button"
        role="row"
        aria-expanded={open}
        aria-controls={editorId}
        onClick={() => {
          if (!open) { setDraft(draftOf(item)); setInvalid(null); save.reset(); clear.reset(); }
          onToggle();
        }}
        className="-mx-2 grid w-[calc(100%+1rem)] grid-cols-[minmax(0,1fr)_repeat(2,5.5rem)] items-center gap-x-3 rounded-md px-2 py-2 text-left transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink sm:grid-cols-[minmax(0,1fr)_repeat(4,5.5rem)]"
      >
        <span role="cell" className="min-w-0">
          <span className="block truncate font-mono text-[12.5px] text-ink" title={item.model}>{item.model}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] leading-4">
            <span data-pricing-source={item.source} className={item.source === 'unknown' ? 'text-amber-ink' : item.source === 'override' ? 'text-selected-ink' : 'text-ink-faint'}>
              {t(SOURCE_KEY[item.source])}
            </span>
            {item.matched_key !== null && item.matched_key !== item.model ? (
              <span className="min-w-0 truncate font-mono text-ink-faint" title={item.matched_key}>· {item.matched_key}</span>
            ) : null}
          </span>
        </span>
        {FIELDS.map((field, index) => (
          <span key={field.key} role="cell" className={`text-right font-mono text-[12.5px] tabular-nums ${index > 1 ? 'hidden sm:block' : ''} ${item.prices?.[field.key] === undefined ? 'text-ink-faint' : 'text-ink'}`}>
            {item.prices === null ? (index === 0 ? unknown : '') : priceText(item.prices[field.key], currency, unknown)}
          </span>
        ))}
      </button>
      <div id={editorId} className="expand-collapse grid" style={{ gridTemplateRows: open ? '1fr' : '0fr' }} inert={!open}>
        <div className="overflow-hidden">
          <form
            className="mb-3 space-y-3 rounded-lg bg-ink/[0.03] p-3"
            onSubmit={(event) => { event.preventDefault(); save.mutate(); }}
          >
            <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
              {FIELDS.map((field) => (
                <label key={field.key} className="block space-y-1">
                  <span className="block text-[11.5px] text-ink-soft">{t(field.labelKey)}{field.required ? '' : ` · ${t('usage.pricing.optional')}`}</span>
                  <input
                    inputMode="decimal"
                    value={draft.values[field.key]}
                    aria-invalid={invalid === field.key}
                    placeholder={field.required ? '0' : t('usage.pricing.unknownPrice')}
                    onChange={(event) => { setDraft((current) => ({ ...current, values: { ...current.values, [field.key]: event.target.value } })); }}
                    className={INPUT}
                  />
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
              <label className="block w-20 space-y-1">
                <span className="block text-[11.5px] text-ink-soft">{t('usage.pricing.currency')}</span>
                <input
                  value={draft.currency}
                  maxLength={3}
                  aria-invalid={invalid === 'currency'}
                  onChange={(event) => { setDraft((current) => ({ ...current, currency: event.target.value.toUpperCase() })); }}
                  className={`${INPUT} text-left uppercase`}
                />
              </label>
              {configured ? (
                <label className="block min-w-0 flex-1 space-y-1">
                  <span className="block text-[11.5px] text-ink-soft">{t('usage.pricing.billingModel')}</span>
                  <input
                    value={draft.pricingModel}
                    spellCheck={false}
                    placeholder={item.matched_key ?? item.model}
                    onChange={(event) => { setDraft((current) => ({ ...current, pricingModel: event.target.value })); }}
                    className={`${INPUT} text-left`}
                  />
                </label>
              ) : null}
            </div>
            {draft.currency.trim().toUpperCase() !== 'USD' ? (
              <p className="text-[12px] leading-5 text-amber-ink">{t('usage.pricing.nonUsd')}</p>
            ) : null}
            {invalid !== null ? (
              <p role="alert" className="text-[12px] text-danger">{t(invalid === 'currency' ? 'usage.pricing.invalidCurrency' : 'usage.pricing.invalidPrice')}</p>
            ) : null}
            {failure !== null && failure !== undefined ? <InlineError error={failure} /> : null}
            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" disabled={save.isPending} className={PRIMARY_BUTTON}>
                {save.isPending ? t('usage.pricing.saving') : t('usage.pricing.save')}
              </button>
              <button type="button" className={SECONDARY_BUTTON} onClick={onToggle}>{t('common.cancel')}</button>
              {item.source === 'override' ? (
                <button
                  type="button"
                  disabled={clear.isPending}
                  onClick={() => { clear.mutate(); }}
                  className="ml-auto h-8 rounded-md px-2 text-[12px] text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50"
                >
                  {t('usage.pricing.clear')}
                </button>
              ) : null}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
