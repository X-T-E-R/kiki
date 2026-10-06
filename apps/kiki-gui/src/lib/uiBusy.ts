/**
 * Tiny registry of open transient UI (context menus, dialogs). The global
 * Escape-to-abort handler consults it so Escape closes a menu/dialog first
 * and only aborts the running turn when nothing transient is open.
 */

const open = new Set<string>();

// Opt-in modal ownership is independent of legacy transient-overlay behavior.
const modals: Array<{ id: string; depth: number; panel: HTMLElement }> = [];

/**
 * The z-index layer every modal overlay is built on: a plain dialog sits here,
 * and each stacked level adds one (see `Dialog`'s `50 + depth`). A portaled
 * surface owned by a dialog paints one above its owner — see
 * `floatingSurfaceZIndex`.
 */
export const MODAL_BASE_Z_INDEX = 50;
function topModal() {
  return modals.reduce<(typeof modals)[number] | undefined>((top, entry) => !top || entry.depth >= top.depth ? entry : top, undefined);
}
export function nextModalDepth(): number {
  return (topModal()?.depth ?? 0) + 1;
}
export function registerModal(id: string, depth: number, panel: HTMLElement) {
  const entry = { id, depth, panel };
  modals.push(entry);
  return {
    isTop: () => topModal() === entry,
    unregister: () => { const index = modals.indexOf(entry); if (index !== -1) modals.splice(index, 1); },
  };
}
export function canRestoreModalFocus(element: HTMLElement): boolean {
  const top = topModal();
  return element.isConnected && (!top || top.panel.contains(element));
}

/**
 * The id of the open modal that contains `element`, or undefined when it is
 * not inside one. A surface portaled out of a dialog (a picker panel in
 * `<body>`) has no DOM ancestor to ask, so its owner is resolved from the
 * trigger it was opened from instead.
 */
export function owningModalId(element: Element | null): string | undefined {
  if (element === null) return undefined;
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const owner = modals.find((entry) => entry.panel.contains(node));
    if (owner !== undefined) return owner.id;
  }
  return undefined;
}

/**
 * The z-index a portaled floating surface needs so it paints above the dialog
 * it belongs to.
 *
 * A picker whose trigger sits inside a modal must land *over* that modal's
 * backdrop, or the dialog's own scrim swallows it: on the first-run wizard the
 * model dropdown rendered at the page's z-50 while its dialog owned
 * `50 + depth`, so the panel was drawn under the panel and the list read as
 * inert — clickable in the DOM, dead on screen. Reading the owning modal's own
 * depth is what keeps this correct for any nesting depth, instead of another
 * fixed constant that a stacked dialog can out-rank.
 *
 * A surface that knows its trigger element resolves ownership from it, which is
 * the exact answer. A surface positioned from coordinates alone (a context menu)
 * has no element to ask, so it falls back to the modal currently on top — the
 * only one it could belong to, since anything behind it could not have opened
 * it.
 *
 * Outside a dialog the value matches every other page-level popover, so a
 * picker on the page is unchanged.
 */
export function floatingSurfaceZIndex(element: Element | null): number {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const owner = modals.find((entry) => entry.panel.contains(node));
    if (owner !== undefined) return MODAL_BASE_Z_INDEX + owner.depth + 1;
  }
  return element === null && topModal() !== undefined
    ? MODAL_BASE_Z_INDEX + topModal()!.depth + 1
    : MODAL_BASE_Z_INDEX;
}

export function registerOverlay(id: string): () => void {
  open.add(id);
  return () => {
    open.delete(id);
  };
}

export function anyOverlayOpen(except: readonly string[] = []): boolean {
  if (modals.some((entry) => !except.includes(entry.id))) return true;
  if (open.size === 0) return false;
  if (except.length === 0) return true;
  for (const id of open) {
    if (!except.includes(id)) return true;
  }
  return false;
}
