/**
 * The window backdrop: one fixed layer behind the app that shows the active
 * background, plus the attributes and variables the surface CSS reads.
 *
 * Plain DOM rather than React on purpose: it runs from the same document-level
 * sync as the skin (before the first render, outside any route), and a media
 * element that survives every route change never reloads or restarts a video.
 *
 * Written on `<html>` while a background is showing:
 *   data-kiki-bg="window|main|sidebar"   which surfaces go translucent
 *   data-kiki-bg-assist                  readability assist is on
 *   --kiki-surface-alpha                 canvas opacity, exactly as requested
 *   --kiki-text-alpha                    extra layer under text (assist), so
 *                                        canvas + layer reach the solved floor
 *   --kiki-solid-alpha                   that floor as one opacity, for text
 *                                        surfaces that sit on no canvas
 *   --kiki-surface-blur                  backdrop blur behind surfaces
 *
 * Video policy: always muted, looped and inline. It plays only while the
 * window is visible and focused, the motion preference allows it, and the
 * device is not saving power; otherwise it rests on its poster or first frame.
 */

import { objectPositionOf, readableSurfaceAlpha, sampleLuminance, type BackgroundMediaRef, type BackgroundSlot, type MediaSample } from './background';
import { getMedia } from './mediaStore';

export interface BackdropStatus {
  /** The media in the slot could not be loaded (deleted, or storage cleared). */
  readonly missing: boolean;
  /** A video larger than 1440p is playing; GPU memory scales with pixels. */
  readonly heavyVideo: boolean;
  /** A video is resting on its first frame, and why. */
  readonly paused: 'motion' | 'hidden' | 'power' | null;
  /** The canvas opacity applied (always the requested panel opacity). */
  readonly surfaceAlpha: number | null;
  /** The opacity text surfaces reach: the solved floor with assist, else the canvas. */
  readonly textAlpha: number | null;
}

const IDLE_STATUS: BackdropStatus = { missing: false, heavyVideo: false, paused: null, surfaceAlpha: null, textAlpha: null };

let status: BackdropStatus = IDLE_STATUS;
const statusListeners = new Set<() => void>();

export function backdropStatus(): BackdropStatus {
  return status;
}

export function subscribeBackdropStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}

function setStatus(patch: Partial<BackdropStatus>): void {
  const next = { ...status, ...patch };
  if (JSON.stringify(next) === JSON.stringify(status)) return;
  status = next;
  for (const listener of statusListeners) listener();
}

const samples = new Map<string, MediaSample>();

/** Readability assist, from the prefs on each apply (see applySurfaceVars). */
let assistEnabled = true;

/** Measured luminance of a media id, once it has been drawn at least once. */
export function mediaSample(id: string): MediaSample | undefined {
  return samples.get(id);
}

function measure(source: CanvasImageSource, id: string): void {
  if (samples.has(id) || typeof document === 'undefined') return;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 32;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) return;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    samples.set(id, sampleLuminance(context.getImageData(0, 0, canvas.width, canvas.height).data));
  } catch {
    // An unreadable frame keeps the worst-case assumption (black and white).
  }
}

interface SurfaceProbe {
  readonly surface: string;
  readonly ground: string;
  readonly texts: readonly string[];
}

function cssColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function probeSurfaces(): SurfaceProbe[] {
  const texts = ['--color-ink', '--color-ink-soft', '--color-ink-faint'].map(cssColor);
  const ground = cssColor('--color-canvas');
  return ['--color-canvas', '--color-paper', '--color-panel'].map((name) => ({ surface: cssColor(name), ground, texts }));
}
interface Layer {
  readonly root: HTMLDivElement;
  readonly media: HTMLDivElement;
  readonly scrim: HTMLDivElement;
}

let layer: Layer | null = null;
let current: { key: string; element: HTMLImageElement | HTMLVideoElement | null; urls: string[] } = { key: '', element: null, urls: [] };
let carouselTimer: ReturnType<typeof setInterval> | undefined;
let slideIndex = 0;
let activeSlot: BackgroundSlot | null = null;
let generation = 0;

