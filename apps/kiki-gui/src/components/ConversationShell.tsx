/**
 * ConversationShell — the resident conversation skeleton for /new and /s/:id/*.
 *
 * One layout route owns the composer mount: child routes (the /new hero, the
 * live session view) never render <Composer/> themselves. They publish a
 * memoized seat object ({ phase, composer }) through `useRegisterSeat`, and
 * the shell renders that element at its own stable tree position — the
 * textarea DOM node survives the /new → /s/:id send transition (focus kept),
 * which a per-route composer cannot do.
 *
 * Route chrome that must sit outside the centered column (top header, right
 * rail, below-seat terminal panel, dock cards above the card, hero extras
 * below it) portals into shell-owned slot elements from `useConversationSlots`.
 * Portals re-render with their child owner, so only the seat itself needs the
 * memo discipline (a fresh seat object every render would re-publish forever).
 *
 * Phases (data-phase on the root, see index.css):
 *   hero     — /new: composer flex-centered in the column with the hero chrome
 *   settling — /s/:id still loading with no first-prompt hand-off: the seat
 *              stays mounted but invisible, so no wrong layout flashes before
 *              the transcript lands (dsh's rule)
 *   active   — composer docked at the bottom under a fixed 36px fade mask
 *
 * An empty-but-loaded session is NOT a hero: it keeps the long-standing
 * in-transcript wordmark empty state with the composer docked (active).
 *
 * Donor: deepseek-harness ui-conversation ConversationRoot — same single-tree
 * phase model, flex centering (never transform: a transformed ancestor would
 * become the containing block for position:fixed pickers), px-stop gradient
 * mask, and the shared width-axis custom property.
 */

import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Outlet, useMatch } from 'react-router-dom';

export type ConversationPhase = 'hero' | 'settling' | 'active';

/**
 * What a child route publishes into the shell. `composer` is a fully composed
 * <Composer/> element (or null where no composer belongs); `phase` drives the
 * shell's geometry. Publish a MEMOIZED
 * object — the registration effect keys on identity.
 */
export interface ConversationSeat {
  readonly phase: ConversationPhase;
  readonly composer: ReactNode;
}

/** Shell-owned portal targets, one per chrome region outside the column flow. */
export interface ConversationShellSlots {
  readonly header: HTMLElement | null;
  readonly dock: HTMLElement | null;
  readonly heroFooter: HTMLElement | null;
  readonly rail: HTMLElement | null;
  readonly footer: HTMLElement | null;
  /** Preview workspace dock — between the conversation column and the rail. */
  readonly preview: HTMLElement | null;
}

interface ConversationShellContextValue {
  readonly slots: ConversationShellSlots;
  readonly registerSeat: (seat: ConversationSeat) => void;
  readonly unregisterSeat: (seat: ConversationSeat) => void;
}

const ConversationShellContext = createContext<ConversationShellContextValue | null>(null);

/** Slot set with no targets — workspace chrome simply stays unportaled. */
export const EMPTY_SLOTS: ConversationShellSlots = {
  header: null,
  dock: null,
  heroFooter: null,
  rail: null,
  footer: null,
  preview: null,
};

/**
 * Resolve the phase before any seat is registered (first paint, or the commit
 * gap between an unmounting route and the mounting one): /new can only be the
 * hero; a session route without its controller yet is still settling — never
 * flash the docked bar over an unloaded transcript.
 */
export function resolveFallbackPhase(isNewRoute: boolean): ConversationPhase {
  return isNewRoute ? 'hero' : 'settling';
}

/** Slot portal targets + seat registration. Only usable under ConversationShell. */
export function useConversationShell(): ConversationShellContextValue {
  const context = useContext(ConversationShellContext);
  if (context === null) {
    throw new Error('useConversationShell must be used under <ConversationShell>');
  }
  return context;
}

/**
 * Null-safe variant for components that also render outside the shell (unit
 * tests mount MediaPreviewProvider bare; the preview workspace then falls
 * back to its fixed-overlay form instead of portaling into the slot).
 */
export function useOptionalConversationShell(): ConversationShellContextValue | null {
  return useContext(ConversationShellContext);
}

/**
 * Publish the route's seat into the shell until unmount. The effect keys on
 * the seat's identity, so the seat object MUST be memoized — otherwise every
 * render re-publishes and the shell re-renders the outlet in a loop.
 *
 * This is a LAYOUT effect, deliberately: the composer is a controlled input
 * rendered by the shell from published state. If registration were passive,
 * a keystroke could be processed while the shell still holds the previous
 * seat — React would then restore the stale `value` over the character the
 * browser just inserted, and the onChange read would lose it (observed as
 * dropped characters in the attachments/slash-commands proofs). Layout
 * effects + their setState flush synchronously before paint, so the shell
 * always commits the current seat before the next input event.
 */
