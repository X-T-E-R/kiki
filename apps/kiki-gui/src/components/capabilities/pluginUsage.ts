/**
 * Plugin usage — the pure rules behind every plugin scope switch.
 *
 * The server owns the truth: an override writes, and the reply carries the
 * target it actually used, a revision, and whether consumers have applied it
 * yet. Everything here is about reading that answer honestly and not letting
 * one scope's answer overwrite another's, so the risky parts stay out of the
 * component and stay unit-tested.
 *
 * Four scopes stack, and a row has to name which one decided:
 *
 *   home  →  global  →  workspace  →  session
 *
 * `home_enabled` is the master authorization and `enabled` is its value: a
 * false there is the only thing no override can get past. Below it, the global
 * default can be off while a workspace or a session turns the plugin on, so a
 * row must not read "global is off" as "unavailable".
 *
 * Six rules earn their own code:
 *
 * - **The server names the place.** The name in a section head comes from
 *   `target.name`; the window's cwd is never used to guess it.
 * - **An answer is only ever applied to the target that asked.** Switching
 *   session or workspace mid-save must not let the late reply rewrite the new
 *   list, so every async result is checked against the target that asked.
 * - **A newer revision is never rolled back** by a slower one.
 * - **Home state caps the switch.** An `on` at any lower scope cannot make a
 *   home-disabled plugin available, and the row says why instead of pretending
 *   the toggle worked.
 * - **Restore is a choice only while this scope overrides something**, and it
 *   returns this scope to inherit, not to the scope below.
 * - **A failure keeps the last good value.** A row that refused a write shows
 *   the server's own answer next to the error rather than a value nobody
 *   holds.
 */

import type { PluginUsageItem, PluginUsageResponse, PluginUsageTarget } from '@kiki/protocol';

/** The place half of a target — what a list is keyed by and titled with. */
export interface UsageScope {
  readonly workspaceId: string;
  readonly name: string;
  readonly root: string;
  /** The session this answer was read for, when the request asked for one. */
  readonly sessionId?: string;
}

/** Explicit workspace selection wins; a workspace alone never guesses a bridge session. */
export function panelScopeFrom(params: URLSearchParams): { readonly target?: PluginUsageTarget; readonly sessionId?: string } {
  const workspaceId = params.get('workspace');
  if (workspaceId !== null && workspaceId !== '') return { target: { workspace_id: workspaceId }, sessionId: undefined };
  const requestedSession = params.get('session');
  const sessionId = requestedSession === null || requestedSession === '' ? undefined : requestedSession;
  return { target: sessionId === undefined ? undefined : { session_id: sessionId }, sessionId };
}

export function scopeKey(target: PluginUsageTarget | undefined): string {
  if (target === undefined) return '';
  return 'workspace_id' in target ? target.workspace_id : `session:${target.session_id}`;
}

/** The place an answer actually resolved to; absent before the first read. */
export function scopeOf(response: PluginUsageResponse | undefined): UsageScope | undefined {
  if (response === undefined) return undefined;
  return {
    workspaceId: response.target.workspace_id,
    name: response.target.name,
    root: response.target.root,
    ...(response.target.session_id !== undefined ? { sessionId: response.target.session_id } : {}),
  };
}

/** Do these two answers describe the same place? Both halves must agree. */
export function sameScope(a: UsageScope | undefined, b: UsageScope | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.workspaceId !== b.workspaceId) return false;
  // A session answer names its session; a workspace answer does not. Only one
  // side carrying it is the same place only when the other asked for the
  // workspace itself, which is a different target and a different key.
  return a.sessionId === b.sessionId;
}

/** Section head: the server's own name for this place, never a guessed one. */
export function scopeTitle(scope: UsageScope, t: (key: 'rail.plugins.scope', params: { name: string }) => string): string {
  return t('rail.plugins.scope', { name: scope.name });
}

/**
 * Which scope actually decided this row's value. Shown so a reader can tell a
 * plugin that is on because this session asked for it from one that is on
 * because it is on everywhere.
 */
export type OverrideSource = 'session' | 'workspace' | 'global' | 'home';

