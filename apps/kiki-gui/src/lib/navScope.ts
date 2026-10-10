import { clearNavHistory, cloneNavScope, createVisitId, getVisitForLocation, isCrossScopeNavigation, type NavScopeIdentity } from './navHistory';
import { isSpaceViewRoute } from './spaceViewState';

export type ScopeRestoreFailure = 'offline' | 'auth-required' | 'scope-invalid' | 'identity-mismatch' | 'target-missing';
export interface ScopeDestination {
  readonly scope: NavScopeIdentity;
  readonly route: string;
}
export type ScopeRestoreState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'restoring' | 'verifying'; readonly target: ScopeDestination }
  | { readonly phase: 'failed'; readonly target: ScopeDestination; readonly reason: ScopeRestoreFailure };

export class ScopeRestoreError extends Error {
  constructor(readonly reason: ScopeRestoreFailure) { super(reason); this.name = 'ScopeRestoreError'; }
}
export interface PreparedScope {
  readonly scope: NavScopeIdentity;
  validate(route: string, signal: AbortSignal): Promise<void>;
  commit(): void | Promise<void>;
  dispose(): void | Promise<void>;
}
export interface ScopeConnectionAdapter {
  prepare(scope: NavScopeIdentity, signal: AbortSignal, token?: string): Promise<PreparedScope>;
}
export interface ScopeLocation {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly key: string;
  readonly state: unknown;
}

export function destinationForLocation(location: ScopeLocation, active: NavScopeIdentity): ScopeDestination {
  const entry = getVisitForLocation(location);
  const state = location.state as { kikiNav?: { scope?: NavScopeIdentity } } | null;
  const claimed = state?.kikiNav?.scope;
  const scope = entry?.scope ?? (typeof claimed?.homeId === 'string' && typeof claimed.scopeId === 'string' ? claimed : active);
  return { scope, route: `${location.pathname}${location.search}${location.hash}` };
}

export function isScopeEntityRoute(route: string): boolean {
  return /^\/(?:s|rooms|r)\/[^/?#]+/.test(route);
}

/** Stages a verified connection; only the caller may commit the Router transition. */
export async function prepareScopeDestination(
  target: ScopeDestination,
  adapter: ScopeConnectionAdapter,
  signal: AbortSignal,
  publish: (state: ScopeRestoreState) => void,
  token?: string,
): Promise<PreparedScope> {
  let prepared: PreparedScope | undefined;
  try {
    signal.throwIfAborted();
    if (!isSpaceViewRoute(target.route)) throw new ScopeRestoreError('scope-invalid');
    publish({ phase: 'restoring', target });
    prepared = await adapter.prepare(target.scope, signal, token);
    signal.throwIfAborted();
    publish({ phase: 'verifying', target });
    if (isCrossScopeNavigation(prepared.scope, target.scope)) throw new ScopeRestoreError('identity-mismatch');
    await prepared.validate(target.route, signal);
    signal.throwIfAborted();
    return prepared;
  } catch (error) {
    await prepared?.dispose();
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    const reason = error instanceof ScopeRestoreError ? error.reason : 'offline';
    publish({ phase: 'failed', target, reason });
    throw new ScopeRestoreError(reason);
  }
}

export interface ScopeNavigationRequest {
  readonly scope?: NavScopeIdentity;
  readonly homeId?: string;
  readonly scopeId?: string;
  readonly route?: string;
  readonly token?: string;
}
let navigationHandler: ((request: ScopeNavigationRequest) => Promise<void>) | undefined;
export function registerScopeNavigation(handler: (request: ScopeNavigationRequest) => Promise<void>): () => void {
  navigationHandler = handler;
  return () => { if (navigationHandler === handler) navigationHandler = undefined; };
}
export function requestScopeNavigation(request: ScopeNavigationRequest): Promise<void> {
  if (navigationHandler === undefined) return Promise.reject(new ScopeRestoreError('scope-invalid'));
  return navigationHandler(request);
}

const HANDOFF_KEY = 'kiki.navScopeHandoff.v1';
interface ReloadHandoff { readonly scope: NavScopeIdentity; readonly route: string; readonly key: string }
let consumedReloadHandoff: ReloadHandoff | null = null;
/** The validated credential-free boot scope, also retained after the handoff is consumed. */
export function pendingScopeReloadScope(): NavScopeIdentity | null {
  try {
    const handoff = (JSON.parse(sessionStorage.getItem(HANDOFF_KEY) ?? 'null') as ReloadHandoff | null) ?? consumedReloadHandoff;
    if (handoff === null) return null;
    if (typeof handoff.scope?.homeId !== 'string' || typeof handoff.scope.scopeId !== 'string' ||
        !isSpaceViewRoute(handoff.route) || handoff.route !== `${window.location.pathname}${window.location.search}${window.location.hash}` ||
        handoff.key !== window.history.state?.key) return null;
    return cloneNavScope(handoff.scope);
  } catch { return null; }
}
export function markScopeReload(scope: NavScopeIdentity, route: string, key: string): void {
  // No credential, connection config, message body or editor buffer crosses reload.
  sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ scope: cloneNavScope(scope), route, key }));
}
export function consumeScopeReload(homeId: string): boolean {
  consumedReloadHandoff = null;
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) ?? 'null');
    sessionStorage.removeItem(HANDOFF_KEY);
    if (typeof raw !== 'object' || raw === null) return false;
    const handoff = raw as ReloadHandoff;
    const matches = handoff.scope?.homeId === homeId && isSpaceViewRoute(handoff.route) &&
      handoff.route === `${window.location.pathname}${window.location.search}${window.location.hash}` &&
      handoff.key === window.history.state?.key;
    consumedReloadHandoff = matches ? { ...handoff, scope: cloneNavScope(handoff.scope) } : null;
    return matches;
  } catch { return false; }
}

export function beginNavWindow(controlledReload: boolean, documentReload: boolean): void {
  if (!controlledReload && !documentReload) clearNavHistory();
}
export function applyColdNavigationIntent(intent: { route: string; homeId?: string; scope?: NavScopeIdentity }, homeId: string): boolean {
  if (!isSpaceViewRoute(intent.route)) return false;
  clearNavHistory();
  const state = window.history.state as Record<string, unknown> | null;
  const scope = cloneNavScope(intent.scope ?? { homeId: intent.homeId ?? homeId, scopeId: 'local' });
  window.history.replaceState({ ...state, idx: state?.['idx'] ?? 0, key: state?.['key'] ?? `cold_${createVisitId()}`,
    usr: { kikiNav: { visitId: createVisitId(), scope, intent: 'notification' } } }, '', intent.route);
  return true;
}

/** Reuse the credential-free reload handoff for a native connection-id-only window launch. */
export function stageRemoteSpaceBoot(connectionId: string): boolean {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(connectionId)) return false;
  clearNavHistory();
  const scope = { homeId: `remote:${connectionId}`, scopeId: `remote:${connectionId}` };
  const route = '/new';
  const key = `remote_${createVisitId()}`;
  window.history.replaceState({ idx: 0, key, usr: { kikiNav: { visitId: createVisitId(), scope } } }, '', route);
  markScopeReload(scope, route, key);
  return true;
}
