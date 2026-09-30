/**
 * ComposerControls — the popover controls on the composer's status line:
 *
 * - AddMenu (＋): one searchable "add" menu — Add context (files & images,
 *   skills, @-mention, SSH hosts) and Session (Mode, Rebuild). The Mode view
 *   is the same popover swapped to the run-mode panel, so `/plan`, `/goal`
 *   and the run-mode chip all open one surface.
 * - RunModeChip: shown only when the run mode is not Normal; its ✕ returns
 *   to Normal.
 * - PermissionSelect: the approvals chip + menu, rendered from the
 *   data-driven PERMISSION_MODES list (tone decides the resting colour).
 *
 * All popovers share one contract: Escape closes and refocuses the trigger,
 * ↑/↓ walk `[data-menu-row]`, a pointerdown outside closes, and an open panel
 * registers as an overlay so the global Escape (turn abort) stays out.
 *
 * All status-line panels also share one place (useComposerPanelAnchor): they
 * float just above the composer card's top edge, flush with the card's left
 * edge when opened from the left of the status line and with its right edge
 * when opened from the right, whatever the trigger's own position.
 */

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { FsSearchHit, PermissionMode } from '@kiki/protocol';
import { filterSlashItems, type SlashItem } from '@kiki/session-core/commands';

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
  'group/segment flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-ink-soft outline-none transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 aria-expanded:bg-ink/[0.04] aria-expanded:text-ink disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:h-10';

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
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink outline-none transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] focus-visible:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40 disabled:cursor-not-allowed disabled:opacity-50';

export type RunMode = 'normal' | 'plan' | 'goal';

/** Gap between the composer card's top edge and any status-line panel. */
const PANEL_GAP_PX = 6;

/** The composer card every status-line panel floats above. */
export const ComposerCardContext = createContext<RefObject<HTMLElement | null> | undefined>(undefined);

/**
 * Status-line panel placement. Panels stay absolutely positioned inside
 * their trigger's root; this hook writes the root-relative offsets of the
 * composer card onto the root as CSS variables, so a panel carrying
 * `COMPOSER_PANEL_START` / `COMPOSER_PANEL_END` lands just above the card,
 * flush with its left / right edge and never wider than it. Without a card
 * (a picker rendered outside the composer) the classes fall back to "just
 * above the trigger". Re-measured when the card resizes (chips, a growing
 * draft), on window resize, and right before a pointer or key opens a panel.
 */
export function useComposerPanelAnchor(rootRef: RefObject<HTMLElement | null>, open?: boolean): void {
  const cardRef = useContext(ComposerCardContext);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null || cardRef === undefined) return;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => { measure(); });
    let observed: HTMLElement | null = null;
    const measure = () => {
      // The card is read on every pass, not captured once: a root inside the
      // card (ComposerPanelOrigin in the status line) runs this effect before
      // the card's own ref is attached, so the first pass can find no card
      // and a later one (resize, the opening pointer or key) must still work.
      const card = cardRef.current;
      if (card === null) return;
      if (observed !== card) {
        if (observed !== null) observer?.unobserve(observed);
        observer?.observe(card);
        observed = card;
      }
      // Offsets are relative to the panel's containing block: the root, or
      // the positioned root of a wrapped SearchableSelect (ComposerPanelOrigin).
      const origin = root.querySelector<HTMLElement>(':scope > [data-searchable-select]') ?? root;
      const rootRect = origin.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      root.style.setProperty('--cp-bottom', `${Math.max(0, rootRect.bottom - cardRect.top) + PANEL_GAP_PX}px`);
      root.style.setProperty('--cp-left', `${cardRect.left - rootRect.left}px`);
      root.style.setProperty('--cp-right', `${rootRect.right - cardRect.right}px`);
      root.style.setProperty('--cp-max-w', `${cardRect.width}px`);
      // Room above the card inside the nearest clipping ancestor (the hero's
      // scroll region, the page sheet): a panel taller than that would lose
      // its first lines under the page header, so it caps here and its list
      // scrolls instead.
      let clipTop = 0;
      for (let node = origin.parentElement; node !== null; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.overflowY !== 'visible' || style.overflowX !== 'visible') {
          clipTop = node.getBoundingClientRect().top;
          break;
        }
      }
      root.style.setProperty('--cp-max-h', `${Math.max(160, cardRect.top - clipTop - PANEL_GAP_PX - 8)}px`);
    };
    measure();
    // The ref lands in the same commit, after this effect; one frame later it
    // is there, so the resting values exist before any panel opens.
    const frame = requestAnimationFrame(measure);
    root.addEventListener('pointerdown', measure, true);
    root.addEventListener('keydown', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener('pointerdown', measure, true);
      root.removeEventListener('keydown', measure, true);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [rootRef, cardRef, open]);
}

