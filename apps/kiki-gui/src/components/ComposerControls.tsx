/**
 * ComposerControls — the popover controls on the composer's status line:
 *
 * - AddMenu (＋): Attach files · Mode ▸ · Rebuild context. The Mode view is
 *   the same popover swapped to the run-mode panel, so `/plan`, `/goal` and
 *   the run-mode chip all open one surface.
 * - RunModeChip: shown only when the run mode is not Normal; its ✕ returns
 *   to Normal.
 * - PermissionSelect: the approvals chip + menu, rendered from the
 *   data-driven PERMISSION_MODES list (tone decides the resting colour).
 *
 * All popovers share one contract: Escape closes and refocuses the trigger,
 * ↑/↓ walk `[data-menu-row]`, a pointerdown outside closes, and an open panel
 * registers as an overlay so the global Escape (turn abort) stays out.
 */

import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

import type { PermissionMode } from '@kiki/protocol';

import { useI18n } from '../i18n';
import { registerOverlay } from '../lib/uiBusy';
import { PERMISSION_MODES, RECOMMENDED_PERMISSION_MODE, permissionModeDef } from '../lib/permissionModes';
import { POPOVER_SURFACE_CLASS } from './SearchableSelect';
import { Icon } from './icons';

/**
 * Status-line trigger. Each segment is one picker and says what it changes by
 * its leading kind icon (agent, model, approvals, mode); at rest it is quiet
 * ink-soft text, the neutral wash on hover and while its panel is open. A
 * segment the user has moved off its default lifts to ink (`STATUS_SEGMENT_SET`).
 */
export const STATUS_SEGMENT_CLASS =
  'group/segment flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-ink-soft outline-none transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 aria-expanded:bg-ink/[0.04] aria-expanded:text-ink disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:h-10';

/** Added to a segment whose value differs from the inherited default. */
export const STATUS_SEGMENT_SET = 'text-ink';

/** The segment's kind icon: faint at rest, follows the text on hover/open. */
export const STATUS_SEGMENT_ICON_CLASS =
  'text-ink-faint transition-colors duration-[var(--kiki-motion-quick)] group-hover/segment:text-current group-aria-expanded/segment:text-current';

/** Selected row in a composer popover: the raised paper sheet, never a tint. */
export const MENU_ROW_SELECTED_CLASS = 'bg-paper font-medium text-ink shadow-[var(--kiki-sheet-shadow)] hover:bg-paper';

/** Popover section label: sentence-case 12px, no caps tracking. */
export const POPOVER_LABEL_CLASS = 'px-2.5 pt-1.5 pb-1 text-[12px] font-medium text-ink-faint';

const MENU_ROW_CLASS =
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink outline-none transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-visible:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50';

export type RunMode = 'normal' | 'plan' | 'goal';

/** Shared popover plumbing: overlay registration, outside-pointer close, keys. */
function usePopover(
  open: boolean,
  close: (refocus?: boolean) => void,
  rootRef: RefObject<HTMLDivElement | null>,
  overlayId: string,
) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const release = registerOverlay(overlayId);
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        closeRef.current();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      release();
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, overlayId, rootRef]);

  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeRef.current(true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Text fields own their own arrow keys (caret movement).
      if ((event.target as HTMLElement).tagName === 'INPUT') return;
      event.preventDefault();
      const rows = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-menu-row]:not(:disabled)') ?? [])];
      if (rows.length === 0) return;
      const index = rows.findIndex((row) => row === document.activeElement);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      rows[(index + delta + rows.length) % rows.length]?.focus();
    }
  };
}

function Switch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors duration-150 ${on ? 'bg-accent' : 'bg-hairline-strong'}`}
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-panel shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.2)] transition-[left] duration-150 motion-reduce:transition-none ${on ? 'left-3.5' : 'left-0.5'}`}
      />
    </span>
  );
}

function Check({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={`flex h-[19px] w-3 shrink-0 items-center ${on ? 'text-ink' : 'text-transparent'}`}>
      <Icon name="check" size={12} />
    </span>
  );
}

const RUN_MODES: readonly { id: RunMode; labelKey: 'composer.runMode.normal' | 'composer.runMode.plan' | 'composer.runMode.goal'; hintKey: 'composer.runMode.normalHint' | 'composer.runMode.planHint' | 'composer.runMode.goalHint' }[] = [
  { id: 'normal', labelKey: 'composer.runMode.normal', hintKey: 'composer.runMode.normalHint' },
  { id: 'plan', labelKey: 'composer.runMode.plan', hintKey: 'composer.runMode.planHint' },
  { id: 'goal', labelKey: 'composer.runMode.goal', hintKey: 'composer.runMode.goalHint' },
];

