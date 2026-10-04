/**
 * Context window vs. automatic compaction, the two quantities the model
 * editor and the defaults tab keep apart:
 *   - the window is a fact of the model/endpoint (only the model declares it);
 *   - the compaction point is a preference that decides when to compact.
 * Model and profile layers store the point as tokens; only the global default
 * is a percentage of each model's usable window. What a model really gets is
 * the engine's own resolution — model overrides, then the context budget, then
 * the input limit against the window — and the movable range of its point is
 * the same clamp; both are owned by the shared preview helpers.
 */

import { useEffect, useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import {
  inheritedCompactPoint,
  modelCompactionBounds,
  modelCompactionPreview,
  modelCompactPoint,
  readLoopControl,
} from '@kiki/session-core/settings/modelCompaction';

import { useI18n } from '../../i18n';
import {
  AUTO_COMPACT_STEP,
  CONTEXT_WINDOW_PRESETS,
  compactPercentLabel,
  compactPresetsFor,
  formatCompactTokens,
  shortPercent,
  snapCompactTokens,
  type AutoCompactBounds,
} from '../../lib/autoCompact';
import { TokenPresetRow } from '../TokenPresetRow';
import { useConnection } from '../../state/connection';
import { ContextStepper } from '../ProviderFields';
import { FeedbackLine, Hint, InlineError, SavedTick, type Feedback } from '../controls';
import { SMALL_INPUT } from '../ui';
import { CompactPointField } from './CompactPointField';
import { AdvancedDetails } from './fields';
import { SectionCard } from './SectionCard';
import { useSavedTick } from './useSavedTick';

const HATCH = 'repeating-linear-gradient(135deg, var(--color-hairline-strong) 0 1.5px, transparent 1.5px 4px)';

/**
 * The compaction point on a real track: dragging or arrowing moves the same
 * draft the text field writes, and the point the model will use stays visible
 * on the right while it moves. Nothing is saved here — the editor's Save is
 * the only writer, and it already carries the draft's dirty state.
 */
export function CompactPointTrack({
  label,
  dataAttribute,
  usable,
  bounds,
  reserved,
  value,
  title,
  reason,
  pinned = false,
  onChange,
}: {
  label: string;
  dataAttribute: string;
  /** Effective window the point is measured against. */
  usable: number;
  /** Movable range from the shared clamp, or undefined when nothing previews. */
  bounds: AutoCompactBounds | undefined;
  reserved: number;
  /** The point as the editor shows it: the draft, the override, or the default. */
  value: number | undefined;
  /** What the number means right now, e.g. where an inherited point comes from. */
  title: string;
  /** Why the track cannot move, shown next to it exactly when it cannot. */
  reason: string;
  /** A model override sets the point, so this track may only report it. */
  pinned?: boolean;
  onChange: (tokens: number) => void;
}) {
  const { t } = useI18n();
  const reasonId = useId();
  // A window the reserve swallows leaves no scale to draw: the track stays a
  // hairline and the reason line says why, instead of painting negative space.
  const scale = bounds !== undefined && Number.isFinite(usable) && usable > 0 && Number.isFinite(bounds.ceil) && bounds.ceil > 0
    ? bounds
    : undefined;
  const movable = scale !== undefined && !scale.locked && !pinned;
  const shown = value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
  const parked = scale === undefined ? undefined : Math.min(scale.ceil, Math.max(scale.floor, shown ?? scale.floor));
  const at = (tokens: number) => `${Math.min(100, Math.max(0, (tokens / usable) * 100))}%`;
  const percent = shown === undefined || scale === undefined ? '' : compactPercentLabel(shown, usable);
  const pageStep = Math.max(AUTO_COMPACT_STEP, Math.round((usable * 0.05) / AUTO_COMPACT_STEP) * AUTO_COMPACT_STEP);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2" data-compact-track={dataAttribute}>
        <div className="relative h-6 min-w-0 flex-1 pointer-coarse:h-11">
          <div aria-hidden className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-hairline">
            {scale === undefined || parked === undefined ? null : (
              <>
                <div className="absolute inset-y-0 left-0 bg-ink/[0.06]" style={{ width: at(scale.floor) }} />
                <div data-compact-track-fill className="absolute inset-y-0 left-0 bg-ink/[0.12]" style={{ width: at(parked) }} />
                <div data-compact-track-reserve className="absolute inset-y-0 right-0 bg-canvas" style={{ width: at(reserved), backgroundImage: HATCH }} />
              </>
            )}
          </div>
          {scale === undefined || parked === undefined ? null : (
            <input
              type="range"
              data-compact-slider
              aria-label={label}
              aria-valuetext={t('st.compact.trackValue', { tokens: formatCompactTokens(parked), limit: formatCompactTokens(usable) })}
              aria-describedby={movable ? undefined : reasonId}
              min={scale.floor}
              max={scale.ceil}
              // Native stepping on the token grid would put the real endpoints
              // out of reach, so a pointer move is snapped here instead.
              step={1}
              value={parked}
              disabled={!movable}
              onChange={(event) => { onChange(snapCompactTokens(Number(event.target.value), scale)); }}
              onKeyDown={(event) => {
                let next: number | undefined;
                if (event.key === 'PageUp') next = parked + pageStep;
                if (event.key === 'PageDown') next = parked - pageStep;
                if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = parked + AUTO_COMPACT_STEP;
                if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = parked - AUTO_COMPACT_STEP;
                if (event.key === 'Home') next = scale.floor;
                if (event.key === 'End') next = scale.ceil;
                if (next === undefined) return;
                event.preventDefault();
                // One key press is one step from where the point is. Snapping
                // again would round an off-grid value (an inherited 340k) up
                // past the ceiling, turning a step into a jump.
                onChange(Math.min(scale.ceil, Math.max(scale.floor, next)));
              }}
              // A half-thumb of slack on each side keeps the native value↔pixel
              // map identical to the painted track.
              className="peer absolute inset-y-0 z-10 m-0 cursor-ew-resize appearance-none bg-transparent opacity-0 disabled:cursor-default [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none"
              style={{ left: `calc(${at(scale.floor)} - 8px)`, width: `calc(${at(scale.ceil - scale.floor)} + 16px)` }}
            />
          )}
          {/* Thumb: ink at rest, ink-blue ring on keyboard focus. */}
          {parked === undefined ? null : (
            <span
              aria-hidden
              data-compact-thumb
              className={`pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-paper transition-shadow duration-[var(--kiki-motion-quick)] peer-hover:shadow-[0_0_0_4px_rgb(var(--kiki-shadow-ink)/0.08)] peer-focus-visible:shadow-[0_0_0_3px_var(--color-paper),0_0_0_5px_var(--color-selected-ink)] ${
                movable ? 'bg-ink' : 'bg-ink-faint'
              }`}
              style={{ left: at(parked) }}
            />
          )}
        </div>
        <span
          data-compact-track-value
          title={title}
          className={`flex shrink-0 items-baseline gap-1 font-mono text-[12px] tabular-nums ${
            shown === undefined ? 'text-ink-faint' : value === undefined ? 'text-ink-soft' : 'text-ink'
          }`}
        >
          <span>{shown === undefined ? '—' : formatCompactTokens(shown)}</span>
          {percent === '' ? null : <span className="text-ink-faint">{percent}</span>}
        </span>
      </div>
      {movable ? null : (
        <p id={reasonId} data-compact-track-reason className="text-[12px] leading-4 text-ink-faint">{reason}</p>
      )}
    </div>
  );
}

