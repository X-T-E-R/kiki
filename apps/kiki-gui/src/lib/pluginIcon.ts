/**
 * Plugin icon rendering. A plugin's icon is an inert `<img>`; the only question
 * is what colour it paints in.
 *
 * An SVG delivered in an `<img>` gets its own document, so `currentColor` has
 * no page to inherit from: it resolves to black, which is unreadable on the
 * dark palette and wrong on a skin. Rather than forcing every package to ship
 * a second, per-theme file, an icon that DECLARES `currentColor` is taken at
 * its word — it is asking to take the app's ink — and is recoloured to the live
 * `--color-ink-soft` token. An icon that paints itself (a brand mark, a raster)
 * is left exactly as it is, so a third-party identity keeps its colours.
 *
 * The token is re-read whenever it actually changes, for the same reason xterm
 * re-reads its colours: a mark that cannot follow a CSS variable has to be told
 * when the variable moved. That is deliberately the TOKEN rather than the
 * theme attribute — a skin, and a space-level override, write the same token by
 * another route, and a watcher on `data-theme` alone silently ignores both.
 *
 * Recolouring is a text substitution on the bytes we already hold, handed back
 * as a `data:` URI. Nothing is ever injected as HTML, so the icon stays an
 * image the browser parses as an image.
 */

import { useEffect, useState } from 'react';

import { onThemeChange } from './theme';

/** Where a first-party mark rests: ink-soft, the tone the family sits at. */
const INK_TOKEN = '--color-ink-soft';
const INK_FALLBACK = '#4b453e';

/** Past this a payload is not an icon. */
const MAX_ICON_BYTES = 256 * 1024;

interface IconPayload {
  readonly uri: string;
  readonly svg?: string;
}

/** Bounded like displayMedia's cache; a theme flip needs no second round trip. */
const MAX_ENTRIES = 64;
const payloads = new Map<string, IconPayload | undefined>();
const inFlight = new Map<string, Promise<IconPayload | undefined>>();

/** Drop every remembered icon. A new document (or a test) starts clean. */
export function resetPluginIconCache(): void {
  payloads.clear();
  inFlight.clear();
}

/** `data:image/svg+xml;…` only — the one shape whose bytes we can read. */
function readDataUri(source: string): string | null {
  const match = /^data:image\/svg\+xml(;[^,]*)?,(.*)$/s.exec(source);
  if (match === null) return null;
  const [, params = '', payload = ''] = match;
  try {
    return params.includes('base64')
      ? new TextDecoder().decode(Uint8Array.from(atob(payload), (char) => char.codePointAt(0) ?? 0))
      : decodeURIComponent(payload);
  } catch {
    return null;
  }
}

export function iconSource(icon: string | undefined): string | undefined {
  if (icon === undefined) return undefined;
  if (icon.startsWith('data:image/svg+xml') || icon.startsWith('data:image/png')) return icon;
  if (/^https?:\/\//.test(icon)) return icon;
  return undefined;
}

/** The ink a first-party mark is drawn in, read from the live token. */
function inkToken(): string {
  if (typeof document === 'undefined') return INK_FALLBACK;
  const value = getComputedStyle(document.documentElement).getPropertyValue(INK_TOKEN).trim();
  return value === '' ? INK_FALLBACK : value;
}

function dataUri(bytes: Uint8Array, type: string): string {
  const binary = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join('');
  return `data:${type};base64,${btoa(binary)}`;
}

/** Only currentColor SVGs change; raster bytes and fixed colours stay intact. */
function recolor(payload: IconPayload | undefined): string | undefined {
  const text = payload?.svg;
  if (text === undefined || !text.includes('currentColor')) return payload?.uri;
  return dataUri(new TextEncoder().encode(text.replaceAll('currentColor', inkToken())), 'image/svg+xml');
}

function remembered(source: string | undefined): IconPayload | undefined {
  if (source === undefined) return undefined;
  if (source.startsWith('data:')) {
    return { uri: source, svg: readDataUri(source) ?? undefined };
  }
  return payloads.get(source);
}

/** Enforce the byte limit while reading, not after buffering an arbitrary body. */
async function readIcon(response: Response): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > MAX_ICON_BYTES) {
    await response.body?.cancel();
    throw new Error('icon too large');
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ICON_BYTES) {
        await reader.cancel();
        throw new Error('icon too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Remote images use connect-src, then data: img-src — never a remote <img>. */
async function learn(source: string): Promise<IconPayload | undefined> {
  try {
    const response = await fetch(source, {
      credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const bytes = await readIcon(response);
    if (bytes.length === 0) return undefined;
    const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    const svg = type === 'image/svg+xml' || !type.startsWith('image/')
      ? new TextDecoder().decode(bytes) : undefined;
    if (svg?.includes('<svg')) return { uri: dataUri(bytes, 'image/svg+xml'), svg };
    if (type.startsWith('image/') && type !== 'image/svg+xml') return { uri: dataUri(bytes, type) };
  } catch {
    // Network, CORS, timeout and invalid payloads leave the existing kind tile.
  }
  return undefined;
}

/**
 * Fire `listener` when the ink token's VALUE changes, whatever wrote it.
 *
 * A theme flip, a skin, and a space override all land as inline custom
 * properties on `<html>`; watching one source would miss the other two, and
 * watching the attribute alone would fire on unrelated style writes. So the
 * token is compared and the listener only runs for a real change.
 */
function watchInkToken(listener: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {};
  }
  let last = inkToken();
  const observer = new MutationObserver(() => {
    const next = inkToken();
    if (next === last) return;
    last = next;
    listener();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
  return () => { observer.disconnect(); };
}

function resolve(source: string): Promise<IconPayload | undefined> {
  if (payloads.has(source)) {
    const hit = payloads.get(source);
    payloads.delete(source);
    payloads.set(source, hit);
    return Promise.resolve(hit);
  }
  const pending = inFlight.get(source);
  if (pending !== undefined) return pending;
  const work = learn(source).then((payload) => {
    payloads.set(source, payload);
    while (payloads.size > MAX_ENTRIES) {
      const oldest = payloads.keys().next().value;
      if (oldest !== undefined) payloads.delete(oldest);
    }
    return payload;
  }).finally(() => { inFlight.delete(source); });
  inFlight.set(source, work);
  return work;
}

/**
 * Inline icons are ready on the first paint. Remote icons stay on the kind tile
 * until their bytes arrive: production CSP allows HTTP fetch, not HTTP img-src.
 */
export function useThemedIcon(icon: string | undefined): string | undefined {
  const source = iconSource(icon);
  const [resolved, setResolved] = useState(() => ({ source, payload: remembered(source) }));

  useEffect(() => {
    let live = true;
    let payload = remembered(source);
    const apply = (): void => { if (live) setResolved({ source, payload }); };
    apply();
    if (source !== undefined && !source.startsWith('data:')) {
      void resolve(source).then((next) => {
        payload = next;
        apply();
      });
    }
    // Each mounted consumer holds its own payload, even after cache eviction.
    const stopWatchingTheme = onThemeChange(apply);
    const stopWatchingToken = watchInkToken(apply);
    return () => {
      live = false;
      stopWatchingTheme();
      stopWatchingToken();
    };
  }, [source]);

  // A source change must never paint the previous request's result, even before
  // its effect runs. Cleanup also keeps a late result from overwriting the new one.
  return recolor(resolved.source === source ? resolved.payload : remembered(source));
}
