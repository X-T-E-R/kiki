/**
 * tool-groups — the rail's capability block with tools read as groups. The
 * built-in list mirrors the server's own tool domains and tool names (17
 * domains, 30 tools) so the tabs, the counts and the "+N groups" fold are
 * exercised the way a real main agent reports; the MCP servers, the two
 * plugins and the user-registered tool cover the remaining reads: five states
 * across every group, a group that is entirely off, a group whose states are
 * all unconfirmed, an unlocalized category token, a long provider name, two
 * providers sharing one tool short name, and an MCP tool whose server was
 * never reported. It is a fixture, not a census of a running install.
 */

import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_tool_groups';

const t = (name, category, state, source = 'builtin', extra = {}) => ({
  name, category, source, state,
  description: `${name} — fixture description`.replace('—', '-'),
  ...extra,
});
const mcp = (server, tool, state, extra = {}) => t(`mcp__${server}__${tool}`, 'mcp', state, 'mcp', extra);
const plugin = (id, tool, state, extra = {}) => t(`plugin__${id}__${tool}`, 'plugin', state, 'plugin', extra);

const POLICY_REASON = { unavailable_reason: 'Disabled by effective tool policy', unavailable_reason_code: 'tool_policy_disabled' };
const NOT_CONNECTED = { unavailable_reason: 'Required runtime capability is not connected', unavailable_reason_code: 'runtime_not_connected' };

const TOOLS = [
  // 1 · os/backends — six members, one off and one waiting for approval.
  t('Read', 'os/backends', 'enabled'),
  t('Write', 'os/backends', 'disabled', 'builtin', POLICY_REASON),
  t('Grep', 'os/backends', 'enabled'),
  t('Glob', 'os/backends', 'enabled'),
  t('ReadMediaFile', 'os/backends', 'enabled'),
  t('Bash', 'os/backends', 'approval-required', 'builtin', {
    unavailable_reason: 'An invocation of this tool is waiting for approval',
    unavailable_reason_code: 'approval_pending',
  }),
  // 2 · edit
  t('Edit', 'edit', 'disabled', 'builtin', POLICY_REASON),
  // 3 · nbSearch
  t('WebSearch', 'nbSearch', 'approval-required', 'builtin', {
    unavailable_reason: 'An invocation of this tool is waiting for approval',
    unavailable_reason_code: 'approval_pending',
  }),
  t('FetchURL', 'nbSearch', 'enabled'),
  // 4 · threadCommunication
  t('ThreadCreate', 'threadCommunication', 'enabled'),
  t('ThreadList', 'threadCommunication', 'enabled'),
  t('ThreadRead', 'threadCommunication', 'enabled'),
  t('ThreadSend', 'threadCommunication', 'enabled'),
  t('ThreadWait', 'threadCommunication', 'disabled', 'builtin', POLICY_REASON),
  // 5 · agentTask
  t('TaskList', 'agentTask', 'enabled'),
  t('TaskOutput', 'agentTask', 'enabled'),
  t('TaskStop', 'agentTask', 'enabled'),
  t('TaskWait', 'agentTask', 'enabled'),
  // 6 · subagent
  t('AgentRun', 'subagent', 'enabled'),
  t('AgentList', 'subagent', 'enabled'),
  t('AgentNotify', 'subagent', 'disabled', 'builtin', POLICY_REASON),
  t('AgentSend', 'subagent', 'enabled'),
  // 7 · todo
  t('TodoList', 'todo', 'enabled'),
  // 8 · plan
  t('EnterPlanMode', 'plan', 'enabled'),
  t('ExitPlanMode', 'plan', 'enabled'),
  // 9 · goal
  t('Goal', 'goal', 'enabled'),
  t('UpdateGoal', 'goal', 'enabled'),
  t('GetGoal', 'goal', 'enabled'),
  // 10 · memory — a snapshot-style read: every state unconfirmed.
  t('MemoryRead', 'memory', 'unknown', 'builtin', { unavailable_reason: 'Snapshot inventory only', unavailable_reason_code: 'snapshot_inventory_only' }),
  t('MemorySearch', 'memory', 'unknown', 'builtin', { unavailable_reason: 'Snapshot inventory only', unavailable_reason_code: 'snapshot_inventory_only' }),
  t('MemoryWrite', 'memory', 'unknown', 'builtin', { unavailable_reason: 'Snapshot inventory only', unavailable_reason_code: 'snapshot_inventory_only' }),
  // 11 · questionTools
  t('AskUserQuestion', 'questionTools', 'enabled'),
  // 12 · toolSelect
  t('CallTool', 'toolSelect', 'enabled'),
  t('SelectTools', 'toolSelect', 'disconnected', 'builtin', NOT_CONNECTED),
  // 13 · taskBoard
  t('BoardRead', 'taskBoard', 'enabled'),
  t('BoardWrite', 'taskBoard', 'enabled'),
  // 14 · skill
  t('Skill', 'skill', 'enabled'),
  // 15 · history
  t('HistorySearch', 'history', 'enabled'),
  t('HistoryRead', 'history', 'enabled'),
  t('HistoryList', 'history', 'enabled'),
  // 16 · browser
  t('BrowserConnections', 'browser', 'enabled'),
  t('BrowserTabs', 'browser', 'disconnected', 'builtin', NOT_CONNECTED),
  // 17 · message
  t('SendMessage', 'message', 'enabled'),
  // The user's own registration: its own source group, never a skill entry.
  t('TeamNoteSearch', 'custom', 'enabled', 'user'),
  // MCP servers, one group each.
  mcp('github', 'search_issues', 'enabled'),
  mcp('github', 'list_commits', 'enabled'),
  mcp('github', 'create_pr', 'disabled', POLICY_REASON),
  // Same short name as github's, different provider: two groups, two keys.
  mcp('gitlab', 'search_issues', 'enabled'),
  mcp('linear', 'list_issues', 'disabled', POLICY_REASON),
  mcp('linear', 'create_issue', 'disabled', POLICY_REASON),
  mcp('figma', 'get_frame', 'disconnected', NOT_CONNECTED),
  mcp('modelcontextprotocol-filesystem-server-prod', 'read_file', 'enabled'),
  mcp('modelcontextprotocol-filesystem-server-prod', 'list_directory', 'enabled'),
  mcp('sentry', 'list_projects', 'enabled'),
  // An MCP tool whose server was never reported: its own explicit group.
  t('mcp__unreported', 'mcp', 'enabled', 'mcp'),
  // Two plugins, one of them not connected.
  plugin('release_kit', 'stage_tag', 'enabled'),
  plugin('browser_bridge', 'open_tab', 'disconnected', NOT_CONNECTED),
];

