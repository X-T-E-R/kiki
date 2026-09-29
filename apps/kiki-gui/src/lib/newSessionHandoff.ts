/**
 * The /new → /s/:id hand-off motion. The first send navigates at once; the
 * motion only rides along, it never gates the create, the prompt or the
 * stream.
 *
 * With View Transitions (Chromium, WebView2) the browser snapshots the hero,
 * the route swaps, and three named parts move on their own:
 *   kiki-composer      the composer card glides from the hero seat to the dock
 *   kiki-first-message the sent text lifts out of the input and lands as the
 *                      user bubble at the top of the timeline
 *   kiki-hero-chrome   the wordmark, claim and target row fade out
 * The message lands on the real bubble when the session is already showing
 * it; otherwise (the usual case: the prompt echoes only once the session has
 * loaded) the landing spot holds a stand-in bubble with the same shape and
 * tokens, which steps aside as soon as the real one appears. Without View Transitions
 * the new view simply fades in; with reduced motion the route just switches.
 * Durations and curves live in styles/new-session.css on the motion tokens.
 */

import { prefersReducedMotion } from './motion';

/** Attribute on <html> while a hand-off runs: `morph` (View Transition) or `fade`. */
const HANDOFF_ATTR = 'data-kiki-handoff';
/** Marks the old-state element the sent text flies out of. */
const SOURCE_ATTR = 'data-kiki-handoff-source';
/** Marks the real first bubble when it is already on screen at capture time. */
const TARGET_ATTR = 'data-kiki-handoff-target';
const GHOST_CLASS = 'kiki-handoff-ghost';
/** Longest the swapped DOM may keep the browser's snapshot frozen. */
const SWAP_WAIT_MS = 250;
/** Longest the stand-in bubble waits for the real one. */
const GHOST_MAX_MS = 6000;
/** The transcript's first row sits this far under the body top (paddingStart + meta line). */
const BUBBLE_TOP_OFFSET = 24 + 18 + 4;

export type HandoffMode = 'morph' | 'fade' | 'instant';

/** Which motion this environment gets. */
export function handoffMode(doc: Document = document): HandoffMode {
  if (prefersReducedMotion()) return 'instant';
  // Typed as always present, but older engines (and jsdom) do not ship it.
  return typeof (doc as Partial<Pick<Document, 'startViewTransition'>>).startViewTransition === 'function' ? 'morph' : 'fade';
}

function sessionViewReady(): boolean {
  return document.querySelector('.conversation-shell[data-phase="active"], .conversation-shell[data-phase="settling"]') !== null;
}

/**
 * Resolve once the session route has committed, capped so the snapshot never
 * lingers. Timers, not animation frames: the browser holds rendering while a
 * View Transition's update runs, so a frame callback would never arrive.
 */
function waitForSessionView(): Promise<void> {
  return new Promise((resolve) => {
    const started = performance.now();
    const tick = () => {
      if (sessionViewReady() || performance.now() - started > SWAP_WAIT_MS) resolve();
      else window.setTimeout(tick, 16);
    };
    tick();
  });
}

/**
 * Place the stand-in bubble where the first user row will render: top of the
 * conversation body, right edge of the centred reading column.
 */
function mountGhost(text: string): HTMLElement | null {
  const body = document.querySelector<HTMLElement>('.conversation-shell .conversation-body');
  if (body === null) return null;
  const rect = body.getBoundingClientRect();
  const column = Math.min(rect.width, 760);
  const right = window.innerWidth - (rect.left + (rect.width + column) / 2) + 24;
  const ghost = document.createElement('div');
  ghost.className = GHOST_CLASS;
  ghost.setAttribute('aria-hidden', 'true');
  ghost.textContent = text;
  ghost.style.top = `${rect.top + BUBBLE_TOP_OFFSET}px`;
  ghost.style.right = `${right}px`;
  ghost.style.maxWidth = `${(column - 48) * 0.8}px`;
  document.body.append(ghost);
  return ghost;
}

/** Hand the landing spot to the real bubble: fade the stand-in out once it shows. */
function retireGhostWhenReal(ghost: HTMLElement): void {
  let done = false;
  const retire = () => {
    if (done) return;
    done = true;
    observer.disconnect();
    window.clearTimeout(timer);
    ghost.dataset['retiring'] = '';
    // The fade runs on a motion token; transitionend never fires when it is
    // collapsed (reduced motion), so a short timer backs it up.
    ghost.addEventListener('transitionend', () => { ghost.remove(); }, { once: true });
    window.setTimeout(() => { ghost.remove(); }, 400);
  };
  const realBubble = () => document.querySelector('.conversation-body [data-transcript-lane="user"]') !== null;
  const observer = new MutationObserver(() => { if (realBubble()) retire(); });
  observer.observe(document.body, { childList: true, subtree: true });
  const timer = window.setTimeout(retire, GHOST_MAX_MS);
  if (realBubble()) retire();
}

function realFirstBubble(): HTMLElement | null {
  const bubbles = document.querySelectorAll<HTMLElement>('.conversation-body [data-transcript-lane="user"] .bg-bubble-user');
  return [...bubbles].at(-1) ?? null;
}

function clearHandoff(): void {
  document.documentElement.removeAttribute(HANDOFF_ATTR);
  for (const attr of [SOURCE_ATTR, TARGET_ATTR]) {
    for (const node of document.querySelectorAll(`[${attr}]`)) node.removeAttribute(attr);
  }
}

/**
 * Navigate from /new into the created session with the hand-off motion.
 * `navigate` runs exactly once in every mode.
 */
export function runNewSessionHandoff({ text, navigate }: {
  /** The first prompt as sent; empty or undefined skips the bubble flight. */
  readonly text?: string;
  readonly navigate: () => void;
}): void {
  const mode = handoffMode();
  if (mode === 'instant') {
    navigate();
    return;
  }
  const root = document.documentElement;
  if (mode === 'fade') {
    root.setAttribute(HANDOFF_ATTR, 'fade');
    navigate();
    window.setTimeout(clearHandoff, 600);
    return;
  }

  const message = text?.trim() ?? '';
  const source = message === '' ? null : document.querySelector<HTMLElement>('textarea[data-composer]');
  source?.setAttribute(SOURCE_ATTR, '');
  root.setAttribute(HANDOFF_ATTR, 'morph');
  let navigated = false;
  // Assigned inside the update callback; a holder keeps the type honest.
  const landing: { ghost: HTMLElement | null } = { ghost: null };
  try {
    const transition = document.startViewTransition(async () => {
      navigated = true;
      navigate();
      await waitForSessionView();
      // The textarea node survives the swap (the shell keeps the seat), so
      // its name must go before the new state is captured.
      source?.removeAttribute(SOURCE_ATTR);
      if (message === '') return;
      const real = realFirstBubble();
      if (real !== null) real.setAttribute(TARGET_ATTR, '');
      else landing.ghost = mountGhost(message);
    });
    // A skipped or aborted transition rejects `ready`; the route has already
    // switched by then, so there is nothing to recover beyond the cleanup.
    transition.ready.catch(() => undefined);
    transition.finished.catch(() => undefined).finally(() => {
      clearHandoff();
      if (landing.ghost !== null) retireGhostWhenReal(landing.ghost);
    });
  } catch {
    clearHandoff();
    landing.ghost?.remove();
    if (!navigated) navigate();
  }
}
