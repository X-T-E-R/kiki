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

export interface PluginFocusIdentity {
  readonly homeId: string;
  readonly requestId: number;
}

export interface DesktopPluginFocusHandoff extends PluginFocusIdentity {
  readonly scopeId: 'local';
  readonly route: string;
}

/** The foreground page hands this to the existing cancellable scope transaction. */
export function desktopPluginFocusHandoff(value: unknown): DesktopPluginFocusHandoff | undefined {
  const intent = desktopPluginFocus(value);
  if (intent === undefined) return undefined;
  return { homeId: intent.homeId, scopeId: 'local', route: intent.route, requestId: intent.requestId };
}

/** An ack clears pending focus only when it names that same home and request. */
export function pluginFocusSameIdentity(
  pending: PluginFocusIdentity | null | undefined,
  ack: PluginFocusIdentity,
): boolean {
  if (pending === undefined || pending === null) return false;
  return pending.homeId === ack.homeId && pending.requestId === ack.requestId;
}

/** Recording an id stays on this page. A focus that changes the desktop is shared for that home. */
export function pluginFocusPublication(step: PluginFocusStep, owner: PluginFocusOwner): PluginFocusIdentity | undefined {
  if (step.kind === 'focus-current') return { homeId: owner.homeId, requestId: step.cursor.seenId };
  if (step.kind === 'restore-owner') return { homeId: step.homeId, requestId: step.cursor.seenId };
  return undefined;
}
