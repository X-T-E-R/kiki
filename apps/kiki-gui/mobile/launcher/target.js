/**
 * What the person typed or pasted into the launcher, read as a Kiki server.
 *
 * Accepts a bare address ("192.168.1.5:5494"), a full origin, or an entry
 * link copied from Settings → Web access (`…/#access=<one-time code>`). The
 * shell keeps only the origin; the link itself is opened once and never
 * stored, so a spent one-time code or a token never lands on the phone's disk.
 */

const LOCAL_HOST = /^(localhost|\[[0-9a-f:]+\]|\d{1,3}(?:\.\d{1,3}){3}|[^.]+|.+\.local)$/i;

/** @returns {{ ok: true, origin: string, entry: string } | { ok: false, reason: 'empty' | 'invalid' | 'scheme' | 'credentials' }} */
export function readTarget(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: false, reason: 'empty' };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url;
  try {
    if (hasScheme) {
      url = new URL(text);
    } else {
      const host = text.split(/[/?#]/, 1)[0].replace(/:\d+$/, '');
      // A home machine on the LAN rarely has a certificate; a named public
      // host almost always does.
      url = new URL(`${LOCAL_HOST.test(host) ? 'http' : 'https'}://${text}`);
    }
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' };
  if (url.hostname === '') return { ok: false, reason: 'invalid' };
  const carriesEntry = /(?:^#|&)access=/.test(url.hash) || url.searchParams.has('token');
  return { ok: true, origin: url.origin, entry: carriesEntry ? url.href : `${url.origin}/` };
}

/** Host text for display: the origin without a default scheme's noise. */
export function displayOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' ? url.host : `${url.host} · http`;
  } catch {
    return origin;
  }
}
