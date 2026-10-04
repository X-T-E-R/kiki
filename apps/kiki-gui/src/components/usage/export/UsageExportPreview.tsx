/**
 * Usage → External sync → payload preview.
 *
 * This is the screen a person actually decides on, so it shows the payload's
 * own numbers rather than a summary of a summary: the exact UTC history start,
 * how much of the local history the snapshot covers, what the quality flags say
 * about the records behind it, and one real bucket exactly as it would be
 * serialized. The server's own consent text stays available verbatim, and the
 * caveats a person cannot infer (vibecafe.ai's total definition, a script's
 * ordinary OS permissions) are stated above it in the active locale.
 *
 * Nothing here is optimistic: `stale` is set by the caller when the form has
 * been edited since the preview, and it replaces the consent action with a
 * request to preview again.
 */

import { useState, type ReactNode } from 'react';

import { useI18n } from '../../../i18n';
import type { UsageExportPreview } from '@kiki/protocol';
import { Icon } from '../../icons';
import {
  previewQuality,
  sampleItem,
  utcLabel,
} from '../../../lib/usageExport';

const PRE = 'max-h-64 overflow-y-auto rounded-lg border border-hairline bg-paper/60 p-2 font-mono text-[11px] leading-snug text-ink-soft whitespace-pre-wrap';
const NOTE_SOFT = 'rounded-lg border border-hairline bg-panel px-3 py-2 text-[12.5px] leading-relaxed text-ink-soft';
const NOTE_AMBER = 'rounded-lg border border-amber-rule/40 bg-amber-card px-3 py-2 text-[12.5px] leading-relaxed text-amber-ink';

