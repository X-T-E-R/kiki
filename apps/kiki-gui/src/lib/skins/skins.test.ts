// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPACE_PREFERENCES, type SpaceDetail } from '@kiki/protocol';
import type { KikiClient } from '../client';
import { clearSpaceAuthority, configureSpaceAuthority, configureSpacePreferencePorts } from '../spaceAuthority';
import { skinPrefsSnapshot } from './store';

import { translate } from '@kiki/session-core/i18n';
import { writeSettings } from '@kiki/session-core/settings';
import { configureSpaceStorage } from '@kiki/session-core/storage';

import {
  BUILTIN_SKINS,
  DEFAULT_SKIN_ID,
  allSkinVariables,
  applyCurrentSkin,
  applySkinVariables,
  buildSkinExport,
  builtinSkinDescriptionKey,
  builtinSkinNameKey,
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
  spaceTweaksOf,
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
  configureSpaceStorage(null);
  setSkinPreview(null);
  setUserSkins([], null);
  clearSelectedSkinCache();
  localStorage.clear();
  applySkinVariables(document.documentElement, {});
  delete document.documentElement.dataset['theme'];
  delete document.documentElement.dataset['skin'];
});

describe('built-in skins', () => {
  it('ships exactly six paired families with complete palettes and Inkstone as the default dark', () => {
    expect(BUILTIN_SKINS.map((skin) => skin.id)).toEqual(['paper', 'porcelain', 'celadon', 'apricot', 'iris', 'contrast']);
    for (const skin of BUILTIN_SKINS) {
      expect(declaredVariants(skin)).toEqual(['light', 'dark']);
      for (const mode of ['light', 'dark'] as const) {
        expect(Object.keys(skin.variants[mode]!.colors!)).toHaveLength(36);
      }
    }
    expect(findBuiltinSkin(DEFAULT_SKIN_ID)?.variants.dark?.colors?.paper).toBe('#1B2226');
  });

  it('gives every built-in a localized pair name and description in both locales', () => {
    for (const skin of BUILTIN_SKINS) {
      for (const key of [builtinSkinDescriptionKey(skin.id), builtinSkinNameKey(skin.id)]) {
        expect(key, skin.id).toBeDefined();
        expect(translate('en', key!), skin.id).not.toBe(key);
        expect(translate('zh', key!), skin.id).not.toBe(translate('en', key!));
      }
    }
    expect(builtinSkinDescriptionKey('ocean')).toBeUndefined();
    expect(builtinSkinDescriptionKey('toString')).toBeUndefined();
  });

  it('keeps shell text at AA on normal and hover grounds in both modes', () => {
    for (const skin of BUILTIN_SKINS) {
      for (const mode of ['light', 'dark'] as const) {
        const c = skin.variants[mode]!.colors!;
        for (const text of ['shellInk', 'shellInkStrong', 'shellInkSoft', 'shellDanger'] as const) {
          for (const ground of ['shell', 'shellHover'] as const) {
            expect(contrast(c[text]!, c[ground]!), `${skin.id}/${mode}/${text}/${ground}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    }
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

  it('holds High contrast to its promise: AAA text, borders you can see, no hue-only signal', () => {
    const skin = findBuiltinSkin('contrast')!;
    for (const theme of ['light', 'dark'] as const) {
      const c = skin.variants[theme]!.colors!;
      for (const surface of ['canvas', 'paper', 'panel'] as const) {
        for (const text of ['ink', 'inkSoft', 'inkFaint'] as const) {
          expect(contrast(c[text]!, c[surface]!), `contrast/${theme}: ${text} on ${surface}`).toBeGreaterThanOrEqual(7);
        }
        // WCAG 1.4.11: a border is a component boundary and needs 3:1.
        expect(contrast(c.hairline!, c[surface]!), `contrast/${theme}: hairline on ${surface}`).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(c.selectedInk!, c.selected!), `contrast/${theme}: selected row`).toBeGreaterThanOrEqual(7);
    }
  });

  it('gives every new skin its own hue, not a near copy of another', () => {
    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
      const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
      if (d === 0) return 0;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const accents = BUILTIN_SKINS.filter((s) => s.id !== 'contrast' && s.id !== DEFAULT_SKIN_ID)
      .map((s) => ({ id: s.id, h: hue((s.variants.dark ?? s.variants.light)!.colors!.accent!) }));
    for (const [i, a] of accents.entries()) {
      for (const b of accents.slice(i + 1)) {
        const gap = Math.min(Math.abs(a.h - b.h), 360 - Math.abs(a.h - b.h));
        expect(gap, `${a.id} vs ${b.id} accent hue`).toBeGreaterThanOrEqual(20);
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
    const prefs = { selection: { source: 'builtin' as const, id: 'porcelain' }, tweaks: {} };
    const light = skinVariablesFor(prefs, 'light');
    const dark = skinVariablesFor(prefs, 'dark');
    expect(light['--color-paper']).toBe('#F8FBFF');
    expect(dark['--color-paper']).toBe('#152238');
  });

  it('applies a dark-only user skin in both modes without inventing a variant', () => {
    setUserSkins([{ kind: 'kiki-skin', version: 1, id: 'midnight', name: 'Midnight', variants: { dark: { colors: { paper: '#001122' } } } }], '/themes');
    const prefs = { selection: { source: 'user' as const, id: 'midnight' }, tweaks: {} };
    expect(skinVariablesFor(prefs, 'light')['--color-paper']).toBe('#001122');
    expect(skinVariablesFor(prefs, 'dark')['--color-paper']).toBe('#001122');
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

  it('migrates all eight retired built-ins on boot, preserving tweaks and brightness', () => {
    for (const id of ['linen', 'graphite', 'forest', 'claret', 'heather', 'nocturne', 'sand', 'slate']) {
      expect(findBuiltinSkin(id), id).toBeUndefined();
      localStorage.setItem('kiki.skin', JSON.stringify({ selection: { source: 'builtin', id }, tweaks: { accent: '#0b6e87', radius: 6 } }));
      clearSelectedSkinCache();
      expect(readSkinPrefs(), id).toEqual({
        selection: { source: 'builtin', id: DEFAULT_SKIN_ID },
        tweaks: { accent: '#0b6e87', radius: 6 },
      });
      expect(skinVariablesFor(readSkinPrefs(), 'light')['--color-paper']).toBe('#FBFAF6');
      expect(skinVariablesFor(readSkinPrefs(), 'dark')['--color-paper']).toBe('#1B2226');
    }
  });

  it('paints retired choices as Paper or Inkstone in main and desktop space storage', () => {
    for (const space of [null, { homeId: 'example-space' }]) {
      configureSpaceStorage(space);
      for (const mode of ['light', 'dark'] as const) {
        writeSettings({ theme: mode });
        writeSkinPrefs({ selection: { source: 'builtin', id: 'nocturne' }, tweaks: {} });
        applyCurrentSkin();
        expect(readSkinPrefs().selection.id).toBe(DEFAULT_SKIN_ID);
        expect(document.documentElement.dataset['skin']).toBe(DEFAULT_SKIN_ID);
        expect(document.documentElement.style.getPropertyValue('--color-paper')).toBe(mode === 'light' ? '#FBFAF6' : '#1B2226');
      }
    }
  });

  it('only retires built-ins: a user or pack skin that happens to be named slate is kept', () => {
    expect(normalizeSkinPrefs({ selection: { source: 'user', id: 'slate' } }).selection).toEqual({ source: 'user', id: 'slate' });
    expect(normalizeSkinPrefs({ selection: { source: 'pack', id: 'sand' } }).selection).toEqual({ source: 'pack', id: 'sand' });
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
    expect(resolveSkin({ source: 'user', id: 'porcelain' })).toBeNull();
    expect(resolveSkin({ source: 'builtin', id: 'porcelain' })?.name).toBe('瓷白 Porcelain × 深海 Deepwater');
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
    writeSkinPrefs({ selection: { source: 'builtin', id: 'porcelain' }, tweaks: {} });

    const stop = startSkinSync();
    expect(document.documentElement.style.getPropertyValue('--color-paper')).toBe('#F8FBFF');
    expect(document.documentElement.dataset['skin']).toBe('porcelain');

    writeSettings({ theme: 'dark' });
    applyTheme('dark');
    expect(document.documentElement.style.getPropertyValue('--color-paper')).toBe('#152238');
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

    // Dropping the preview restores the stored default palette exactly.
    setSkinPreview(null);
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#C8401A');
    stop();
  });

  it('never leaves a preview in storage', () => {
    setSkinPreview({
      selection: { source: 'builtin', id: 'porcelain' },
      tweaks: { accent: '#ff0000' },
    });
    expect(readSkinPrefs().tweaks).toEqual({});
  });

  it('stops applying after teardown', () => {
    writeSettings({ theme: 'light' });
    const stop = startSkinSync();
    stop();
    applySkinVariables(document.documentElement, {});
    writeSkinPrefs({ selection: { source: 'builtin', id: 'porcelain' }, tweaks: {} });
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
      { selection: { source: 'builtin', id: 'porcelain' }, tweaks: { accent: '#ff0000', radius: 4 } },
      'My Porcelain',
    );
    expect(exported.filename).toBe('my-porcelain.json');
    const file = JSON.parse(exported.json);
    expect(file.kind).toBe('kiki-skin');
    expect(file.id).toBe('my-porcelain');
    expect(file.name).toBe('My Porcelain');
    // The tweak is baked in, and the rest of Porcelain's tokens travel with it.
    expect(file.variants.light.colors.accent).toBe('#ff0000');
    expect(file.variants.light.colors.paper).toBe('#F8FBFF');
    expect(file.variants.dark.colors.accent).toBe('#ff0000');
    expect(file.variants.light.shape.radius).toBe(4);
  });

  it('exports the complete default pair with tweaks baked in', () => {
    const file = JSON.parse(buildSkinExport(
      { selection: { source: 'builtin', id: DEFAULT_SKIN_ID }, tweaks: { accent: '#00ff00' } },
      'Mine',
    ).json);
    for (const mode of ['light', 'dark'] as const) {
      expect(file.variants[mode].colors).toEqual({ ...findBuiltinSkin(DEFAULT_SKIN_ID)!.variants[mode]!.colors, accent: '#00ff00' });
    }
  });

  it('only exports the variants a user skin declares', () => {
    setUserSkins([{ kind: 'kiki-skin', version: 1, id: 'midnight', name: 'Midnight', variants: { dark: { colors: { paper: '#001122' } } } }], '/themes');
    const file = JSON.parse(buildSkinExport(
      { selection: { source: 'user', id: 'midnight' }, tweaks: {} },
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

describe('tweaks as a space value', () => {
  // The protocol carries the density as a multiple of the stylesheet's step,
  // not as the rem value the sheet uses, so the three densities this GUI
  // offers (compact 0.22rem, default 0.25rem, roomy 0.29rem) travel as the
  // multiples 0.88 / 1 / 1.16 and read back as those same rem values.
  it('sends the density as a multiple of the stylesheet step', () => {
    expect(spaceTweaksOf({ spacing: 0.22 }).spacing).toBe(0.88);
    expect(spaceTweaksOf({ spacing: 0.25 }).spacing).toBe(1);
    expect(spaceTweaksOf({ spacing: 0.29 }).spacing).toBe(1.16);
  });

  it('passes the rest of the tweaks through unchanged', () => {
    expect(spaceTweaksOf({ accent: '#0b6e87', fontSans: 'Georgia, serif', radius: 6, spacing: 0.25 }))
      .toEqual({ accent: '#0b6e87', fontSans: 'Georgia, serif', radius: 6, spacing: 1 });
  });
});

describe('server spacing consumption', () => {
  const identity = { serverId: 'server-a', homeId: 'main' };
  function detail(spacing?: number): SpaceDetail {
    return {
      schema: 2, id: 'main', name: 'Main', primary: true, revision: 'r1',
      inherit: { config: true, agents: true, instructions: true, skills: true, mcp: true, appearance: true, plugins: false, credentials: 'shared', generic_roots: true },
      groups: [], items: [], preferences: { ...DEFAULT_SPACE_PREFERENCES, tweaks: spacing === undefined ? {} : { spacing } },
      preference_authority: true, restart_required: false,
    };
  }
  afterEach(() => {
    clearSpaceAuthority();
    configureSpacePreferencePorts(undefined);
  });

  it.each([[0.5, 0.125], [1, 0.25], [2, 0.5]])('renders wire density %s as %srem and preserves it in an ordinary tweak save', async (wire, rem) => {
    localStorage.setItem('kiki.skin', JSON.stringify({ selection: { source: 'builtin', id: 'paper' }, tweaks: { spacing: 0.22 } }));
    configureSpaceAuthority(identity, detail(wire));
    const stop = startSkinSync();
    try {
      expect(skinPrefsSnapshot().tweaks.spacing).toBe(rem);
      expect(document.documentElement.style.getPropertyValue('--spacing')).toBe(`${rem}rem`);
      expect(spaceTweaksOf(skinPrefsSnapshot().tweaks).spacing).toBe(wire);
      const preview = vi.fn().mockResolvedValue({ token: 't', rows: [{ id: 'pref:skin' }, { id: 'pref:tweaks' }] });
      const client = { klient: { rest: { homes: { preview, apply: vi.fn().mockResolvedValue({ detail: detail(wire) }) } } } } as unknown as KikiClient;
      configureSpacePreferencePorts({ client: () => client, identity: () => identity, spaceId: () => 'main' });
      writeSkinPrefs({ tweaks: { ...skinPrefsSnapshot().tweaks, radius: 6 } });
      await Promise.resolve();
      await Promise.resolve();
      expect(preview).toHaveBeenCalledWith('main', { action: 'edit', changes: [{ id: 'pref:tweaks', value: { spacing: wire, radius: 6 } }] });
      expect(readSkinPrefs().tweaks.spacing).toBe(0.22);
      configureSpaceAuthority(identity, detail());
      expect(skinPrefsSnapshot().tweaks.spacing).toBeUndefined();
      expect(document.documentElement.style.getPropertyValue('--spacing')).toBe('');
    } finally {
      stop();
    }
  });

  it('keeps legacy device/file spacing validation separate from the space wire range', () => {
    for (const spacing of [0.125, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizeSkinPrefs({ tweaks: { spacing } }).tweaks.spacing).toBeUndefined();
    }
    for (const spacing of [0.19, 0.22, 0.25, 0.29, 0.33]) {
      expect(normalizeSkinPrefs({ tweaks: { spacing } }).tweaks.spacing).toBe(spacing);
    }
  });
});