/**
 * The model editor's context block: the window the model supports, then the
 * compaction point on a track that follows the draft. Leaving the point empty
 * inherits the global percentage (or the built-in formula), shown as the
 * placeholder; the number on the right of the track is what the model gets.
 */
export function ModelContextFields({
  modelId,
  windowTokens,
  inputTokens,
  contextBudget,
  overrides,
  onWindowChange,
  autoCompact,
  onAutoCompactChange,
  loopControl,
  hideCompaction = false,
}: {
  modelId: string;
  windowTokens: number;
  /** Declared input limit; the effective one is clamped to the window. */
  inputTokens?: number;
  /** Declared context budget for the model, if any. */
  contextBudget?: number;
  /** Model overrides as the engine stores them, or the editor's JSON text. */
  overrides?: unknown;
  onWindowChange: (value: number) => void;
  autoCompact: number | undefined;
  onAutoCompactChange: (value: number | undefined) => void;
  loopControl: unknown;
  /**
   * The compaction point moved to the model editor's parameter group, where
   * shared and per-identity values are one row instead of two. The window and
   * its usable-range preview stay here, because they are a fact about the
   * model rather than a setting anybody chooses.
   */
  hideCompaction?: boolean;
}) {
  const { t } = useI18n();
  const loop = readLoopControl(loopControl);
  const reserved = loop.reservedContextSize ?? 50_000;
  // The draft is resolved the way the engine will read it: model overrides
  // first, then the context budget, then the input limit against the window.
  const preview = modelCompactionPreview({ windowTokens, inputTokens, contextBudget, autoCompact, overrides });
  const usable = preview.valid ? preview.usableTokens : 0;
  const bounds = preview.valid ? modelCompactionBounds(usable, reserved) : undefined;
  const inherited = preview.valid && usable > 0 ? inheritedCompactPoint(usable, loop) : undefined;
  // The clamp lands on a non-positive point when the reserve swallows the
  // window; a negative "default" is not something the field should promise.
  const inheritedTokens = inherited !== undefined && Number.isFinite(inherited.tokens) && inherited.tokens > 0 ? inherited.tokens : undefined;
  const inheritedLabel = inherited === undefined || inheritedTokens === undefined
    ? ''
    : inherited.from === 'global'
      ? t('st.compact.inheritGlobal', { tokens: formatCompactTokens(inheritedTokens), percent: inherited.percent ?? '' })
      : t('st.compact.inheritLegacy', { tokens: formatCompactTokens(inheritedTokens) });
  // A model override pins the point the sessions actually get, so that is the
  // number the track shows and the reason it will not move.
  const overridden = preview.valid && preview.autoCompactOverridden && preview.autoCompact !== undefined;
  // The track reports the point the engine will apply, which is the draft run
  // through the same clamp; the field above keeps the raw draft it was given.
  const effectivePoint = preview.valid && usable > 0
    ? modelCompactPoint(usable, overridden ? preview.autoCompact : autoCompact, loop)
    : undefined;
  const trackValue = effectivePoint !== undefined && Number.isFinite(effectivePoint) && effectivePoint > 0 ? effectivePoint : undefined;
  const overCeil = !overridden && autoCompact !== undefined && bounds !== undefined && autoCompact > bounds.ceil;
  const noRoom = bounds === undefined || bounds.locked;
  const trackReason = !preview.valid
    ? t('st.compact.trackOverridesInvalid')
    : overridden
      ? t('st.compact.trackOverridden')
      : usable <= 0
        ? t('st.compact.trackNeedsWindow')
        : t('st.compact.trackLocked');
  const trackTitle = overridden
    ? t('st.compact.trackOverridden')
    : autoCompact === undefined
      ? inheritedLabel
      : overCeil
        ? t('st.compact.pointClampHint', { tokens: formatCompactTokens(bounds?.ceil ?? 0) })
        : formatCompactTokens(trackValue ?? autoCompact);
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
          {inputTokens !== undefined && preview.valid
            ? t('st.compact.windowInputHint', { tokens: formatCompactTokens(usable) })
            : t('st.compact.windowHint')}
        </p>
      </div>
      {hideCompaction === true ? null : (
      <div>
        <CompactPointField
          dataAttribute={`model:${modelId}`}
          label={t('st.compact.pointLabel')}
          value={autoCompact}
          onChange={onAutoCompactChange}
          windowTokens={usable}
          placeholder={inheritedLabel}
          presets={bounds === undefined ? undefined : compactPresetsFor(usable, bounds.ceil, bounds.floor)}
          presetsLabel={t('context.compact.presetsLabel')}
          hint={noRoom
            ? undefined
            : overCeil
              ? t('st.compact.pointClampHint', { tokens: formatCompactTokens(bounds.ceil) })
              : t('st.compact.pointHint')}
        />
        <CompactPointTrack
          label={t('st.compact.trackLabel')}
          dataAttribute={`model:${modelId}`}
          usable={usable}
          bounds={bounds}
          reserved={reserved}
          value={trackValue}
          title={trackTitle}
          reason={trackReason}
          pinned={overridden}
          onChange={onAutoCompactChange}
        />
      </div>
      )}
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

/**
 * Everything the compaction track needs for one model, derived the way the
 * engine reads it: model overrides first, then the context budget, then the
 * input limit against the window. The parameter group renders this under the
 * compaction row rather than repeating the arithmetic.
 */
export function useModelCompactionTrack(input: {
  windowTokens: number;
  inputTokens: number | undefined;
  contextBudget: number | undefined;
  overrides: unknown;
  autoCompact: number | undefined;
  loopControl: unknown;
}): {
  usable: number;
  reserved: number;
  bounds: AutoCompactBounds | undefined;
  inheritedTokens: number | undefined;
  inheritedLabel: string;
  overridden: boolean;
  trackValue: number | undefined;
  trackTitle: string;
  trackReason: string;
  overCeil: boolean;
  presets: readonly number[] | undefined;
  presetsLabel: string;
  hint: string | undefined;
} {
  const { t } = useI18n();
  const loop = readLoopControl(input.loopControl);
  const reserved = loop.reservedContextSize ?? 50_000;
  const preview = modelCompactionPreview({
    windowTokens: input.windowTokens,
    inputTokens: input.inputTokens,
    contextBudget: input.contextBudget,
    autoCompact: input.autoCompact,
    overrides: input.overrides,
  });
  const usable = preview.valid ? preview.usableTokens : 0;
  const bounds = preview.valid ? modelCompactionBounds(usable, reserved) : undefined;
  const inherited = preview.valid && usable > 0 ? inheritedCompactPoint(usable, loop) : undefined;
  const inheritedTokens = inherited !== undefined && Number.isFinite(inherited.tokens) && inherited.tokens > 0
    ? inherited.tokens : undefined;
  const inheritedLabel = inherited === undefined || inheritedTokens === undefined
    ? ''
    : inherited.from === 'global'
      ? t('st.compact.inheritGlobal', { tokens: formatCompactTokens(inheritedTokens), percent: inherited.percent ?? '' })
      : t('st.compact.inheritLegacy', { tokens: formatCompactTokens(inheritedTokens) });
  const overridden = preview.valid && preview.autoCompactOverridden && preview.autoCompact !== undefined;
  const effectivePoint = preview.valid && usable > 0
    ? modelCompactPoint(usable, overridden ? preview.autoCompact : input.autoCompact, loop)
    : undefined;
  const trackValue = effectivePoint !== undefined && Number.isFinite(effectivePoint) && effectivePoint > 0
    ? effectivePoint : undefined;
  const overCeil = !overridden && input.autoCompact !== undefined && bounds !== undefined && input.autoCompact > bounds.ceil;
  const noRoom = bounds === undefined || bounds.locked;
  return {
    usable,
    reserved,
    bounds,
    inheritedTokens,
    inheritedLabel,
    overridden,
    trackValue,
    trackTitle: overridden
      ? t('st.compact.trackOverridden')
      : input.autoCompact === undefined ? inheritedLabel
      : overCeil ? t('st.compact.pointClampHint', { tokens: formatCompactTokens(bounds?.ceil ?? 0) })
      : formatCompactTokens(trackValue ?? input.autoCompact),
    trackReason: !preview.valid
      ? t('st.compact.trackOverridesInvalid')
      : overridden ? t('st.compact.trackOverridden')
      : usable <= 0 ? t('st.compact.trackNeedsWindow')
      : t('st.compact.trackLocked'),
    overCeil,
    presets: bounds === undefined ? undefined : compactPresetsFor(usable, bounds.ceil, bounds.floor),
    presetsLabel: t('context.compact.presetsLabel'),
    hint: noRoom ? undefined
      : overCeil ? t('st.compact.pointClampHint', { tokens: formatCompactTokens(bounds.ceil) })
      : t('st.compact.pointHint'),
  };
}

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
        <AdvancedDetails summary={t('st.compact.advanced')} data-auto-compact-advanced>
          <div className="flex flex-wrap items-center gap-2">
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
          <p className="max-w-[62ch] text-[12px] leading-snug text-ink-faint">{t('st.compact.reserveHint')}</p>
        </AdvancedDetails>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}
