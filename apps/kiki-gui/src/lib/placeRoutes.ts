/**
 * URL helpers for Two-Tier per-conversation remote computer routing (`/p/:connectionId/...`).
 *
 * Local conversations keep `/new`, `/s/:id`, `/rooms/:id`, `/r/:id`.
 * Paired remote computer conversations live at `/p/:connectionId/new`,
 * `/p/:connectionId/s/:id/*`, `/p/:connectionId/rooms/:id`, and `/p/:connectionId/r/:id`.
 *
 * Deliberately never matches `/p/:personaId/daily` (whose 3rd segment is `daily`).
 */

const PLACE_PREFIX_RE = /^\/p\/([^/]+)(?=\/(?:new|s|rooms|r)(?:\/|$))/;

/** Return `/p/<connectionId>` for a remote computer, or `''` for local. */
export function placeRoutePrefix(connectionId: string | null | undefined): string {
  if (typeof connectionId !== 'string' || connectionId.trim() === '') return '';
  return `/p/${encodeURIComponent(connectionId)}`;
}

/** Extract the paired remote `connectionId` from a place-prefixed pathname, if any. */
export function parsePlaceConnectionId(pathname: string): string | undefined {
  const match = PLACE_PREFIX_RE.exec(pathname);
  if (match?.[1] === undefined) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Strip a `/p/:connectionId` prefix before `/new`, `/s`, `/rooms`, or `/r`. */
export function stripPlacePrefix(pathname: string): string {
  const match = PLACE_PREFIX_RE.exec(pathname);
  return match === null ? pathname : pathname.slice(match[0].length) || '/';
}

/** Build `/new` or `/p/:connectionId/new` with an optional query string (including leading `?`). */
export function placeNewPath(connectionId: string | null | undefined, query = ''): string {
  return `${placeRoutePrefix(connectionId)}/new${query}`;
}

/** Build `/s/:id` or `/p/:connectionId/s/:id` with an optional subpath (e.g. `/tasks` or `/agent/...`). */
export function placeSessionPath(
  connectionId: string | null | undefined,
  sessionId: string,
  subPath = '',
): string {
  return `${placeRoutePrefix(connectionId)}/s/${encodeURIComponent(sessionId)}${subPath}`;
}

/** Build `/rooms/:id` or `/p/:connectionId/rooms/:id`. */
export function placeRoomPath(connectionId: string | null | undefined, roomId: string): string {
  return `${placeRoutePrefix(connectionId)}/rooms/${encodeURIComponent(roomId)}`;
}

/** Build `/r/:id` or `/p/:connectionId/r/:id`. */
export function placeRoomLinkPath(connectionId: string | null | undefined, roomId: string): string {
  return `${placeRoutePrefix(connectionId)}/r/${encodeURIComponent(roomId)}`;
}

/** Prefix a local conversation href (`/new`, `/s/...`, `/rooms/...`, `/r/...`) for a `spaceKey`. */
export function placeHrefForSpaceKey(spaceKey: string, localHref: string): string {
  if (!spaceKey.startsWith('remote:')) return localHref;
  const connectionId = spaceKey.slice('remote:'.length);
  if (connectionId === '') return localHref;
  if (PLACE_PREFIX_RE.test(localHref)) return localHref;
  return `${placeRoutePrefix(connectionId)}${localHref.startsWith('/') ? localHref : `/${localHref}`}`;
}
