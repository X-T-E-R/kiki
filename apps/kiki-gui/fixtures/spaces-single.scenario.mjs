/**
 * spaces-single — an existing single-home user (scripts/fixture-spaces.mjs):
 *
 *   Only the main space is registered, so the sidebar wordmark is the one
 *   place that offers "New space…". Everything else matches `spaces`.
 */

import base from './spaces.scenario.mjs';

export default {
  ...base,
  spaces: { ...base.spaces, items: [], sshCandidates: [] },
};
