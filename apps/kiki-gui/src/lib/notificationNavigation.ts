import type { NotificationNavigationIntent } from '../host/host';
import type { NavScopeIdentity } from './navHistory';

/** Strip everything except the navigation identity before crossing the native bridge. */
export function notificationScope(value: unknown): NavScopeIdentity | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const scope = value as Partial<NavScopeIdentity>;
  if (typeof scope.homeId !== 'string' || !scope.homeId || typeof scope.scopeId !== 'string' || !scope.scopeId) return undefined;
  return { homeId: scope.homeId, scopeId: scope.scopeId,
    serverHomeId: typeof scope.serverHomeId === 'string' ? scope.serverHomeId : undefined,
    connectionRef: typeof scope.connectionRef === 'string' ? scope.connectionRef : undefined };
}

export function notificationIntent(value: unknown): NotificationNavigationIntent | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const intent = value as Partial<NotificationNavigationIntent>;
  if (typeof intent.route !== 'string') return undefined;
  return { route: intent.route, homeId: typeof intent.homeId === 'string' ? intent.homeId : undefined,
    scope: notificationScope(intent.scope), navigationId: typeof intent.navigationId === 'string' ? intent.navigationId : undefined };
}