function ensureLayer(): Layer {
  if (layer !== null && layer.root.isConnected) return layer;
  const root = document.createElement('div');
  root.dataset['kikiBackdrop'] = '';
  root.setAttribute('aria-hidden', 'true');
  const media = document.createElement('div');
  media.dataset['kikiBackdropMedia'] = '';
  const scrim = document.createElement('div');
  scrim.dataset['kikiBackdropScrim'] = '';
  root.append(media, scrim);
  document.body.prepend(root);
  layer = { root, media, scrim };
  return layer;
}

function motionAllowed(): boolean {
  const pref = document.documentElement.dataset['kikiMotion'];
  if (pref === 'reduce') return false;
  if (pref === 'full') return true;
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

let powerSaving = false;

/** Battery Status API where it exists: pause video under 20% and unplugged. */
function watchBattery(): void {
  const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean; addEventListener(type: string, cb: () => void): void }> };
  void nav.getBattery?.().then((battery) => {
    const update = () => {
      powerSaving = !battery.charging && battery.level < 0.2;
      syncPlayback();
    };
    battery.addEventListener('levelchange', update);
    battery.addEventListener('chargingchange', update);
    update();
  }).catch(() => undefined);
}

function pauseReason(): BackdropStatus['paused'] {
  if (!motionAllowed()) return 'motion';
  if (document.visibilityState === 'hidden' || !document.hasFocus()) return 'hidden';
  if (powerSaving) return 'power';
  return null;
}

function syncPlayback(): void {
  const video = current.element instanceof HTMLVideoElement ? current.element : null;
  if (video === null) {
    setStatus({ paused: null });
    return;
  }
  const reason = pauseReason();
  // `hidden` is ordinary (blur, minimise) and not worth a status line; it
  // still pauses. Only reasons the user can act on reach the settings page.
  setStatus({ paused: reason === 'hidden' ? null : reason });
  if (reason === null) void video.play().catch(() => undefined);
  else video.pause();
}

function revoke(): void {
  for (const url of current.urls) URL.revokeObjectURL(url);
  current = { key: '', element: null, urls: [] };
}

async function urlFor(ref: BackgroundMediaRef, resolve: MediaResolver): Promise<string | null> {
  const blob = await resolve(ref);
  if (blob === null) return null;
  const url = URL.createObjectURL(blob);
  current.urls.push(url);
  return url;
}

/** Where media bytes come from: the local store, or a pack's server files. */
export type MediaResolver = (ref: BackgroundMediaRef) => Promise<Blob | null>;

let resolver: MediaResolver = (ref) => getMedia(ref.id);

export function setBackdropMediaResolver(next: MediaResolver): void {
  resolver = next;
  // The resolver arrives with the connection; a pack slot restored from
  // storage on boot had nothing to fetch its media with until now.
  if (activeSlot !== null && current.element === null) void mountMedia(activeSlot, slideIndex, generation);
}

/** Fetch a ref's bytes the same way the backdrop does (thumbnails, previews). */
export function resolveBackdropMedia(ref: BackgroundMediaRef): Promise<Blob | null> {
  return resolver(ref);
}

function styleMedia(element: HTMLElement, slot: BackgroundSlot, tile: string | null): void {
  const { look } = slot;
  const filter = [look.blur > 0 ? `blur(${look.blur}px)` : '', look.brightness !== 1 ? `brightness(${look.brightness})` : ''].filter(Boolean).join(' ');
  element.style.opacity = String(look.opacity);
  element.style.filter = filter;
  // Blur spreads transparent edges inward; overscan hides them.
  element.style.inset = look.blur > 0 ? `-${Math.ceil(look.blur * 2)}px` : '0';
  if (tile !== null) {
    element.style.backgroundImage = `url("${tile}")`;
    element.style.backgroundRepeat = 'repeat';
    element.style.backgroundPosition = objectPositionOf(look.alignment);
    return;
  }
  element.style.objectFit = look.fit === 'contain' ? 'contain' : look.fit === 'center' ? 'none' : 'cover';
  element.style.objectPosition = objectPositionOf(look.alignment);
}