const PANEL_Y = 'bottom-[var(--cp-bottom,calc(100%_+_6px))] max-w-[min(var(--cp-max-w,100vw),calc(100vw_-_32px))]';
/** A panel opened from the left of the status line: flush with the card's left edge. */
export const COMPOSER_PANEL_START = `absolute z-40 ${PANEL_Y} left-[var(--cp-left,0px)]`;
/** A panel opened from the right of the status line: flush with the card's right edge. */
export const COMPOSER_PANEL_END = `absolute z-40 ${PANEL_Y} right-[var(--cp-right,0px)]`;

/**
 * Anchors a SearchableSelect (whose root and panel it does not own) to the
 * composer card: the variables land on this wrapper and inherit into the
 * select's panel, which takes `COMPOSER_PANEL_START` as its class.
 */
export function ComposerPanelOrigin({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useComposerPanelAnchor(ref);
  // The select closes itself on Escape while focus is inside it. Focus can
  // leave an open panel (Tab out of the filter); Escape from anywhere still
  // closes it here, before the session's Escape-to-abort sees the key.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const root = ref.current;
      if (root === null || root.contains(event.target as Node)) return;
      const trigger = root.querySelector<HTMLButtonElement>('[data-searchable-select] > button[aria-expanded="true"]');
      if (trigger === null) return;
      event.preventDefault();
      trigger.click();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => { document.removeEventListener('keydown', onKeyDown, true); };
  }, []);
  return <div ref={ref} className={className}>{children}</div>;
}

/**
 * Shared popover dismissal: overlay registration (so the global Escape never
 * aborts the turn under an open panel), a pointerdown outside the root, and
 * Escape anywhere in the document, including while focus sits outside the
 * panel. Returns the in-panel key handler (Escape refocuses the trigger).
 */
export function usePopoverDismiss(
  open: boolean,
  close: (refocus?: boolean) => void,
  rootRef: RefObject<HTMLElement | null>,
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
    // Focus outside the root (e.g. the panel opened by pointer and focus
    // went back to the page): the document still hears Escape. In-panel
    // Escape is handled (and stopped) by the root's own key handler first.
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (rootRef.current?.contains(event.target as Node) === true) return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      release();
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, overlayId, rootRef]);
  return (event: KeyboardEvent<HTMLElement>) => {
    if (!open || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeRef.current(true);
  };
}

