/**
 * PluginToolCardBody — E12 Slot 6 (`tool-card-renderer`).
 *
 * Purely declarative tool-card field rendering for plugin tools. Maps safe
 * dot/index field paths (`args.*`, `result.*`, `display.*`) into Kiki's Paper &
 * Ink typography without executing untrusted HTML or scripts.
 */

import type { ReactNode } from 'react';

import {
  formatPluginToolFieldValue,
  resolvePluginLocalizedText,
  resolvePluginToolFieldValue,
  type PluginToolCardFieldSpec,
  type PluginToolCardRendererSlotContribution,
} from '@kiki/session-core';

import { useI18n } from '../../i18n';
import { FilePathLink } from '../mediaParts';

export interface PluginToolFieldSources {
  readonly args?: unknown;
  readonly result?: unknown;
  readonly display?: unknown;
}

export function resolvePluginToolTargetNode(
  slot: PluginToolCardRendererSlotContribution,
  sources: PluginToolFieldSources,
): ReactNode | undefined {
  if (slot.targetFieldPath === undefined || slot.targetFieldPath.trim() === '') {
    return undefined;
  }
  const raw = resolvePluginToolFieldValue(sources, slot.targetFieldPath);
  const formatted = formatPluginToolFieldValue(raw, 'inline-text');
  if (formatted === undefined || formatted === '') return undefined;
  const looksLikePath = /[\\/]/.test(formatted) && !formatted.includes(' ');
  return (
    <span className="font-mono" data-plugin-tool-target>
      {looksLikePath ? <FilePathLink path={formatted} /> : formatted}
    </span>
  );
}

function renderFormattedFieldValue(
  value: string,
  format: PluginToolCardFieldSpec['format'],
): ReactNode {
  switch (format) {
    case 'file-path':
      return (
        <span className="font-mono text-[12.5px] text-ink">
          <FilePathLink path={value} />
        </span>
      );
    case 'badge':
      return (
        <span className="inline-flex items-center rounded-full border border-hairline bg-paper px-2 py-0.5 font-mono text-[11px] font-medium text-ink-soft">
          {value}
        </span>
      );
    case 'code':
    case 'diff':
      return (
        <pre className="max-h-56 overflow-auto rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink">
          {value}
        </pre>
      );
    case 'key-value':
      return (
        <span className="font-mono text-[12px] text-ink-soft">{value}</span>
      );
    case 'inline-text':
    default:
      return (
        <span className="text-[12.5px] text-ink">{value}</span>
      );
  }
}

export function PluginToolCardBody({
  slot,
  sources,
  rawFallback,
}: {
  readonly slot: PluginToolCardRendererSlotContribution;
  readonly sources: PluginToolFieldSources;
  readonly rawFallback?: ReactNode;
}) {
  const { locale } = useI18n();

  const summaryRows = slot.summaryFields.flatMap((field, index) => {
    const raw = resolvePluginToolFieldValue(sources, field.sourcePath);
    const formatted = formatPluginToolFieldValue(raw, field.format);
    if (formatted === undefined) return [];
    return [{ key: `summary-${index}`, field, formatted }];
  });

  const detailRows = slot.detailFields.flatMap((field, index) => {
    const raw = resolvePluginToolFieldValue(sources, field.sourcePath);
    const formatted = formatPluginToolFieldValue(raw, field.format);
    if (formatted === undefined) return [];
    return [{ key: `detail-${index}`, field, formatted }];
  });

  if (summaryRows.length === 0 && detailRows.length === 0) {
    return rawFallback !== undefined ? <>{rawFallback}</> : null;
  }

  return (
    <div
      data-plugin-tool-card={`${slot.pluginId}:${slot.id}`}
      className="space-y-2.5 pt-0.5"
    >
      {summaryRows.length > 0 ? (
        <dl
          data-plugin-tool-summary
          className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5"
        >
          {summaryRows.map(({ key, field, formatted }) => {
            const label = resolvePluginLocalizedText(field.label, locale);
            return (
              <div key={key} className="flex min-w-0 items-baseline gap-1.5">
                <dt className="shrink-0 text-[11.5px] text-ink-faint">{label}</dt>
                <dd className="min-w-0 break-words">{renderFormattedFieldValue(formatted, field.format)}</dd>
              </div>
            );
          })}
        </dl>
      ) : null}

      {detailRows.length > 0 ? (
        <div data-plugin-tool-details className="space-y-2">
          {detailRows.map(({ key, field, formatted }) => {
            const label = resolvePluginLocalizedText(field.label, locale);
            const blockFormat = field.format === 'code' || field.format === 'diff';
            return blockFormat ? (
              <div key={key} className="space-y-1">
                <p className="text-[11.5px] font-medium text-ink-faint">{label}</p>
                {renderFormattedFieldValue(formatted, field.format)}
              </div>
            ) : (
              <div key={key} className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 text-[11.5px] text-ink-faint">{label}</span>
                <div className="min-w-0 flex-1 break-words">
                  {renderFormattedFieldValue(formatted, field.format)}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {rawFallback !== undefined ? (
        <details className="pt-1">
          <summary className="cursor-pointer text-[12px] text-ink-faint select-none">
            {locale === 'zh' ? '原始输入与输出' : 'Raw input & output'}
          </summary>
          <div className="mt-1.5 space-y-2">{rawFallback}</div>
        </details>
      ) : null}
    </div>
  );
}
