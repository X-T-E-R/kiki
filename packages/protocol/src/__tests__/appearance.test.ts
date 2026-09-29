import { describe, expect, it } from 'vitest';

import {
  APPEARANCE_LIMITS,
  appearancePackFiles,
  backgroundLookSchema,
  backgroundMediaTypeOf,
  mediaTypeMatches,
  parseAppearancePack,
  sniffBackgroundMediaType,
} from '../appearance';

const pack = {
  kind: 'kiki-appearance-pack',
  version: 1,
  id: 'dusk-harbor',
  name: 'Dusk Harbor',
  preview: 'preview.webp',
  variants: {
    light: {
      colors: { accent: '#b4532a' },
      background: { media: ['day.webp'], opacity: 0.9, surfaceOpacity: 0.8 },
    },
    dark: {
      background: { media: ['night.mp4'], poster: 'night.webp', scope: 'main' },
    },
  },
};

const bytes = (...values: number[]) => new Uint8Array([...values, ...new Array(16).fill(0)]);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

describe('parseAppearancePack', () => {
  it('accepts a two-variant pack and lists every referenced file once', () => {
    const result = parseAppearancePack(pack);
    expect(result.warnings).toEqual([]);
    expect(result.pack?.variants.dark?.background?.scope).toBe('main');
    expect(appearancePackFiles(result.pack!)).toEqual(['preview.webp', 'day.webp', 'night.mp4', 'night.webp']);
  });

  it('refuses the whole pack on any unknown key, including a css slot', () => {
    expect(parseAppearancePack({ ...pack, css: 'body{display:none}' }).pack).toBeNull();
    const withCss = { ...pack, variants: { light: { ...pack.variants.light, css: '*{}' } } };
    expect(parseAppearancePack(withCss).pack).toBeNull();
  });

  it('refuses traversal, nested paths, scripts, svg and html media', () => {
    for (const file of ['../x.png', 'a/b.png', 'x.svg', 'x.html', 'x.js', '.hidden.png', 'x']) {
      const bad = { ...pack, variants: { light: { background: { media: [file] } } } };
      expect(parseAppearancePack(bad).pack, file).toBeNull();
    }
  });

  it('clamps nothing silently: out-of-range dials are errors', () => {
    expect(backgroundLookSchema.safeParse({ opacity: 1.5 }).success).toBe(false);
    expect(backgroundLookSchema.safeParse({ surfaceOpacity: 0.1 }).success).toBe(false);
    expect(backgroundLookSchema.safeParse({ fit: 'stretch' }).success).toBe(false);
    expect(backgroundLookSchema.safeParse({ alignment: 'bottomRight', blur: 8 }).success).toBe(true);
  });

  it('caps carousel length', () => {
    const media = Array.from({ length: APPEARANCE_LIMITS.slides + 1 }, (_, index) => `s${index}.webp`);
    expect(parseAppearancePack({ ...pack, variants: { light: { background: { media } } } }).pack).toBeNull();
  });

  it('needs at least one variant and version 1', () => {
    expect(parseAppearancePack({ ...pack, variants: {} }).pack).toBeNull();
    expect(parseAppearancePack({ ...pack, version: 2 }).pack).toBeNull();
  });
});

describe('media typing', () => {
  it('maps the allow-list of extensions', () => {
    expect(backgroundMediaTypeOf('a.JPG')).toEqual({ kind: 'image', mime: 'image/jpeg' });
    expect(backgroundMediaTypeOf('a.webm')?.kind).toBe('video');
    expect(backgroundMediaTypeOf('a.svg')).toBeNull();
    expect(backgroundMediaTypeOf('noext')).toBeNull();
  });

  it('sniffs the real type and refuses a renamed file', () => {
    expect(sniffBackgroundMediaType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffBackgroundMediaType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffBackgroundMediaType(bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')))).toBe('image/webp');
    expect(sniffBackgroundMediaType(bytes(0, 0, 0, 0x20, ...ascii('ftypisom')))).toBe('video/mp4');
    expect(sniffBackgroundMediaType(bytes(0, 0, 0, 0x20, ...ascii('ftypavif')))).toBe('image/avif');
    expect(sniffBackgroundMediaType(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe('video/webm');
    const html = new TextEncoder().encode('<html><script>alert(1)</script>');
    expect(sniffBackgroundMediaType(html)).toBeNull();
    expect(mediaTypeMatches('image/png', null)).toBe(false);
    expect(mediaTypeMatches('video/mp4', 'image/avif')).toBe(false);
    expect(mediaTypeMatches('image/webp', 'image/webp')).toBe(true);
  });
});