async function mountMedia(slot: BackgroundSlot, index: number, run: number): Promise<void> {
  const { media: host } = ensureLayer();
  const ref = slot.media[index % slot.media.length]!;
  const key = `${slot.packId ?? ''}|${ref.id}|${slot.look.fit}`;
  if (current.key === key && current.element !== null) {
    styleMedia(current.element, slot, slot.look.fit === 'tile' && ref.kind === 'image' ? current.urls[0] ?? null : null);
    syncPlayback();
    return;
  }
  const previous = current;
  current = { key, element: null, urls: [] };
  const url = await urlFor(ref, resolver);
  if (run !== generation) { for (const u of current.urls) URL.revokeObjectURL(u); return; }
  if (url === null) {
    for (const u of previous.urls) URL.revokeObjectURL(u);
    host.replaceChildren();
    setStatus({ missing: true });
    return;
  }
  let element: HTMLImageElement | HTMLVideoElement | HTMLDivElement;
  if (ref.kind === 'video') {
    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.autoplay = false;
    video.preload = 'auto';
    video.disablePictureInPicture = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    if (slot.poster !== undefined) {
      const poster = await urlFor(slot.poster, resolver);
      if (poster !== null) video.poster = poster;
    }
    video.addEventListener('loadeddata', () => {
      measure(video, ref.id);
      setStatus({ heavyVideo: video.videoWidth * video.videoHeight > 2560 * 1440 });
      applySurfaceVars(slot);
    }, { once: true });
    video.src = url;
    element = video;
  } else if (slot.look.fit === 'tile') {
    element = document.createElement('div');
    const probe = new Image();
    probe.addEventListener('load', () => { measure(probe, ref.id); applySurfaceVars(slot); }, { once: true });
    probe.src = url;
  } else {
    const image = document.createElement('img');
    image.decoding = 'async';
    image.alt = '';
    image.addEventListener('load', () => { measure(image, ref.id); applySurfaceVars(slot); }, { once: true });
    image.src = url;
    element = image;
  }
  element.dataset['kikiBackdropItem'] = ref.kind;
  styleMedia(element, slot, element instanceof HTMLDivElement ? url : null);
  host.replaceChildren(element);
  for (const u of previous.urls) URL.revokeObjectURL(u);
  current.element = element instanceof HTMLDivElement ? null : element;
  setStatus({ missing: false, heavyVideo: false });
  syncPlayback();
}

function applySurfaceVars(slot: BackgroundSlot): void {
  const root = document.documentElement;
  const sample = slot.sample ?? mediaSample(slot.media[slideIndex % slot.media.length]!.id);
  const canvas = slot.look.surfaceOpacity;
  // Two layers. The canvas (sheets, sidebar ground, margins, empty space) is
  // exactly what the user asked for. Readability is solved only for the text
  // layer (reading band, rows, cards) stacked on it: `solid` is the combined
  // opacity text needs, `band` the extra layer that gets the canvas there.
  // With the assist off, nothing is raised anywhere.
  const solid = assistEnabled
    ? Math.max(...probeSurfaces().map((colors) => readableSurfaceAlpha(colors, slot.look, sample, canvas)))
    : canvas;
  const band = canvas >= 1 ? 0 : Math.max(0, (solid - canvas) / (1 - canvas));
  root.style.setProperty('--kiki-surface-alpha', `${Math.round(canvas * 100)}%`);
  root.style.setProperty('--kiki-text-alpha', `${Math.ceil(band * 100)}%`);
  root.style.setProperty('--kiki-solid-alpha', `${Math.ceil(solid * 100)}%`);
  root.style.setProperty('--kiki-surface-blur', `${slot.look.surfaceBlur}px`);
  root.style.setProperty('--kiki-backdrop-scrim', String(slot.look.scrim));
  if (assistEnabled) root.dataset['kikiBgAssist'] = '';
  else delete root.dataset['kikiBgAssist'];
  setStatus({ surfaceAlpha: canvas, textAlpha: solid });
}

function clearBackdrop(): void {
  generation += 1;
  clearInterval(carouselTimer);
  carouselTimer = undefined;
  activeSlot = null;
  revoke();
  layer?.root.remove();
  layer = null;
  const root = document.documentElement;
  delete root.dataset['kikiBg'];
  delete root.dataset['kikiBgAssist'];
  for (const name of ['--kiki-surface-alpha', '--kiki-text-alpha', '--kiki-solid-alpha', '--kiki-surface-blur', '--kiki-backdrop-scrim']) root.style.removeProperty(name);
  setStatus(IDLE_STATUS);
}

