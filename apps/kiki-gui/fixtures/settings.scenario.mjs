/**
 * settings — demo data for the settings panels and responsive screenshots.
 *
 * No session-side event script is needed; the proof runner navigates to
 * /settings and reads the catalog endpoints served here.
 */

import { fid, sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_settings';
const WSID = 'wd_fixture_000000000000';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: settings demo' })],
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
    extra_skill_dirs: ['C:/fixture/skills'],
    experimental: { search_worker: true },
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
    {
      provider: 'fixture',
      model: 'fixture/kiki-lite',
      display_name: 'Kiki Lite',
      max_context_size: 131072,
      capabilities: ['chat'],
    },
  ],
  providers: [
    {
      id: 'fixture',
      type: 'openai',
      has_api_key: true,
      status: 'connected',
      default_model: 'fixture/kiki-pro',
      models: ['fixture/kiki-pro', 'fixture/kiki-lite'],
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
  oauthStart: {
    flow_id: fid('oauth'),
    provider: 'fixture',
    status: 'authenticated',
  },
  tools: [
    {
      name: 'Bash',
      description: 'Run shell commands in the workspace.',
      input_schema: { type: 'object' },
      source: 'builtin',
    },
    {
      name: 'Read',
      description: 'Read a file from the workspace.',
      input_schema: { type: 'object' },
      source: 'builtin',
    },
    {
      name: 'FixtureMcpTool',
      description: 'A tool provided by the fixture MCP server.',
      input_schema: { type: 'object' },
      source: 'mcp',
      mcp_server_id: 'mcp_fixture_0001',
    },
  ],
  mcpServers: [
    {
      id: 'mcp_fixture_0001',
      name: 'fixture-mcp',
      transport: 'stdio',
      status: 'connected',
      tool_count: 1,
    },
  ],
  workspaceSkills: {
    [WSID]: [
      {
        name: 'review',
        description: 'Review code changes and suggest improvements.',
        path: 'skills/review',
        source: 'workspace',
        type: 'skill',
      },
      {
        name: 'test',
        description: 'Generate tests for the current file.',
        path: 'skills/test',
        source: 'workspace',
        type: 'skill',
      },
    ],
  },
  workspaces: [
    {
      id: WSID,
      root: 'C:/fixture',
      name: 'fixture',
      created_at: ts(120),
      last_opened_at: ts(2),
      session_count: 1,
    },
    {
      id: 'wd_fixture_000000000001',
      root: 'C:/fixture/other',
      name: 'other',
      created_at: ts(120),
      last_opened_at: ts(60),
      session_count: 0,
    },
  ],
};
