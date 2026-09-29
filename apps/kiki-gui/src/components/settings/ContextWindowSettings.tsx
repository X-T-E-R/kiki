/**
 * Context window vs. automatic compaction, the two quantities the model
 * editor and the defaults tab keep apart:
 *   - the window is a fact of the model/endpoint (only the model declares it);
 *   - the compaction point is a preference that decides when to compact.
 * Model and profile layers store the point as tokens; only the global default
 * is a percentage of each model's usable window.
 */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import {
  CONTEXT_WINDOW_PRESETS,
  compactPresetsFor,
  formatCompactTokens,
  legacyCompactDefault,
  shortPercent,
} from '../../lib/autoCompact';
import { TokenPresetRow } from '../TokenPresetRow';
import { useConnection } from '../../state/connection';
import { ContextStepper } from '../ProviderFields';
import { FeedbackLine, Hint, InlineError, SavedTick, type Feedback } from '../controls';
import { SMALL_INPUT } from '../ui';
import { CompactPointField } from './CompactPointField';
import { SectionCard } from './SectionCard';
import { useSavedTick } from './useSavedTick';

interface LoopControlView {
  readonly autoCompact?: string;
  readonly compactionTriggerRatio?: number;
  readonly compactionSoftContextSize?: number;
  readonly reservedContextSize?: number;
}

/** The config echo keeps loop_control's inner keys camelCase or snake_case depending on the path. */
export function readLoopControl(value: unknown): LoopControlView {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const pick = (camel: string, snake: string) => record[camel] ?? record[snake];
  const autoCompact = pick('autoCompact', 'auto_compact');
  const ratio = pick('compactionTriggerRatio', 'compaction_trigger_ratio');
  const soft = pick('compactionSoftContextSize', 'compaction_soft_context_size');
  const reserved = pick('reservedContextSize', 'reserved_context_size');
  return {
    autoCompact: typeof autoCompact === 'string' ? autoCompact : undefined,
    compactionTriggerRatio: typeof ratio === 'number' ? ratio : undefined,
    compactionSoftContextSize: typeof soft === 'number' && soft > 0 ? soft : undefined,
    reservedContextSize: typeof reserved === 'number' ? reserved : undefined,
  };
}

/**
 * What applies to a model with no point of its own: the global percentage,
 * or the legacy formula. Display-only; the server resolves the real value.
 */
export function inheritedCompactPoint(usable: number, loop: LoopControlView): { tokens: number; from: 'global' | 'legacy'; percent?: string } {
  const reserved = loop.reservedContextSize ?? 50_000;
  if (loop.autoCompact !== undefined) {
    const percent = Number(loop.autoCompact.replace('%', ''));
    const ceil = Math.max(0, usable - reserved);
    return { tokens: Math.min(ceil, Math.round((usable * percent) / 100)), from: 'global', percent: shortPercent(loop.autoCompact) };
  }
  let tokens = legacyCompactDefault(usable, loop.compactionTriggerRatio ?? 0.85, reserved);
  if (loop.compactionSoftContextSize !== undefined) tokens = Math.min(tokens, loop.compactionSoftContextSize);
  return { tokens, from: 'legacy' };
}

const HATCH = 'repeating-linear-gradient(135deg, var(--color-hairline-strong) 0 1.5px, transparent 1.5px 4px)';

/** Static preview: where the point sits in the window, with the reserve hatched. Not interactive. */
function CompactPreviewTrack({ usable, point, reserved }: { usable: number; point: number; reserved: number }) {
  const at = (value: number) => `${Math.min(100, Math.max(0, (value / usable) * 100))}%`;
  return (
    <div aria-hidden data-compact-preview className="relative mt-1 h-3 w-full max-w-[22rem]">
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-hairline">
        <div className="absolute inset-y-0 left-0 bg-ink/[0.12]" style={{ width: at(point) }} />
        <div className="absolute inset-y-0 right-0 bg-canvas" style={{ width: at(reserved), backgroundImage: HATCH }} />
      </div>
      <span className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink ring-2 ring-paper" style={{ left: at(point) }} />
    </div>
  );
}

