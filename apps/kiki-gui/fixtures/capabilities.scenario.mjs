/**
 * capabilities — mixed-source skill catalog plus MCP servers in three states,
 * for the /capabilities page walk. No session script; the walker drives the
 * page directly (including route-intercepted no-workspace and failure states).
 */

import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_capabilities';
const WSID = 'wd_fixture_000000000000';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: capabilities demo' })],
  snapshots: {
    [SID]: { messages: [], has_more: false },
  },
  mcpServers: [
    {
      id: 'mcp_fixture_0001',
      name: 'fixture-fs',
      transport: 'stdio',
      status: 'connected',
      tool_count: 4,
    },
    {
      id: 'mcp_fixture_0002',
      name: 'fixture-web',
      transport: 'http',
      status: 'error',
      last_error: 'spawn failed: ENOENT fixture-web',
      tool_count: 0,
    },
    {
      id: 'mcp_fixture_0003',
      name: 'fixture-legacy',
      transport: 'sse',
      status: 'disconnected',
      tool_count: 2,
    },
  ],
  workspaceSkills: {
    [WSID]: [
      {
        name: 'web-research',
        description: 'Search and synthesize public sources into a cited brief.',
        path: 'C:/fixture/plugins/research/skills/web-research',
        source: 'plugin',
      },
      {
        name: 'data-scrape',
        description: 'Extract structured tables from pages the plugin has fetched.',
        path: 'C:/fixture/plugins/research/skills/data-scrape',
        source: 'plugin',
      },
      {
        name: 'release-checklist',
        description: 'Walk the release checklist for this repository and tick off each gate.',
        path: 'C:/fixture/.kimi/skills/release-checklist',
        source: 'project',
      },
      {
        name: 'fixture-lint',
        description: 'Run the workspace lint suite and summarize failures.',
        path: 'C:/fixture/.kimi/skills/fixture-lint',
        source: 'project',
      },
      {
        name: 'morning-brief',
        description: 'A personal daily digest the user keeps in their home skills directory.',
        path: 'C:/Users/fixture/.kimi/skills/morning-brief',
        source: 'user',
      },
      {
        name: 'team-glossary',
        description: 'Shared team terminology loaded from an extra skill directory.',
        path: 'C:/fixture/shared/team-glossary',
        source: 'extra',
      },
      {
        name: 'write-goal',
        description: 'Draft or refine the session goal statement.',
        path: 'builtin:write-goal',
        source: 'builtin',
      },
      {
        name: 'update-config',
        description: 'Guide configuration updates for the agent runtime.',
        path: 'builtin:update-config',
        source: 'builtin',
      },
      {
        name: 'import-from-cc-codex',
        description: 'Import settings and skills from other agent tools.',
        path: 'builtin:import-from-cc-codex',
        source: 'builtin',
      },
    ],
  },
  workspaces: [
    {
      id: WSID,
      root: 'C:/fixture',
      name: 'fixture',
      created_at: new Date().toISOString(),
      last_opened_at: new Date().toISOString(),
      session_count: 1,
      pinned: false,
    },
  ],
};
