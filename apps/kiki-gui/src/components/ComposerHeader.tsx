/**
 * ComposerHeader — the goal and the queue as a short stack of sheets tucked
 * behind the composer card's top edge (rendered through Composer's `stack`
 * slot, above the card):
 *
 *   - the goal sheet sits on top (LifeMark, title truncated to one line,
 *     status word); the queue sheet in front of it, nearest the card, reads
 *     "下一条 <first prompt> · N 条待发送", with the first prompt's own actions
 *     (`actions`) beside it. Without a goal, extra queued prompts show as
 *     slivers behind the queue sheet;
 *   - each sheet's label is a disclosure button: its detail opens as a panel
 *     above the stack (grid-rows height + a short rise) while the sheets and
 *     the input stay put. One detail at a time; Esc, clicking the label again,
 *     or a click outside closes it. A `forceOpen` section (a queued prompt
 *     parked in the composer) ignores all three so the edit's context never
 *     hides;
 *   - a growing queue count fades its text in once — never on the session's
 *     cold load (`settled` + a short grace window), never while at rest.
 *
 * Renders nothing without a goal or a queue, so the composer stays as it is.
 * Reduced motion (system or app setting) collapses the motion tokens, so the
 * detail simply switches.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { anyOverlayOpen, registerOverlay } from '../lib/uiBusy';

export interface ComposerHeaderSection {
  /** The row text (goal line / queue count). Truncation is the node's own. */
  readonly summary: ReactNode;
  /** Accessible name of the half and of its detail region. */
  readonly ariaLabel: string;
  readonly title?: string;
  /** Queue only: a growing count fades the summary in once. */
  readonly count?: number;
  /** Keep the detail open (Esc / outside / its own button leave it). */
  readonly forceOpen?: boolean;
  readonly panel: ReactNode;
  /** Controls beside the label on the sheet (outside the disclosure button). */
  readonly actions?: ReactNode;
}

type SectionId = 'goal' | 'queue';

/** Collapse fallback for when the height transition never reports its end. */
const CLOSE_FALLBACK_MS = 1200;
/**
 * A just-opened session projects its queue over a few frames after it reports
 * loaded; growth inside this window is the cold load arriving, not a prompt
 * the user just queued, so it never bumps.
 */
const SETTLE_GRACE_MS = 800;

export function ComposerHeader({
  goal,
  queue,
  settled = true,
}: {
  readonly goal?: ComposerHeaderSection;
  readonly queue?: ComposerHeaderSection;
  /** False while the session is still loading: counts arriving then never bump. */
  readonly settled?: boolean;
}) {
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const sections: Partial<Record<SectionId, ComposerHeaderSection>> = { goal, queue };
  const [openId, setOpenId] = useState<SectionId | null>(null);
  // The detail keeps its last content while it collapses, then drops it.
  const [shownId, setShownId] = useState<SectionId | null>(null);
  const forced: SectionId | undefined =
    queue?.forceOpen === true ? 'queue' : goal?.forceOpen === true ? 'goal' : undefined;
  const effectiveOpen = forced ?? (openId !== null && sections[openId] !== undefined ? openId : null);
  const openSection = effectiveOpen === null ? undefined : sections[effectiveOpen];
  const pinned = openSection?.forceOpen === true;

  // Count growth → one fade of the queue text (alternating keyframes replay).
  const countRef = useRef<number | null>(null);
  const settledAtRef = useRef<number | null>(null);
  const [bumps, setBumps] = useState(0);
  const queueCount = queue?.count ?? 0;
  useLayoutEffect(() => {
    if (!settled) settledAtRef.current = null;
    else settledAtRef.current ??= performance.now();
    const warm = settledAtRef.current !== null && performance.now() - settledAtRef.current >= SETTLE_GRACE_MS;
    const previous = countRef.current;
    countRef.current = settled ? queueCount : null;
    if (warm && previous !== null && queueCount > previous) setBumps((value) => value + 1);
  }, [queueCount, settled]);

  useEffect(() => {
    if (effectiveOpen !== null) {
      setShownId(effectiveOpen);
      return;
    }
    const timer = setTimeout(() => { setShownId(null); }, CLOSE_FALLBACK_MS);
    return () => { clearTimeout(timer); };
  }, [effectiveOpen]);

  // An open detail is transient UI: Esc closes it before it may abort the turn.
  useEffect(() => {
    if (effectiveOpen === null) return;
    const unregister = registerOverlay('composer-header');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || pinned) return;
      if (anyOverlayOpen(['composer-header'])) return;
      event.preventDefault();
      setOpenId(null);
      // Keep focus in the row: hand it back to the half that owned the detail.
      if (rootRef.current?.contains(document.activeElement) === true) {
        rootRef.current.querySelector<HTMLElement>(`[data-header-toggle="${effectiveOpen}"]`)?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (pinned || anyOverlayOpen(['composer-header'])) return;
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target) === true) return;
      setOpenId(null);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [effectiveOpen, pinned]);

  if (goal === undefined && queue === undefined) return null;
  const shown = shownId === null ? undefined : sections[effectiveOpen ?? shownId];

  const toggle = (id: SectionId) => {
    if (sections[id]?.forceOpen === true) return;
    setOpenId((current) => (current === id && effectiveOpen === id ? null : id));
  };
  // Slivers behind the queue sheet stand for the prompts after the first; a
  // goal sheet already sits there, so they only show without one.
  const slivers = goal === undefined ? Math.min(2, Math.max(0, queueCount - 1)) : 0;
  const half = (id: SectionId, section: ComposerHeaderSection) => {
    const open = effectiveOpen === id;
    return (
      <div
        key={id}
        data-header-sheet={id}
        data-slivers={id === 'queue' && slivers > 0 ? slivers : undefined}
        className={`composer-header-sheet composer-header-${id}`}
      >
        <button
          type="button"
          data-header-toggle={id}
          data-open={open ? '' : undefined}
          data-bump={id === 'queue' && bumps > 0 ? (bumps % 2 === 0 ? 'b' : 'a') : undefined}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={section.ariaLabel}
          title={section.title}
          onClick={() => { toggle(id); }}
          className="composer-header-half"
        >
          <span className="composer-header-label">{section.summary}</span>
        </button>
        {section.actions === undefined ? null : <span className="composer-header-actions">{section.actions}</span>}
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      data-composer-header
      data-header-open={effectiveOpen ?? undefined}
      className="composer-header"
    >
      <div
        id={panelId}
        role="region"
        aria-label={openSection?.ariaLabel}
        data-header-panel={shown === undefined ? undefined : (effectiveOpen ?? shownId)}
        data-open={openSection !== undefined ? '' : undefined}
        inert={openSection === undefined}
        className="composer-header-panel"
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && effectiveOpen === null) setShownId(null);
        }}
      >
        <div className="composer-header-clip">
          <div className="composer-header-scroll">{shown?.panel ?? null}</div>
        </div>
      </div>
      <div className="composer-header-row">
        {goal !== undefined ? half('goal', goal) : null}
        {queue !== undefined ? half('queue', queue) : null}
      </div>
    </div>
  );
}
