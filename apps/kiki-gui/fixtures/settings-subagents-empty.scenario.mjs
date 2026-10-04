/**
 * settings-subagents-empty — the same subagent leaf on a server that returns
 * no tool catalog, so the page's recoverable "no catalog" state is exercised
 * instead of a faked static tool list.
 */

import subagents from './settings-subagents.scenario.mjs';

export default {
  ...subagents,
  tools: [],
};
