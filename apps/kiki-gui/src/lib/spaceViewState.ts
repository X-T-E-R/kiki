import { activeSpace, readHomeStorageItem, spaceStorage } from './spaceStorage';

const VIEW_ROUTE_KEY = 'kiki.viewRoute';
const ROUTE_OWNER_KEY = 'kiki.viewRouteOwner';

interface RouteOwner {
  readonly homeId: string;
  readonly route: string;
}

export function isSpaceViewRoute(route: unknown): route is string {
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || route.includes('\\')) return false;
  try {
    const url = new URL(route, 'http://example.test');
    if (url.origin !== 'http://example.test' || url.searchParams.has('token') || url.searchParams.has('server') || url.searchParams.has('url') || url.hash.startsWith('#token=')) return false;
    return /^\/(?:new|usage|activity|board|cron|memory|personas|capabilities)$/.test(url.pathname) ||
      /^\/settings(?:\/[^/]+)?$/.test(url.pathname) ||
      /^\/s\/[^/]+(?:\/.*)?$/.test(url.pathname) ||
      /^\/(?:rooms|r)\/[^/]+$/.test(url.pathname);
  } catch {
    return false;
  }
}

function readRoutes(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(spaceStorage.getItem(VIEW_ROUTE_KEY) ?? '{}');
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Storage may be disabled, full, or left by an older build.
  }
  return {};
}

export function readHomeViewRoute(home: string, scopeId = 'local'): string | undefined {
  try {
    const routes = JSON.parse(readHomeStorageItem(home, VIEW_ROUTE_KEY) ?? '{}') as Record<string, unknown>;
    const route = Object.hasOwn(routes, scopeId) ? routes[scopeId] : undefined;
    return isSpaceViewRoute(route) ? route : undefined;
  } catch { return undefined; }
}

export function readSpaceViewRoute(scopeId = 'local'): string | undefined {
  const routes = readRoutes();
  const route = Object.hasOwn(routes, scopeId) ? routes[scopeId] : undefined;
  return isSpaceViewRoute(route) ? route : undefined;
}

export function writeSpaceViewRoute(route: string, scopeId = 'local'): void {
  if (!isSpaceViewRoute(route)) return;
  try {
    spaceStorage.setItem(VIEW_ROUTE_KEY, JSON.stringify({ ...readRoutes(), [scopeId]: route }));
  } catch {
    // Navigation must still work when preferences cannot be written.
  }
}

function homeId(): string {
  return activeSpace()?.homeId ?? 'main';
}

function readRouteOwner(): RouteOwner | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(ROUTE_OWNER_KEY) ?? 'null');
    if (typeof value !== 'object' || value === null) return undefined;
    const owner = value as Partial<RouteOwner>;
    if (typeof owner.homeId === 'string' && typeof owner.route === 'string') return owner as RouteOwner;
  } catch {
    // No ownership marker means the inherited URL is not trusted.
  }
  return undefined;
}

export function markSpaceViewRoute(route: string): void {
  try {
    sessionStorage.setItem(ROUTE_OWNER_KEY, JSON.stringify({ homeId: homeId(), route }));
  } catch {
    // Boot will use this space's saved view if session storage is unavailable.
  }
}

function initialSpaceViewRoute(): string {
  const saved = readSpaceViewRoute();
  if (saved !== undefined) return saved;
  try {
    const lastSessionId = spaceStorage.getItem('kiki.lastSessionId');
    if (lastSessionId) return `/s/${encodeURIComponent(lastSessionId)}`;
  } catch {
    // An unavailable or empty preference uses this space's start page.
  }
  return '/new';
}

/** Runs after the space is resolved, before BrowserRouter or any session view mounts. */
export function restoreSpaceViewAtBoot(host: { readonly kind: string }): void {
  if (host.kind !== 'tauri') return;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const owner = readRouteOwner();
  let target = current;
  if (owner?.homeId !== homeId()) {
    // Native notification clicks replace history state with null and /activity;
    // ordinary React Router navigation keeps its state across a space reload.
    const notification = owner !== undefined && current === '/activity' && window.history.state === null;
    target = notification ? current : initialSpaceViewRoute();
  } else if (current === '/') {
    target = initialSpaceViewRoute();
  }
  if (target !== current) window.history.replaceState(null, '', target);
  markSpaceViewRoute(target);
}
