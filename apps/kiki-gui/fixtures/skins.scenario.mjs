/**
 * skins — the external skin path.
 *
 * Seeds two user skin files the way a real `<KIKI_HOME>/themes/` directory
 * would hold them, plus the two kinds of file that must be skipped: a TUI
 * color theme (same directory, different format) and one carrying raw CSS.
 * The GUI's appearance page should list exactly the two valid skins, report
 * the two skips, and apply a skin the moment it is picked.
 *
 * No prompt script: the point is the settings surface and the palette, not a
 * turn.
 */

import { sessionRecord, userMsg, assistantMsg } from './helpers.mjs';
// The /usage page is one of the four surfaces each skin is checked on, so it
// needs real numbers; reuse the dashboard scenario's seed rather than a second
// copy that would drift.
import { usageV2 } from './usage-dashboard.scenario.mjs';

const SID = 'session_fixture_skins';

/** A full dual-variant skin: deliberately unlike any built-in, so a screenshot proves it applied. */
const OCEAN = {
  kind: 'kiki-skin',
  version: 1,
  id: 'ocean',
  name: 'Ocean',
  description: 'Fixture skin: deep teal paper with a coral accent.',
  author: 'fixtures',
  variants: {
    light: {
      colors: {
        canvas: '#dbe9ea',
        paper: '#eef5f5',
        panel: '#f9fcfc',
        hairline: '#cfe0e1',
        hairlineStrong: '#a8c3c5',
        ink: '#0f2224',
        inkSoft: '#3d5457',
        inkFaint: '#556c6f',
        accent: '#b23a48',
        accentDeep: '#8c2733',
        accentSoft: '#f7e2e4',
        onAccent: '#ffffff',
        amberInk: '#7d4a08',
        amberCard: '#f8eed8',
        amberRule: '#bd8420',
        success: '#0f6b46',
        danger: '#a82015',
        onDanger: '#ffffff',
        bubbleUser: '#e3eeee',
        scrollbar: '#bcd2d3',
        scrollbarHover: '#9bb6b8',
        shell: '#11282a',
        shellInk: '#cfe0e1',
        shellInkStrong: '#eef5f5',
        shellInkSoft: '#7d9a9d',
        shellHairline: '#1d3a3d',
        shellHover: '#183134',
        shadowInk: '#0f2224',
      },
    },
    dark: {
      colors: {
        canvas: '#06161a',
        paper: '#0b2126',
        panel: '#112c32',
        hairline: '#1b3b42',
        hairlineStrong: '#2b555e',
        ink: '#e2f0f1',
        inkSoft: '#a5c0c3',
        inkFaint: '#87a3a7',
        accent: '#ff8d7a',
        accentDeep: '#ffb0a1',
        accentSoft: '#33201c',
        onAccent: '#2b0a05',
        amberInk: '#e5b055',
        amberCard: '#2c2214',
        amberRule: '#7d5e23',
        success: '#6cd3a2',
        danger: '#ff9186',
        onDanger: '#2b0704',
        bubbleUser: '#123036',
        scrollbar: '#1f454d',
        scrollbarHover: '#2e5c66',
        shell: '#041013',
        shellInk: '#cfe0e1',
        shellInkStrong: '#eef5f5',
        shellInkSoft: '#7d9a9d',
        shellHairline: '#123036',
        shellHover: '#0e272c',
        shadowInk: '#000000',
      },
    },
  },
};

/** A single-variant skin, to exercise the "dark only" badge and notice. */
const MIDNIGHT = {
  kind: 'kiki-skin',
  version: 1,
  id: 'midnight',
  name: 'Midnight',
  description: 'Fixture skin: dark only, to exercise the single-variant notice.',
  variants: {
    dark: {
      colors: {
        canvas: '#08080c',
        paper: '#0f0f16',
        panel: '#16161f',
        hairline: '#22222e',
        hairlineStrong: '#34344a',
        ink: '#e6e6ef',
        inkSoft: '#a9a9bd',
        inkFaint: '#8a8a9e',
        accent: '#9d8cff',
        accentDeep: '#bcb0ff',
        accentSoft: '#1d1930',
        onAccent: '#0c0720',
        success: '#6fd58f',
        danger: '#ff8a93',
        onDanger: '#26060c',
      },
      fonts: { sans: "ui-sans-serif, system-ui, 'PingFang SC', 'Noto Sans SC', sans-serif" },
      shape: { radius: 6 },
    },
  },
};

/** A TUI color theme. Same directory, not a GUI skin — must be skipped. */
const EMBER_TUI_THEME = {
  name: 'ember',
  base: 'dark',
  colors: { primary: '#83A598', accent: '#FE8019' },
};

/** A skin that tries to smuggle CSS. The schema is closed, so it is skipped. */
const SNEAKY = {
  kind: 'kiki-skin',
  version: 1,
  id: 'sneaky',
  name: 'Sneaky',
  css: 'body { display: none }',
  variants: { light: { colors: { paper: '#ffffff' } } },
};

export default {
  models: [
    { id: 'fixture/model-a', display_name: 'Fixture A', provider_id: 'fixture', remote_id: 'model-a', max_context_size: 262144 },
  ],
  sessions: [
    sessionRecord(SID, {
      title: 'Appearance and skins',
      agent_config: { model: 'fixture/model-a' },
    }),
  ],
  snapshots: {
    [SID]: {
      messages: [
        userMsg(SID, 'Show me what the interface looks like under a different skin.', 8),
        assistantMsg(
          SID,
          [
            'A skin only moves design tokens — colors, type and shape. Here is a fenced block so you can see code surfaces move too:\n\n```ts\nexport const answer = 42;\n```\n\nAnd a list, to check text tones:\n\n- body text on paper\n- a muted secondary line\n- one `inline code` span',
          ],
          6,
        ),
      ],
    },
  },
  /**
   * Consumed by fixture-server.mjs's `/api/skins` routes: the files a themes
   * directory would hold, valid and invalid alike.
   */
  skinFiles: {
    ocean: OCEAN,
    midnight: MIDNIGHT,
    ember: EMBER_TUI_THEME,
    sneaky: SNEAKY,
  },
  skinsDirectory: '/home/fixture/.kiki/themes',
  usageV2,
};
