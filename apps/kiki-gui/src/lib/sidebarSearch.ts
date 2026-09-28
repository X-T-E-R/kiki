/**
 * Ask the sidebar to open and focus its session search. The sidebar is the
 * one session list, so any "see all sessions" affordance lands there instead
 * of on a second list. On narrow windows the caller must also open the
 * drawer, since the sidebar is off-screen there.
 */

export const SESSION_SEARCH_EVENT = 'kiki:session-search';

export function requestSessionSearch(): void {
  window.dispatchEvent(new Event(SESSION_SEARCH_EVENT));
}
