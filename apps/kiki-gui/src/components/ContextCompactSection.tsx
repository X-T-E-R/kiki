/**
 * ContextCompactSection — the "Context window" block of the ContextMeter
 * detail card once the server reports an automatic-compaction point. One
 * track carries used, the compaction point, the reserve and the usable limit;
 * a native range input (keyboard and screen-reader operable) moves the point,
 * a small text box takes `400k` / `400000` / `73%`. Nothing is written while
 * dragging: release, Enter, blur, or 600ms after the last arrow key commits.
 * The source label doubles as the menu that saves the point as a default.
 */

import { useEffect, useId, useRef, useState } from 'react';

import type { AutoCompactStatus, AutoCompactWriteResult } from '@kiki/protocol';

import { useI18n } from '../i18n';
import {
  AUTO_COMPACT_KEY_COMMIT_MS,
  AUTO_COMPACT_STEP,
  autoCompactBounds,
  clampCompactTokens,
  compactInputTokens,
  compactPercentLabel,
  compactPresetsFor,
  formatCompactTokens,
  parseCompactInput,
  shortPercent,
  snapCompactTokens,
  type AutoCompactSaveTarget,
  type AutoCompactSource,
} from '../lib/autoCompact';
import { pushToast } from '../lib/toasts';
import { Icon } from './icons';
import { TokenPresetRow } from './TokenPresetRow';

export interface CompactSaveOutcome {
  readonly result: AutoCompactWriteResult;
  /** Restores the layer (and the session override) to what it was before. */
  readonly undo?: () => Promise<void>;
}

export interface ContextCompactSectionProps {
  readonly status: AutoCompactStatus;
  /** Default without the session override, when known. */
  readonly defaultStatus?: AutoCompactStatus;
  readonly used: number;
  /** The model's configured window (W); the usable limit comes from `status`. */
  readonly windowTokens: number;
  /** A turn is running: the point applies before the next step, not the next message. */
  readonly running: boolean;
  /** System + tools estimate; raises the lowest movable point when known. */
  readonly residentTokens?: number;
  readonly modelLabel?: string;
  readonly profile?: { readonly name: string; readonly editable: boolean };
  readonly onCommit: (tokens: number | null) => Promise<AutoCompactWriteResult>;
  /** Saves `tokens` as the default of `target` (and as this session's value). */
  readonly onSave: (target: AutoCompactSaveTarget, tokens: number) => Promise<CompactSaveOutcome>;
}

type Note =
  | { readonly tone: 'info'; readonly text: string }
  | { readonly tone: 'error'; readonly text: string };

export const LAYER_KEY = {
  session: 'context.compact.layer.session',
  profile: 'context.compact.layer.profile',
  model: 'context.compact.layer.model',
  global: 'context.compact.layer.global',
  legacy: 'context.compact.layer.legacy',
} as const satisfies Record<AutoCompactSource, string>;

function pct(value: number, total: number): string {
  if (total <= 0) return '0%';
  return `${Math.min(100, Math.max(0, (value / total) * 100))}%`;
}

/** The reserve reads as hatched hairline: space the point may never enter. */
const RESERVE_HATCH =
  'repeating-linear-gradient(135deg, var(--color-hairline-strong) 0 1.5px, transparent 1.5px 4px)';

