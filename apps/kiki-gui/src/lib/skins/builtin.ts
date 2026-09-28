/**
 * Built-in skins. One source of truth: the same declarative shape a user file
 * in `~/.kiki/themes/` uses, so a built-in skin and a user skin travel through
 * exactly the same resolve/apply path (`lib/skins/apply.ts`).
 *
 * Design intent per skin lives in its `description`; the palettes were checked
 * for WCAG AA on every step of the surface ladder (canvas / paper / panel)
 * before landing — see `skins.test.ts`, which re-checks it on every run.
 *
 * `paper` is special: it is the product's own identity and carries no colors
 * here. Its values are the `@theme` defaults in `index.css`, so the default
 * skin is literally "apply nothing" and the shell owner stays the single
 * author of the base palette.
 */

import type { SkinFile } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

/** The skin id that means "the base palette in index.css". */
export const DEFAULT_SKIN_ID = 'paper';

const FONT_SANS_NEUTRAL =
  "'Instrument Sans Variable', 'Instrument Sans', ui-sans-serif, system-ui, 'Segoe UI', 'PingFang SC', 'Noto Sans SC', sans-serif";
const FONT_DISPLAY_NEUTRAL =
  "'Instrument Sans Variable', 'Instrument Sans', ui-sans-serif, system-ui, 'Segoe UI', 'PingFang SC', 'Noto Sans SC', sans-serif";