export function overrideSource(item: PluginUsageItem): OverrideSource {
  if (item.session_override !== undefined && item.session_override !== 'inherit') return 'session';
  if (item.override !== 'inherit') return 'workspace';
  if (!item.global_enabled) return 'global';
  return 'home';
}

/**
 * What the row shows, derived from usage and never from the master switch
 * alone. A plugin can be blocked (no scope can make it live), overridden (the
 * requested scope decided), or inherited (this scope decided nothing and the
 * value came from below it).
 */
export type RowState =
  /** Usable in this scope, and this scope decided nothing. */
  | { readonly kind: 'inherited'; readonly available: boolean }
  /** The requested scope turned it on or off. */
  | { readonly kind: 'overridden'; readonly available: boolean; readonly on: boolean }
  /** The master switch is off, or the plugin is broken: nothing can make it live. */
  | { readonly kind: 'blocked'; readonly reason: 'home_disabled' | 'invalid_plugin' };

export function rowState(item: PluginUsageItem): RowState {
  if (item.reason === 'home_disabled' || item.reason === 'invalid_plugin') {
    return { kind: 'blocked', reason: item.reason };
  }
  const own = ownOverride(item);
  if (own === 'inherit') return { kind: 'inherited', available: item.effective };
  return { kind: 'overridden', available: item.effective, on: own === 'on' };
}

/**
 * The override that belongs to the scope the row is reading. A workspace page
 * reads `override`, a session page reads `session_override`; the other field is
 * the scope above it and must not answer for this row.
 */
export function ownOverride(item: PluginUsageItem): 'on' | 'off' | 'inherit' {
  return item.session_override ?? item.override;
}

/** The switch position: the effective truth, which home state can pin. */
export function rowAvailable(item: PluginUsageItem): boolean {
  return item.effective;
}

/** The switch a click should ask for. Home-blocked rows have no answer to give. */
export function rowToggleIntent(item: PluginUsageItem): { readonly override: 'on' | 'off'; readonly enabled: boolean } | undefined {
  if (item.reason === 'home_disabled' || item.reason === 'invalid_plugin') return undefined;
  return { override: item.effective ? 'off' : 'on', enabled: item.effective };
}

/** "Restore default" is a choice only while this scope overrides something. */
export function rowCanRestore(item: PluginUsageItem): boolean {
  return ownOverride(item) !== 'inherit';
}

/** Is a scope-level `on` actually going to work right now? */
export function rowBlockedByHome(item: PluginUsageItem): boolean {
  return !item.home_enabled || item.state === 'error';
}

/** Applied / applying / failed, as the row's own status line. */
export function applyTone(response: PluginUsageResponse | undefined): 'applied' | 'pending' | 'failed' | undefined {
  return response?.apply_state;
}

/**
 * Did the reader move on before this answer arrived? A save for session A
 * landing after the reader switched to B must not rewrite B's list, so the
 * reply is dropped rather than merged into whatever is on screen now.
 */
export function isStaleTarget(requested: PluginUsageTarget, current: PluginUsageTarget | undefined): boolean {
  return scopeKey(current) !== scopeKey(requested);
}

/** Does the answer belong to the place currently on screen? */
export function isStaleScope(response: PluginUsageResponse, currentScope: UsageScope | undefined): boolean {
  return currentScope !== undefined && !sameScope(scopeOf(response), currentScope);
}

/** Never let an older revision overwrite a newer one already on screen. */
export function isStaleRevision(previous: number | undefined, next: number): boolean {
  return previous !== undefined && next < previous;
}

/** The optimistic row: the choice stays visible while consumers catch up. */
export function withPendingOverride(item: PluginUsageItem, override: 'on' | 'off'): PluginUsageItem {
  return { ...item, effective: override === 'on' && item.home_enabled && item.state === 'ok' };
}

/** Count for the folded head: how many plugins this scope can use. */
export function availableCount(items: readonly PluginUsageItem[]): number {
  return items.reduce((count, item) => (rowAvailable(item) ? count + 1 : count), 0);
}

/** The scope id a query key is built from, so two targets never share a cache entry. */
export function usageQueryKey(sessionId: string): readonly ['plugin-usage', { readonly session_id: string }] {
  return ['plugin-usage', { session_id: sessionId }] as const;
}