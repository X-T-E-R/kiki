/**
 * mcp-composer — the ＋ menu's MCP list on a real conversation.
 *
 * Self-contained on purpose: this page is about what the list says, so it
 * declares exactly the servers it needs. Every row is one of the cases a
 * screenshot has to be able to show:
 *
 *   - a server this conversation is using, with its tools;
 *   - one still connecting, so the list cannot only speak in finished states;
 *   - one that failed, carrying the engine's own error rather than a word this
 *     page invented;
 *   - one waiting for sign-in;
 *   - one the *configuration* turned off, which is a fact about every
 *     conversation rather than about this one — and which this conversation can
 *     still add for itself, because the server is there to be admitted;
 *   - one a plugin provides, so the level that configured it is visible;
 *   - one a plugin switched off at its source, which the engine refuses to admit
 *     here, so no switch can be offered;
 *   - one whose runtime name another source owns, which is unavailable rather
 *     than off.
 *
 * `mcpSessionCapabilities` is the session-scoped port's answer
 * (`agent.listMcpSessionCapabilities()`): redacted metadata only, which is why a
 * row knows its source, its transport and its state but never a path, an
 * environment value or a header. `connectionAfter` says what the fixture answers
 * after a write, so a switch has something to change into; the override itself is
 * remembered per conversation, exactly as the engine's own selection is.
 *
 * `mcpServerEntries` and `mcpManagedServers` are the older reads. They are what a
 * build without the session port has, and they stay so that path keeps a fixture.
 */

import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_mcp_composer';
const WSID = 'wd_mcp_composer_0123456789ab';

