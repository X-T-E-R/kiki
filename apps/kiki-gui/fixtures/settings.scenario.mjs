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
      alt: {
        type: 'anthropic',
        has_api_key: false,
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
    {
      provider: 'alt',
      model: 'alt/claude-x',
      display_name: 'Alt Claude X',
      max_context_size: 200000,
      capabilities: ['reasoning', 'tools'],
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
    {
      id: 'alt',
      type: 'anthropic',
      has_api_key: false,
      status: 'unconfigured',
      default_model: 'alt/claude-x',
      models: ['alt/claude-x'],
    },
  ],
  auth: {
    ready: true,
    providers_count: 2,
    default_model: 'fixture/kiki-pro',
    managed_provider: null,
  },
  oauth: {
    flow_id: fid('oauth'),
    provider: 'fixture',
    status: 'pending',
    verification_uri: 'https://fixture.test/verify',
    verification_uri_complete: 'https://fixture.test/verify?code=ABCD-EFGH',
    user_code: 'ABCD-EFGH',
    expires_in: 600,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    interval: 5,
  },
  oauthStart: {
    flow_id: fid('oauth'),
    provider: 'fixture',
    status: 'pending',
    verification_uri: 'https://fixture.test/verify',
    verification_uri_complete: 'https://fixture.test/verify?code=WXYZ-1234',
    user_code: 'WXYZ-1234',
    expires_in: 600,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    interval: 5,
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
    {
      id: 'wd_fixture_000000000002',
      root: 'C:/fixture/third',
      name: 'third',
      created_at: ts(120),
      last_opened_at: ts(90),
      session_count: 0,
    },
  ],
  // Expanded rows; GET /agents merges the three `reviewer` rows (same
  // name+source+file across the workspaces) into one with workspace_ids.
  agentProfiles: [
    {
      name: 'agent',
      source: 'builtin',
      description: 'General-purpose built-in agent for subagent dispatch.',
      routes: [],
    },
    {
      name: 'explore',
      source: 'builtin',
      description: 'Read-only codebase exploration agent.',
      routes: [],
    },
    {
      name: 'reviewer',
      source: 'workspace',
      workspace_id: WSID,
      source_file: 'C:/fixture/shared/agents/reviewer.md',
      description: 'Review code changes and suggest improvements.',
      routes: [],
    },
    {
      name: 'reviewer',
      source: 'workspace',
      workspace_id: 'wd_fixture_000000000001',
      source_file: 'C:/fixture/shared/agents/reviewer.md',
      description: 'Review code changes and suggest improvements.',
      routes: [],
    },
    {
      name: 'reviewer',
      source: 'workspace',
      workspace_id: 'wd_fixture_000000000002',
      source_file: 'C:/fixture/shared/agents/reviewer.md',
      description: 'Review code changes and suggest improvements.',
      routes: [],
    },
    {
      name: 'frontend',
      source: 'user',
      workspace_id: WSID,
      source_file: 'C:/fixture/user/agents/frontend.md',
      description: 'Owns a UI slice end to end.',
      routes: [],
    },
  ],
};
