// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_BACKGROUND_LOOK, parseAppearancePack } from '@kiki/protocol';

import {
  TEXT_CONTRAST_TARGET,
  applyBackdrop,
  checkBackgroundFile,
  contrastRatio,
  editKeyForTheme,
  normalizeBackgroundPrefs,
  normalizeLook,
  normalizeSkinPrefs,
  packBackgroundPrefs,
  packSkinOf,
  parseHex,
  parsePackMediaId,
  readableSurfaceAlpha,
  relativeLuminance,
  resetBackgroundPrefsCache,
  sampleLuminance,
  slotForTheme,
  writeBackgroundPrefs,
  backgroundPrefsSnapshot,
} from './index';

// The shipped paper palette (index.css), light and dark.
const LIGHT = { surface: '#f8f4ec', ground: '#ede5d6', texts: ['#1c1917', '#544a3f', '#665a4c'] };
const DARK = { surface: '#17140f', ground: '#110e0a', texts: ['#efe8dc', '#b8ac99', '#958978'] };

/** Contrast of the faintest text over the surface composited on a gray pixel. */
function worstContrast(colors: typeof LIGHT, alpha: number, look = DEFAULT_BACKGROUND_LOOK): number {
  const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  const mix = (a: readonly number[], b: readonly number[], t: number) => a.map((v, i) => v * t + b[i]! * (1 - t));
  const surface = parseHex(colors.surface)!;
  const ground = parseHex(colors.ground)!;
  let worst = Infinity;
  for (const lum of [0, 1]) {
    const pixel = [toSrgb(lum), toSrgb(lum), toSrgb(lum)];
    const backdrop = mix(pixel, ground, look.opacity * (1 - look.scrim));
    const bg = relativeLuminance(mix(surface, backdrop, alpha) as unknown as [number, number, number]);
    for (const text of colors.texts) worst = Math.min(worst, contrastRatio(relativeLuminance(parseHex(text)!), bg));
  }
  return worst;
}

afterEach(() => {
  localStorage.clear();
  resetBackgroundPrefsCache();
});

describe('readableSurfaceAlpha', () => {
  it('keeps the default look at AA in both themes without raising it when it already holds', () => {
    for (const colors of [LIGHT, DARK]) {
      const alpha = readableSurfaceAlpha(colors, DEFAULT_BACKGROUND_LOOK, undefined, DEFAULT_BACKGROUND_LOOK.surfaceOpacity);
      expect(worstContrast(colors, alpha)).toBeGreaterThanOrEqual(TEXT_CONTRAST_TARGET);
    }
  });

  it('raises a see-through request on a full-strength picture until the faintest text holds', () => {
    const look = normalizeLook({ opacity: 1, scrim: 0, surfaceOpacity: 0.3 });
    for (const colors of [LIGHT, DARK]) {
      const alpha = readableSurfaceAlpha(colors, look, undefined, 0.3);
      expect(alpha).toBeGreaterThan(0.3);
      expect(alpha).toBeLessThanOrEqual(1);
      expect(worstContrast(colors, alpha, look)).toBeGreaterThanOrEqual(TEXT_CONTRAST_TARGET);
      // And not more than needed: one step lower fails.
      if (alpha > 0.31) expect(worstContrast(colors, alpha - 0.02, look)).toBeLessThan(TEXT_CONTRAST_TARGET + 0.2);
    }
  });

  it('lets a measured, even picture stay more see-through than the worst case', () => {
    const look = normalizeLook({ opacity: 1, scrim: 0 });
    const midtones = { dark: 0.2, light: 0.35 };
    expect(readableSurfaceAlpha(DARK, look, midtones, 0.3)).toBeLessThan(readableSurfaceAlpha(DARK, look, undefined, 0.3));
  });

  it('fails closed to opaque when a token cannot be read', () => {
    expect(readableSurfaceAlpha({ ...LIGHT, surface: 'var(--x)' }, DEFAULT_BACKGROUND_LOOK, undefined, 0.4)).toBe(1);
  });
});

