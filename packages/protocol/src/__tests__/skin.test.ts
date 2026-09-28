import { describe, expect, it } from 'vitest';

import { isSkinFileShape, parseSkinFile, skinFileSchema } from '../skin';

const minimal = {
  kind: 'kiki-skin',
  version: 1,
  name: 'Slate',
  variants: { light: { colors: { paper: '#ffffff', accent: '#3355ff' } } },
};

describe('parseSkinFile', () => {
  it('accepts a minimal single-variant skin and fills the id from the filename', () => {
    const result = parseSkinFile(minimal, 'slate');
    expect(result.warnings).toEqual([]);
    expect(result.skin?.id).toBe('slate');
    expect(result.skin?.variants.light?.colors?.accent).toBe('#3355ff');
    expect(result.skin?.variants.dark).toBeUndefined();
  });

  it('rejects a file that is not a kiki-skin', () => {
    expect(parseSkinFile({ name: 'ember', colors: { primary: '#83A598' } }).skin).toBeNull();
    expect(parseSkinFile(null).skin).toBeNull();
    expect(parseSkinFile([]).skin).toBeNull();
  });

  it('drops an invalid color but keeps the rest of the variant', () => {
    const result = parseSkinFile({
      ...minimal,
      variants: {
        light: { colors: { paper: 'rebeccapurple', accent: '#0a0', ink: '#111111' } },
      },
    }, 'slate');
    expect(result.skin?.variants.light?.colors).toEqual({ accent: '#0a0', ink: '#111111' });
    expect(result.warnings).toContain('variants.light.colors.paper: invalid value');
  });

  it('drops unknown tokens instead of failing the file', () => {
    const result = parseSkinFile({
      ...minimal,
      variants: { light: { colors: { paper: '#ffffff', mystery: '#ffffff' } } },
    }, 'slate');
    expect(result.skin?.variants.light?.colors).toEqual({ paper: '#ffffff' });
    expect(result.warnings).toContain('variants.light.colors.mystery: unknown token');
  });

  it('refuses font values that could smuggle CSS', () => {
    for (const font of [
      "Inter; } body { display: none } '",
      'url(https://evil.example/f.woff2)',
      'Inter", sans-serif; background: url(x)',
      'a'.repeat(201),
    ]) {
      const result = parseSkinFile({
        ...minimal,
        variants: { light: { fonts: { sans: font } } },
      }, 'slate');
      expect(result.skin?.variants.light?.fonts).toEqual({});
      expect(result.warnings).toContain('variants.light.fonts.sans: invalid value');
    }
  });

  it('accepts a normal font stack including CJK family names', () => {
    const result = parseSkinFile({
      ...minimal,
      variants: { light: { fonts: { sans: "'IBM Plex Sans', 苹方-简, system-ui, sans-serif" } } },
    }, 'slate');
    expect(result.warnings).toEqual([]);
    expect(result.skin?.variants.light?.fonts?.sans).toContain('IBM Plex Sans');
  });

  it('rejects shape values outside the supported range', () => {
    const result = parseSkinFile({
      ...minimal,
      variants: { light: { shape: { radius: 400 } } },
    }, 'slate');
    expect(result.warnings).toContain('variants.light.shape: invalid value');
    expect(result.skin?.variants.light?.shape).toBeUndefined();
  });

  it('requires at least one variant', () => {
    expect(parseSkinFile({ ...minimal, variants: {} }, 'slate').skin).toBeNull();
  });

  it('rejects an id that is not a safe slug', () => {
    expect(parseSkinFile({ ...minimal, id: '../../etc/passwd' }).skin).toBeNull();
    expect(parseSkinFile({ ...minimal, id: 'Slate Blue' }).skin).toBeNull();
  });

  it('keeps warnings while still returning the usable skin', () => {
    const result = parseSkinFile({
      ...minimal,
      variants: {
        light: { colors: { paper: '#fff' } },
        dark: { colors: { paper: 'nope' }, fonts: { mono: 'JetBrains Mono' } },
      },
    }, 'slate');
    expect(result.skin?.variants.dark?.fonts?.mono).toBe('JetBrains Mono');
    expect(result.warnings).toEqual(['variants.dark.colors.paper: invalid value']);
  });
});

describe('skinFileSchema', () => {
  it('rejects extra top-level keys so a skin cannot carry a css payload', () => {
    const parsed = skinFileSchema.safeParse({ ...minimal, css: 'body{display:none}' });
    expect(parsed.success).toBe(false);
  });

  it('identifies skin-shaped objects', () => {
    expect(isSkinFileShape(minimal)).toBe(true);
    expect(isSkinFileShape({ name: 'ember', colors: {} })).toBe(false);
  });
});
