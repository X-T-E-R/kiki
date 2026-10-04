/**
 * The host's own scroll region for a capability view: the rail's column
 * (`data-agent-panel-scroll`) when the group is hosted there, or the fallback
 * detail shell's body. One region per host — a group never adds a second
 * scroller, and a way back restores this region's offset instead of
 * re-centring the page.
 */
export function scrollHostOf(element: Element | null | undefined): HTMLElement | null {
  return element?.closest<HTMLElement>('[data-agent-panel-scroll], [data-capability-group-drawer]') ?? null;
}
