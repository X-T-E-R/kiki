/**
 * ContextStrategySection — the "When it fills up" block of the ContextMeter
 * detail card, under the compaction track: which renewal strategy this agent
 * uses at its compaction point. A three-way radio group (summarize is the
 * default, fresh restarts from the work notes, auto picks per run) writes the
 * session override; the source label says which layer the value came from
 * and doubles as the menu that saves it globally or resets to the inherited
 * layer. Subagents and external executors read only.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import type { ContextStrategyStatus } from '@kiki/protocol';

import { useI18n } from '../i18n';
import { pushToast } from '../lib/toasts';
import { Icon } from './icons';
import type { ContextStrategy, ContextStrategyHandle } from './useContextStrategy';

export const STRATEGY_ORDER = ['summarize', 'fresh', 'auto'] as const satisfies readonly ContextStrategy[];

export const STRATEGY_LABEL_KEY = {
  summarize: 'context.strategy.option.summarize',
  fresh: 'context.strategy.option.fresh',
  auto: 'context.strategy.option.auto',
} as const satisfies Record<ContextStrategy, string>;

const STRATEGY_HINT_KEY = {
  summarize: 'context.strategy.hint.summarize',
  fresh: 'context.strategy.hint.fresh',
  auto: 'context.strategy.hint.auto',
} as const satisfies Record<ContextStrategy, string>;

type Source = ContextStrategyStatus['source'];

const SOURCE_KEY = {
  session: 'context.strategy.source.session',
  global: 'context.strategy.source.global',
  default: 'context.strategy.source.default',
  subagent: 'context.strategy.source.subagent',
  executor: 'context.strategy.source.executor',
} as const satisfies Record<Exclude<Source, 'profile'>, string>;

export interface ContextStrategySectionProps {
  readonly handle: ContextStrategyHandle;
  /** The bound profile, named in the "from profile" label. */
  readonly profileName?: string;
}

type Note = { readonly tone: 'info' | 'error'; readonly text: string };