export default {
  sessions: [sessionRecord(SID, { workspace_id: WSID, title: 'Fixture: MCP servers', metadata: { cwd: 'C:/fixture/mcp' } })],
  snapshots: { [SID]: { messages: [], has_more: false } },
  workspaces: [
    {
      id: WSID,
      root: 'C:/fixture/mcp',
      name: 'MCP workspace',
      created_at: new Date().toISOString(),
      last_opened_at: new Date().toISOString(),
      session_count: 1,
      pinned: false,
      isGit: true,
    },
  ],
  workspaceTrust: { [WSID]: { trusted: true } },
  workspaceSkills: { [WSID]: [] },
  // The session's own answer, one entry per configured server.
  mcpSessionCapabilities: {
    [SID]: [
      {
        locator: { source: 'global', name: 'files' },
        runtimeName: 'files',
        origin: 'global',
        config: { transport: 'stdio', command: 'npx', args: ['-y', 'fixture-files'], enabled: true, envKeys: ['FIXTURE_TOKEN'] },
        authStatus: 'not-applicable',
        connection: 'connected',
        override: 'inherit',
      },
      {
        locator: { source: 'global', name: 'docs-search' },
        runtimeName: 'docs-search',
        origin: 'global',
        config: { transport: 'http', url: 'https://docs.example.test/mcp', enabled: true, headerKeys: ['X-Fixture'] },
        authStatus: 'not-applicable',
        connection: 'connecting',
        override: 'inherit',
      },
      {
        locator: { source: 'global', name: 'local-db' },
        runtimeName: 'local-db',
        origin: 'global',
        config: { transport: 'stdio', command: 'npx', args: ['-y', 'fixture-db'], enabled: true },
        authStatus: 'not-applicable',
        connection: 'failed',
        override: 'inherit',
        error: 'spawn npx ENOENT',
      },
      {
        locator: { source: 'global', name: 'remote-notes' },
        runtimeName: 'remote-notes',
        origin: 'global',
        config: { transport: 'sse', url: 'https://notes.example.test/mcp', auth: 'oauth', enabled: true },
        authStatus: 'oauth-required',
        connection: 'failed',
        override: 'inherit',
        error: 'MCP server "remote-notes" finished with status needs-auth',
      },
      {
        locator: { source: 'global', name: 'screenshot-tools' },
        runtimeName: 'screenshot-tools',
        origin: 'global',
        config: { transport: 'stdio', command: 'npx', args: ['-y', 'fixture-shots'], enabled: false },
        authStatus: 'not-applicable',
        connection: 'disabled',
        override: 'inherit',
        error: 'MCP server is disabled by its source configuration',
        // Added for this conversation only, the fixture answers with a real
        // connection attempt; the engine's own admission is what makes it valid.
        connectionAfter: { on: 'connecting', inherit: 'disabled' },
      },
      {
        locator: { source: 'plugin', pluginId: 'fixture-research', serverName: 'research-notes' },
        runtimeName: 'research-notes',
        origin: 'plugin',
        config: { transport: 'sse', url: 'https://research.example.test/mcp', enabled: true },
        authStatus: 'not-applicable',
        connection: 'connected',
        override: 'inherit',
        connectionAfter: { off: 'disabled' },
      },
      {
        locator: { source: 'plugin', pluginId: 'fixture-shots', serverName: 'plugin-muted' },
        runtimeName: 'plugin-muted',
        origin: 'plugin',
        config: { transport: 'stdio', command: 'npx', args: ['-y', 'fixture-muted'], enabled: false },
        authStatus: 'not-applicable',
        connection: 'disabled',
        override: 'inherit',
        error: 'MCP server is disabled by its source configuration',
        // The plugin owns the off. The engine rejects `on` for this locator, so
        // the row must not draw a switch at all.
        refusesOn: true,
      },
      {
        locator: { source: 'global', name: 'bench-tools' },
        runtimeName: 'bench-tools',
        origin: 'global',
        config: { transport: 'stdio', command: 'npx', args: ['-y', 'fixture-bench'], enabled: true },
        authStatus: 'not-applicable',
        connection: 'unavailable',
        override: 'inherit',
        error: 'MCP runtime name "bench-tools" is owned by another source; selected locator is unavailable',
      },
    ],
  },
  // What the engine reports once the conversation rebuilds its context: a server
  // enabled in the configuration since the session started joins the list, and
  // every override the reader made survives.
  mcpSessionCapabilitiesAdded: [
    {
      locator: { source: 'global', name: 'release-notes' },
      runtimeName: 'release-notes',
      origin: 'global',
      config: { transport: 'http', url: 'https://releases.example.test/mcp', enabled: true },
      authStatus: 'not-applicable',
      connection: 'connecting',
      override: 'inherit',
    },
  ],
  // The older reads: the conversation's own entries, and the catalog that names
  // where each one was configured.
  mcpServerEntries: {
    [SID]: [
      { name: 'files', transport: 'stdio', status: 'connected', toolCount: 3 },
      { name: 'docs-search', transport: 'http', status: 'pending', toolCount: 0 },
      { name: 'local-db', transport: 'stdio', status: 'failed', toolCount: 0, error: 'spawn npx ENOENT' },
      { name: 'remote-notes', transport: 'sse', status: 'needs-auth', toolCount: 0 },
      { name: 'screenshot-tools', transport: 'stdio', status: 'disabled', toolCount: 0 },
      { name: 'research-notes', transport: 'sse', status: 'connected', toolCount: 2 },
    ],
  },
  mcpManagedServers: [
    { name: 'files', config: { transport: 'stdio', command: 'npx', args: ['-y', 'fixture-files'] }, source: 'global', origin: '/home/fixture/.kimi/mcp.json', mutable: true },
    { name: 'docs-search', config: { transport: 'http', url: 'https://docs.example.test/mcp', headerKeys: [] }, source: 'global', origin: '/home/fixture/.kimi/mcp.json', mutable: true },
    { name: 'local-db', config: { transport: 'stdio', command: 'npx', args: ['-y', 'fixture-db'] }, source: 'global', origin: '/home/fixture/.kimi/mcp.json', mutable: true },
    { name: 'remote-notes', config: { transport: 'sse', url: 'https://notes.example.test/mcp', auth: 'oauth' }, source: 'global', origin: '/home/fixture/.kimi/mcp.json', mutable: true },
    { name: 'screenshot-tools', config: { transport: 'stdio', command: 'npx', args: ['-y', 'fixture-shots'], enabled: false }, source: 'global', origin: '/home/fixture/.kimi/mcp.json', mutable: true },
    { name: 'research-notes', config: { transport: 'sse', url: 'https://research.example.test/mcp', headerKeys: [] }, source: 'plugin', origin: 'Fixture research plugin', mutable: false, plugin: { id: 'research', name: 'research-notes' } },
  ],
};