/** Shared popover plumbing: dismissal (usePopoverDismiss) plus ↑/↓ row walking. */
function usePopover(
  open: boolean,
  close: (refocus?: boolean) => void,
  rootRef: RefObject<HTMLDivElement | null>,
  overlayId: string,
) {
  const closeRef = useRef(close);
  closeRef.current = close;
  usePopoverDismiss(open, close, rootRef, overlayId);

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
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors duration-150 ${on ? 'bg-selected-ink' : 'bg-hairline-strong'}`}
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
                    className="mt-1 w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent focus-visible:ring-2 focus-visible:ring-selected-ink/40"
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
 * ＋ — the "add to this message / session" entry point. Root: a search field,
 * then two groups:
 *
 *   Add context   Files & images · Skills ▸ · Mention a file ▸ · SSH hosts ▸
 *   Session       Mode ▸ · Rebuild context
 *
 * Typing in the search filters skills, files and SSH hosts in one list. Each
 * ▸ row drills into its own view (→ / Enter in, ← / Escape / the Back row
 * out). What the menu adds lands where typing would put it: a skill becomes
 * the same `/name ` token the `/` picker writes, a file the same @-mention
 * chip, a host the same session host chip. `view` is parent-owned so `/plan`,
 * `/goal` and the run-mode chip can open straight into Mode (Escape then
 * closes, since nothing was drilled from). `data-plan-select` stays on the
 * root for proofs that address the run-shape panel by that hook.
 *
 * The panel floats above the whole composer card (useComposerPanelAnchor),
 * never over the card's own chips or header.
 */
export type AddMenuView = 'closed' | 'root' | 'mode' | 'ssh' | 'skills' | 'mention';

/** One SSH host as the ＋ search lists it (the SSH view owns the full panel). */
export interface AddMenuHost {
  readonly id: string;
  readonly name: string;
  readonly detail?: string;
  readonly joined: boolean;
}

export interface AddMenuSkills {
  /** Skill rows only (`kind === 'skill'`), same catalog as the `/` picker. */
  readonly items: readonly SlashItem[];
  readonly status: 'loading' | 'error' | 'ready';
  readonly onInsert: (item: SlashItem) => void;
  /** Called when a skills list is about to show (lets a stale catalog refresh). */
  readonly onShow?: () => void;
}

export interface AddMenuFiles {
  readonly search: (query: string) => Promise<FsSearchHit[]>;
  /** Cache scope shared with the `@` picker's query key. */
  readonly scopeKey: string;
  readonly onMention: (hit: FsSearchHit) => void;
}

const FILE_ROW_LIMIT = 8;
const SEARCH_ROW_LIMIT = 5;
const FILE_DEBOUNCE_MS = 200;

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => { setDebounced(value); }, delay);
    return () => { clearTimeout(timer); };
  }, [value, delay]);
  return debounced;
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <p role="presentation" className={POPOVER_LABEL_CLASS}>{children}</p>;
}

function Chevron() {
  return <Icon name="chevron" size={12} className="shrink-0 text-ink-faint" />;
}

function SkillRow({ item, onInsert, result = false }: { item: SlashItem; onInsert: (item: SlashItem) => void; result?: boolean }) {
  const hint = item.skill?.argument_hint;
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-row
      data-add-result={result ? '' : undefined}
      data-add-skill={item.name}
      aria-disabled={item.disabled === true || undefined}
      title={item.description}
      onClick={() => { if (item.disabled !== true) onInsert(item); }}
      className={`${MENU_ROW_CLASS} items-start aria-disabled:cursor-not-allowed aria-disabled:opacity-50`}
    >
      <Icon name="skill" size={14} className="mt-[3px] shrink-0 text-ink-soft" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-medium text-ink">/{item.name}</span>
          {hint !== undefined && hint !== '' ? <span className="truncate text-[12px] text-ink-faint">{hint}</span> : null}
        </span>
        {item.description !== '' ? (
          <span className="mt-0.5 block truncate text-[12px] leading-snug text-ink-faint">{item.description}</span>
        ) : null}
      </span>
    </button>
  );
}

function FileRow({ hit, onMention, result = false }: { hit: FsSearchHit; onMention: (hit: FsSearchHit) => void; result?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-row
      data-add-result={result ? '' : undefined}
      data-add-file={hit.path}
      title={hit.path}
      onClick={() => { onMention(hit); }}
      className={MENU_ROW_CLASS}
    >
      <Icon name="file" size={14} className="shrink-0 text-ink-soft" />
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
        {hit.name}{hit.kind === 'directory' ? '/' : ''}
      </span>
      {hit.path.includes('/') ? (
        <span className="max-w-[45%] min-w-0 truncate font-mono text-[11px] text-ink-faint">{hit.path.slice(0, hit.path.lastIndexOf('/'))}</span>
      ) : null}
    </button>
  );
}

export function AddMenu({
  view,
  onViewChange,
  attachDisabled,
  onAttach,
  onRebuild,
  rebuildDisabled,
  runMode,
  ssh,
  skills,
  files,
}: {
  readonly view: AddMenuView;
  readonly onViewChange: (view: AddMenuView) => void;
  readonly attachDisabled: boolean;
  readonly onAttach: () => void;
  /** Absent hides the row (no rebuild path for this composer). */
  readonly onRebuild?: () => void;
  readonly rebuildDisabled?: boolean;
  /** Absent hides the Mode row (subagent composer). */
  readonly runMode?: RunModeControls;
  /** SSH hosts row + view (components/ssh/ComposerSsh); absent hides it. */
  readonly ssh?: {
    readonly count: number;
    readonly renderPanel: (close: (refocus?: boolean) => void) => React.ReactNode;
    /** Hosts for the root search; toggling joins/leaves the session. */
    readonly hosts?: readonly AddMenuHost[];
    readonly onToggleHost?: (id: string) => void;
  };
  /** Skills row + view; absent hides it. */
  readonly skills?: AddMenuSkills;
  /** Mention-a-file row + view (the `@` picker's search); absent hides it. */
  readonly files?: AddMenuFiles;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const open = view !== 'closed';
  const [query, setQuery] = useState('');
  // Whether the current sub-view was entered from the root (Back returns
  // there) or opened directly (`/plan` → Mode: Escape just closes).
  const drilledRef = useRef(false);
  const close = (refocus = false) => {
    drilledRef.current = false;
    onViewChange('closed');
    if (refocus) triggerRef.current?.focus();
  };
  const drill = (next: AddMenuView) => {
    drilledRef.current = true;
    setQuery('');
    onViewChange(next);
  };
  const back = () => {
    drilledRef.current = false;
    setQuery('');
    onViewChange('root');
  };
  const popoverKeyDown = usePopover(open, close, rootRef, 'composer-add');
  useComposerPanelAnchor(rootRef, open);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  // With Attach as the only action (the subagent composer) a menu would be
  // one pointless extra click: ＋ attaches directly.
  const attachOnly =
    runMode === undefined && onRebuild === undefined && ssh === undefined && skills === undefined && files === undefined;
  const searchable = skills !== undefined || files !== undefined || (ssh?.hosts !== undefined && ssh.hosts.length > 0);

  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const searching = view === 'root' && trimmed !== '';
  const fileQuery = useDebounced(trimmed, FILE_DEBOUNCE_MS);
  const filesWanted = open && files !== undefined && (view === 'mention' || (view === 'root' && fileQuery !== ''));
  const filesQuery = useQuery({
    queryKey: ['fs-search', files?.scopeKey ?? 'none', fileQuery],
    queryFn: () => files!.search(fileQuery),
    enabled: filesWanted,
    staleTime: 30_000,
  });
  const fileHits = (filesQuery.data ?? []).slice(0, view === 'mention' ? FILE_ROW_LIMIT : SEARCH_ROW_LIMIT);
  const skillMatches = skills === undefined ? [] : trimmed === '' ? skills.items : filterSlashItems(skills.items, trimmed);
  const hostMatches = (ssh?.hosts ?? []).filter(
    (host) => host.name.toLowerCase().includes(needle) || (host.detail ?? '').toLowerCase().includes(needle),
  );

  const onShowSkills = skills?.onShow;
  useEffect(() => {
    if (open && (view === 'skills' || view === 'root')) onShowSkills?.();
    // Once per open / view change; the catalog refreshes only when stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view]);

  // Opening (or changing view) focuses the view's first stop.
  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    if (root === null) return;
    const field =
      view === 'mode'
        ? root.querySelector<HTMLElement>('[data-goal-objective]')
        : root.querySelector<HTMLElement>('[data-add-search]');
    (field ?? root.querySelector<HTMLElement>('[role="radio"][aria-checked="true"], [data-menu-row]:not([data-add-back])') ?? root.querySelector<HTMLElement>('[data-menu-row]'))?.focus();
  }, [open, view]);

  const firstRow = () =>
    rootRef.current?.querySelector<HTMLElement>('[data-menu-row]:not([data-add-back]):not(:disabled):not([aria-disabled="true"])') ?? null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    const target = event.target as HTMLElement;
    const inSearch = target.dataset['addSearch'] !== undefined;
    if (event.key === 'Escape') {
      if (inSearch && query !== '') {
        event.preventDefault();
        event.stopPropagation();
        setQuery('');
        return;
      }
      if (view !== 'root' && drilledRef.current) {
        event.preventDefault();
        event.stopPropagation();
        back();
        return;
      }
    }
    if (inSearch) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        firstRow()?.focus();
        return;
      }
      if (event.key === 'ArrowLeft' && query === '' && view !== 'root' && drilledRef.current) {
        event.preventDefault();
        back();
        return;
      }
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
        event.preventDefault();
        firstRow()?.click();
        return;
      }
    } else if (target.tagName !== 'INPUT') {
      if (event.key === 'ArrowRight' && target.dataset['addDrill'] !== undefined) {
        event.preventDefault();
        target.click();
        return;
      }
      if (event.key === 'ArrowLeft' && view !== 'root' && drilledRef.current) {
        event.preventDefault();
        back();
        return;
      }
      // Typing on a row goes to the view's search field.
      const search = rootRef.current?.querySelector<HTMLInputElement>('[data-add-search]');
      if (search !== null && search !== undefined && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        search.focus();
      }
    }
    popoverKeyDown(event);
  };

  if (attachOnly) {
    return (
      <button
        type="button"
        data-attach-button
        onClick={onAttach}
        disabled={attachDisabled}
        aria-label={t('composer.attachAria')}
        title={t('composer.attachTitle')}
        className="flex h-7 w-7 shrink-0 items-center justify-center self-start rounded-md text-ink-soft transition-colors duration-150 hover:bg-paper hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none disabled:opacity-40 pointer-coarse:h-10 pointer-coarse:w-10"
      >
        <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
    );
  }

  const insertSkill = (item: SlashItem) => { close(); skills?.onInsert(item); };
  const mentionFile = (hit: FsSearchHit) => { close(); files?.onMention(hit); };

  const searchField = (placeholder: string) => (
    <div className="px-1 pt-0.5 pb-1">
      <label className="flex h-8 items-center gap-2 rounded-md bg-ink/[0.04] px-2.5 text-ink-faint focus-within:ring-2 focus-within:ring-selected-ink/40">
        <Icon name="search" size={14} className="shrink-0" />
        <input
          data-add-search
          value={query}
          onChange={(event) => { setQuery(event.target.value); }}
          placeholder={placeholder}
          aria-label={placeholder}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
        />
      </label>
    </div>
  );

  const backRow = (label: string) =>
    drilledRef.current ? (
      <button type="button" role="menuitem" data-menu-row data-add-back onClick={back} className={`${MENU_ROW_CLASS} text-ink-soft`}>
        <Icon name="chevron" size={12} className="shrink-0 rotate-180 text-ink-faint" />
        <span className="flex-1 font-medium">{label}</span>
      </button>
    ) : null;

  const drillRow = (id: AddMenuView, icon: React.ReactNode, label: string, trailing?: React.ReactNode, data?: Record<string, string>) => (
    <button
      type="button"
      role="menuitem"
      data-menu-row
      data-add-drill
      {...data}
      aria-haspopup="menu"
      onClick={() => { drill(id); }}
      className={MENU_ROW_CLASS}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {trailing}
      <Chevron />
    </button>
  );

  const note = (text: string, tone: 'faint' | 'danger' = 'faint') => (
    <p role={tone === 'danger' ? 'alert' : undefined} className={`px-2.5 py-1.5 text-[12px] leading-4 ${tone === 'danger' ? 'text-danger' : 'text-ink-faint'}`}>
      {text}
    </p>
  );

  const rootBody = searching ? (
    <div data-add-results>
      {skills !== undefined && skillMatches.length > 0 ? (
        <>
          <GroupLabel>{t('composer.addMenu.skills')}</GroupLabel>
          {skillMatches.slice(0, SEARCH_ROW_LIMIT).map((item) => (
            <SkillRow key={item.name} item={item} onInsert={insertSkill} result />
          ))}
        </>
      ) : null}
      {files !== undefined && fileHits.length > 0 ? (
        <>
          <GroupLabel>{t('composer.addMenu.files')}</GroupLabel>
          {fileHits.map((hit) => <FileRow key={hit.path} hit={hit} onMention={mentionFile} result />)}
        </>
      ) : null}
      {hostMatches.length > 0 && ssh?.onToggleHost !== undefined ? (
        <>
          <GroupLabel>{t('composer.addMenu.ssh')}</GroupLabel>
          {hostMatches.slice(0, SEARCH_ROW_LIMIT).map((host) => (
            <button
              key={host.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={host.joined}
              data-menu-row
              data-add-result
              data-add-host={host.id}
              onClick={() => { ssh.onToggleHost?.(host.id); }}
              className={`${MENU_ROW_CLASS} items-start`}
            >
              <Check on={host.joined} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">{host.name}</span>
                {host.detail !== undefined ? <span className="block truncate font-mono text-[12px] leading-4 text-ink-faint">{host.detail}</span> : null}
              </span>
            </button>
          ))}
        </>
      ) : null}
      {skillMatches.length === 0 && hostMatches.length === 0 && (files === undefined || (fileHits.length === 0 && !(filesQuery.isFetching || fileQuery !== trimmed)))
        ? note(t('composer.addMenu.noMatch', { query: trimmed }))
        : null}
      {files !== undefined && fileHits.length === 0 && (filesQuery.isFetching || fileQuery !== trimmed) ? note(t('composer.filesSearching')) : null}
    </div>
  ) : (
    <>
      <div role="group" aria-label={t('composer.addMenu.contextGroup')}>
        <GroupLabel>{t('composer.addMenu.contextGroup')}</GroupLabel>
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
          <span className="text-[12px] text-ink-faint">{t('composer.addMenu.attachHint')}</span>
        </button>
        {skills !== undefined
          ? drillRow('skills', <Icon name="skill" size={14} className="shrink-0 text-ink-soft" />, t('composer.addMenu.skills'),
              <span className="font-mono text-[12px] text-ink-faint">/</span>, { 'data-add-menu-skills': '' })
          : null}
        {files !== undefined
          ? drillRow('mention', <span aria-hidden className="flex w-3.5 shrink-0 justify-center font-mono text-[13px] leading-none text-ink-soft">@</span>,
              t('composer.addMenu.mention'), <span className="font-mono text-[12px] text-ink-faint">@</span>, { 'data-add-menu-mention': '' })
          : null}
        {ssh !== undefined
          ? drillRow('ssh', <Icon name="terminal" size={14} className="shrink-0 text-ink-soft" />, t('composer.addMenu.ssh'),
              ssh.count > 0 ? <span className="text-[12px] text-ink-faint tabular-nums">{ssh.count}</span> : undefined, { 'data-add-menu-ssh': '' })
          : null}
      </div>
      {runMode !== undefined || onRebuild !== undefined ? (
        <div role="group" aria-label={t('composer.addMenu.sessionGroup')} className="mt-1 border-t border-hairline pt-1">
          <GroupLabel>{t('composer.addMenu.sessionGroup')}</GroupLabel>
          {runMode !== undefined
            ? drillRow('mode', <MenuIcon d="M2.5 4h7M2.5 8h7M4.5 2.5v3M7.5 6.5v3" />, t('composer.addMenu.mode'),
                <span className="text-[12px] text-ink-faint">{t(RUN_MODES.find((mode) => mode.id === runMode.runMode)!.labelKey)}</span>,
                { 'data-add-menu-mode': '' })
            : null}
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
        </div>
      ) : null}
    </>
  );

  const skillsBody = skills === undefined ? null : (
    <div data-add-skills-view>
      {backRow(t('composer.addMenu.skills'))}
      {searchField(t('composer.addMenu.searchSkills'))}
      <div className="max-h-72 overflow-y-auto">
        {skills.status === 'loading' && skills.items.length === 0 ? note(t('composer.addMenu.skillsLoading'))
          : skills.status === 'error' && skills.items.length === 0 ? note(t('composer.addMenu.skillsFailed'), 'danger')
          : skillMatches.length === 0 ? note(trimmed === '' ? t('composer.addMenu.skillsEmpty') : t('composer.addMenu.noMatch', { query: trimmed }))
          : skillMatches.map((item) => <SkillRow key={item.name} item={item} onInsert={insertSkill} />)}
      </div>
    </div>
  );

  const mentionBody = files === undefined ? null : (
    <div data-add-mention-view>
      {backRow(t('composer.addMenu.mention'))}
      {searchField(t('composer.addMenu.searchFiles'))}
      <div className="max-h-72 overflow-y-auto">
        {filesQuery.isError ? note(t('composer.filesFailed'), 'danger')
          : fileHits.length === 0 && (filesQuery.isFetching || fileQuery !== trimmed) ? note(t('composer.filesSearching'))
          : fileHits.length === 0 ? note(trimmed === '' ? t('composer.filesEmpty') : t('composer.filesNoMatch', { query: trimmed }))
          : fileHits.map((hit) => <FileRow key={hit.path} hit={hit} onMention={mentionFile} />)}
      </div>
      <p className="px-2.5 pt-1 pb-1.5 text-[12px] leading-4 text-ink-faint">{t('composer.addMenu.mentionHint')}</p>
    </div>
  );

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
        onClick={() => { if (open) close(); else { drilledRef.current = false; onViewChange('root'); } }}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors duration-150 hover:bg-paper hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none aria-expanded:bg-paper aria-expanded:text-ink pointer-coarse:h-10 pointer-coarse:w-10"
      >
        <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden
          className={`transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-45' : ''}`}>
          <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      {open ? (
        <div
          data-add-panel={view}
          role={view === 'mode' ? 'dialog' : 'menu'}
          aria-label={
            view === 'ssh' ? t('composer.ssh.heading')
              : view === 'mode' ? t('composer.runModeHeading')
              : view === 'skills' ? t('composer.addMenu.skills')
              : view === 'mention' ? t('composer.addMenu.mention')
              : t('composer.addMenuAria')
          }
          className={`anim-enter ${COMPOSER_PANEL_START} w-80 p-1 ${POPOVER_SURFACE_CLASS}`}
        >
          {view === 'root' ? (
            <>
              {searchable ? searchField(t('composer.addMenu.search')) : null}
              {rootBody}
            </>
          ) : view === 'skills' ? (
            skillsBody
          ) : view === 'mention' ? (
            mentionBody
          ) : view === 'ssh' && ssh !== undefined ? (
            <>
              {backRow(t('composer.addMenu.ssh'))}
              {ssh.renderPanel(close)}
            </>
          ) : runMode !== undefined ? (
            <>
              {backRow(t('composer.addMenu.mode'))}
              <RunModePanel controls={runMode} />
            </>
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
        className="flex h-full items-center gap-1.5 rounded-l-md pr-1 pl-2 outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40"
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
        className="flex h-full w-6 items-center justify-center rounded-r-md text-ink-faint outline-none transition-colors duration-[var(--kiki-motion-quick)] hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 pointer-coarse:w-9"
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
  useComposerPanelAnchor(rootRef, open);

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
        <div data-permission-panel className={`anim-enter ${COMPOSER_PANEL_END} w-72 p-1 ${POPOVER_SURFACE_CLASS}`}>
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