describe('background prefs', () => {
  const ref = { id: 'local-abc-1', kind: 'image', mime: 'image/webp', name: 'sky.webp', bytes: 10 } as const;

  it('clamps stored dials and drops media refs that could point anywhere', () => {
    const prefs = normalizeBackgroundPrefs({
      light: { media: [ref, { ...ref, id: '../../etc' }, { ...ref, mime: 'text/html' }], look: { opacity: 7, fit: 'stretch', surfaceOpacity: 0 } },
    });
    expect(prefs.light?.media.map((m) => m.id)).toEqual(['local-abc-1']);
    expect(prefs.light?.look).toMatchObject({ opacity: 1, fit: 'cover', surfaceOpacity: 0.3 });
    expect(normalizeBackgroundPrefs({ light: { media: [] } }).light).toBeNull();
  });

  it('reuses one slot in both themes while linked and splits on request', () => {
    const slot = { media: [ref], interval: 0, look: DEFAULT_BACKGROUND_LOOK };
    writeBackgroundPrefs({ light: slot, dark: null, linked: true });
    const linked = backgroundPrefsSnapshot();
    expect(slotForTheme(linked, 'dark')?.media[0]?.id).toBe('local-abc-1');
    expect(editKeyForTheme(linked, 'dark')).toBe('light');
    const split = { ...linked, linked: false };
    expect(slotForTheme(split, 'dark')).toBeNull();
    expect(editKeyForTheme(split, 'dark')).toBe('dark');
  });

  it('removes its storage entry entirely when cleared', () => {
    writeBackgroundPrefs({ light: { media: [ref], interval: 0, look: DEFAULT_BACKGROUND_LOOK }, dark: null, linked: true });
    expect(localStorage.getItem('kiki.background')).not.toBeNull();
    writeBackgroundPrefs({ light: null, dark: null, linked: true });
    expect(localStorage.getItem('kiki.background')).toBeNull();
  });

  it('keeps the reading assist across writes that do not mention it', () => {
    const slot = { media: [ref], interval: 0, look: DEFAULT_BACKGROUND_LOOK };
    expect(backgroundPrefsSnapshot().assist).toBe(true);
    writeBackgroundPrefs({ light: slot, dark: null, linked: true, assist: false });
    // A pack or a link toggle writes without `assist`: the choice stays off.
    writeBackgroundPrefs({ light: slot, dark: slot, linked: false });
    expect(backgroundPrefsSnapshot().assist).toBe(false);
    // Assist off is a real preference, so clearing the picture keeps it stored.
    writeBackgroundPrefs({ light: null, dark: null, linked: true });
    expect(JSON.parse(localStorage.getItem('kiki.background')!).assist).toBe(false);
  });
});

describe('two-layer backdrop', () => {
  const ref = { id: 'local-abc-2', kind: 'image', mime: 'image/webp', name: 'loud.webp', bytes: 10 } as const;
  const slot = (look = {}) => ({ media: [ref], interval: 0, look: { ...DEFAULT_BACKGROUND_LOOK, ...look }, sample: { dark: 0, light: 1 } });
  const vars = () => {
    const style = document.documentElement.style;
    return {
      canvas: Number.parseFloat(style.getPropertyValue('--kiki-surface-alpha')),
      band: Number.parseFloat(style.getPropertyValue('--kiki-text-alpha')),
      solid: Number.parseFloat(style.getPropertyValue('--kiki-solid-alpha')),
    };
  };
  afterEach(() => { applyBackdrop(null); });

  it('keeps the canvas at the requested opacity and raises only the text layer', () => {
    document.documentElement.style.setProperty('--color-paper', LIGHT.surface);
    document.documentElement.style.setProperty('--color-canvas', LIGHT.ground);
    document.documentElement.style.setProperty('--color-panel', LIGHT.surface);
    document.documentElement.style.setProperty('--color-ink', LIGHT.texts[0]!);
    document.documentElement.style.setProperty('--color-ink-soft', LIGHT.texts[1]!);
    document.documentElement.style.setProperty('--color-ink-faint', LIGHT.texts[2]!);
    applyBackdrop(slot({ surfaceOpacity: 0.6 }), true);
    const on = vars();
    expect(on.canvas).toBe(60);
    expect(on.solid).toBeGreaterThan(60);
    // canvas + band stacked reach the solved floor.
    expect(60 + on.band * 0.4).toBeGreaterThanOrEqual(on.solid - 1);
    expect(document.documentElement.dataset['kikiBgAssist']).toBe('');
  });

  it('with the assist off applies exactly the requested numbers', () => {
    applyBackdrop(slot({ surfaceOpacity: 0.6 }), false);
    expect(vars()).toEqual({ canvas: 60, band: 0, solid: 60 });
    expect(document.documentElement.dataset['kikiBgAssist']).toBeUndefined();
  });
});

