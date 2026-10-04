/**
 * browser-control — the settings 浏览器控制 leaf, seeded with what that page
 * reads: the connection list (each with the status the control service would
 * report), the stored default, and the conditions that make the walk worth
 * taking — a connection that is already up, one that has never been connected and
 * whose connect the gated server refuses, a CDP connection borrowed from another
 * machine, a disabled one, and a connection whose managed driver is the wrong
 * build.
 *
 * The walk in scripts/capture-browser-control.mjs creates, checks, connects,
 * disconnects and deletes through the real controls; nothing is patched into
 * the DOM afterwards, so every image is what the page does with the server's
 * own answers.
 */

const MANAGED = 'C:\\Users\\fixture\\.kimi\\browser\\agent-browser.exe';
// A managed native binary in the same install location that reports the same
// version but was not built by Kiki: the gate is about the two build markers,
// not about the version string or where the file lives.
const MANAGED_UPSTREAM = 'C:\\Users\\fixture\\.kimi\\browser\\agent-browser-upstream.exe';
const DRIVER = { driverVersion: '0.38.2' };

export default {
  sessions: [],
  snapshots: {},
  host: 'fixture-win11',
  // The development-candidate flag this server refuses to run a browser under:
  // the page's feedback points at its row, which lives on the Developer page.
  experimentalFlags: { native_browser: false },
  browser: {
    defaultBrowser: 'research',
    connections: [
      {
        id: 'research',
        name: '资料整理',
        enabled: true,
        type: 'agent-browser-profile',
        driverPath: MANAGED,
        profilePath: 'C:\\Users\\fixture\\kiki\\browsers\\research',
        headed: true,
        status: {
          ...DRIVER, state: 'ready', generation: 4, ownership: 'managed-profile',
          checkedAt: '2026-10-03T01:58:00.000Z', runtimeSession: 'browser-9f1c2ad4e7',
          profilePath: 'C:\\Users\\fixture\\kiki\\browsers\\research',
        },
        // The daemon's own target list: what the status can never show.
        tabs: [
          { tabId: 'tab-1', targetId: 'A1B2C3D4E5F6', title: '资料整理 · 待归档队列', url: 'https://example.test/queue', active: true, label: 'queue' },
          { tabId: 'tab-2', targetId: '0F9E8D7C6B5A', title: '资料整理 · 来源核对', url: 'https://example.test/sources' },
          { tabId: 'tab-3', targetId: '112233445566', url: 'about:blank' },
        ],
        // The managed backend's tools, bucketed the way the service buckets them.
        catalog: [
          { name: 'agent_browser_navigate', description: 'Open a URL in the current tab.', group: 'page', surface: 'operation', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
          { name: 'agent_browser_snapshot', description: 'Return an accessibility snapshot and a screenshot of the page.', group: 'page', surface: 'operation', inputSchema: { type: 'object', properties: { maxDepth: { type: 'integer' } } } },
          { name: 'agent_browser_click', description: 'Click an element by reference.', group: 'page', surface: 'operation', inputSchema: { type: 'object', properties: { ref: { type: 'string' } } } },
          { name: 'agent_browser_network_har_start', description: 'Start recording a HAR from the next navigation.', group: 'network', surface: 'operation' },
          { name: 'agent_browser_network_har_stop', description: 'Stop the HAR recording and return its path.', group: 'network', surface: 'operation' },
          { name: 'agent_browser_cookies_list', description: 'List cookies for the current page.', group: 'state', surface: 'operation' },
          { name: 'agent_browser_console', description: 'Read console messages from the current tab.', group: 'debug', surface: 'operation' },
          { name: 'agent_browser_trace_start', description: 'Start a Playwright trace.', group: 'debug', surface: 'operation' },
          { name: 'agent_browser_mouse_drag', description: 'Drag from one point to another.', group: 'input', surface: 'operation' },
          { name: 'agent_browser_react_tree', description: 'Read the React component tree.', group: 'react', surface: 'operation' },
          { name: 'agent_browser_tab_open', description: 'Open a new tab.', group: 'page', surface: 'lifecycle' },
          { name: 'agent_browser_close', description: 'Close the browser Kiki started.', group: 'page', surface: 'lifecycle' },
          { name: 'agent_browser_state_list', description: 'List saved browser states.', group: 'state', surface: 'administrative' },
        ],
      },
      {
        id: 'work',
        name: '工作浏览器',
        enabled: true,
        type: 'agent-browser-profile',
        driverPath: MANAGED,
        profilePath: 'C:\\Users\\fixture\\kiki\\browsers\\work',
        status: { state: 'idle', generation: 0, ownership: 'managed-profile' },
        // Starting a browser is gated on a development-candidate flag here, so
        // connecting is refused with the sentence the page has to repeat; reading
        // the status and checking stay usable, and nothing is drawn as ready.
        connect: {
          code: 40001,
          msg: 'Native browser execution is experimental; enable native_browser in the existing experimental settings',
          details: { code: 'browser.disabled', reason: 'feature_disabled' },
        },
      },
      {
        id: 'qa',
        name: '回归测试',
        enabled: true,
        type: 'agent-browser-profile',
        driverPath: MANAGED_UPSTREAM,
        profilePath: 'C:\\Users\\fixture\\kiki\\browsers\\qa',
        status: { state: 'idle', generation: 0, ownership: 'managed-profile' },
        // A build without the two markers (kiki-no-replay-r1, kiki-stdio-r1) is
        // refused outright: it can replay after a lost response and hang on
        // Windows MCP output, so the page shows the service's own reason.
        check: {
          state: 'failed',
          error: `Expected the managed agent-browser 0.38.2 kiki-no-replay-r1 kiki-stdio-r1 build; detected 0.38.2. This build prevents automatic replay and Windows MCP output hangs.`,
        },
      },
      {
        id: 'preview',
        name: '远端预览',
        enabled: true,
        type: 'agent-browser-cdp',
        endpoint: 'http://127.0.0.1:9222/',
        status: {
          state: 'ready', generation: 2, ownership: 'external-browser', executionHost: 'fixture-win11',
          checkedAt: '2026-10-03T02:04:00.000Z', runtimeSession: 'browser-cdp-preview',
          driverVersion: '0.38.2', currentCall: { sessionId: 's-4821', agentId: 'main', tool: 'agent_browser_snapshot', tab: 't-77' },
        },
        // Closing a borrowed browser disconnects Kiki and leaves the browser.
        disconnect: { state: 'disconnected', error: undefined },
        // A borrowed browser reports its own targets the same way.
        tabs: [
          { tabId: 'cdp-1', targetId: '9F8E7D6C5B4A', title: '远端预览 · 首页', url: 'http://127.0.0.1:9222/', active: true },
          { tabId: 'cdp-2', targetId: '001122334455', title: '远端预览 · 报表', url: 'http://127.0.0.1:9222/report' },
        ],
      },
      {
        id: 'legacy',
        name: '旧登录环境',
        enabled: false,
        type: 'agent-browser-profile',
        driverPath: MANAGED,
        profilePath: 'C:\\Users\\fixture\\kiki\\browsers\\legacy',
        status: { state: 'idle', generation: 0, ownership: 'managed-profile' },
      },
    ],
  },
};
