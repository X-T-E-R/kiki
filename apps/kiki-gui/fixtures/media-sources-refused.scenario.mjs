/**
 * media-sources-refused — the save contract, under a host that refuses.
 *
 * Every other capture of this surface walks a host that accepts everything,
 * which is exactly why the save bug survived it: a form that reads its values
 * back instead of awaiting its write looks identical when every write lands.
 * This scenario makes the host refuse, so the states that matter are the ones
 * a reader reaches on a real server — a key that did not store, a switch that
 * did not move, a default that did not take.
 *
 * Two things stay true throughout, and both are asserted rather than assumed:
 *
 *  - a plain read still answers normally. The read is NOT the proof of a save,
 *    which is the whole point — a refused write followed by a successful GET
 *    is the case a read-back-as-proof cannot see;
 *  - the typed draft survives. A reader whose key did not store has to be
 *    able to press save again, and the value they typed has to still be there.
 *
 * Nothing here is simulated at the DOM: the refusals are the fixture's own
 * answers, through the same contract methods the happy path uses.
 */

import base from './media-sources-managed.scenario.mjs';

/**
 * The one source this walk uses, with a key that is missing so there is a
 * draft to lose, and a sibling that must not move.
 */
const refusal = {
  // Slow enough that a mid-flight read is a real observation on a loaded
  // machine, not a race this walk happens to win. The write is refused as
  // well, so the window shows "not saved yet" and then "not saved, and here
  // is why" — the two states a fast host collapses into one.
  xai: { refuseWrites: true, delayMs: 900 },
  stepfun: { refuseWrites: true },
  // A source whose write works, so the walk can show that a refusal is about
  // the source the reader pressed and not about the host being down.
  comfyui: {},
  openai: {},
  ark: {},
  novita: {},
  agnes: {},
  newapi: {},
  minimax: {},
  'local-renderer': {},
  'ark-alt': {},
  'retired-gateway': {},
};

export default {
  ...base,
  // The fixture reads this per source id, so a refusal is addressed to the
  // source it belongs to rather than applied to the whole page.
  mediaWriteBehaviour: refusal,
  // A second lever for the per-modality default, which lives on the media
  // package's own settings rather than on a source. It is keyed by package id,
  // and it is set for this walk only, so a reader can see what a refused
  // default looks like without any other package's settings being affected.
  pluginSettingsRefusals: {
    'kiki-media': { code: 40001, message: 'The media plugin refused this setting on this server.' },
  },
};