export function ContextCompactSection({
  status,
  defaultStatus,
  used,
  windowTokens,
  running,
  residentTokens,
  modelLabel,
  profile,
  onCommit,
  onSave,
}: ContextCompactSectionProps) {
  const { t } = useI18n();
  const inputId = useId();
  const noteId = useId();
  const usable = status.effectiveMaxContextTokens;
  const bounds = autoCompactBounds(status, residentTokens);
  // `draft` follows the thumb while dragging; the server value wins otherwise.
  const [draft, setDraft] = useState<number | null>(null);
  const [text, setText] = useState(() => formatCompactTokens(status.tokens));
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [pending, setPending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const point = draft ?? status.tokens;

  useEffect(() => {
    if (!editing) setText(formatCompactTokens(status.tokens));
  }, [editing, status.tokens]);

  useEffect(() => () => {
    if (keyTimer.current !== null) clearTimeout(keyTimer.current);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => { document.removeEventListener('pointerdown', onPointer); };
  }, [menuOpen]);

  const layerName = (source: AutoCompactSource) => t(LAYER_KEY[source], {
    model: modelLabel ?? '',
    profile: profile?.name ?? '',
  });

  const commit = async (next: number | null, clamped?: 'ceil' | 'floor') => {
    if (keyTimer.current !== null) {
      clearTimeout(keyTimer.current);
      keyTimer.current = null;
    }
    if (next !== null && next === status.tokens && status.source === 'session') {
      setDraft(null);
      return;
    }
    setPending(true);
    try {
      const result = await onCommit(next);
      setNote(clamped === undefined
        ? { tone: 'info', text: t('context.compact.appliesNextStep') }
        : { tone: 'info', text: t(clamped === 'ceil' ? 'context.compact.clampedCeil' : 'context.compact.clampedFloor', {
          tokens: formatCompactTokens(result.effective.tokens),
        }) });
    } catch {
      setNote({ tone: 'error', text: t('context.compact.saveFailed') });
    } finally {
      setDraft(null);
      setPending(false);
    }
  };

  const commitText = () => {
    setEditing(false);
    const parsed = parseCompactInput(text);
    const tokens = compactInputTokens(parsed, usable);
    if (tokens === null) {
      setNote({ tone: 'error', text: t('context.compact.inputInvalid') });
      setText(formatCompactTokens(status.tokens));
      return;
    }
    const clamped = clampCompactTokens(tokens, bounds);
    setText(formatCompactTokens(clamped.tokens));
    void commit(clamped.tokens, clamped.clamped);
  };

  const save = async (target: AutoCompactSaveTarget) => {
    setMenuOpen(false);
    setPending(true);
    try {
      const { result, undo } = await onSave(target, status.tokens);
      const saved = typeof result.savedAs === 'string'
        ? shortPercent(result.savedAs)
        : formatCompactTokens(result.savedAs ?? status.tokens);
      const targetName = target === 'model'
        ? t('context.compact.target.model', { model: modelLabel ?? '' })
        : target === 'profile'
          ? t('context.compact.target.profile', { profile: profile?.name ?? '' })
          : t('context.compact.target.global');
      if (result.overrideCleared) {
        setNote(null);
        pushToast({
          tone: 'success',
          text: t(target === 'global' ? 'context.compact.savedGlobal' : 'context.compact.saved', { target: targetName, value: saved }),
          retry: undo === undefined ? undefined : { label: t('context.compact.undo'), run: () => { void undo(); } },
        });
      } else {
        setNote({ tone: 'info', text: t('context.compact.savedShadowed', {
          target: targetName,
          value: saved,
          layer: layerName(result.default.source),
          layerValue: formatCompactTokens(result.default.tokens),
          tokens: formatCompactTokens(result.effective.tokens),
        }) });
      }
    } catch (error) {
      const readOnly = typeof error === 'object' && error !== null && 'code' in error && error.code === 40934;
      setNote({ tone: 'error', text: t(readOnly ? 'context.compact.profileReadOnly' : 'context.compact.saveFailed') });
    } finally {
      setPending(false);
    }
  };

  const onSession = status.source === 'session';
  const sourceLabel = onSession
    ? t('context.compact.sourceSession', { tokens: formatCompactTokens(status.tokens) })
    : t('context.compact.sourceDefault', { tokens: formatCompactTokens(status.tokens), layer: layerName(status.source) });
  const below = point <= used;
  const statusLine = below
    ? t(running ? 'context.compact.belowRunning' : 'context.compact.belowIdle')
    : t('context.compact.remaining', { tokens: formatCompactTokens(point - used) });
  // Fill reads "how close to the point": amber inside the last 10%, and any
  // part already past the point turns danger.
  const fillTone = used < point && used >= point * 0.9 ? 'bg-amber-rule' : 'bg-ink-soft';
  const fillEnd = Math.min(used, point);
  const overflow = Math.max(0, used - point);
  const limitLabel = usable < windowTokens
    ? t('context.compact.usableOfWindow', { usable: formatCompactTokens(usable), window: formatCompactTokens(windowTokens) })
    : t('context.compact.limitTick', { tokens: formatCompactTokens(usable) });
  const span = Math.max(1, bounds.ceil - bounds.floor);

  const pageStep = Math.max(AUTO_COMPACT_STEP, Math.round((usable * 0.05) / AUTO_COMPACT_STEP) * AUTO_COMPACT_STEP);
  const scheduleKeyCommit = (next: number) => {
    if (keyTimer.current !== null) clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(() => {
      keyTimer.current = null;
      void commit(next);
    }, AUTO_COMPACT_KEY_COMMIT_MS);
  };

  return (
    <div data-context-compact-section data-compact-source={status.source} className="mt-2">
      <div className="flex items-center justify-between gap-2">
        <p className="shrink-0 whitespace-nowrap text-[12px] font-medium text-ink-soft">{t('context.windowTitle')}</p>
        <div ref={menuRef} className="relative min-w-0">
          <button
            type="button"
            data-compact-source-trigger
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={pending}
            onClick={() => { setMenuOpen((value) => !value); }}
            className={`flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-[12px] tabular-nums outline-none transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:cursor-default pointer-coarse:h-10 ${
              onSession ? 'text-ink' : 'text-ink-soft'
            } ${menuOpen ? 'bg-ink/[0.04] text-ink' : ''}`}
          >
            <span className="truncate">{sourceLabel}</span>
            <Icon name="chevron" size={12} className={`shrink-0 text-ink-faint transition-transform ${menuOpen ? '-rotate-90' : 'rotate-90'}`} />
          </button>
          {menuOpen ? (
            <CompactSourceMenu
              tokens={status.tokens}
              usable={usable}
              modelLabel={modelLabel}
              profile={profile}
              canReset={onSession}
              resetLabel={defaultStatus === undefined
                ? t('context.compact.reset')
                : t('context.compact.resetTo', { tokens: formatCompactTokens(defaultStatus.tokens), layer: layerName(defaultStatus.source) })}
              onClose={() => { setMenuOpen(false); }}
              onSave={(target) => { void save(target); }}
              onReset={() => { setMenuOpen(false); void commit(null); }}
            />
          ) : null}
        </div>
      </div>
      <div className="relative mt-2 h-6 pointer-coarse:h-11" data-compact-track>
        {/* The visual track: floor zone, used, overflow past the point, reserve. */}
        <div aria-hidden className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-hairline">
          <div className="absolute inset-y-0 left-0 bg-ink/[0.06]" style={{ width: pct(bounds.floor, usable) }} />
          <div data-compact-used className={`absolute inset-y-0 left-0 ${fillTone} transition-[width] duration-[var(--kiki-motion-quick)]`} style={{ width: pct(fillEnd, usable) }} />
          {overflow > 0 ? (
            <div data-compact-overflow className="absolute inset-y-0 bg-danger" style={{ left: pct(point, usable), width: pct(overflow, usable) }} />
          ) : null}
          <div data-compact-reserve className="absolute inset-y-0 right-0 bg-canvas" style={{ width: pct(usable - bounds.ceil, usable), backgroundImage: RESERVE_HATCH }} />
        </div>
        {bounds.locked ? null : (
          <input
            type="range"
            data-compact-slider
            aria-label={t('context.compact.sliderLabel')}
            aria-valuetext={t('context.compact.sliderValue', { tokens: formatCompactTokens(point), limit: formatCompactTokens(usable) })}
            aria-describedby={noteId}
            min={bounds.floor}
            max={bounds.ceil}
            step={AUTO_COMPACT_STEP}
            value={Math.min(bounds.ceil, Math.max(bounds.floor, point))}
            disabled={pending}
            onChange={(event) => { setDraft(snapCompactTokens(Number(event.target.value), bounds)); }}
            onPointerUp={(event) => { void commit(snapCompactTokens(Number(event.currentTarget.value), bounds)); }}
            // Safety net for value changes without a pointer or key release
            // (assistive-technology increments): leaving the control commits.
            onBlur={() => { if (draft !== null && keyTimer.current === null) void commit(draft); }}
            onKeyDown={(event) => {
              let next: number | undefined;
              if (event.key === 'PageUp') next = point + pageStep;
              if (event.key === 'PageDown') next = point - pageStep;
              if (next === undefined) return;
              event.preventDefault();
              const snapped = snapCompactTokens(next, bounds);
              setDraft(snapped);
              scheduleKeyCommit(snapped);
            }}
            onKeyUp={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                scheduleKeyCommit(snapCompactTokens(Number(event.currentTarget.value), bounds));
              }
            }}
            // A fixed 16px native thumb, with the input widened by half a thumb
            // on each side, keeps the native value↔position map identical to
            // the painted track.
            className="peer absolute inset-y-0 z-10 m-0 cursor-ew-resize appearance-none bg-transparent opacity-0 disabled:cursor-default [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none"
            style={{ left: `calc(${pct(bounds.floor, usable)} - 8px)`, width: `calc(${pct(span, usable)} + 16px)` }}
          />
        )}
        {/* Thumb: ink at rest; keyboard focus draws the ink-blue ring. */}
        <span
          aria-hidden
          data-compact-thumb
          className={`pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-panel transition-shadow duration-[var(--kiki-motion-quick)] peer-hover:shadow-[0_0_0_4px_rgb(var(--kiki-shadow-ink)/0.08)] peer-focus-visible:shadow-[0_0_0_3px_var(--color-panel),0_0_0_5px_var(--color-selected-ink)] ${
            bounds.locked ? 'bg-ink-faint' : 'bg-ink'
          }`}
          style={{ left: pct(point, usable) }}
        />
      </div>
      <div aria-hidden className="relative mt-1 h-4 text-[11px] text-ink-faint tabular-nums">
        <span className="absolute left-0">0</span>
        <span data-compact-limit className="absolute right-0">{limitLabel}</span>
      </div>
      {bounds.locked ? null : (
        <div className="mt-1 -ml-2">
          <TokenPresetRow
            dataAttribute="compact"
            label={t('context.compact.presetsLabel')}
            values={compactPresetsFor(usable, bounds.ceil, bounds.floor)}
            current={point}
            disabled={pending}
            onPick={(value) => { void commit(value); }}
          />
        </div>
      )}
      {bounds.locked ? (
        <p className="mt-1.5 text-[12px] text-ink-faint">{t('context.compact.locked')}</p>
      ) : (
        <div className="mt-1.5 flex items-start justify-between gap-3">
          <p
            data-compact-status
            aria-live="polite"
            className={`min-w-0 text-[12px] leading-4 ${below ? 'text-amber-ink' : 'text-ink-soft'}`}
          >
            {statusLine}
            <span className="block text-ink-faint">
              {t('context.compact.reserve', { tokens: formatCompactTokens(status.reservedContextTokens) })}
            </span>
          </p>
          <label htmlFor={inputId} className="sr-only">{t('context.compact.inputLabel')}</label>
          <input
            id={inputId}
            data-compact-input
            inputMode="decimal"
            spellCheck={false}
            autoComplete="off"
            value={editing ? text : formatCompactTokens(point)}
            disabled={pending}
            title={t('context.compact.inputHint', { percent: compactPercentLabel(point, usable) })}
            onFocus={(event) => { setEditing(true); setText(formatCompactTokens(point)); event.currentTarget.select(); }}
            onChange={(event) => { setText(event.target.value); }}
            onBlur={() => { if (editing) commitText(); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); commitText(); }
              if (event.key === 'Escape') { event.stopPropagation(); setEditing(false); setText(formatCompactTokens(status.tokens)); event.currentTarget.blur(); }
            }}
            className="h-7 w-[8ch] shrink-0 rounded-md border border-hairline bg-paper px-1.5 text-right font-mono text-[12px] text-ink tabular-nums outline-none transition-colors focus:border-accent disabled:text-ink-faint pointer-coarse:h-10"
          />
        </div>
      )}
      <p id={noteId} data-compact-note={note?.tone} role={note?.tone === 'error' ? 'alert' : undefined} className={`mt-1 text-[11px] leading-[14px] ${note === null ? 'sr-only' : note.tone === 'error' ? 'text-danger' : 'text-ink-faint'}`}>
        {note?.text ?? t('context.compact.appliesNextStep')}
      </p>
    </div>
  );
}

