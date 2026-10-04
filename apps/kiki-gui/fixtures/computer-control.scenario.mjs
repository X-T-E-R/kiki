/**
 * computer-control — the settings 电脑控制 leaf, seeded with what that page
 * reads: the bootstrap scalars behind the machine line, the `kiki-computer`
 * capability behind the install block, and the global MCP catalog behind the
 * connections. The page renders these seeds and nothing else; the walk in
 * scripts/capture-computer-control.mjs installs, edits, tests and stops
 * through the real controls.
 *
 * `stopState` / `stopOutput` set what `mcpManagementService.stopServer` answers,
 * so the walk can capture a service that could not confirm a stop.
 */

const BINARY = 'C:\\Users\\fixture\\.kimi\\capabilities\\kiki-computer\\windows-x86_64\\cua-driver.exe';

export default {
  sessions: [],
  snapshots: {},
  bootstrap: {
    platform: 'win32',
    arch: 'x64',
    cwd: 'C:\\fixture',
    osHomeDir: 'C:\\Users\\fixture',
    homeDir: 'C:\\Users\\fixture',
    configPath: 'C:\\Users\\fixture\\.kimi\\config.toml',
    sessionsDir: 'C:\\Users\\fixture\\.kimi\\sessions',
    blobsDir: 'C:\\Users\\fixture\\.kimi\\blobs',
    storeDir: 'C:\\Users\\fixture\\.kimi\\store',
    cacheDir: 'C:\\Users\\fixture\\.kimi\\cache',
    logsDir: 'C:\\Users\\fixture\\.kimi\\logs',
  },
  computerCapability: {
    id: 'kiki-computer',
    displayName: 'Kiki Computer Control',
    description: 'Desktop observation and input through the open-source cua-driver stdio MCP server.',
    supported: true,
    state: 'not_installed',
    steps: [
      { id: 'binary', state: 'missing', detail: `No pinned executor at ${BINARY}` },
      { id: 'mcp', state: 'missing', detail: 'No cua-driver stdio entry in the global MCP configuration' },
      { id: 'desktop-access', state: 'missing', detail: 'Not checked during install', optional: true },
    ],
    plan: {
      artifact: {
        version: '0.32.0',
        url: 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.32.0/cua-driver-windows-x86_64.zip',
        sha256: '6d70b45c8c901db773010dd720c8bb9d58c59bb301e9891c58ca1d3860e75652',
        metadataUrl: 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.32.0/meta.json',
        maxBytes: 52_428_800,
      },
      destination: BINARY,
      note: 'Open-source desktop executor (Apache-2.0).',
    },
    install: { running: false },
  },
  mcpManagedServers: [
    {
      name: 'fixture-filesystem',
      config: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/fixture'] },
      source: 'global',
      origin: 'C:/Users/fixture/.kimi/mcp.json',
      mutable: true,
    },
  ],
  stopState: 'stopped',
  stopOutput: 'cua-driver --direct exited (2 children waited)',
};
