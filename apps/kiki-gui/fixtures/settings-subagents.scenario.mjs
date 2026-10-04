/**
 * settings-subagents — the subagent rules leaf with a real tool catalog:
 * builtin tools (including the two board opt-ins and main-agent-only tools),
 * one MCP tool and one plugin tool, plus profiles that carry their own
 * `tools` / `disallowedTools` lists, a built-in profile with no writable file
 * and an external-executor profile whose tool field the backend ignores.
 * The server rule already allows one board tool so the object has stored value.
 */

import settings from './settings.scenario.mjs';

const WSID = 'wd_fixture_000000000000';

const CATALOG = [
  { name: 'AgentRun', description: 'Delegate a bounded task to a subagent.', input_schema: { type: 'object' }, source: 'builtin' },
  { name: 'AskUserQuestion', description: 'Ask the user to choose between options.', input_schema: { type: 'object' }, source: 'builtin' },
  { name: 'Bash', description: 'Run shell commands in the workspace.', input_schema: { type: 'object' }, source: 'builtin' },
  { name: 'BoardRead', description: 'Read task cards from the workspace board.', input_schema: { type: 'object' }, source: 'builtin' },
  { name: 'BoardWrite', description: 'Create and update task cards on the board.', input_schema: { type: 'object' }, source: 'builtin' },
  { name: 'CreateGoal', description: 'Start a goal with a completion condition.', input_schema: { type: 'object' }, source: 'builtin' },
  // The registry registers the merged names of the goal/cron actions; the gate
  // still lists the older action names, so these two rows are the alias case.
  { name: 'Cron', description: 'Schedule a prompt to run later.', input_schema: { type: 'object' }, source: 'builtin' },
  { name: 'Goal', description: 'Track a goal with a budget.', input_schema: { type: 'object' }, source: 'builtin' },
  { name: 'Edit', description: 'Replace text in a file you have already read.', input_schema: { type: 'object' }, source: 'builtin' },
  { name: 'FetchURL', description: 'Fetch a URL and extract its readable text.', input_schema: { type: 'object' }, source: 'builtin' },
  { name: 'Glob', description: 'Find files by name pattern.', input_schema: { type: 'object' }, source: 'builtin' },
  { name: 'Grep', description: 'Search file contents with a regular expression.', input_schema: { type: 'object' }, source: 'builtin' },
  { name: 'Read', description: 'Read a file from the workspace.', input_schema: { type: 'object' }, source: 'builtin' },
  { name: 'ReadMediaFile', description: 'Look at an image or video file.', input_schema: { type: 'object' }, source: 'builtin' },
  { name: 'Skill', description: 'Load a skill by its registered name.', input_schema: { type: 'object' }, source: 'builtin' },
  { name: 'TodoList', description: 'Track the steps of a multi-step task.', input_schema: { type: 'object' }, source: 'builtin' },
  { name: 'WebSearch', description: 'Search the web and rank the sources.', input_schema: { type: 'object' }, source: 'builtin' },
  { name: 'Write', description: 'Write a file in the workspace.', input_schema: { type: 'object' }, source: 'builtin' },
  { name: 'FixtureMcpTool', description: 'A tool provided by the fixture MCP server.', input_schema: { type: 'object' }, source: 'mcp', mcp_server_id: 'mcp_fixture_0001' },
  { name: 'plugin__kiki-office__office_view', description: 'Open a document from the office plugin.', input_schema: { type: 'object' }, source: 'plugin' },
];

export default {
  ...settings,
  config: {
    ...settings.config,
    subagent: {
      ...settings.config.subagent,
      defaultProfile: 'explore',
      allowedTools: ['BoardRead'],
    },
  },
  tools: CATALOG,
  agentProfiles: [
    {
      name: 'agent',
      source: 'builtin',
      description: 'General-purpose built-in assistant.',
      main: true,
      routes: [],
    },
    {
      name: 'explore',
      source: 'builtin',
      description: 'Read-only built-in explorer.',
      main: false,
      routes: [],
    },
    {
      name: 'explore',
      source: 'user',
      workspace_id: WSID,
      source_file: 'C:/fixture/user/agents/explore.md',
      description: 'Read-only codebase exploration agent.',
      override: true,
      main: false,
      routes: [],
      tools: ['Read', 'Glob', 'Grep', 'Bash', 'BoardRead'],
      disallowed_tools: ['Write', 'Edit'],
      subagent_policy: 'advisory',
    },
    {
      name: 'reviewer',
      source: 'workspace',
      workspace_id: WSID,
      source_file: 'C:/fixture/shared/agents/reviewer.md',
      description: 'Review code changes and suggest improvements.',
      main: false,
      routes: [],
      disallowed_tools: ['Bash'],
      subagent_policy: 'strict',
    },
    {
      name: 'grok-build',
      source: 'user',
      workspace_id: WSID,
      source_file: 'C:/fixture/user/agents/grok-build.md',
      description: 'Runs the review on the Grok Build executor.',
      executor: 'grok-build',
      executor_fields: {
        tools: { state: 'ignored', reason: 'Grok Build decides its own tools.' },
        disallowed_tools: { state: 'ignored', reason: 'Grok Build decides its own tools.' },
      },
      main: false,
      routes: [],
    },
  ],
};