/**
 * The model editor's context block: the window the model supports, then the
 * compaction point on its own line. Leaving the point empty inherits the
 * global percentage (or the built-in formula), shown as the placeholder.
 */
export function ModelContextFields({
  modelId,
  windowTokens,
  inputTokens,
  onWindowChange,
  autoCompact,
  onAutoCompactChange,
  loopControl,
}: {
  modelId: string;
  windowTokens: number;
  inputTokens?: number;
  onWindowChange: (value: number) => void;
  autoCompact: number | undefined;
  onAutoCompactChange: (value: number | undefined) => void;
  loopControl: unknown;
}) {
  const { t } = useI18n();
  const loop = readLoopControl(loopControl);
  const usable = inputTokens ?? windowTokens;
  const reserved = loop.reservedContextSize ?? 50_000;
  const inherited = usable > 0 ? inheritedCompactPoint(usable, loop) : undefined;
  const inheritedLabel = inherited === undefined
    ? ''
    : inherited.from === 'global'
      ? t('st.compact.inheritGlobal', { tokens: formatCompactTokens(inherited.tokens), percent: inherited.percent ?? '' })
      : t('st.compact.inheritLegacy', { tokens: formatCompactTokens(inherited.tokens) });
  const point = autoCompact ?? inherited?.tokens;
  const overCeil = autoCompact !== undefined && usable > 0 && autoCompact > usable - reserved;
  return (
    <div data-model-context-fields className="space-y-3 border-t border-hairline pt-3">
      <div className="space-y-1">
        <p className="text-[12px] font-medium text-ink-soft">{t('st.compact.windowLabel')}</p>
        <ContextStepper value={windowTokens} onChange={onWindowChange} ariaLabel={t('st.models.contextAria', { model: modelId })} />
        <div className="-ml-2">
          <TokenPresetRow
            dataAttribute={`window:${modelId}`}
            label={t('st.compact.windowPresets')}
            values={CONTEXT_WINDOW_PRESETS}
            current={windowTokens}
            onPick={onWindowChange}
          />
        </div>
        <p className="max-w-[62ch] text-[12px] leading-snug text-ink-faint">
          {inputTokens !== undefined
            ? t('st.compact.windowInputHint', { tokens: formatCompactTokens(inputTokens) })
            : t('st.compact.windowHint')}
        </p>
      </div>
      <div>
        <CompactPointField
          dataAttribute={`model:${modelId}`}
          label={t('st.compact.pointLabel')}
          value={autoCompact}
          onChange={onAutoCompactChange}
          windowTokens={usable}
          placeholder={inheritedLabel}
          presets={usable > 0 ? compactPresetsFor(usable, usable - reserved, Math.min(usable - reserved, 64_000)) : undefined}
          presetsLabel={t('context.compact.presetsLabel')}
          hint={overCeil
            ? t('st.compact.pointClampHint', { tokens: formatCompactTokens(usable - reserved) })
            : t('st.compact.pointHint')}
        />
        {usable > 0 && point !== undefined ? (
          <CompactPreviewTrack usable={usable} point={Math.min(point, usable - reserved)} reserved={reserved} />
        ) : null}
      </div>
    </div>
  );
}

const PERCENT_PATTERN = /^(?:100(?:\.0+)?|[1-9]?\d(?:\.\d+)?)$/;

/**
 * Global default compaction point: the only layer written as a percentage,
 * since it spans models with very different windows. Saving replaces the
 * loop_control domain so the legacy trigger ratio / soft size keys retire
 * with it; everything else in the domain is carried over unchanged.
 */
