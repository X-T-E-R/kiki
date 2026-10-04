/**
 * spaces — the multi-home slice (scripts/fixture-spaces.mjs):
 *
 *   Main space with two registered spaces: "ACME confidential" (shared
 *   accounts, running, 2 pending approvals, its own default model and title
 *   model) and "Thesis writing" (separate accounts, not started). The main
 *   space's SSH hosts with saved passwords are the copy candidates.
 *   Sessions give the sidebar something real to show beside the switcher.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionRecord } from './helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const SPACE_ACME = 'h-acme0000000000001';
export const SPACE_PAPER = 'h-paper000000000002';

export default {
  // The shipped example pack, with its own picture: the way out for a
  // background that only exists on this device.
  appearancePacks: [join(REPO, 'docs', 'examples', 'appearance-packs', 'dusk-harbor')],
  config: {
    default_model: 'fixture/kiki-pro',
    fast_model: 'fixture/kiki-lite',
    default_permission_mode: 'manual',
    session_title: { model: 'fixture/kiki-lite' },
    providers: {},
  },
  models: [
    { provider: 'fixture', model: 'fixture/kiki-pro', display_name: 'Kiki Pro', max_context_size: 262_144 },
    { provider: 'fixture', model: 'fixture/kiki-lite', display_name: 'Kiki Lite', max_context_size: 200_000 },
    { provider: 'fixture', model: 'fixture/opus-5-5', display_name: 'Opus 5.5', max_context_size: 550_000 },
  ],
  agentProfiles: [
    { name: 'agent', source: 'builtin', description: 'General-purpose built-in agent.', main: true, routes: [] },
    { name: 'reviewer', source: 'inherited', description: 'Reviews a change before it lands.', main: false, routes: [], source_file: 'C:/Users/fixture/.kiki/agents/reviewer.md' },
  ],
  spaces: {
    mainPath: 'C:\\Users\\fixture\\.kiki',
    // The main space's own appearance: what every followed item resolves to.
    mainPrefs: { theme: 'light' },
    items: [
      {
        id: SPACE_ACME, name: 'ACME confidential', color: '#0f766e', path: 'D:\\secure\\kiki-acme',
        credentials: 'shared', live: true,
        overrides: { default_model: 'fixture/opus-5-5', session_title: { model: 'fixture/kiki-pro' } },
        // A space with preferences of its own: the theme and skin were changed
        // here, the config group follows the main space, and three items inside
        // it are fixed for this space.
        prefs: { theme: 'dark', skin: { source: 'builtin', id: 'inkstone' }, defaultAppendTiming: 'subagents_done' },
        selections: {
          'pref:theme': { mode: 'fixed', reason: 'edited' },
          'pref:skin': { mode: 'fixed', reason: 'edited' },
          'pref:proseFont': { mode: 'follow' },
          'group:config': { mode: 'follow' },
        },
      },
      {
        id: SPACE_PAPER, name: 'Thesis writing', color: '#7e22ce', path: 'C:\\Users\\fixture\\.kiki-spaces\\thesis-writing',
        credentials: 'isolated',
      },
    ],
    sshCandidates: [
      { hostId: 'prod-db', name: 'Production database', credential_kinds: ['password'] },
      { hostId: 'gpu-box', name: 'GPU box', credential_kinds: ['passphrase'] },
      { hostId: 'staging', workspaceId: 'wd_fixture_000000000000', name: 'Staging', credential_kinds: ['password', 'passphrase'] },
    ],
  },
  ssh: {
    hosts: [
      { id: 'prod-db', name: 'Production database', hostname: 'db-01.internal.example.com', user: 'readonly', agentAccess: 'offered' },
      { id: 'gpu-box', name: 'GPU box', hostname: 'gpu.lab.example.com', user: 'ubuntu', port: 2222, agentAccess: 'offered' },
    ],
  },
  sessions: [
    sessionRecord('session_space_one', { title: 'Quarterly pricing model' }),
    sessionRecord('session_space_two', { title: 'Draft the migration plan' }),
  ],
  snapshots: {},
};
