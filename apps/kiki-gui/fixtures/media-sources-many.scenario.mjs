/**
 * media-sources-many — the media list at the size people actually reach.
 *
 * The user's own note: the configuration screen has to stay humane at a hundred
 * possible sources. This scenario proves that by being a hundred and four rows
 * that are *different from each other* — not one row copied a hundred times,
 * which would pass a list and fail a scan.
 *
 * The spread is deliberate:
 *
 *  - every modality, and a lot of providers that do more than one;
 *  - every status the list can show, in a realistic proportion (most are fine,
 *    a handful need a key, one failed to load, two are switched off);
 *  - names that collide in the obvious ways — "Atlas Image", "Atlas Video",
 *    "atlas-labs/image", so search has to be tested against both a label and a
 *    package id, and the two must not be confused for one row;
 *  - a long label and a long package id, because a row is one line and a
 *    hundred of them are a page of truncation.
 *
 * The point of the scale is what does *not* happen: no per-row request, no
 * hundred expanded cards, and no hundred settings documents read to draw a
 * hundred one-line rows. Opening this list is one `providers` call.
 */

import base from './media-sources.scenario.mjs';

/**
 * Vendors, spread so that both a label search and a package-id search have to
 * work, and so a reader scanning for "Atlas" finds a family rather than one
 * row.
 */
const VENDORS = [
  ['atlas-labs', 'Atlas', ['image', 'video', 'tts']],
  ['borealis', 'Borealis', ['image']],
  ['cinder', 'Cinder', ['video']],
  ['delta-works', 'Delta Works', ['image', 'tts']],
  ['everline', 'Everline', ['tts']],
  ['fjord', 'Fjord', ['image', 'video']],
  ['glasshouse', 'Glasshouse', ['image', 'video', 'tts']],
  ['halcyon', 'Halcyon', ['tts']],
  ['indigo-labs', 'Indigo Labs', ['image']],
  ['juniper', 'Juniper', ['video', 'tts']],
  ['kelvin', 'Kelvin', ['image']],
  ['lumen', 'Lumen', ['image', 'video', 'tts']],
  ['meridian', 'Meridian', ['tts']],
  ['northlight', 'Northlight', ['image', 'video']],
  ['obsidian', 'Obsidian', ['image']],
];

const ADAPTERS = {
  image: 'images',
  video: 'video',
  tts: 'speech',
};

const definition = (id, kinds, label, extra = {}) => ({ schemaVersion: 1, id, kinds, label, resumeVersion: 1, ...extra });

/**
 * How each generated row lands, by index. A hundred rows that are all "ready"
 * would prove nothing about scanning; a hundred that are all broken would
 * prove less. This is roughly what a real roster looks like: mostly working,
 * some unconfigured, a few dead.
 */
function stateFor(index) {
  if (index % 29 === 7) return 'broken';
  if (index % 17 === 3) return 'disabled';
  if (index % 7 === 2) return 'blocked';
  if (index % 5 === 4) return 'needs-config';
  if (index % 11 === 5) return 'self-managed';
  return 'ready';
}

const providers = [];
const settings = {};

let index = 0;
for (const [pluginId, label, kinds] of VENDORS) {
  for (const kind of kinds) {
    const state = stateFor(index);
    // A few names are deliberately long so truncation is visible in a
    // screenshot rather than theoretical.
    providers.push({
      provider: `${pluginId}/${ADAPTERS[kind]}`,
      definition: definition(ADAPTERS[kind], [kind], `${label} ${kind}`, { connectionSetting: state === 'self-managed' ? undefined : 'connectionId' }),
      // Recorded so the package row below can carry the long label, which is
      // what makes truncation visible instead of theoretical.
    });
    if (state === 'needs-config') {
      settings[pluginId] = {
        schema: { schema: { properties: { apiKey: { type: 'string', title: 'API key', secret: true } }, required: ['apiKey'] } },
        values: {},
        secretsConfigured: [],
      };
    } else if (state === 'ready' || state === 'blocked' || state === 'disabled') {
      settings[pluginId] = {
        schema: { schema: { properties: { connectionId: { type: 'string', title: 'Use a configured connection' } } } },
        values: { connectionId: pluginId },
        secretsConfigured: [],
      };
    }
    // `broken`, `disabled` and `self-managed` deliberately have no settings
    // document at all: a dead package cannot be configured, a switched-off one
    // has nothing to draw until it is on, and a script that manages its own
    // environment has no key for this GUI to hold.
    index += 1;
  }
}

// Extra rows so the list clears a hundred, drawn from the same families so a
// search for "Atlas" still returns a coherent group.
for (let extra = 0; providers.length < 104; extra += 1) {
  const [pluginId, label, kinds] = VENDORS[extra % VENDORS.length];
  const kind = kinds[extra % kinds.length];
  providers.push({
    provider: `${pluginId}-${extra}/${ADAPTERS[kind]}-eu`,
    definition: definition(`${ADAPTERS[kind]}-eu`, [kind], `${label} ${kind} EU`),
  });
}

const PLUGIN = (id, displayName, version, enabled, state, long = false) => ({
  id,
  // A quarter of the vendors carry a long name, so the scan has something to
  // truncate and the eye has something to compare against.
  displayName: long ? `${displayName} — production endpoint (eu-west)` : displayName,
  version,
  enabled,
  state,
  hasErrors: state === 'error',
  skillCount: 0,
  mcpServerCount: 0,
  enabledMcpServerCount: 0,
  hookCount: 0,
  commandCount: 0,
  source: 'github',
});

/**
 * One package per provider id, with the health the list has to show.
 *
 * Every thirteen or so rows carry a long label on purpose: a hundred rows are
 * one line each, and truncation is the thing that has to look right, not
 * something to assume.
 */
const plugins = [
  ...VENDORS.map(([pluginId, label], vendorIndex) =>
    PLUGIN(pluginId, label, `1.${vendorIndex}.0`, stateFor(vendorIndex * 3) !== 'disabled',
      stateFor(vendorIndex * 5) === 'broken' ? 'error' : 'ok', vendorIndex % 3 === 0)),
  // The extra EU packages, so the rows added past a hundred are real rows and
  // not a second page of "did not load".
  ...Array.from({ length: 104 - VENDORS.length }, (_, extra) => {
    const [pluginId, label] = VENDORS[extra % VENDORS.length];
    return PLUGIN(`${pluginId}-${extra}`, `${label} EU`, '2.0.0', stateFor(extra) !== 'disabled',
      stateFor(extra + 3) === 'broken' ? 'error' : 'ok');
  }),
];

export default {
  ...base,
  // The plugin list is what tells the media list whether each provider's
  // package is installed and healthy. Seeding only the providers would make
  // every row read "the plugin did not load" — honest, and useless at scale.
  plugins,
  mediaProviders: providers,
  mediaSettings: settings,
  mediaJobs: [
    // The jobs a hundred-row list still has to render honestly underneath it.
    base.mediaJobs[0],
    base.mediaJobs[4],
    base.mediaJobs[5],
  ],
};
