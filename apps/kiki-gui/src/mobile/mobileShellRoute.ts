export const MOBILE_ROOT_PATH = '/m';
export const MOBILE_ASSISTANT_PATH = '/m/assistant';
/** Earlier root tab; still redirects to the assistant for old links and hosts. */
export const MOBILE_TODAY_PATH = '/m/today';
export const MOBILE_CHATS_PATH = '/m/chats';
export const MOBILE_SPACES_PATH = '/m/spaces';
export const MOBILE_ONBOARDING_PATH = '/m/onboarding';
export const DESKTOP_OVERRIDE_STORAGE_KEY = 'kiki.mobile.preferDesktop';

const MOBILE_APP_SHELL_UA = /\bKikiApp\/(android|ios)\b/;

export function isMobileShellPath(pathname: string): boolean {
  return pathname === MOBILE_ROOT_PATH || pathname.startsWith(`${MOBILE_ROOT_PATH}/`);
}

export function isMobileAppShellUserAgent(
  userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
): boolean {
  return MOBILE_APP_SHELL_UA.test(userAgent);
}

export function isMobileChatPath(pathname: string): boolean {
  return pathname.startsWith(`${MOBILE_ROOT_PATH}/c/`);
}

export function mobileChatPath(spaceKey: string, sessionId: string): string {
  const safeSpace = spaceKey.trim() === '' ? 'local' : spaceKey;
  return `${MOBILE_ROOT_PATH}/c/${encodeURIComponent(safeSpace)}/${encodeURIComponent(sessionId)}`;
}

export function desktopWorkbenchPath(sessionId?: string): string {
  if (sessionId !== undefined && sessionId.trim() !== '') {
    return `/s/${encodeURIComponent(sessionId)}?desktop=1`;
  }
  return '/new?desktop=1';
}

export function readDesktopOverride(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(DESKTOP_OVERRIDE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeDesktopOverride(preferDesktop: boolean): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    if (preferDesktop) sessionStorage.setItem(DESKTOP_OVERRIDE_STORAGE_KEY, '1');
    else sessionStorage.removeItem(DESKTOP_OVERRIDE_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in private contexts.
  }
}

export function shouldUseMobileShell(
  location: Pick<Location, 'pathname' | 'search'> = window.location,
  userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
): boolean {
  if (isMobileShellPath(location.pathname)) {
    return true;
  }
  const params = new URLSearchParams(location.search);
  if (params.get('desktop') === '1') {
    writeDesktopOverride(true);
    return false;
  }
  if (params.get('mobile') === '1') {
    writeDesktopOverride(false);
    return true;
  }
  if (readDesktopOverride()) {
    return false;
  }
  if (isMobileAppShellUserAgent(userAgent)) {
    return true;
  }
  if (
    location.pathname === '/' &&
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse) and (max-width: 639px)').matches
  ) {
    return true;
  }
  return false;
}

/**
 * Normalize legacy/native deep-link routes (including Android notification
 * `/sessions/<id>`) into the active shell's canonical route.
 */
export function normalizeDeepLinkRoute(rawRoute: string, mobileShell: boolean): string {
  const trimmed = rawRoute.trim();
  if (trimmed === '') return mobileShell ? MOBILE_ASSISTANT_PATH : '/';
  const legacySession = /^\/sessions\/([^/?#]+)(.*)$/.exec(trimmed);
  if (legacySession !== null) {
    const id = decodeURIComponent(legacySession[1]!);
    return mobileShell ? mobileChatPath('local', id) : `/s/${encodeURIComponent(id)}${legacySession[2] ?? ''}`;
  }
  if (mobileShell) {
    if (isMobileShellPath(trimmed)) return trimmed;
    const desktopSession = /^\/s\/([^/?#]+)/.exec(trimmed);
    if (desktopSession !== null) {
      return mobileChatPath('local', decodeURIComponent(desktopSession[1]!));
    }
    if (trimmed === '/' || trimmed === '/new') return MOBILE_ASSISTANT_PATH;
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