export function ContextStrategySection({ handle, profileName }: ContextStrategySectionProps) {
  const { t } = useI18n();
  const status = handle.status;
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const groupRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const hintId = useId();

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => { document.removeEventListener('pointerdown', onPointer); };
  }, [menuOpen]);

  // Loading: keep the block's height so the card does not jump on arrival.
  if (status === undefined) {
    return (
      <div data-context-strategy data-strategy-loading className="mt-3 border-t border-hairline pt-3" aria-busy>
        <p className="text-[12px] font-medium text-ink-soft">{t('context.strategy.title')}</p>
        <div aria-hidden className="mt-2 h-7 rounded-[9px] bg-ink/[0.04]" />
      </div>
    );
  }

  const locked = status.source === 'executor';
  const readOnly = locked || !handle.writable;
  const onSession = status.source === 'session';
  const sourceLabel = (source: Source): string => source === 'profile'
    ? profileName === undefined
      ? t('context.strategy.source.profileUnnamed')
      : t('context.strategy.source.profile', { profile: profileName })
    : t(SOURCE_KEY[source]);
  const name = (strategy: ContextStrategy) => t(STRATEGY_LABEL_KEY[strategy]);

  const run = async (action: () => Promise<ContextStrategyStatus>, success?: (next: ContextStrategyStatus) => void) => {
    setMenuOpen(false);
    setPending(true);
    try {
      const next = await action();
      if (success === undefined) setNote({ tone: 'info', text: t('context.strategy.appliesNext') });
      else success(next);
    } catch {
      setNote({ tone: 'error', text: t('context.strategy.saveFailed') });
    } finally {
      setPending(false);
    }
  };

  const pick = (strategy: ContextStrategy) => {
    if (readOnly || pending) return;
    if (strategy === status.strategy && onSession) return;
    void run(() => handle.write(strategy));
  };

  // Arrow keys move the selection (radio-group pattern); the roving tab stop
  // sits on the checked option.
  const onGroupKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const index = STRATEGY_ORDER.indexOf(status.strategy);
    const next = STRATEGY_ORDER[(index + delta + STRATEGY_ORDER.length) % STRATEGY_ORDER.length]!;
    pick(next);
    groupRef.current?.querySelector<HTMLButtonElement>(`[data-strategy-option="${next}"]`)?.focus();
  };

  return (
    <div data-context-strategy data-strategy={status.strategy} data-strategy-source={status.source} className="mt-3 border-t border-hairline pt-3">
      <div className="flex items-center justify-between gap-2">
        <p id={titleId} className="shrink-0 whitespace-nowrap text-[12px] font-medium text-ink-soft">{t('context.strategy.title')}</p>
        <div ref={menuRef} className="relative min-w-0">
          {readOnly ? (
            <span data-strategy-source-label className="block truncate px-1.5 text-[12px] text-ink-faint">{sourceLabel(status.source)}</span>
          ) : (
            <button
              type="button"
              data-strategy-source-trigger
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={pending}
              onClick={() => { setMenuOpen((value) => !value); }}
              className={`flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-[12px] outline-none transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:cursor-default pointer-coarse:h-10 ${
                onSession ? 'text-ink' : 'text-ink-soft'
              } ${menuOpen ? 'bg-ink/[0.04] text-ink' : ''}`}
            >
              <span className="truncate">{sourceLabel(status.source)}</span>
              <Icon name="chevron" size={12} className={`shrink-0 text-ink-faint transition-transform ${menuOpen ? '-rotate-90' : 'rotate-90'}`} />
            </button>
          )}
          {menuOpen ? (
            <StrategySourceMenu
              strategyName={name(status.strategy)}
              canReset={onSession}
              onClose={() => { setMenuOpen(false); }}
              onSaveGlobal={() => {
                void run(() => handle.saveGlobal(status.strategy), (next) => {
                  setNote(null);
                  pushToast({ tone: 'success', text: t('context.strategy.savedGlobal', { strategy: name(next.strategy) }) });
                });
              }}
              onReset={() => { void run(() => handle.write(null)); }}
            />
          ) : null}
        </div>
      </div>
      <div
        ref={groupRef}
        role="radiogroup"
        aria-labelledby={titleId}
        aria-describedby={hintId}
        aria-disabled={readOnly || undefined}
        onKeyDown={onGroupKey}
        className="mt-1.5 grid grid-cols-3 gap-0.5 rounded-[9px] bg-ink/[0.04] p-0.5"
      >
        {STRATEGY_ORDER.map((strategy) => {
          const checked = strategy === status.strategy;
          return (
            <button
              key={strategy}
              type="button"
              role="radio"
              aria-checked={checked}
              data-strategy-option={strategy}
              tabIndex={checked ? 0 : -1}
              disabled={readOnly || pending}
              onClick={() => { pick(strategy); }}
              className={`min-h-7 truncate rounded-[7px] px-2 text-[12px] whitespace-nowrap transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink disabled:cursor-default pointer-coarse:min-h-10 ${
                checked
                  ? 'bg-paper font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
                  : 'text-ink-soft enabled:hover:text-ink'
              } ${readOnly && !checked ? 'text-ink-faint' : ''}`}
            >
              {name(strategy)}
            </button>
          );
        })}
      </div>
      <p id={hintId} data-strategy-hint className="mt-1.5 text-[12px] leading-4 text-ink-soft">
        {t(STRATEGY_HINT_KEY[status.strategy])}
      </p>
      {locked || !handle.writable ? (
        <p className="mt-1 text-[11px] leading-[14px] text-ink-faint">
          {t(locked ? 'context.strategy.executorLocked' : 'context.strategy.subagentReadOnly')}
        </p>
      ) : (
        <p
          data-strategy-note={note?.tone}
          role={note?.tone === 'error' ? 'alert' : undefined}
          aria-live="polite"
          className={`mt-1 text-[11px] leading-[14px] ${note === null ? 'sr-only' : note.tone === 'error' ? 'text-danger' : 'text-ink-faint'}`}
        >
          {note?.text ?? ''}
        </p>
      )}
    </div>
  );
}

const MENU_ROW =
  'flex w-full flex-col items-start rounded-md px-3 py-1.5 text-left text-[13px] text-ink outline-none transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-visible:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40 pointer-coarse:py-2';

/** Same surface and keyboard model as the compaction point's save menu. */
function StrategySourceMenu({
  strategyName,
  canReset,
  onClose,
  onSaveGlobal,
  onReset,
}: {
  strategyName: string;
  canReset: boolean;
  onClose: () => void;
  onSaveGlobal: () => void;
  onReset: () => void;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);
  const move = (delta: number) => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[(index + delta + rows.length) % rows.length]?.focus();
  };
  return (
    <div
      ref={listRef}
      role="menu"
      data-strategy-source-menu
      aria-label={t('context.strategy.menuLabel')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
        if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
        if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
      }}
      className="anim-enter absolute right-0 top-full z-40 mt-1 w-64 max-w-[calc(100vw-48px)] rounded-[10px] border border-hairline bg-panel p-1 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]"
    >
      <button type="button" role="menuitem" data-strategy-save-global className={MENU_ROW} onClick={onSaveGlobal}>
        <span>{t('context.strategy.saveGlobal', { strategy: strategyName })}</span>
      </button>
      {canReset ? (
        <>
          <div aria-hidden className="mx-2 my-1 h-px bg-hairline" />
          <button type="button" role="menuitem" data-strategy-reset className={MENU_ROW} onClick={onReset}>
            <span>{t('context.strategy.reset')}</span>
          </button>
        </>
      ) : null}
    </div>
  );
}
