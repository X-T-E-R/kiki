/**
 * settings-appearance — the Appearance settings leaf and the shared settings
 * shell. Reuses the skins fixture (user skin files, skipped files, a seeded
 * session) and the settings fixture's config, so the page shows user skins
 * next to built-ins and draft-bearing leaves have real server values.
 */

import settings from './settings.scenario.mjs';
import skins from './skins.scenario.mjs';

export default {
  ...settings,
  skinFiles: skins.skinFiles,
  skinsDirectory: skins.skinsDirectory,
};
