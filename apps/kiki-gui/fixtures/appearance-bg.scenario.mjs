/**
 * appearance-bg — backgrounds and appearance packs. The long transcript is
 * the scroll target (timeline over a picture or video); the shipped example
 * pack from docs/examples is served by scripts/fixture-appearance.mjs; one
 * plugin-contributed skin and one themes-folder skin exercise the picker's
 * origin labels.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import longTranscript from './long-transcript.scenario.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export default {
  ...longTranscript,
  appearancePacks: [join(REPO, 'docs', 'examples', 'appearance-packs', 'dusk-harbor')],
  skinsDirectory: '/home/fixture/.kiki/themes',
  skinFiles: {
    ocean: {
      kind: 'kiki-skin',
      version: 1,
      name: 'Ocean',
      description: 'A skin file from the themes folder.',
      variants: { light: { colors: { accent: '#0b6a8a' } }, dark: { colors: { accent: '#6cc4e0' } } },
    },
    'kiki-office:sea-glass': {
      kind: 'kiki-skin',
      version: 1,
      id: 'kiki-office:sea-glass',
      name: 'Sea Glass',
      description: 'A theme contributed by a plugin.',
      variants: { light: { colors: { paper: '#f2fbfa', accent: '#0f766e' } }, dark: { colors: { paper: '#08211f', accent: '#5eead4' } } },
      $plugin: { id: 'kiki-office', version: '1.2.0' },
    },
  },
};