export const BUILTIN_SKINS: readonly SkinFile[] = [
  {
    kind: 'kiki-skin',
    version: 1,
    id: DEFAULT_SKIN_ID,
    name: 'Paper',
    description: 'Warm paper and ink with a rust accent. Kiki\'s own voice.',
    variants: { light: {}, dark: {} },
  },
  {
    kind: 'kiki-skin',
    version: 1,
    id: 'slate',
    name: 'Slate',
    description:
      'Cool neutral greys with an ink-blue accent. Quieter than Paper: the chrome recedes and code is the only warm thing on screen.',
    variants: {
      light: {
        colors: {
          canvas: '#e7eaee',
          paper: '#f3f5f7',
          panel: '#fbfcfd',
          hairline: '#dde1e6',
          hairlineStrong: '#c2c8d1',
          ink: '#161a20',
          inkSoft: '#474d57',
          inkFaint: '#5f6671',
          accent: '#1d4ed8',
          accentDeep: '#1e3a8a',
          accentSoft: '#dde6fa',
          onAccent: '#ffffff',
          amberInk: '#8a4b09',
          amberCard: '#fbeed7',
          amberRule: '#c47f16',
          success: '#15703c',
          danger: '#b3261e',
          onDanger: '#ffffff',
          bubbleUser: '#e9edf2',
          scrollbar: '#ccd2da',
          scrollbarHover: '#b0b8c3',
          termScrollbar: '#3c424c',
          shell: '#1b1e24',
          shellInk: '#d6dae1',
          shellInkStrong: '#f0f2f5',
          shellInkSoft: '#8b929d',
          shellDanger: '#f0a39c',
          shellHairline: '#343943',
          shellHover: '#262b33',
          shadowInk: '#151922',
        },
        fonts: { display: FONT_DISPLAY_NEUTRAL, sans: FONT_SANS_NEUTRAL },
      },
      dark: {
        colors: {
          canvas: '#0e1116',
          paper: '#14181e',
          panel: '#1b2028',
          hairline: '#262c36',
          hairlineStrong: '#39414d',
          ink: '#e8ecf2',
          inkSoft: '#a8b1bd',
          inkFaint: '#8a939f',
          accent: '#7aa7ff',
          accentDeep: '#a6c4ff',
          accentSoft: '#172236',
          onAccent: '#0b1526',
          amberInk: '#e8b055',
          amberCard: '#2a2113',
          amberRule: '#7c5c22',
          success: '#6fce8c',
          danger: '#f58e86',
          onDanger: '#240705',
          bubbleUser: '#1e242d',
          scrollbar: '#333a45',
          scrollbarHover: '#454e5c',
          termScrollbar: '#454e5c',
          shell: '#090b0f',
          shellInk: '#ced5df',
          shellInkStrong: '#eef1f5',
          shellInkSoft: '#858d99',
          shellDanger: '#f0a39c',
          shellHairline: '#1e242d',
          shellHover: '#161b22',
          shadowInk: '#000000',
        },
        fonts: { display: FONT_DISPLAY_NEUTRAL, sans: FONT_SANS_NEUTRAL },
      },
    },
  },
  {
    kind: 'kiki-skin',
    version: 1,
    id: 'contrast',
    name: 'High contrast',
    description:
      'Maximum legibility: pure white or pure black ground, visible borders instead of implied ones, and text at AAA on every surface.',
    variants: {
      light: {
        colors: {
          canvas: '#e4e6e8',
          paper: '#ffffff',
          panel: '#ffffff',
          hairline: '#a8adb4',
          hairlineStrong: '#63696f',
          ink: '#000000',
          inkSoft: '#2b2f33',
          inkFaint: '#45494e',
          accent: '#0b4fc7',
          accentDeep: '#042f85',
          accentSoft: '#dce7fb',
          onAccent: '#ffffff',
          amberInk: '#6b3d00',
          amberCard: '#fbeecb',
          amberRule: '#8a5a00',
          success: '#0a6129',
          danger: '#a41710',
          onDanger: '#ffffff',
          bubbleUser: '#eef0f2',
          scrollbar: '#9aa0a6',
          scrollbarHover: '#6b7075',
          termScrollbar: '#6b7075',
          shell: '#000000',
          shellInk: '#e6e6e6',
          shellInkStrong: '#ffffff',
          shellInkSoft: '#a8a8a8',
          shellDanger: '#ff9d94',
          shellHairline: '#4d4d4d',
          shellHover: '#1f1f1f',
          shadowInk: '#000000',
        },
        fonts: { display: FONT_DISPLAY_NEUTRAL, sans: FONT_SANS_NEUTRAL },
      },
      dark: {
        colors: {
          canvas: '#000000',
          paper: '#0b0b0c',
          panel: '#17181a',
          hairline: '#4d5054',
          hairlineStrong: '#8b8f94',
          ink: '#ffffff',
          inkSoft: '#e2e4e7',
          inkFaint: '#bcbfc4',
          accent: '#8fb8ff',
          accentDeep: '#bcd4ff',
          accentSoft: '#0d1c31',
          onAccent: '#00102b',
          amberInk: '#ffc94d',
          amberCard: '#2b2000',
          amberRule: '#9c7500',
          success: '#63e089',
          danger: '#ff948b',
          onDanger: '#2b0603',
          bubbleUser: '#1b1c1f',
          scrollbar: '#55585c',
          scrollbarHover: '#7a7e83',
          termScrollbar: '#7a7e83',
          shell: '#000000',
          shellInk: '#e6e6e6',
          shellInkStrong: '#ffffff',
          shellInkSoft: '#a8a8a8',
          shellDanger: '#ff9d94',
          shellHairline: '#4d4d4d',
          shellHover: '#1f1f1f',
          shadowInk: '#000000',
        },
        fonts: { display: FONT_DISPLAY_NEUTRAL, sans: FONT_SANS_NEUTRAL },
      },
    },
  },
  {
    kind: 'kiki-skin',
    version: 1,
    id: 'nocturne',
    name: 'Nocturne',
    description:
      'Dark only, on purpose. Deep indigo paper with a mint accent — a late-session room where the transcript glows and nothing else does.',
    variants: {
      dark: {
        colors: {
          canvas: '#0a0912',
          paper: '#12111f',
          panel: '#1a1930',
          hairline: '#272546',
          hairlineStrong: '#3b3868',
          ink: '#e8e5f6',
          inkSoft: '#b2add2',
          inkFaint: '#918cb4',
          accent: '#5fd6c3',
          accentDeep: '#8ce7d8',
          accentSoft: '#0f2f2c',
          onAccent: '#042019',
          amberInk: '#e9b44c',
          amberCard: '#2a2213',
          amberRule: '#7a5c22',
          success: '#6fd58f',
          danger: '#ff8a93',
          onDanger: '#26060c',
          bubbleUser: '#1c1a33',
          scrollbar: '#2f2c54',
          scrollbarHover: '#413d70',
          termScrollbar: '#413d70',
          shell: '#07060f',
          shellInk: '#d8d4ee',
          shellInkStrong: '#f2f0ff',
          shellInkSoft: '#8f89b4',
          shellDanger: '#ff9ea6',
          shellHairline: '#1e1c38',
          shellHover: '#17152b',
          shadowInk: '#000000',
        },
        shape: { radius: 14 },
      },
    },
  },
];

export function findBuiltinSkin(id: string): SkinFile | undefined {
  return BUILTIN_SKINS.find((skin) => skin.id === id);
}

/**
 * Localized descriptions for the built-in skins. The English `description`
 * above stays on the skin itself (it travels into exported skin files); the
 * picker shows this key instead. User skins have no key and show their own text.
 */
export const BUILTIN_SKIN_DESCRIPTION_KEYS = {
  paper: 'st.skin.desc.paper',
  slate: 'st.skin.desc.slate',
  contrast: 'st.skin.desc.contrast',
  nocturne: 'st.skin.desc.nocturne',
} as const satisfies Readonly<Record<string, I18nKey>>;

export function builtinSkinDescriptionKey(id: string | undefined): I18nKey | undefined {
  return id !== undefined && Object.hasOwn(BUILTIN_SKIN_DESCRIPTION_KEYS, id)
    ? BUILTIN_SKIN_DESCRIPTION_KEYS[id as keyof typeof BUILTIN_SKIN_DESCRIPTION_KEYS]
    : undefined;
}