/**
 * Show a slot (or nothing). Idempotent: the sync loop calls it on every
 * settings, skin and theme change, and an unchanged slot keeps its media
 * element — a playing video does not restart because the accent moved.
 */
export function applyBackdrop(slot: BackgroundSlot | null, assist = true): void {
  if (typeof document === 'undefined') return;
  assistEnabled = assist;
  if (slot === null) {
    if (activeSlot !== null || layer !== null) clearBackdrop();
    return;
  }
  const changedMedia = JSON.stringify(activeSlot?.media) !== JSON.stringify(slot.media) || activeSlot?.packId !== slot.packId;
  activeSlot = slot;
  if (changedMedia) {
    generation += 1;
    slideIndex = 0;
  }
  document.documentElement.dataset['kikiBg'] = slot.look.scope;
  ensureLayer().root.dataset['scope'] = slot.look.scope;
  if (slot.look.scope !== 'window') {
    attachSidebarEdge();
    // The sidebar mounts after the first sync on a cold boot.
    requestAnimationFrame(attachSidebarEdge);
  }
  applySurfaceVars(slot);
  void mountMedia(slot, slideIndex, generation);
  clearInterval(carouselTimer);
  carouselTimer = undefined;
  if (slot.media.length > 1 && slot.interval > 0 && motionAllowed()) {
    carouselTimer = setInterval(() => {
      if (activeSlot === null || document.visibilityState === 'hidden') return;
      slideIndex = (slideIndex + 1) % activeSlot.media.length;
      void mountMedia(activeSlot, slideIndex, generation);
    }, slot.interval * 1000);
  }
}

/**
 * The sidebar's right edge, for `main` and `sidebar` scopes: the backdrop is
 * clipped to one side of it. Measured with a ResizeObserver, not assumed,
 * because the sidebar is user-resizable. Attached lazily from `applyBackdrop`
 * (no DOM-wide observer: the transcript mutates on every streamed token).
 */
let edgeObserver: ResizeObserver | null = null;
let edgeTarget: Element | null = null;

function publishSidebarEdge(): void {
  const width = edgeTarget?.getBoundingClientRect().right ?? 0;
  document.documentElement.style.setProperty('--kiki-backdrop-sidebar', `${Math.round(width)}px`);
}

function attachSidebarEdge(): void {
  if (typeof ResizeObserver === 'undefined') return;
  const next = document.querySelector('.app-sidebar');
  if (next === edgeTarget) return;
  edgeObserver ??= new ResizeObserver(publishSidebarEdge);
  if (edgeTarget !== null) edgeObserver.unobserve(edgeTarget);
  edgeTarget = next;
  if (edgeTarget !== null) edgeObserver.observe(edgeTarget);
  publishSidebarEdge();
}

function trackSidebarEdge(): () => void {
  window.addEventListener('resize', publishSidebarEdge);
  return () => {
    window.removeEventListener('resize', publishSidebarEdge);
    edgeObserver?.disconnect();
    edgeObserver = null;
    edgeTarget = null;
    document.documentElement.style.removeProperty('--kiki-backdrop-sidebar');
  };
}

let watching = false;

/** Pause and resume video with focus, visibility and power; call once. */
export function watchBackdropPlayback(): () => void {
  if (watching || typeof window === 'undefined') return () => {};
  watching = true;
  const onChange = () => { syncPlayback(); };
  document.addEventListener('visibilitychange', onChange);
  window.addEventListener('focus', onChange);
  window.addEventListener('blur', onChange);
  const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  motion?.addEventListener?.('change', onChange);
  watchBattery();
  const stopEdge = trackSidebarEdge();
  return () => {
    watching = false;
    stopEdge();
    document.removeEventListener('visibilitychange', onChange);
    window.removeEventListener('focus', onChange);
    window.removeEventListener('blur', onChange);
    motion?.removeEventListener?.('change', onChange);
    clearBackdrop();
  };
}

/** Re-check the playback policy after the motion setting moves. */
export function refreshBackdropPlayback(): void {
  if (typeof document !== 'undefined') syncPlayback();
}
