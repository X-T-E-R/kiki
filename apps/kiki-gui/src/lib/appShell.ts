/**
 * The Android / iOS app shell (`apps/kiki-gui/mobile`) loads this same GUI from
 * the server, inside a WebView with no address bar. It tags the WebView's user
 * agent so the few places that would otherwise say "open a link" can send the
 * person back to the shell's own connect screen instead.
 */

const SHELL_AGENT = /\bKikiApp\/(android|ios)\b/;

/** The shell's connect screen, opened to enter a new server address or link. */
export function appShellConnectUrl(userAgent: string = globalThis.navigator?.userAgent ?? ''): string | null {
  const platform = SHELL_AGENT.exec(userAgent)?.[1];
  if (platform === 'android') return 'https://localhost/index.html#change';
  if (platform === 'ios') return 'capacitor://localhost/index.html#change';
  return null;
}