const SOURCE_MENU_ROW =
  'flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink outline-none transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-visible:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent pointer-coarse:py-2.5';

/**
 * "Save as default…" menu behind the source label. Each row names the target
 * and the value that will be written: tokens for the model and profile,
 * the converted percentage for the global default.
 */
function CompactSourceMenu({
  tokens,
  usable,
  modelLabel,
  profile,
  canReset,
  resetLabel,
  onClose,
  onSave,
  onReset,
}: {
  tokens: number;
  usable: number;
  modelLabel?: string;
  profile?: { readonly name: string; readonly editable: boolean };
  canReset: boolean;
  resetLabel: string;
  onClose: () => void;
  onSave: (target: AutoCompactSaveTarget) => void;
  onReset: () => void;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, []);
  const value = formatCompactTokens(tokens);
  const percent = compactPercentLabel(tokens, usable);
  const move = (delta: number) => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[(index + delta + rows.length) % rows.length]?.focus();
  };
  return (
    <div
      ref={listRef}
      role="menu"
      data-compact-source-menu
      aria-label={t('context.compact.menuLabel')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
        if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
        if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
      }}
      className="anim-enter absolute right-0 top-full z-40 mt-1 w-64 max-w-[calc(100vw-48px)] rounded-[10px] border border-hairline bg-panel p-1 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]"
    >
      <p className="px-2.5 pt-1.5 pb-1 text-[12px] font-medium text-ink-faint">{t('context.compact.menuLabel')}</p>
      <button type="button" role="menuitem" data-compact-save="model" className={SOURCE_MENU_ROW} onClick={() => { onSave('model'); }}>
        <span className="truncate">{t('context.compact.saveModel', { model: modelLabel ?? '', value })}</span>
      </button>
      {profile !== undefined ? (
        <button
          type="button"
          role="menuitem"
          data-compact-save="profile"
          disabled={!profile.editable}
          className={SOURCE_MENU_ROW}
          onClick={() => { onSave('profile'); }}
        >
          <span className="truncate">{t('context.compact.saveProfile', { profile: profile.name, value })}</span>
          {!profile.editable ? (
            <span className="text-[12px] text-ink-faint">{t('context.compact.profileBuiltin')}</span>
          ) : null}
        </button>
      ) : null}
      <button type="button" role="menuitem" data-compact-save="global" className={SOURCE_MENU_ROW} onClick={() => { onSave('global'); }}>
        <span>{t('context.compact.saveGlobal', { value: percent })}</span>
        <span className="text-[12px] text-ink-faint">{t('context.compact.saveGlobalHint', { tokens: value })}</span>
      </button>
      {canReset ? (
        <>
          <div aria-hidden className="mx-2 my-1 h-px bg-hairline" />
          <button type="button" role="menuitem" data-compact-reset className={SOURCE_MENU_ROW} onClick={onReset}>
            <span className="truncate">{resetLabel}</span>
          </button>
        </>
      ) : null}
    </div>
  );
}