describe('media checks', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  it('accepts a real picture and refuses a renamed page or an unknown type', async () => {
    expect(await checkBackgroundFile(Object.assign(new Blob([png]), { name: 'a.png' }))).toMatchObject({ ok: true, kind: 'image', mime: 'image/png' });
    expect(await checkBackgroundFile(Object.assign(new Blob(['<html>']), { name: 'a.png' }))).toEqual({ ok: false, reason: 'content' });
    expect(await checkBackgroundFile(Object.assign(new Blob(['<svg/>']), { name: 'a.svg' }))).toEqual({ ok: false, reason: 'type' });
    expect(await checkBackgroundFile(Object.assign(new Blob([png]), { name: 'a.jpg' }))).toEqual({ ok: false, reason: 'content' });
  });

  it('samples luminance percentiles and ignores transparent pixels', () => {
    const pixels = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 0]);
    const sample = sampleLuminance(pixels);
    expect(sample.dark).toBe(0);
    expect(sample.light).toBeCloseTo(1, 5);
  });
});

describe('packs as prefs', () => {
  const pack = parseAppearancePack({
    kind: 'kiki-appearance-pack',
    version: 1,
    id: 'dusk-harbor',
    name: 'Dusk Harbor',
    variants: {
      light: { colors: { accent: '#9a3f1c' }, background: { media: ['day.webp'], opacity: 0.8 } },
      dark: { background: { media: ['night.mp4'], poster: 'night.webp', scope: 'main' } },
    },
  }).pack!;

  it('maps each variant to its own slot with pack media ids', () => {
    const prefs = packBackgroundPrefs(pack);
    expect(prefs.linked).toBe(false);
    expect(prefs.light?.media[0]?.id).toBe('pack:dusk-harbor/day.webp');
    expect(prefs.dark?.media[0]).toMatchObject({ kind: 'video', mime: 'video/mp4' });
    expect(prefs.dark?.poster?.id).toBe('pack:dusk-harbor/night.webp');
    expect(prefs.dark?.look.scope).toBe('main');
    expect(parsePackMediaId('pack:dusk-harbor/day.webp')).toEqual({ packId: 'dusk-harbor', file: 'day.webp' });
    // Survives a storage round-trip; the reading assist defaults to on.
    expect(normalizeBackgroundPrefs(JSON.parse(JSON.stringify(prefs)))).toEqual({ ...prefs, assist: true });
  });

  it('turns only the declared token variants into a skin', () => {
    const skin = packSkinOf(pack)!;
    expect(skin.variants.light?.colors?.accent).toBe('#9a3f1c');
    expect(skin.variants.dark).toBeUndefined();
    expect(packSkinOf({ ...pack, variants: { light: { background: pack.variants.light!.background } } })).toBeNull();
  });
});

describe('skin selections', () => {
  it('keeps plugin and pack selections through normalization', () => {
    expect(normalizeSkinPrefs({ selection: { source: 'user', id: 'kiki-office:sea-glass' } }).selection).toEqual({ source: 'user', id: 'kiki-office:sea-glass' });
    expect(normalizeSkinPrefs({ selection: { source: 'pack', id: 'dusk-harbor' } }).selection).toEqual({ source: 'pack', id: 'dusk-harbor' });
    expect(normalizeSkinPrefs({ selection: { source: 'user', id: '../x' } }).selection.id).toBe('paper');
  });
});
