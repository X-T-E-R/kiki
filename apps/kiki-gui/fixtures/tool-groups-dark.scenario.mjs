/**
 * tool-groups-dark — the capability fixture with the active home's own
 * appearance preference set to Paper after dark (Inkstone). The app reads
 * theme and skin from the home's preference authority, so this is the path a
 * real dark install takes; the walker checks that the palette really moved
 * instead of trusting the flag.
 */

import base from './tool-groups.scenario.mjs';

export default {
  ...base,
  spaces: {
    mainPrefs: { theme: 'dark' },
  },
};
