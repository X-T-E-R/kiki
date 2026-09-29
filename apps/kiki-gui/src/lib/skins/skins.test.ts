// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { translate } from '@kiki/session-core/i18n';
import { writeSettings } from '@kiki/session-core/settings';

import {
  BUILTIN_SKINS,
  DEFAULT_SKIN_ID,
  allSkinVariables,
  applyCurrentSkin,
  applySkinVariables,
  buildSkinExport,
  builtinSkinDescriptionKey,
  clearSelectedSkinCache,
  declaredVariants,
  findBuiltinSkin,
  hexToRgbTriplet,
  normalizeSkinPrefs,
  readSkinPrefs,
  resolveSkin,
  setSkinPreview,
  setUserSkins,
  skinVariablesFor,
  slugify,
  startSkinSync,
  variantToCssVariables,
  writeSkinPrefs,
} from './index';
import { applyTheme } from '../theme';

/** Relative luminance / WCAG contrast, to re-check the shipped palettes. */
function luminance(hex: string): number {
  const body = hex.replace('#', '');
  const full = body.length === 3 ? body.split('').map((c) => `${c}${c}`).join('') : body;
  const channels = [0, 2, 4]
    .map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

afterEach(() => {
  setSkinPreview(null);
  setUserSkins([], null);
  clearSelectedSkinCache();
  localStorage.clear();
  applySkinVariables(document.documentElement, {});
  delete document.documentElement.dataset['theme'];
  delete document.documentElement.dataset['skin'];
});

describe('built-in skins', () => {
  it('ships Paper as the default with no colors of its own', () => {
    const paper = findBuiltinSkin(DEFAULT_SKIN_ID);
    expect(paper?.variants.light).toEqual({});
    expect(paper?.variants.dark).toEqual({});
  });

  it('ships at least three skins beyond the default, with unique ids', () => {
    const ids = BUILTIN_SKINS.map((skin) => skin.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id !== DEFAULT_SKIN_ID).length).toBeGreaterThanOrEqual(3);
  });

  it('gives every built-in a localized description in both locales', () => {
    for (const skin of BUILTIN_SKINS) {
      const key = builtinSkinDescriptionKey(skin.id);
      expect(key, skin.id).toBeDefined();
      expect(translate('en', key!), skin.id).not.toBe(key);
      expect(translate('zh', key!), skin.id).not.toBe(translate('en', key!));
    }
    expect(builtinSkinDescriptionKey('ocean')).toBeUndefined();
    expect(builtinSkinDescriptionKey('toString')).toBeUndefined();
  });

  it('declares the variants it actually carries', () => {
    expect(declaredVariants(findBuiltinSkin('slate')!)).toEqual(['light', 'dark']);
    expect(declaredVariants(findBuiltinSkin('contrast')!)).toEqual(['light', 'dark']);
    // Nocturne is dark-only on purpose, and says so.
    expect(declaredVariants(findBuiltinSkin('nocturne')!)).toEqual(['dark']);
  });

  it('keeps text at WCAG AA on every surface of every variant', () => {
    for (const skin of BUILTIN_SKINS) {
      if (skin.id === DEFAULT_SKIN_ID) continue; // base palette: checked from index.css below
      for (const theme of declaredVariants(skin)) {
        const colors = skin.variants[theme]!.colors;
        if (colors === undefined) continue; // an empty variant is the base palette
        for (const surface of ['canvas', 'paper', 'panel'] as const) {
          for (const text of ['ink', 'inkSoft', 'inkFaint', 'accent', 'success', 'danger', 'amberInk'] as const) {
            const ratio = contrast(colors[text]!, colors[surface]!);
            expect(ratio, `${skin.id}/${theme}: ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
          }
          // Focal roles, where the skin states them (else derived, see apply.ts).
          for (const text of ['sectionInk', 'attention', 'selectedInk'] as const) {
            if (colors[text] === undefined) continue;
            expect(contrast(colors[text], colors[surface]!), `${skin.id}/${theme}: ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
          }
        }
        if (colors.selected !== undefined) {
          for (const text of ['ink', 'inkSoft', 'inkFaint', 'selectedInk'] as const) {
            expect(contrast(colors[text]!, colors.selected), `${skin.id}/${theme}: ${text} on selected`).toBeGreaterThanOrEqual(4.5);
          }
        }
        // Labels on filled surfaces: the case plain `text-white` got wrong.
        expect(contrast(colors.onAccent!, colors.accent!), `${skin.id}/${theme} onAccent`)
          .toBeGreaterThanOrEqual(4.5);
        expect(contrast(colors.onDanger!, colors.danger!), `${skin.id}/${theme} onDanger`)
          .toBeGreaterThanOrEqual(4.5);
        expect(contrast(colors.shellInk!, colors.shell!), `${skin.id}/${theme} shellInk`)
          .toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps the default Paper palette (index.css) at AA, faint text and focal roles included', () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../index.css'), 'utf8');
    const block = (start: string) => {
      const from = css.indexOf(start);
      return css.slice(from, css.indexOf('\n}', from));
    };
    const read = (text: string) => Object.fromEntries([...text.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1]!, m[2]!]));
    const light = read(block('@theme {'));
    const dark = { ...light, ...read(block("[data-theme='dark'] {")) };
    for (const [theme, p] of [['light', light], ['dark', dark]] as const) {
      for (const surface of ['canvas', 'paper', 'panel', 'selected']) {
        for (const text of ['ink', 'ink-soft', 'ink-faint', 'accent-ink', 'section-ink', 'attention', 'selected-ink', 'success', 'danger', 'amber-ink']) {
          expect(contrast(p[text]!, p[surface]!), `paper/${theme}: ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(p['attention']!, p['attention-soft']!), `paper/${theme}: attention on its wash`).toBeGreaterThanOrEqual(4.5);
    }
    // The sheet reads as the brightest step: paper sits clearly above canvas.
    expect(luminance(light['paper']!)).toBeGreaterThan(luminance(light['canvas']!) * 1.1);
  });
});

describe('variantToCssVariables', () => {
  it('maps a color token onto every variable it drives', () => {
    const vars = variantToCssVariables({ colors: { paper: '#fafafa' } });
    expect(vars['--color-paper']).toBe('#fafafa');
    // Streamdown's shadcn mirrors must move with the palette or code blocks desync.
    expect(vars['--color-muted']).toBe('#fafafa');
    expect(vars['--color-sidebar']).toBe('#fafafa');
  });

  it('converts the shadow ink to the rgb triplet its consumers need', () => {
    expect(hexToRgbTriplet('#1c1917')).toBe('28 25 23');
    expect(hexToRgbTriplet('#abc')).toBe('170 187 204');
    expect(variantToCssVariables({ colors: { shadowInk: '#000000' } })['--kiki-shadow-ink'])
      .toBe('0 0 0');
  });

  it('emits shape tokens with their units', () => {
    const vars = variantToCssVariables({ shape: { radius: 14, stageGap: 6, spacing: 0.22 } });
    expect(vars['--kiki-sheet-radius']).toBe('14px');
    expect(vars['--kiki-stage-gap']).toBe('6px');
    expect(vars['--spacing']).toBe('0.22rem');
  });

  it('lets a tweak beat the skin and derives the accent companions', () => {
    const vars = variantToCssVariables(
      { colors: { accent: '#111111', accentDeep: '#000000' } },
      { accent: '#ff0000' },
    );
    expect(vars['--color-accent']).toBe('#ff0000');
    expect(vars['--color-accent-deep']).toContain('#ff0000');
    expect(vars['--color-accent-soft']).toContain('#ff0000');
  });

  it('produces nothing for a null variant with no tweaks', () => {
    expect(variantToCssVariables(null)).toEqual({});
  });
});

describe('applySkinVariables', () => {
  it('clears the previous skin before writing the next one', () => {
    applySkinVariables(document.documentElement, { '--color-paper': '#111111' });
    expect(document.documentElement.style.getPropertyValue('--color-paper')).toBe('#111111');

    applySkinVariables(document.documentElement, { '--color-ink': '#eeeeee' });
    expect(document.documentElement.style.getPropertyValue('--color-paper')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--color-ink')).toBe('#eeeeee');
  });

  it('owns every variable it can write, so a revert is exact', () => {
    const owned = allSkinVariables();
    expect(owned).toContain('--color-paper');
    expect(owned).toContain('--font-sans');
    expect(owned).toContain('--spacing');
    expect(owned).toContain('--kiki-shadow-ink');
  });
});

describe('skinVariablesFor', () => {
  it('follows the resolved theme for a dual-variant skin', () => {
    const prefs = { selection: { source: 'builtin' as const, id: 'slate' }, tweaks: {} };
    const light = skinVariablesFor(prefs, 'light');
    const dark = skinVariablesFor(prefs, 'dark');
    expect(light['--color-paper']).toBe('#f3f5f7');
    expect(dark['--color-paper']).toBe('#14181e');
  });

  it('applies a dark-only skin in light mode rather than inventing a light variant', () => {
    const prefs = { selection: { source: 'builtin' as const, id: 'nocturne' }, tweaks: {} };
    // Its single variant is the only thing the author approved, so it is what
    // both themes get; the settings UI says the skin is dark-only.
    expect(skinVariablesFor(prefs, 'light')['--color-paper']).toBe('#12111f');
    expect(skinVariablesFor(prefs, 'dark')['--color-paper']).toBe('#12111f');
  });

  it('falls back to the base palette for a selection that cannot be resolved', () => {
    const prefs = { selection: { source: 'user' as const, id: 'gone' }, tweaks: {} };
    expect(skinVariablesFor(prefs, 'dark')).toEqual({});
  });

  it('keeps the tweaks when the skin itself is missing', () => {
    const prefs = { selection: { source: 'user' as const, id: 'gone' }, tweaks: { accent: '#00ff00' } };
    expect(skinVariablesFor(prefs, 'dark')['--color-accent']).toBe('#00ff00');
  });
});

describe('skin prefs storage', () => {
  it('defaults to the built-in Paper skin', () => {
    expect(readSkinPrefs()).toEqual({
      selection: { source: 'builtin', id: DEFAULT_SKIN_ID },
      tweaks: {},
    });
  });

  it('round-trips a selection and tweaks', () => {
    writeSkinPrefs({ selection: { source: 'user', id: 'ocean' }, tweaks: { radius: 4 } });
    expect(readSkinPrefs()).toEqual({
      selection: { source: 'user', id: 'ocean' },
      tweaks: { radius: 4 },
    });
  });

  it('rejects stored values that would smuggle CSS or escape the range', () => {
    expect(normalizeSkinPrefs({
      selection: { source: 'builtin', id: '../../evil' },
      tweaks: { accent: 'red; background: url(x)', fontSans: 'a{}', radius: 9999, spacing: 40 },
    })).toEqual({ selection: { source: 'builtin', id: DEFAULT_SKIN_ID }, tweaks: {} });
  });

  it('ignores a malformed stored blob entirely', () => {
    localStorage.setItem('kiki.skin', 'not json');
    expect(readSkinPrefs().selection.id).toBe(DEFAULT_SKIN_ID);
  });
});

describe('user skin catalog', () => {
  const ocean = {
    kind: 'kiki-skin' as const,
    version: 1 as const,
    id: 'ocean',
    name: 'Ocean',
    variants: { dark: { colors: { paper: '#001122' } } },
  };

  it('resolves a user selection only once the file is loaded', () => {
    expect(resolveSkin({ source: 'user', id: 'ocean' })).toBeNull();
    setUserSkins([ocean], '/home/u/.kiki/themes');
    expect(resolveSkin({ source: 'user', id: 'ocean' })?.name).toBe('Ocean');
  });

  it('never resolves a user id to a same-named built-in', () => {
    setUserSkins([], null);
    expect(resolveSkin({ source: 'user', id: 'slate' })).toBeNull();
    expect(resolveSkin({ source: 'builtin', id: 'slate' })?.name).toBe('Slate');
  });

  it('writes the selected user skin to the paint cache', () => {
    writeSkinPrefs({ selection: { source: 'user', id: 'ocean' }, tweaks: {} });
    setUserSkins([ocean], '/themes');
    expect(JSON.parse(localStorage.getItem('kiki.skin.cache')!).id).toBe('ocean');
  });

  it('paints a cached user skin before the catalog request lands', () => {
    // A fresh document: prefs and cache on disk, catalog not fetched yet.
    localStorage.setItem('kiki.skin', JSON.stringify({
      selection: { source: 'user', id: 'ocean' },
      tweaks: {},
    }));
    localStorage.setItem('kiki.skin.cache', JSON.stringify(ocean));
    clearSelectedSkinCache();
    localStorage.setItem('kiki.skin.cache', JSON.stringify(ocean));

    expect(resolveSkin({ source: 'user', id: 'ocean' })?.name).toBe('Ocean');
    expect(skinVariablesFor(readSkinPrefs(), 'dark')['--color-paper']).toBe('#001122');
  });

  it('drops the cache when the selected file is gone from the server', () => {
    writeSkinPrefs({ selection: { source: 'user', id: 'ocean' }, tweaks: {} });
    setUserSkins([ocean], '/themes');
    expect(resolveSkin({ source: 'user', id: 'ocean' })).not.toBeNull();

    // The user deleted the file; the catalog comes back without it.
    setUserSkins([], '/themes');
    expect(resolveSkin({ source: 'user', id: 'ocean' })).toBeNull();
    expect(localStorage.getItem('kiki.skin.cache')).toBeNull();
  });

  it('refuses a tampered cache entry', () => {
    writeSkinPrefs({ selection: { source: 'user', id: 'evil' }, tweaks: {} });
    clearSelectedSkinCache();
    localStorage.setItem('kiki.skin.cache', JSON.stringify({
      kind: 'kiki-skin',
      version: 1,
      id: 'evil',
      name: 'Evil',
      css: 'body { display: none }',
      variants: { dark: { colors: { paper: '#000000' } } },
    }));
    expect(resolveSkin({ source: 'user', id: 'evil' })).toBeNull();
  });
});

describe('startSkinSync', () => {
  it('applies the stored skin and follows a theme flip', () => {
    writeSettings({ theme: 'light' });
    writeSkinPrefs({ selection: { source: 'builtin', id: 'slate' }, tweaks: {} });

    const stop = startSkinSync();
    expect(document.documentElement.style.getPropertyValue('--color-paper')).toBe('#f3f5f7');
    expect(document.documentElement.dataset['skin']).toBe('slate');

    writeSettings({ theme: 'dark' });
    applyTheme('dark');
    expect(document.documentElement.style.getPropertyValue('--color-paper')).toBe('#14181e');
    stop();
  });

  it('repaints on a live preview and drops it again', () => {
    writeSettings({ theme: 'light' });
    writeSkinPrefs({ selection: { source: 'builtin', id: DEFAULT_SKIN_ID }, tweaks: {} });
    const stop = startSkinSync();
    setSkinPreview({
      selection: { source: 'builtin', id: DEFAULT_SKIN_ID },
      tweaks: { accent: '#ff0000' },
    });
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#ff0000');

    // Dropping the preview falls back to the stored skin — here the default
    // palette, which sets no inline accent at all.
    setSkinPreview(null);
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('');
    stop();
  });

  it('never leaves a preview in storage', () => {
    setSkinPreview({
      selection: { source: 'builtin', id: 'slate' },
      tweaks: { accent: '#ff0000' },
    });
    expect(readSkinPrefs().tweaks).toEqual({});
  });

  it('stops applying after teardown', () => {
    writeSettings({ theme: 'light' });
    const stop = startSkinSync();
    stop();
    applySkinVariables(document.documentElement, {});
    writeSkinPrefs({ selection: { source: 'builtin', id: 'slate' }, tweaks: {} });
    expect(document.documentElement.style.getPropertyValue('--color-paper')).toBe('');
  });

  it('clears data-skin when the selection cannot be resolved', () => {
    writeSkinPrefs({ selection: { source: 'user', id: 'gone' }, tweaks: {} });
    applyCurrentSkin();
    expect(document.documentElement.dataset['skin']).toBeUndefined();
  });
});

describe('buildSkinExport', () => {
  it('writes a resolved file, not a diff against the built-in', () => {
    const exported = buildSkinExport(
      { selection: { source: 'builtin', id: 'slate' }, tweaks: { accent: '#ff0000', radius: 4 } },
      'My Slate',
    );
    expect(exported.filename).toBe('my-slate.json');
    const file = JSON.parse(exported.json);
    expect(file.kind).toBe('kiki-skin');
    expect(file.id).toBe('my-slate');
    expect(file.name).toBe('My Slate');
    // The tweak is baked in, and the rest of Slate's tokens travel with it.
    expect(file.variants.light.colors.accent).toBe('#ff0000');
    expect(file.variants.light.colors.paper).toBe('#f3f5f7');
    expect(file.variants.dark.colors.accent).toBe('#ff0000');
    expect(file.variants.light.shape.radius).toBe(4);
  });

  it('exports the tweaks alone when the base skin is the default palette', () => {
    const file = JSON.parse(buildSkinExport(
      { selection: { source: 'builtin', id: DEFAULT_SKIN_ID }, tweaks: { accent: '#00ff00' } },
      'Mine',
    ).json);
    expect(file.variants.light.colors).toEqual({ accent: '#00ff00' });
    expect(file.variants.dark.colors).toEqual({ accent: '#00ff00' });
  });

  it('only exports the variants the source skin declares', () => {
    const file = JSON.parse(buildSkinExport(
      { selection: { source: 'builtin', id: 'nocturne' }, tweaks: {} },
      'Night',
    ).json);
    expect(Object.keys(file.variants)).toEqual(['dark']);
  });

  it('falls back to a usable id for a name that slugifies to nothing', () => {
    expect(buildSkinExport(
      { selection: { source: 'builtin', id: DEFAULT_SKIN_ID }, tweaks: {} },
      '///',
    ).filename).toBe('my-skin.json');
    expect(slugify('  Ocean Blue 2  ')).toBe('ocean-blue-2');
  });
});