// A realistic catalog: a working machine has a few project skills and a long
// tail of global ones, which is exactly the case the skills tab's fold has to
// read well — many names, wrapping into more rows than the column shows.
const PROJECT_SKILLS = [
  ['release-notes', 'Draft release notes from merged changes'],
  ['api-diff', 'Compare two public API snapshots'],
  ['code-review', 'Review a diff for correctness and style'],
  ['migration-plan', 'Draft a migration plan from a schema change'],
  ['test-matrix', 'Map a change onto the test matrix it needs'],
  ['changelog-scan', 'Find every changelog line a commit touches'],
  ['perf-note', 'Write a short performance note for a diff'],
  ['doc-drift', 'Report documentation that no longer matches the code'],
].map(([name, description]) => ({
  name, description, source: 'project', source_kind: 'project',
  scope: 'workspace', path: `.kiki/skills/${name}/SKILL.md`, state: 'enabled',
}));

const GLOBAL_SKILLS = [
  'code-review', 'absorb-anything', 'ai4s', 'autodl-pro', 'brainstorm-to-decision',
  'gen-image-via-api', 'github-project-growth', 'handoff-builder', 'image-art-director',
  'kiki-appearance', 'kiki-as-subagent', 'kiki-hooks', 'kiki-ops', 'kiki-persona',
  'kiki-plugin', 'kiki-profile', 'my-little-frontend', 'nb-extract', 'nb-skill-creator',
  'officecli', 'paper-search-cli', 'paperflow', 'reader-first-writing', 'search-layer',
  'speak-human', 'tool-workflows',
].map((name, index) => ({
  name,
  description: `Global skill ${index + 1}: what it is for and when to reach for it.`,
  source: 'user',
  source_kind: 'user',
  scope: 'global',
  path: `~/.kiki/skills/${name}/SKILL.md`,
  state: 'enabled',
}));

const SKILLS = [...PROJECT_SKILLS, ...GLOBAL_SKILLS];

const TARGETS = [
  { profile: 'explore', caller_profile: 'agent', source: 'builtin', executor: 'native', defaults_available: true, launch_allowed: true, description: 'Bounded read-only evidence gathering' },
  { profile: 'reviewer', caller_profile: 'agent', source: 'workspace', executor: 'native', defaults_available: true, launch_allowed: true, source_file: '.kiki/agents/reviewer.md' },
];

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: tool groups' })],
  snapshots: { [SID]: { messages: [], has_more: false } },
  agentPanel: {
    context: 'live',
    live: true,
    owner: { profile: 'agent', agent_id: 'main' },
    available: true,
    profile: {
      name: 'agent',
      description: 'Fixture general-purpose agent.',
      source: 'builtin',
      model: 'fixture/kiki-pro',
      thinking_effort: 'high',
      profile_source: 'registered',
      subagent_policy: 'advisory',
      tools: TOOLS.filter((tool) => tool.state !== 'disabled').map((tool) => tool.name),
    },
    targets: TARGETS,
    tools: TOOLS,
    skills: SKILLS,
  },
  // The first workspace skill has a real SKILL.md, so the detail sheet proves
  // it fills itself from the file rather than waiting for a click. The rest are
  // deliberately absent: an unreadable file is a state the sheet has to answer
  // for too, not a gap in the fixture.
  fsFiles: {
    '.kiki/skills/release-notes/SKILL.md': {
      mime: 'text/markdown',
      content: `# Release notes

Turn a merged range into release notes a user can read.

## When to use this

Use it when a change set is on \`main\` and the release needs a description of
what changed and why it matters. Skip it for a single fix that the changelog
already covers.

## What it produces

A short heading per change, grouped by the kind of change, with the user-facing
effect first and the implementation detail last.

## Steps

1. Read the commits in range, newest first.
2. Drop anything a user cannot observe.
3. Group what is left by kind: added, changed, fixed, removed.
4. Write one line per group entry, in the words a user would use.

## Example

> **Fixed**
> The rail no longer reflows when you preview a tool group.
`,
    },
  },
};
