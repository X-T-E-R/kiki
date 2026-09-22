/**
 * Tiny registry of open transient UI (context menus, dialogs). The global
 * Escape-to-abort handler consults it so Escape closes a menu/dialog first
 * and only aborts the running turn when nothing transient is open.
 */

const open = new Set<string>();

// Opt-in modal ownership is independent of legacy transient-overlay behavior.
const modals: Array<{ id: string; depth: number; panel: HTMLElement }> = [];
function topModal() {
  return modals.reduce<(typeof modals)[number] | undefined>((top, entry) => !top || entry.depth >= top.depth ? entry : top, undefined);
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