export function UsageExportPreviewBlock({ preview, stale, footer }: {
  readonly preview: UsageExportPreview;
  /** The form changed after this preview was built. */
  readonly stale: boolean;
  readonly footer?: ReactNode;
}) {
  const { t } = useI18n();
  const [jsonOpen, setJsonOpen] = useState(false);
  const quality = previewQuality(preview);
  const sample = sampleItem(preview);
  const kind = preview.destination.target.kind;
  const mappingWarnings = quality.unmapped > 0 || quality.unpriced > 0 || quality.invalid > 0;

  return (
    <div data-usage-export-preview-block className="space-y-3">
      <div>
        <h4 className="font-display text-[15px] font-semibold text-ink">{t('usage.export.preview.title')}</h4>
        <dl className="mt-1.5 space-y-1 text-[12.5px] leading-relaxed">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <dt className="text-ink-faint">{t('usage.export.detail.scope')}</dt>
            <dd data-usage-export-preview-range className="font-mono text-ink tabular-nums">
              {utcLabel(preview.destination.scope.start_at)}
            </dd>
            <dd className="text-ink-soft">· {t('usage.export.preview.count', { count: quality.total })}</dd>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <dt className="text-ink-faint">{t('usage.export.detail.quality')}</dt>
            <dd data-usage-export-preview-quality className="font-mono text-ink-soft tabular-nums">
              {t('usage.export.preview.quality', {
                known: quality.known, missing: quality.missing, legacy: quality.legacy,
              })}
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-[12.5px]">
          {preview.source_complete
            ? <span data-usage-export-preview-complete className="text-ink-faint">{t('usage.export.preview.complete')}</span>
            : <span data-usage-export-preview-incomplete role="status" className="text-amber-ink">{t('usage.export.preview.incomplete')}</span>}
        </p>
      </div>

      {quality.total === 0 ? <p className={NOTE_SOFT}>{t('usage.export.preview.empty')}</p> : null}

      {mappingWarnings ? (
        <ul data-usage-export-preview-warnings className="space-y-1">
          {quality.unmapped > 0 ? (
            <li className="text-[12.5px] leading-relaxed text-amber-ink">
              {t('usage.export.preview.mapping', { count: quality.unmapped })}
            </li>
          ) : null}
          {quality.unpriced > 0 ? (
            <li className="text-[12.5px] leading-relaxed text-amber-ink">
              {t('usage.export.preview.price', { count: quality.unpriced })}
            </li>
          ) : null}
          {quality.invalid > 0 ? (
            <li className="text-[12.5px] leading-relaxed text-amber-ink">
              {t('usage.export.preview.invalid', { count: quality.invalid })}
            </li>
          ) : null}
        </ul>
      ) : null}

      {kind === 'vibe' ? (
        <div className={NOTE_AMBER} data-usage-export-vibe-caveat>
          <p>{t('usage.export.vibe.caveat')}</p>
          <details className="mt-1.5 [&[open]>summary]:mb-1">
            <summary className="cursor-pointer text-[12px] underline decoration-dotted underline-offset-2">
              {t('usage.export.form.advanced')}
            </summary>
            <p className="text-[12.5px] leading-relaxed">{t('usage.export.vibe.detail')}</p>
          </details>
        </div>
      ) : null}

      {sample !== undefined && sample.bucket !== null ? (
        <div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h5 className="text-[12.5px] font-medium text-ink">{t('usage.export.preview.sample')}</h5>
            <p className="text-[12px] text-ink-faint">{t('usage.export.preview.sampleNote')}</p>
            <button
              type="button"
              data-usage-export-preview-json-toggle
              aria-expanded={jsonOpen}
              onClick={() => { setJsonOpen((open) => !open); }}
              className="ml-auto inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-[12px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
            >
              <Icon name={jsonOpen ? 'collapse' : 'expand'} size={12} />
              {t(jsonOpen ? 'usage.export.preview.hideJson' : 'usage.export.preview.showJson')}
            </button>
          </div>
          <pre data-usage-export-preview-sample className={`mt-1 ${PRE}`}>
            {JSON.stringify(jsonOpen ? sample : { schema_version: sample.schema_version, bucket: sample.bucket, operation: sample.operation, revision: sample.revision }, null, 2)}
          </pre>
          {preview.items.length > 1 ? (
            <p data-usage-export-preview-items className="mt-1 text-[11.5px] text-ink-faint tabular-nums">
              {t('usage.export.preview.items', { shown: Math.min(preview.items.length, 200), total: preview.total_buckets })}
            </p>
          ) : null}
        </div>
      ) : null}

      <div>
        <p className="text-[12.5px] leading-relaxed">{t('usage.export.preview.bindingNote')}</p>
        <details className="mt-0.5 [&[open]>summary]:mb-0.5">
          <summary className="inline cursor-pointer text-[12px] text-ink-faint underline decoration-dotted underline-offset-2">
            {t('usage.export.preview.bindingShow')}
          </summary>
          <p className="text-[12px] text-ink-faint">
            <span data-usage-export-preview-fingerprint title={preview.preview_fingerprint} className="font-mono break-all text-ink-soft">
              {preview.preview_fingerprint.slice(0, 24)}…
            </span>
          </p>
        </details>
      </div>

      {stale ? <p role="status" data-usage-export-preview-stale className={NOTE_AMBER}>{t('usage.export.form.previewStale')}</p> : null}

      {preview.disclosures.length > 0 ? (
        <details data-usage-export-disclosures className="text-[12.5px] leading-relaxed text-ink-soft [&[open]>summary]:mb-1.5">
          <summary className="cursor-pointer text-[12px] text-ink-faint underline decoration-dotted underline-offset-2">
            {t('usage.export.preview.serviceText')}
          </summary>
          <ul className="list-disc space-y-1 pl-4">
            {preview.disclosures.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </details>
      ) : null}

      {footer}
    </div>
  );
}

/**
 * The facts a person is actually agreeing to, in the active locale. The
 * server's own disclosure text stays below in the preview block; these lines
 * exist so the consent is readable without depending on server prose.
 */
export function UsageExportConsentFacts({ kind, privateGrant }: { readonly kind: string; readonly privateGrant: boolean }) {
  const { t } = useI18n();
  const facts = [
    'usage.export.consent.fact.noContent',
    'usage.export.consent.fact.timing',
    'usage.export.consent.fact.identity',
    'usage.export.consent.fact.background',
    'usage.export.consent.fact.reobtain',
  ] as const;
  return (
    <div data-usage-export-consent-facts className="space-y-1.5">
      <p className="text-[12.5px] font-medium text-ink">{t('usage.export.consent.summary')}</p>
      <ul className="list-disc space-y-1 pl-4 text-[12.5px] leading-relaxed text-ink-soft">
        {facts.map((key) => <li key={key}>{t(key)}</li>)}
        {privateGrant ? <li>{t('usage.export.form.privateHint')}</li> : null}
        {kind === 'script' ? <li>{t('usage.export.form.commandHint')}</li> : null}
      </ul>
    </div>
  );
}
