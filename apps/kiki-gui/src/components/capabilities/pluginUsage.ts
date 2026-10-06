/**
 * Workspace plugin usage — the pure rules behind the rail's plugin list.
 *
 * The server owns the truth: an override writes, and the reply carries the
 * target it actually used, a revision, and whether consumers have applied it
 * yet. Everything here is about reading that answer honestly and not letting
 * one workspace's answer overwrite another's, so the risky parts stay out of
 * the component and stay unit-tested.
 *
 * Four rules earn their own code:
 *
 * - **The server names the workspace.** The name in the section head comes
 *   from `target.name`; the window's cwd is never used to guess it.
 * - **An answer is only ever applied to the target that asked.** Switching
 *   workspace mid-save must not let the late reply rewrite the new list, so
 *   every async result is checked against the target that requested it.
 * - **A newer revision is never rolled back** by a slower one.
 * - **Home state caps the switch.** A workspace `on` cannot make a
 *   home-disabled plugin available, and the row says why instead of
 *   pretending the toggle worked.
 */

import type { PluginUsageItem, PluginUsageResponse, PluginUsageTarget } from '@kiki/protocol';

/** The workspace half of a target — what a list is keyed by and titled with. */
export interface UsageScope {
  readonly workspaceId: string;
  readonly name: string;
  readonly root: string;
}

/** Explicit workspace selection wins; a workspace alone never guesses a bridge session. */
export function panelScopeFrom(params: URLSearchParams): { readonly target?: PluginUsageTarget; readonly sessionId?: string } {
  const workspaceId = params.get('workspace');
  if (workspaceId !== null && workspaceId !== '') return { target: { workspace_id: workspaceId } };
  const requestedSession = params.get('session');
  const sessionId = requestedSession === null || requestedSession === '' ? undefined : requestedSession;
  return { target: sessionId === undefined ? undefined : { session_id: sessionId }, sessionId };
}

export function scopeKey(target: PluginUsageTarget | undefined): string {
  if (target === undefined) return '';
  return 'workspace_id' in target ? target.workspace_id : `session:${target.session_id}`;
}

/** The workspace an answer actually resolved to; absent before the first read. */
export function scopeOf(response: PluginUsageResponse | undefined): UsageScope | undefined {
  if (response === undefined) return undefined;
  return { workspaceId: response.target.workspace_id, name: response.target.name, root: response.target.root };
}

/** Do these two answers describe the same place? Both halves must agree. */
export function sameScope(a: UsageScope | undefined, b: UsageScope | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.workspaceId === b.workspaceId;
}

/** Section head: the server's own name for this workspace, never a guessed one. */
export function scopeTitle(scope: UsageScope, t: (key: 'rail.plugins.scope', params: { name: string }) => string): string {
  return t('rail.plugins.scope', { name: scope.name });
}

/** What the row shows, derived from usage and never from the home toggle alone. */
export type RowState =
  /** Available in this workspace, and this workspace decided nothing. */
  | { readonly kind: 'inherited'; readonly available: boolean }
  /** This workspace turned it on or off. */
  | { readonly kind: 'overridden'; readonly available: boolean; readonly on: boolean }
  /** Home is off (or the plugin is broken), so the workspace cannot make it live. */
  | { readonly kind: 'blocked'; readonly reason: 'home_disabled' | 'invalid_plugin' };

export function rowState(item: PluginUsageItem): RowState {
  if (item.reason === 'home_disabled' || item.reason === 'invalid_plugin') {
    return { kind: 'blocked', reason: item.reason };
  }
  if (item.override === 'inherit') return { kind: 'inherited', available: item.effective };
  return { kind: 'overridden', available: item.effective, on: item.override === 'on' };
}

/** The switch position: the effective truth, which home state can pin. */
export function rowAvailable(item: PluginUsageItem): boolean {
  return item.effective;
}

/** The switch a click should ask for. Home-blocked rows have no workspace answer. */
export function rowToggleIntent(item: PluginUsageItem): { readonly override: 'on' | 'off'; readonly enabled: boolean } | undefined {
  if (item.reason === 'home_disabled' || item.reason === 'invalid_plugin') return undefined;
  return { override: item.effective ? 'off' : 'on', enabled: item.effective };
}

/** "Restore default" is a choice only while the workspace is overriding. */
export function rowCanRestore(item: PluginUsageItem): boolean {
  return item.override !== 'inherit';
}

/** Is a workspace-level `on` actually going to work right now? */
export function rowBlockedByHome(item: PluginUsageItem): boolean {
  return !item.home_enabled || item.state === 'error';
}

/** Applied / applying / failed, as the row's own status line. */
export function applyTone(response: PluginUsageResponse | undefined): 'applied' | 'pending' | 'failed' | undefined {
  return response?.apply_state;
}

/**
 * Did the reader move on before this answer arrived? A save for workspace A
 * landing after the reader switched to B must not rewrite B's list, so the
 * reply is dropped rather than merged into whatever is on screen now.
 */
export function isStaleTarget(requested: PluginUsageTarget, current: PluginUsageTarget | undefined): boolean {
  return scopeKey(current) !== scopeKey(requested);
}

/** Does the answer belong to the workspace currently on screen? */
export function isStaleScope(response: PluginUsageResponse, currentScope: UsageScope | undefined): boolean {
  return currentScope !== undefined && !sameScope(scopeOf(response), currentScope);
}

/** Never let an older revision overwrite a newer one already on screen. */
export function isStaleRevision(previous: number | undefined, next: number): boolean {
  return previous !== undefined && next < previous;
}

/** The optimistic row: the choice stays visible while consumers catch up. */
export function withPendingOverride(item: PluginUsageItem, override: 'on' | 'off'): PluginUsageItem {
  return { ...item, override, effective: override === 'on' && item.home_enabled && item.state === 'ok' };
}

/** Count for the folded head: how many plugins this workspace can use. */
export function availableCount(items: readonly PluginUsageItem[]): number {
  return items.reduce((count, item) => (rowAvailable(item) ? count + 1 : count), 0);
}

/** The scope id a query key is built from, so two workspaces never share a cache entry. */
export function usageQueryKey(sessionId: string): readonly ['plugin-usage', { readonly session_id: string }] {
  return ['plugin-usage', { session_id: sessionId }] as const;
}
