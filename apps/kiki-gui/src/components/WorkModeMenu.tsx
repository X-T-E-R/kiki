/**
 * The window's mode: which working surface this window offers, and how to
 * change it.
 *
 * The menu says one thing and does one thing. It switches the surface of THIS
 * window, and its footer states the boundary that users actually get wrong:
 * sessions, memory and background work are untouched. It deliberately does not
 * offer "set as default for this space" — the mode is a window property, and a
 * space-wide default would be a second concept wearing the same name.
 *
 * A mode this home has not set up is offered as a setup action rather than
 * hidden, because that is the same door a new user arrives through. A mode the
 * server no longer reports is never shown at all: nothing here revives what
 * the user removed.
 */

import { useEffect, useRef, useState } from 'react';

import type { WorkPresetItem } from '@kiki/protocol';

import { useI18n } from '../i18n';
import { useWindowModeId, type WorkModeCatalog } from '../lib/workModeCatalog';
import { Icon } from './icons';
import { FOCUS_RING } from './rail-variants/shell';
import { SECONDARY_BUTTON } from './ui';

export interface WorkModeMenuProps {
  readonly catalog: WorkModeCatalog;
  /** Opens this home's setup for a mode that is not enabled here yet. */
  readonly onSetup: (mode: WorkPresetItem) => void;
  /** Opens a second window already in this mode, where the host allows it. */
  readonly onOpenInNewWindow?: (mode: WorkPresetItem) => void;
  readonly className?: string;
}

function ModeStateTag({ mode, labels }: { mode: WorkPresetItem; labels: { ready: string; setup: string } }) {
  if (mode.removed) return null;
  if (mode.enabled) {
    return <span className="mt-1.5 block text-[10.5px] font-medium uppercase tracking-[0.04em] text-ink-faint">{labels.ready}</span>;
  }
  return <span className="mt-1.5 block text-[10.5px] font-medium uppercase tracking-[0.04em] text-attention">{labels.setup}</span>;
}

export function WorkModeMenu({ catalog, onSetup, onOpenInNewWindow, className }: WorkModeMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [modeId, chooseMode] = useWindowModeId();
  const root = useRef<HTMLDivElement | null>(null);
  const labels = { ready: t('workMode.enabled'), setup: t('workMode.needsSetup') };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const modes = catalog.items.filter((item) => !item.removed);
  const current = modes.find((item) => item.id === modeId) ?? modes.find((item) => item.enabled) ?? modes[0];

  return (
    <div ref={root} className={`relative ${className ?? ''}`} data-work-mode-menu>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('workMode.menu')}
        data-work-mode-trigger
        onClick={() => { setOpen((value) => !value); }}
        className={`flex h-8 items-center gap-1.5 rounded-lg border border-hairline bg-paper px-2.5 text-[12.5px] font-medium text-ink transition-colors hover:border-hairline-strong ${FOCUS_RING}`}
      >
        <span
          aria-hidden
          className={`h-2 w-2 rounded-[2px] ${current === undefined ? 'bg-hairline-strong' : current.enabled ? 'bg-accent' : 'bg-ink-faint'}`}
        />
        <span className="max-w-[10rem] truncate">{current?.name ?? t('workMode.aria')}</span>
        <Icon name="chevron" size={12} className={`rotate-90 text-ink-faint transition-transform ${open ? 'rotate-270' : ''}`} />
      </button>

      {open ? (
        <div role="menu" aria-label={t('workMode.aria')} className="absolute right-0 top-9 z-50 w-[19rem] rounded-xl bg-panel p-1.5 shadow-[var(--kiki-sheet-shadow)]" data-work-mode-popover>
          <div className="border-b border-hairline px-2.5 pb-2 pt-1.5">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-section-ink">{t('workMode.aria')}</p>
            <p className="mt-1 text-[11.5px] leading-[1.45] text-ink-faint">{t('workMode.appliesToWindow')}</p>
          </div>

          {modes.length === 0 ? (
            <p className="px-2.5 py-3 text-[12px] text-ink-faint">{t('workMode.loadFailed')}</p>
          ) : null}

          {modes.map((mode) => {
            const active = mode.id === current?.id;
            return (
              <div key={mode.id} className="mt-1">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  data-work-mode-option={mode.id}
                  onClick={() => {
                    chooseMode(mode.id);
                    if (!mode.enabled) onSetup(mode);
                    else setOpen(false);
                  }}
                  className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-ink/[0.04] ${active ? 'bg-selected' : ''}`}
                >
                  <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-[2px] ${active ? 'bg-selected-ink' : 'bg-hairline-strong'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-ink">{mode.name}</span>
                    <span className="mt-0.5 block text-[11.5px] leading-[1.45] text-ink-faint">{mode.description}</span>
                    <ModeStateTag mode={mode} labels={labels} />
                  </span>
                </button>
                {onOpenInNewWindow !== undefined ? (
                  <button
                    type="button"
                    onClick={() => { onOpenInNewWindow(mode); setOpen(false); }}
                    className={`ml-7 mt-0.5 mb-1 rounded-md px-2 py-1 text-[11.5px] text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink ${FOCUS_RING}`}
                  >
                    {t('workMode.open')}
                  </button>
                ) : null}
              </div>
            );
          })}

          <p className="mt-1 border-t border-hairline px-2.5 pb-1 pt-2 text-[11px] leading-[1.5] text-ink-faint">{t('workMode.sameSpaceSecondWindow')}</p>
        </div>
      ) : null}
    </div>
  );
}

/** Shown where the user lands when this home has no usable mode at all. */
export function WorkModeUnavailable({ catalog, onRetry }: { catalog: WorkModeCatalog; onRetry: () => void }) {
  const { t } = useI18n();
  if (catalog.status !== 'failed') return null;
  return (
    <div className="flex items-center gap-2 text-[12px] text-ink-soft">
      <span>{catalog.error ?? t('workMode.loadFailed')}</span>
      <button type="button" onClick={onRetry} className={SECONDARY_BUTTON}>{t('workMode.retry')}</button>
    </div>
  );
}
