/**
 * Tiny registry of open transient UI (context menus, dialogs). The global
 * Escape-to-abort handler consults it so Escape closes a menu/dialog first
 * and only aborts the running turn when nothing transient is open.
 */

const open = new Set<string>();

export function registerOverlay(id: string): () => void {
  open.add(id);
  return () => {
    open.delete(id);
  };
}

export function anyOverlayOpen(except: readonly string[] = []): boolean {
  if (open.size === 0) return false;
  if (except.length === 0) return true;
  for (const id of open) {
    if (!except.includes(id)) return true;
  }
  return false;
}