export function GlobalCompactionCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [tick, ping] = useSavedTick();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const raw = configQuery.data?.loop_control;
  const loop = readLoopControl(raw);
  const legacyRatio = loop.compactionTriggerRatio;
  const storedPercent = loop.autoCompact?.replace('%', '');
  const shown = storedPercent !== undefined
    ? shortPercent(loop.autoCompact!).replace('%', '')
    : String(Math.round((legacyRatio ?? 0.85) * 100));
  const [text, setText] = useState(shown);
  const [reserve, setReserve] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => { setText(shown); }, [shown]);
  useEffect(() => {
    setReserve(loop.reservedContextSize === undefined ? '' : formatCompactTokens(loop.reservedContextSize));
  }, [loop.reservedContextSize]);

  const write = async (next: Record<string, unknown>) => {
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig({ loop_control: next, replace_domains: ['loop_control'] });
      queryClient.setQueryData(['config'], echoed);
      // Every open session's effective point may have moved.
      void queryClient.invalidateQueries({ queryKey: ['autoCompact'] });
      ping();
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const base = (): Record<string, unknown> => {
    const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
    for (const key of ['compactionTriggerRatio', 'compaction_trigger_ratio', 'compactionSoftContextSize', 'compaction_soft_context_size', 'autoCompact', 'auto_compact']) {
      delete record[key];
    }
    return record;
  };

  const savePercent = () => {
    const value = text.trim().replace('%', '');
    if (!PERCENT_PATTERN.test(value) || Number(value) <= 0) {
      setFeedback({ tone: 'error', text: t('st.compact.globalInvalid') });
      setText(shown);
      return;
    }
    if (storedPercent !== undefined && Number(value) === Number(storedPercent)) return;
    void write({ ...base(), autoCompact: `${value}%` });
  };

  const saveReserve = () => {
    const trimmed = reserve.trim().toLowerCase();
    const current = loop.reservedContextSize;
    if (trimmed === '') {
      if (current === undefined) return;
      const next = { ...(raw as Record<string, unknown>) };
      delete next['reservedContextSize'];
      delete next['reserved_context_size'];
      void write(next);
      return;
    }
    const match = /^(\d+(?:\.\d+)?)(k)?$/.exec(trimmed.replaceAll(',', ''));
    const tokens = match === null ? NaN : Math.round(Number(match[1]) * (match[2] === 'k' ? 1000 : 1));
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      setFeedback({ tone: 'error', text: t('st.compact.inputInvalid') });
      return;
    }
    if (tokens === current) return;
    const next = { ...(raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}) };
    delete next['reserved_context_size'];
    void write({ ...next, reservedContextSize: tokens });
  };

  const hasLegacy = storedPercent === undefined && (legacyRatio !== undefined || loop.compactionSoftContextSize !== undefined);
  return (
    <SectionCard id="st-card-auto-compact" title={t('st.compact.globalTitle')}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="st-auto-compact-percent" className="text-[13px] text-ink">{t('st.compact.globalLabel')}</label>
          <div className="flex items-center gap-1">
            <input
              id="st-auto-compact-percent"
              data-global-auto-compact
              inputMode="decimal"
              className={`${SMALL_INPUT} h-8 w-20 text-right font-mono tabular-nums`}
              value={text}
              disabled={saving || configQuery.data === undefined}
              onChange={(event) => { setText(event.target.value); }}
              onBlur={savePercent}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); savePercent(); } }}
            />
            <span aria-hidden className="text-[13px] text-ink-soft">%</span>
          </div>
          <SavedTick show={tick} />
        </div>
        <Hint>{hasLegacy
          ? t('st.compact.globalLegacyHint', { percent: String(Math.round((legacyRatio ?? 0.85) * 100)) })
          : t('st.compact.globalHint')}</Hint>
        <details className="group">
          <summary className="flex h-7 w-fit cursor-pointer list-none items-center rounded-md px-1 text-[12px] font-medium text-ink-soft hover:bg-ink/[0.04] hover:text-ink">
            {t('st.compact.advanced')}
          </summary>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label htmlFor="st-auto-compact-reserve" className="text-[13px] text-ink">{t('st.compact.reserveLabel')}</label>
            <input
              id="st-auto-compact-reserve"
              inputMode="decimal"
              className={`${SMALL_INPUT} h-8 w-24 text-right font-mono tabular-nums`}
              value={reserve}
              placeholder="50k"
              disabled={saving || configQuery.data === undefined}
              onChange={(event) => { setReserve(event.target.value); }}
              onBlur={saveReserve}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveReserve(); } }}
            />
          </div>
          <p className="mt-1 max-w-[62ch] text-[12px] leading-snug text-ink-faint">{t('st.compact.reserveHint')}</p>
        </details>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
