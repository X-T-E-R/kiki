/**
 * Decide which desktop scope owns a plugin session-focus request.
 *
 * The page watching the on-screen connection may navigate that connection.
 * A request read from any other host names that host's home and scope; the
 * caller restores that scope instead of pushing the session onto the route
 * that is currently open.
 */

export interface PluginFocusRequestRef {
  readonly id: number;
  readonly sessionId: string;
}

export interface PluginFocusCursor {
  readonly initialized: boolean;
  readonly seenId: number;
}

export interface PluginFocusOwner {
  readonly homeId: string;
  readonly scopeId: string;
}

export type PluginFocusStep =
  | { readonly kind: 'remember'; readonly cursor: PluginFocusCursor }
  | { readonly kind: 'focus-current'; readonly cursor: PluginFocusCursor; readonly route: string }
  | {
      readonly kind: 'restore-owner';
      readonly cursor: PluginFocusCursor;
      readonly homeId: string;
      readonly scopeId: string;
      readonly route: string;
    };

export interface DesktopPluginFocus {
  readonly homeId: string;
  readonly route: string;
  readonly requestId: number;
}

/** Session path segment, using the same encoding as `encodeURIComponent`. */
export function pluginSessionRoute(sessionId: string): string | undefined {
  if (sessionId.length === 0) return undefined;
  const route = `/s/${encodeURIComponent(sessionId)}`;
  return isPluginSessionRoute(route) ? route : undefined;
}

export function isPluginSessionRoute(route: string): boolean {
  return /^\/s\/[^/?#]+$/.test(route);
}

/**
 * The first observation only records the id. A later, newer id is a focus.
 * The returned cursor is committed by the caller only after the focus succeeds.
 */
export function pluginFocusStep(input: {
  readonly request: PluginFocusRequestRef | undefined;
  readonly cursor: PluginFocusCursor;
  readonly sameConnection: boolean;
  readonly owner: PluginFocusOwner;
}): PluginFocusStep {
  const request = input.request;
  if (!input.cursor.initialized) {
    return { kind: 'remember', cursor: { initialized: true, seenId: request?.id ?? input.cursor.seenId } };
  }
  if (request === undefined || request.id <= input.cursor.seenId) {
    return { kind: 'remember', cursor: input.cursor };
  }
  const route = pluginSessionRoute(request.sessionId);
  const cursor = { initialized: true, seenId: request.id };
  if (route === undefined) return { kind: 'remember', cursor };
  if (input.sameConnection) return { kind: 'focus-current', cursor, route };
  return {
    kind: 'restore-owner',
    cursor,
    homeId: input.owner.homeId,
    scopeId: input.owner.scopeId,
    route,
  };
}

export function desktopPluginFocus(value: unknown): DesktopPluginFocus | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record['homeId'] !== 'string' || record['homeId'].length === 0) return undefined;
  if (typeof record['route'] !== 'string' || !isPluginSessionRoute(record['route'])) return undefined;
  const requestId = record['requestId'];
  if (typeof requestId !== 'number' || !Number.isInteger(requestId) || requestId < 0) return undefined;
  return { homeId: record['homeId'], route: record['route'], requestId };
}

/** The reloaded page applies the intent only when it is already that home. */
export function desktopPluginFocusTargets(
  intent: DesktopPluginFocus | undefined,
  pageHomeId: string,
): DesktopPluginFocus | undefined {
  if (intent === undefined || intent.homeId !== pageHomeId) return undefined;
  return intent;
}
