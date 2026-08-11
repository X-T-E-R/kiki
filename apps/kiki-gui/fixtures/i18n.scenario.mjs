/**
 * i18n — minimal data for the language-toggle walker: one session so the
 * sidebar renders, plus the standard settings catalog (the walker lives on
 * /settings/general and flips #language-select between locales).
 */

import { fid, sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_i18n';
const WSID = 'wd_fixture_000000000000';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: i18n' })],
  snapshots: {
    [SID]: { messages: [], has_more: false },
  },
  config: {
    default_provider: 'fixture',
    default_model: 'fixture/kiki-pro',
    default_permission_mode: 'manual',
    default_plan_mode: false,
    thinking: { enabled: true, effort: 'high' },
    merge_all_available_skills: true,
    extra_skill_dirs: [],
    experimental: {},
    telemetry: true,
    providers: {
      fixture: {
        type: 'openai',
        has_api_key: true,
      },
    },
  },
  models: [
    {
      provider: 'fixture',
      model: 'fixture/kiki-pro',
      display_name: 'Kiki Pro',
      max_context_size: 262144,
      support_efforts: ['low', 'medium', 'high'],
      default_effort: 'high',
      capabilities: ['reasoning', 'vision'],
    },
  ],
  providers: [
    {
      id: 'fixture',
      type: 'openai',
      has_api_key: true,
      status: 'connected',
      default_model: 'fixture/kiki-pro',
      models: ['fixture/kiki-pro'],
    },
  ],
  auth: {
    ready: true,
    providers_count: 1,
    default_model: 'fixture/kiki-pro',
    managed_provider: null,
  },
  oauth: {
    flow_id: fid('oauth'),
    provider: 'fixture',
    status: 'authenticated',
    verification_uri: 'https://fixture.test/verify',
    verification_uri_complete: 'https://fixture.test/verify?code=ABCD',
    user_code: 'ABCD-EFGH',
    expires_in: 600,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    interval: 5,
  },
  tools: [],
  mcpServers: [],
  workspaceSkills: { [WSID]: [] },
  workspaces: [
    {
      id: WSID,
      root: 'C:/fixture',
      name: 'fixture',
      created_at: ts(120),
      last_opened_at: ts(2),
      session_count: 1,
    },
  ],
};