export function useRegisterSeat(seat: ConversationSeat): void {
  const { registerSeat, unregisterSeat } = useConversationShell();
  useLayoutEffect(
    () => {
      registerSeat(seat);
      return () => { unregisterSeat(seat); };
    },
    [registerSeat, unregisterSeat, seat],
  );
}

/**
 * Warm backdrop ellipse behind the hero composer card (dsh's HeroGlow
 * mechanism): one SVG gaussian-blurred ellipse in the kiki accent at a low
 * alpha, centered on the card by the owner's CSS. Pure decoration.
 */
function HeroGlow({ className }: { className?: string }) {
  // Stable filter id so multiple hero mounts do not collide in the DOM.
  const glowFilterId = `kiki-hero-glow-${useId().replace(/:/g, '')}`;
  return (
    <svg className={className} viewBox="0 0 1051 468" fill="none" aria-hidden="true">
      <defs>
        <filter
          id={glowFilterId}
          x="0"
          y="0"
          width="1051"
          height="468"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="50" result="effect1_foregroundBlur" />
        </filter>
      </defs>
      <g filter={`url(#${glowFilterId})`}>
        <ellipse
          cx="525.5" cy="234" rx="425.5" ry="134"
          fill="var(--color-accent)" fillOpacity="0.08"
        />
        <ellipse
          cx="525.5" cy="254" rx="300" ry="90"
          fill="var(--color-amber-rule)" fillOpacity="0.07"
        />
      </g>
    </svg>
  );
}

function useSlotRef(): [HTMLElement | null, (node: HTMLElement | null) => void] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  // Callback refs: identity must be stable so React does not detach/attach on
  // every render (which would churn every portal targeting the slot).
  const ref = useCallback((node: HTMLElement | null) => { setElement(node); }, []);
  return [element, ref];
}

export function ConversationShell() {
  const [seat, setSeat] = useState<ConversationSeat | null>(null);
  // Mirror for the unregister guard: a late cleanup must not clear a newer
  // route's seat (effect destroy/setup order across routes is guaranteed, but
  // the guard makes the invariant explicit instead of implied).
  const seatRef = useRef<ConversationSeat | null>(null);
  const registerSeat = useCallback((next: ConversationSeat) => {
    seatRef.current = next;
    setSeat(next);
  }, []);
  const unregisterSeat = useCallback((departed: ConversationSeat) => {
    if (seatRef.current !== departed) return;
    seatRef.current = null;
    setSeat(null);
  }, []);

  const [header, headerRef] = useSlotRef();
  const [dock, dockRef] = useSlotRef();
  const [heroFooter, heroFooterRef] = useSlotRef();
  const [rail, railRef] = useSlotRef();
  const [footer, footerRef] = useSlotRef();
  const [preview, previewRef] = useSlotRef();

  const contextValue = useMemo<ConversationShellContextValue>(
    () => ({
      slots: { header, dock, heroFooter, rail, footer, preview },
      registerSeat,
      unregisterSeat,
    }),
    [header, dock, heroFooter, rail, footer, preview, registerSeat, unregisterSeat],
  );

  const isNewRoute = useMatch('/new') !== null;
  const phase = seat?.phase ?? resolveFallbackPhase(isNewRoute);

  return (
    <ConversationShellContext.Provider value={contextValue}>
      <div className="conversation-shell" data-phase={phase}>
        <div className="conversation-row">
          <div className="conversation-center">
            <div ref={headerRef} className="conversation-header-slot" />
            <div className="conversation-middle">
              {/* <main>: the route's primary content landmark (the burst
                  proof's mutation observer also binds here). */}
              <main className="conversation-body">
                <Outlet />
              </main>
              <div className="conversation-seat" data-composer-seat="">
                {phase === 'hero' ? <HeroGlow className="hero-glow" /> : null}
                <div ref={dockRef} className="conversation-dock-slot" />
                {seat?.composer ?? null}
                <div ref={heroFooterRef} className="conversation-herofooter-slot" />
              </div>
            </div>
            <div ref={footerRef} className="conversation-footer-slot" />
          </div>
          <div ref={previewRef} className="conversation-preview-slot" />
          <div ref={railRef} className="conversation-rail-slot" />
        </div>
      </div>
    </ConversationShellContext.Provider>
  );
}
