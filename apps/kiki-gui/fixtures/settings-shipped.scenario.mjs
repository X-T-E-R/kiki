/**
 * settings-shipped — shipped (built-in) profile management on the Subagents
 * settings leaf: the default subagent target card at the top, a managed
 * built-in copy with local modifications (status badge + restore-original),
 * and a removed managed copy restorable from its tombstone row.
 *
 * The managed copies are user-home files, so the catalog rows carry
 * source 'user' with source_file under agents/builtin/; the shipped list
 * matches them by that exact path.
 */

import base from './settings.scenario.mjs';

const WSID = 'wd_fixture_000000000000';

export default {
  ...base,
  agentProfiles: [
    ...base.agentProfiles,
    {
      name: 'general',
      source: 'user',
      workspace_id: WSID,
      source_file: 'C:/fixture/user/agents/builtin/general.md',
      description: 'Default subagent when a dispatch names no profile.',
      main: false,
      routes: [],
    },
  ],
  shippedAgentProfiles: [
    {
      template_id: 'agent',
      status: 'clean',
      managed: true,
      main: true,
      description: 'General-purpose built-in assistant.',
      active_path: 'C:/fixture/user/agents/builtin/agent.md',
    },
    {
      template_id: 'explore',
      status: 'clean',
      managed: true,
      main: false,
      description: 'Read-only codebase exploration agent.',
      active_path: 'C:/fixture/user/agents/builtin/explore.md',
    },
    {
      template_id: 'general',
      status: 'custom',
      managed: true,
      main: false,
      description: 'Default subagent when a dispatch names no profile.',
      active_path: 'C:/fixture/user/agents/builtin/general.md',
    },
    {
      template_id: 'plan',
      status: 'removed',
      managed: true,
      main: false,
      description: 'Planning subagent.',
    },
  ],
};