export interface RunModeControls {
  readonly runMode: RunMode;
  readonly onChangeRunMode: (mode: RunMode) => void;
  /** False hides the Goal row (no goal path wired). */
  readonly goalAvailable: boolean;
  /** Present only with a session-scoped gate handler. */
  readonly planGateFree?: boolean;
  readonly onChangePlanGateFree?: (free: boolean) => void;
  /** Persistent objective field (the /new draft); absent in a live session. */
  readonly goalObjective?: string;
  readonly onChangeGoalObjective?: (objective: string) => void;
}

/**
 * The Mode view: Normal / Plan / Goal, one exclusive choice. Each mode's own
 * setting nests under its row while that mode is selected: the plan gate
 * under Plan, the objective field under Goal (the /new draft only).
 */
function RunModePanel({ controls }: { controls: RunModeControls }) {
  const { t } = useI18n();
  const { runMode } = controls;
  const showGate = controls.planGateFree !== undefined && controls.onChangePlanGateFree !== undefined;
  const showObjective = controls.onChangeGoalObjective !== undefined;
  return (
    <div data-run-mode-panel>
      <p className={POPOVER_LABEL_CLASS}>{t('composer.runModeHeading')}</p>
      <div role="radiogroup" aria-label={t('composer.runModeHeading')}>
        {RUN_MODES.filter((mode) => mode.id !== 'goal' || controls.goalAvailable).map((mode) => {
          const on = runMode === mode.id;
          return (
            <div key={mode.id}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                data-menu-row
                data-mode-switch={mode.id}
                data-goal-mode-toggle={mode.id === 'goal' ? '' : undefined}
                onClick={() => { controls.onChangeRunMode(mode.id); }}
                className={`${MENU_ROW_CLASS} items-start ${on ? MENU_ROW_SELECTED_CLASS : ''}`}
              >
                <Check on={on} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-ink">{t(mode.labelKey)}</span>
                  <span className="mt-0.5 block text-[12px] leading-snug text-ink-faint">{t(mode.hintKey)}</span>
                </span>
              </button>
              {on && mode.id === 'plan' && showGate ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={controls.planGateFree}
                  data-menu-row
                  data-mode-switch="planGate"
                  title={t('composer.planGateFreeHint')}
                  onClick={() => { controls.onChangePlanGateFree?.(!controls.planGateFree); }}
                  className={`${MENU_ROW_CLASS} mt-0.5 pl-8`}
                >
                  <span className="min-w-0 flex-1">{t('composer.planGateFree')}</span>
                  <Switch on={controls.planGateFree === true} />
                </button>
              ) : null}
              {on && mode.id === 'goal' && showObjective ? (
                <div className="pt-1.5 pr-2.5 pb-2 pl-8" data-goal-open>
                  <label htmlFor="composer-goal-objective" className="text-[12px] font-medium text-ink-faint">
                    {t('composer.goalObjective')}
                  </label>
                  <input
                    id="composer-goal-objective"
                    data-goal-objective
                    value={controls.goalObjective ?? ''}
                    onChange={(event) => { controls.onChangeGoalObjective?.(event.target.value); }}
                    placeholder={t('composer.goalObjectiveNext')}
                    className="mt-1 w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/40"
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * ＋ — Attach files · Mode ▸ · Rebuild context. `view` is parent-owned so
 * `/plan`, `/goal` and the run-mode chip can open straight into Mode.
 * `data-plan-select` stays on the root for proofs that address the run-shape
 * panel by that hook.
 */
export function AddMenu({
  view,
  onViewChange,
  attachDisabled,
  onAttach,
  onRebuild,
  rebuildDisabled,
  runMode,
}: {
  readonly view: 'closed' | 'root' | 'mode';
  readonly onViewChange: (view: 'closed' | 'root' | 'mode') => void;
  readonly attachDisabled: boolean;
  readonly onAttach: () => void;
  /** Absent hides the row (no rebuild path for this composer). */
  readonly onRebuild?: () => void;
  readonly rebuildDisabled?: boolean;
  /** Absent hides the Mode row (subagent composer). */
  readonly runMode?: RunModeControls;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const open = view !== 'closed';
  const close = (refocus = false) => {
    onViewChange('closed');
    if (refocus) triggerRef.current?.focus();
  };
  const onKeyDown = usePopover(open, close, rootRef, 'composer-add');
  // With Attach as the only action (the subagent composer) a menu would be
  // one pointless extra click: ＋ attaches directly.
  const attachOnly = runMode === undefined && onRebuild === undefined;

  // Opening focuses the first row so the menu is keyboard-ready.
  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    if (root === null) return;
    const field = view === 'mode' ? root.querySelector<HTMLElement>('[data-goal-objective]') : null;
    (field ?? root.querySelector<HTMLElement>('[role="radio"][aria-checked="true"], [data-menu-row]'))?.focus();
  }, [open, view]);

  if (attachOnly) {
    return (
      <button
        type="button"
        data-attach-button
        onClick={onAttach}
        disabled={attachDisabled}
        aria-label={t('composer.attachAria')}
        title={t('composer.attachTitle')}
        className="flex h-7 w-7 shrink-0 items-center justify-center self-start rounded-md text-ink-soft transition-colors duration-150 hover:bg-paper hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:opacity-40 pointer-coarse:h-10 pointer-coarse:w-10"
      >
        <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
    );
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape/arrow handling for the open panel
    <div ref={rootRef} className="relative self-start" data-add-menu data-plan-select onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        data-add-menu-trigger
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('composer.addMenuAria')}
        title={t('composer.addMenuAria')}
        onClick={() => { onViewChange(open ? 'closed' : 'root'); }}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors duration-150 hover:bg-paper hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none aria-expanded:bg-paper aria-expanded:text-ink pointer-coarse:h-10 pointer-coarse:w-10"
      >
        <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden
          className={`transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-45' : ''}`}>
          <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      {open ? (
        <div
          role={view === 'root' ? 'menu' : 'dialog'}
          aria-label={view === 'root' ? t('composer.addMenuAria') : t('composer.runModeHeading')}
          className={`anim-enter absolute bottom-full left-0 z-30 mb-1.5 w-72 max-w-[calc(100vw-48px)] p-1 ${POPOVER_SURFACE_CLASS}`}
        >
          {view === 'root' ? (
            <>
              <button
                type="button"
                role="menuitem"
                data-menu-row
                data-attach-button
                disabled={attachDisabled}
                onClick={() => { close(); onAttach(); }}
                className={MENU_ROW_CLASS}
              >
                <MenuIcon d="M9.5 6.5 6.2 9.8a2.3 2.3 0 0 1-3.3-3.3l3.9-3.9a1.5 1.5 0 0 1 2.2 2.2L5.3 8.5a.7.7 0 0 1-1-1l3.2-3.2" />
                <span className="flex-1">{t('composer.addMenu.attach')}</span>
              </button>
              {runMode !== undefined ? (
                <button
                  type="button"
                  role="menuitem"
                  data-menu-row
                  data-add-menu-mode
                  onClick={() => { onViewChange('mode'); }}
                  className={MENU_ROW_CLASS}
                >
                  <MenuIcon d="M2.5 4h7M2.5 8h7M4.5 2.5v3M7.5 6.5v3" />
                  <span className="flex-1">{t('composer.addMenu.mode')}</span>
                  <span className="text-[12px] text-ink-faint">
                    {t(RUN_MODES.find((mode) => mode.id === runMode.runMode)!.labelKey)}
                  </span>
                  <Icon name="chevron" size={12} className="text-ink-faint" />
                </button>
              ) : null}
              {onRebuild !== undefined ? (
                <button
                  type="button"
                  role="menuitem"
                  data-menu-row
                  data-add-menu-rebuild
                  disabled={rebuildDisabled}
                  onClick={() => { close(); onRebuild(); }}
                  className={MENU_ROW_CLASS}
                >
                  <MenuIcon d="M9.6 5A3.7 3.7 0 0 0 3 3.8M2.4 7A3.7 3.7 0 0 0 9 8.2M3 2v1.9h1.9M9 10V8.1H7.1" />
                  <span className="flex-1">{t('composer.addMenu.rebuild')}</span>
                </button>
              ) : null}
            </>
          ) : runMode !== undefined ? (
            <RunModePanel controls={runMode} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MenuIcon({ d }: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0 text-ink-soft">
      <path d={d} stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Status-line chip for a non-Normal mode (`Plan`, `Goal`). Clicking the label
 * reopens the Mode view; ✕ returns to Normal.
 */
export function RunModeChip({
  runMode,
  onOpen,
  onClear,
}: {
  readonly runMode: RunMode;
  readonly onOpen: () => void;
  readonly onClear: () => void;
}) {
  const { t } = useI18n();
  if (runMode === 'normal') return null;
  const label = t(RUN_MODES.find((mode) => mode.id === runMode)!.labelKey);
  // A mode is a standing change to how the next turn runs, so it sits on the
  // status line as a raised paper sheet (the selected-state form), not a tint.
  return (
    <span
      data-run-mode-chip={runMode}
      className="anim-enter flex h-7 shrink-0 items-center rounded-md bg-paper text-[13px] font-medium text-ink shadow-[var(--kiki-sheet-shadow)] pointer-coarse:h-10"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${t('composer.runModeHeading')}: ${label}`}
        title={t(RUN_MODES.find((mode) => mode.id === runMode)!.hintKey)}
        className="flex h-full items-center gap-1.5 rounded-l-md pr-1 pl-2 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <Icon name={runMode === 'goal' ? 'goal' : 'plan'} size={14} className="text-ink-soft" />
        {/* Narrow composers keep the icon; the name stays in aria-label/title. */}
        <span className="@max-[24rem]/toolbar:sr-only">{label}</span>
      </button>
      <button
        type="button"
        onClick={onClear}
        aria-label={t('composer.runModeClear')}
        title={t('composer.runModeClear')}
        className="flex h-full w-6 items-center justify-center rounded-r-md text-ink-faint outline-none transition-colors duration-[var(--kiki-motion-quick)] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 pointer-coarse:w-9"
      >
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}

/**
 * The approvals chip + menu. Rows come from PERMISSION_MODES; the resting
 * chip is quiet ink, and only a `danger`-tone mode (Full access) tints it.
 * `data-mode-select` / `[role=option]` keep the proof and test hooks.
 */
export function PermissionSelect({
  open,
  onOpenChange,
  value,
  onChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly value: PermissionMode;
  readonly onChange: (mode: PermissionMode) => void;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = permissionModeDef(value) ?? PERMISSION_MODES[0]!;
  const danger = current.tone === 'danger';
  const close = (refocus = false) => {
    onOpenChange(false);
    if (refocus) triggerRef.current?.focus();
  };
  const onKeyDown = usePopover(open, close, rootRef, 'composer-mode');

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus();
  }, [open]);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape/arrow handling for the open panel
    <div ref={rootRef} className="relative" data-mode-select onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('composer.permAria')}
        title={t(current.hintKey)}
        data-permission-tone={current.tone}
        onClick={() => { onOpenChange(!open); }}
        data-segment-set={value !== RECOMMENDED_PERMISSION_MODE ? '' : undefined}
        className={`${STATUS_SEGMENT_CLASS} max-w-56 ${
          danger
            ? 'bg-danger/10 font-medium text-danger hover:bg-danger/15 hover:text-danger aria-expanded:bg-danger/15 aria-expanded:text-danger'
            : value !== RECOMMENDED_PERMISSION_MODE ? STATUS_SEGMENT_SET : ''
        }`}
      >
        <Icon name="gate" size={14} className={danger ? '' : STATUS_SEGMENT_ICON_CLASS} />
        {/* Narrow composers keep the shield; the mode name stays in the tooltip. */}
        <span className="min-w-0 truncate @max-[24rem]/toolbar:sr-only">{t(current.labelKey)}</span>
      </button>
      {open ? (
        <div className={`anim-enter absolute right-0 bottom-full z-30 mb-1.5 w-72 max-w-[calc(100vw-48px)] p-1 ${POPOVER_SURFACE_CLASS}`}>
          <p className={POPOVER_LABEL_CLASS}>{t('composer.permAria')}</p>
          <div role="listbox" aria-label={t('composer.permAria')}>
            {PERMISSION_MODES.map((mode) => {
              const isCurrent = mode.id === value;
              return (
                <button
                  key={mode.id}
                  type="button"
                  role="option"
                  data-menu-row
                  data-mode-row
                  data-permission-mode={mode.id}
                  aria-selected={isCurrent}
                  onClick={() => {
                    onChange(mode.id);
                    close(true);
                  }}
                  className={`${MENU_ROW_CLASS} items-start ${isCurrent ? MENU_ROW_SELECTED_CLASS : ''}`}
                >
                  <Check on={isCurrent} />
                  <span className="min-w-0 flex-1">
                    <span className={`block font-medium ${mode.tone === 'danger' ? 'text-danger' : 'text-ink'}`}>
                      {t(mode.labelKey)}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-snug text-ink-faint">{t(mode.hintKey)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
