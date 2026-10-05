/**
 * control-ecosystem-scene — the fixture worlds behind the Freedom / Extend /
 * Ecosystem documentation frames (the `ce-20261005-*` set).
 *
 * These are the same kind of scenario the shipped marketing scenes are: the
 * real Kiki GUI rendering a neutral example project, driven entirely by the
 * fixture server's existing contract routes. Nothing here reaches a network,
 * a provider, or a credential. Every endpoint is `*.example.test`, every
 * account is an `@example.test` address, and every key is absent or reported
 * only as "configured: yes".
 *
 * Why these worlds exist at all. The three pages this slice covers each open a
 * capability in prose and then show at most one frame, so the frames have to
 * carry states the prose names but the existing scene does not show:
 *
 *   - Freedom names the OAuth device flow (a code, a verification page, a
 *     countdown, a cancel) and the "check this machine, then use this sign-in"
 *     reuse order. Neither appears in any existing frame.
 *   - Extend had no frames at all, and it is the page with four distinct
 *     extension seams. A plugin, a skill, an MCP server and a search lane are
 *     four different screens; the page needs to be seen.
 *   - Ecosystem names a seat and an external executor. The seat is a CLI
 *     concern with no GUI surface, but the executor side is a real settings
 *     section with install detection and remaining setup steps.
 *
 * Every locale variant is generated from the same shape so the two frames of a
 * pair carry the same data and differ only in language — which is what lets a
 * reader compare them.
 */

import base from './settings.scenario.mjs';
import { sessionRecord } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Shared neutral vocabulary
// ---------------------------------------------------------------------------

/** Locale-aware copy, matching the shipped marketing scenes' own helper. */
export const pick = (locale, en, zh) => (locale === 'zh' ? zh : en);

/**
 * A world a public frame can show. It starts from the shipped settings world
 * — the same connections, workspaces and config the proof runners use — and
 * the callers below add only what their frame is about. A frame that needs
 * the session rail says so; a settings frame does not need a session, and
 * seeding one would put a fixture-flavoured title in the sidebar of a page
 * that has nothing to do with sessions.
 */
function settingsWorld() {
  return {
    ...base,
    // The rail is the loudest thing in a Kiki frame. Settings frames replace
    // it with the app rail, which is what a reader sees on these pages.
    sessions: [],
    // The workspace picker in the page header prints the workspace's own
    // name and root, and the shipped settings world calls it `fixture` under
    // `C:/fixture` — a fixture artifact in a public frame. Renaming it keeps
    // the id (every seed is keyed by it) and only changes what is displayed.
    workspaces: base.workspaces.map((workspace, index) => (index === 0
      ? { ...workspace, name: 'sample-app', root: 'C:/Projects/sample-app' }
      : { ...workspace, name: `sample-app-${workspace.name}` })),
    config: {
      ...base.config,
      // The fixture's own home path is a giveaway in a public frame. Every
      // path a settings page can print goes through these.
      nb_search_source: { reuse_local_config: true },
    },
  };
}

// ---------------------------------------------------------------------------
// ce-freedom-oauth — the device flow and the reuse path, side by side
// ---------------------------------------------------------------------------

/**
 * The two halves of one page's "Connections" story, and the reason they are
 * two frames rather than one.
 *
 * `ce-freedom-oauth-device` needs the **Add connection** panel open with the
 * account lane chosen and a flow already pending, so the reader sees a code,
 * the verification page button, the countdown and the cancel. That panel is a
 * side panel over the list; a frame wide enough to hold the device card would
 * crop the list it is explaining.
 *
 * `ce-freedom-oauth-reuse` needs the **Check this machine → Use this sign-in**
 * result, which only exists after a probe has run. The panel is short and the
 * list beside it is the point (this connection has no credential of its own),
 * so that one fits one frame.
 *
 * Neither state is a mock of the UI: the panel, the device card and the
 * original-source panel are the real components, and the fixture's OAuth
 * service answers `startLogin` / `probeOriginal` with these values.
 */
export function buildFreedomOAuth(_locale) {
  const world = settingsWorld();
  return {
    ...world,
    models: [
      { provider: 'managed:kimi-code', model: 'kimi-code/kimi-k2', display_name: 'Kimi K2', max_context_size: 262_144, capabilities: ['chat', 'reasoning'] },
      { provider: 'managed:grok-build', model: 'grok-build/grok-code', display_name: 'Grok Code', max_context_size: 256_000, capabilities: ['chat', 'reasoning'] },
    ],
    providers: [
      {
        id: 'managed:kimi-code', type: 'kimi', base_url: 'https://api.kimi.example.test/coding/v1',
        has_api_key: false, status: 'connected', default_model: 'kimi-code/kimi-k2',
        models: ['kimi-code/kimi-k2'],
      },
      {
        // Signed in once; the provider will not accept that credential again.
        // Recovered in place rather than added as a second row.
        id: 'managed:grok-build', type: 'openai', base_url: 'https://api.grok.example.test/v1',
        has_api_key: false, status: 'unconfigured', models: [],
      },
      {
        id: 'byo-endpoint', type: 'openai', base_url: 'https://api.example.test/v1',
        has_api_key: true, status: 'connected', default_model: 'kimi-code/kimi-k2',
        models: ['kimi-code/kimi-k2'],
      },
    ],
    oauthMethods: [
      // Connected: this method is therefore not offered in Add connection, and
      // its row on the list carries the state instead. That is the page's
      // central claim, so the frame has to contain both halves of it.
      { id: 'kimi-code', label: 'Kimi Code', provider: 'managed:kimi-code', protocol: 'openai', signed_in: true, connection_state: 'ready', account: { state: 'known', id: 'you@example.test' } },
      { id: 'grok-build', label: 'Grok Build', provider: 'managed:grok-build', protocol: 'openai', signed_in: true, connection_state: 'reconnect_required', account: { state: 'known', id: 'release@example.test' } },
      // Not signed in, and the machine already holds its sign-in. This is the
      // method the reuse frame is about.
      { id: 'openai-codex', label: 'ChatGPT', provider: 'managed:openai-codex', protocol: 'openai_responses', signed_in: false, account: { state: 'unknown' }, quota: { state: 'unknown' } },
    ],
    config: {
      ...world.config,
      providers: {
        'managed:kimi-code': { type: 'kimi', has_api_key: false },
        'managed:grok-build': { type: 'openai', has_api_key: false },
      },
    },
    // The device flow the walker drives: a code, a verification page, and a
    // window long enough that the countdown is not the thing under test.
    oauthStart: {
      flow_id: 'oauth_ce_codex',
      provider: 'managed:openai-codex',
      status: 'pending',
      verification_uri: 'https://auth.example.test/device',
      verification_uri_complete: 'https://auth.example.test/device?user_code=WXYZ-1234',
      user_code: 'WXYZ-1234',
      expires_in: 900,
      expires_at: new Date(Date.now() + 900_000).toISOString(),
      interval: 5,
    },
    // What the machine reports when asked whether it already holds a sign-in.
    // `keyring` is the interesting answer because it is the one a file-based
    // credential cannot produce, and the panel's whole point is saying *where*
    // the credential lives before offering to use it.
    oauthOriginal: {
      'openai-codex': {
        home_dir: '~/.codex',
        storage_backend: 'keyring',
        state: 'ready',
        account: { state: 'known', id: 'you@example.test' },
        can_connect: true,
      },
      'grok-build': {
        home_dir: '~/.grok',
        storage_backend: 'file',
        state: 'signed_out',
        account: { state: 'unknown' },
        can_connect: false,
        reason: 'No saved account in ~/.grok.',
      },
    },
    auth: { ready: true, providers_count: 3, default_model: 'kimi-code/kimi-k2', managed_provider: null },
  };
}

// ---------------------------------------------------------------------------
// ce-extend-plugins — one installed plugin, expanded, with what it contributes
// ---------------------------------------------------------------------------

/**
 * The plugin detail page: what one plugin contributed, grouped by kind.
 *
 * Extend's opening section says a plugin can contribute skills, agents, MCP
 * servers, hooks, commands and panels, and that you browse, install and
 * configure them on Capabilities. A marketplace grid proves none of that — it
 * only proves a grid exists. The detail page is the one screen that answers
 * "what did installing this actually add", so that is the frame.
 *
 * The counts in the summary and the groups below are one story: three skills
 * means the Skills group has three rows, and a reader who counts the two
 * against each other can trust both.
 */
export function buildExtendPlugins(locale) {
  const world = settingsWorld();
  const PLUGIN = 'kiki-office';
  return {
    ...world,
    plugins: [{
      id: PLUGIN,
      displayName: 'Kiki Office',
      version: '0.1.0',
      enabled: true,
      state: 'ok',
      skillCount: 3,
      mcpServerCount: 1,
      enabledMcpServerCount: 1,
      hookCount: 1,
      commandCount: 2,
      hasErrors: false,
      source: 'local-path',
    }],
    pluginInfos: {
      [PLUGIN]: {
        id: PLUGIN,
        displayName: 'Kiki Office',
        version: '0.1.0',
        enabled: true,
        state: 'ok',
        skillCount: 3,
        mcpServerCount: 1,
        enabledMcpServerCount: 1,
        hookCount: 1,
        commandCount: 2,
        hasErrors: false,
        source: 'local-path',
        root: 'C:/Users/you/.kiki/plugins/managed/kiki-office',
        installedAt: '2026-09-28T09:12:00.000Z',
        manifest: {
          name: 'kiki-office',
          version: '0.1.0',
          // Manifest copy is seeded per locale like every other string in
          // this file: the detail page prints the description and every
          // contributed row's own description straight from the manifest, so
          // an English-only seed puts English prose inside the Chinese frame
          // beside rows that are correctly translated.
          description: pick(
            locale,
            'Read and edit local Word, Excel and PowerPoint files.',
            '读取并修改本地 Word、Excel 和 PowerPoint 文件。',
          ),
          // The detail page derives "What it adds" from the manifest's own
          // `x-kiki` block — tools, panels, commands, themes, presets — and
          // takes only the SKILL and HOOK counts from the plugin summary,
          // because those are counts rather than named rows. So a manifest
          // that omits `commands` renders "Skills · 3" and nothing else, and
          // the frame would claim the plugin bundles nothing while the header
          // says it does.
          'x-kiki': {
            permissions: { net: [], fs: 'workspace' },
            tools: [
              {
                name: 'office_render',
                description: pick(locale, 'Render a document or deck to images for inspection.', '把文档或演示文稿渲染成图片以便检查。'),
                accesses: ['workspace'],
              },
              {
                name: 'office_read',
                description: pick(locale, 'Read the text and tables of a local Office file.', '读取本地 Office 文件的正文和表格。'),
                accesses: ['workspace'],
              },
            ],
            commands: [
              { name: 'officecli', description: pick(locale, 'Open the Office CLI for this workspace.', '打开本工作区的 Office 命令行。') },
              { name: 'deck-preview', description: pick(locale, 'Render the current deck to a contact sheet.', '把当前演示文稿渲染成缩略图。') },
            ],
            panels: [
              { id: 'office-preview', label: pick(locale, 'Office preview', 'Office 预览'), slot: 'workspace' },
            ],
          },
        },
        mcpServers: [{ name: 'office-tools', runtimeName: 'plugin__kiki-office__office-tools', enabled: true, transport: 'stdio', command: 'node' }],
        diagnostics: [],
      },
    },
    // The three skills the summary counts, and the one hook. They are seeded
    // on the workspace so the Skills tab can show a plugin-sourced row, which
    // is where the reader sees the same contribution under its own name.
    workspaceSkills: {
      wd_fixture_000000000000: [
        { name: 'office-write', description: pick(locale, 'Create and revise .docx, .xlsx and .pptx files in place.', '就地创建和修改 .docx、.xlsx、.pptx 文件。'), path: 'C:/Users/you/.kiki/plugins/managed/kiki-office/skills/office-write/SKILL.md', source: 'plugin' },
        { name: 'office-read', description: pick(locale, 'Read a local Office file and answer questions about it.', '读取本地 Office 文件并回答关于它的问题。'), path: 'C:/Users/you/.kiki/plugins/managed/kiki-office/skills/office-read/SKILL.md', source: 'plugin' },
        { name: 'office-render', description: pick(locale, 'Render a deck to images for a quick visual pass.', '把演示文稿渲染成图片做快速目视检查。'), path: 'C:/Users/you/.kiki/plugins/managed/kiki-office/skills/office-render/SKILL.md', source: 'plugin' },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// ce-extend-skills — the skill catalog, one row per workflow
// ---------------------------------------------------------------------------

/**
 * The Skills list. Extend says a skill is a Markdown file that injects a
 * workflow and also registers as a slash command you can trigger yourself, and
 * that naming several in one prompt activates them together.
 *
 * The list is the one screen where both halves are visible at once: a row
 * carries the source it came from (plugin, project, user, built-in) and, for a
 * prompt command, the `/name` you would type. A row-per-workflow frame that
 * shows the sources side by side is what "these are reusable workflows" looks
 * like in the product; a single skill's file does not show the catalog.
 */
export function buildExtendSkills(locale) {
  const world = settingsWorld();
  return {
    ...world,
    workspaceSkills: {
      wd_fixture_000000000000: [
        { name: 'web-research', description: pick(locale, 'Search and synthesize public sources into a cited brief.', '检索并综合公开来源，产出一份带引用的简报。'), path: 'C:/Users/you/.kiki/plugins/managed/research/skills/web-research/SKILL.md', source: 'plugin' },
        { name: 'release-checklist', description: pick(locale, 'Walk the release checklist for this repository and tick off each gate.', '按清单走一遍本仓库的发布流程并逐项打勾。'), path: 'C:/Projects/sample-app/.kiki/skills/release-checklist/SKILL.md', source: 'project', prompt_command: true },
        { name: 'sample-lint', description: pick(locale, 'Run the workspace lint suite and summarize failures.', '运行工作区的 lint 并汇总失败项。'), path: 'C:/Projects/sample-app/.kiki/skills/sample-lint/SKILL.md', source: 'project' },
        { name: 'morning-brief', description: pick(locale, 'A personal daily digest kept in the home skills folder.', '放在 home 技能目录里的个人每日简报。'), path: 'C:/Users/you/.kiki/skills/morning-brief/SKILL.md', source: 'user', disable_model_invocation: true },
        { name: 'kiki-ops', description: pick(locale, 'Kiki product usage and configuration operations.', 'Kiki 产品的使用与配置操作。'), path: 'builtin:kiki-ops', source: 'builtin' },
        { name: 'kiki-profile', description: pick(locale, 'Create or modify Kiki agent profile files.', '创建或修改 Kiki 智能体 profile 文件。'), path: 'builtin:kiki-profile', source: 'builtin' },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// ce-extend-mcp — the MCP list, every transport and every state
// ---------------------------------------------------------------------------

/**
 * The MCP list. Extend names three transports and says MCP tools reach the
 * agent exactly like built-in tools, with the same approval model.
 *
 * The list is the only screen where all three transports sit together, and the
 * shape the doc promises — name, status, transport, tool count, launch target
 * — is precisely this row. One row is expanded so the tools it contributes are
 * visible: that is the proof of "the same tools as anything else", and it is
 * the one thing a collapsed row cannot show.
 *
 * The error row is real data, not decoration. A reader who has never used MCP
 * needs to see that a server which failed says so and offers a reconnect,
 * rather than discovering that a red row means nothing.
 */
export function buildExtendMcp(_locale) {
  const world = settingsWorld();
  return {
    ...world,
    mcpServers: [
      { id: 'mcp_ce_0001', name: 'github-issues', transport: 'stdio', status: 'connected', tool_count: 6 },
      { id: 'mcp_ce_0002', name: 'postgres', transport: 'http', status: 'connected', tool_count: 4 },
      { id: 'mcp_ce_0003', name: 'legacy-notes', transport: 'sse', status: 'disconnected', tool_count: 2 },
      { id: 'mcp_ce_0004', name: 'build-runner', transport: 'stdio', status: 'error', last_error: 'spawn failed: ENOENT build-runner', tool_count: 0 },
    ],
    mcpManagedServers: [
      { name: 'github-issues', config: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }, source: 'global', origin: 'C:/Users/you/.kiki/mcp.json', mutable: true },
      { name: 'postgres', config: { transport: 'http', url: 'https://mcp.example.test/postgres' }, source: 'global', origin: 'C:/Users/you/.kiki/mcp.json', mutable: true },
      // A server configured by a project file rather than by the user. The
      // server distinguishes those by `origin` alone — `source` is one of
      // global / plugin / caller, and anything else is rejected by the
      // contract — so the project path is what carries the distinction here.
      { name: 'legacy-notes', config: { transport: 'sse', url: 'https://legacy.example.test/sse' }, source: 'global', origin: 'C:/Projects/sample-app/.kiki/mcp.json', mutable: true },
      { name: 'build-runner', config: { transport: 'stdio', command: 'build-runner', args: ['--stdio'] }, source: 'global', origin: 'C:/Users/you/.kiki/mcp.json', mutable: true },
    ],
    tools: [
      { name: 'Read', description: 'Read a file from the workspace.', input_schema: {}, source: 'builtin', active: true },
      { name: 'Bash', description: 'Run a shell command.', input_schema: {}, source: 'builtin', active: true },
      { name: 'mcp__github-issues__list_issues', description: 'List issues in a repository.', input_schema: {}, source: 'mcp', mcp_server_id: 'mcp_ce_0001', active: true },
      { name: 'mcp__github-issues__create_issue', description: 'Create an issue.', input_schema: {}, source: 'mcp', mcp_server_id: 'mcp_ce_0001', active: true },
      { name: 'mcp__github-issues__comment', description: 'Comment on an issue.', input_schema: {}, source: 'mcp', mcp_server_id: 'mcp_ce_0001', active: true },
      { name: 'mcp__github-issues__search', description: 'Search issues and pull requests.', input_schema: {}, source: 'mcp', mcp_server_id: 'mcp_ce_0001', active: true },
      { name: 'mcp__github-issues__list_labels', description: 'List labels.', input_schema: {}, source: 'mcp', mcp_server_id: 'mcp_ce_0001', active: true },
      { name: 'mcp__github-issues__update_issue', description: 'Update an issue.', input_schema: {}, source: 'mcp', mcp_server_id: 'mcp_ce_0001', active: true },
    ],
  };
}

// ---------------------------------------------------------------------------
// ce-extend-search — the retrieval module's own overview and its lanes
// ---------------------------------------------------------------------------

/**
 * Search & retrieval. Extend says the module is inspectable: which config
 * source is in effect, whether the server reuses your local search config, the
 * readiness of each named lane, key rotation, and which extractor produced the
 * text of a fetch.
 *
 * The overview tab is the only screen carrying the source half of that, and
 * the lanes tab the only one carrying the named-lane half. One frame cannot
 * honestly show both at a readable size, so this world serves two, and the
 * fetch chain is a third because "which extractor produced the text" is a
 * different claim from "which lanes are ready".
 */
export function buildExtendSearch(_locale) {
  const world = settingsWorld();
  const inherited = base.nbSearchCapabilities;

  // A capability frame documents what the module does when it is set up, so
  // the world it runs on has to BE set up. Three of the shipped seed's
  // defaults are configuration accidents rather than facts about the product,
  // and each one put a red `LANE_NOT_CONFIGURED` / `RATE_LIMIT_UNAUTHENTICATED`
  // line in the middle of a public screenshot:
  //
  //   - `jina.reader` is seeded `availability: 'unavailable'` with a
  //     `LANE_NOT_CONFIGURED` issue, yet its own descriptor declares
  //     `activation: { credential: 'none' }`. A reader that needs no key has
  //     nothing to misconfigure, so the unavailable state contradicts the
  //     schema it is supposed to illustrate.
  //   - `github.repositories` carries `RATE_LIMIT_UNAUTHENTICATED` even though
  //     the page's own prose says repository search works without a key, and
  //     the overview prints that warning verbatim under a Ready badge.
  //   - `tavily.search` and `searxng.search` are unavailable, which is a true
  //     state but not one a feature page should lead with. They stay in the
  //     list as the unselected options a reader is being offered, which is what
  //     the lanes tab is for — but the frames capture the ready half.
  //
  // None of this is cosmetic: `availability` and `issues` are read straight
  // off this seed by the lane and pipeline rows (the fixture server passes
  // `fetch.pipelines` through unchanged), and the overview's readiness row is
  // DERIVED from it by `nbSearchReadinessFromCapabilities`. So setting them is
  // declaring a different, and schema-valid, configuration — not overriding a
  // verdict after the fact.
  const readyPipeline = (id) => ({
    ...base.nbSearchCapabilities.fetch.pipelines.find((pipeline) => pipeline.id === id),
    availability: 'ready',
    issues: [],
  });
  const readyLane = (id) => ({
    ...base.nbSearchCapabilities.search.lanes.find((lane) => lane.id === id),
    availability: 'ready',
    issues: [],
  });

  /**
   * The overview's summary line is computed by `anyPartial` in
   * `NbSearchOverviewTab`, which ORs the issue list of EVERY provider
   * instance, EVERY lane and EVERY pipeline — not only the ones in use. So a
   * single unused method still carrying a credential issue puts
   * "Partially ready — some lanes or pipelines still report issues" across
   * the bottom of the one frame whose whole subject is "this module is set up
   * and working".
   *
   * The methods that need a key are therefore removed from this world rather
   * than left failing. They are not hidden: the lanes frame is where the
   * reader sees which methods are on offer, and a server being read as fully
   * configured here is a truthful picture — the ones needing a key are simply
   * not configured on it. Keeping a red option in a "working configuration"
   * screenshot states a falsehood about the server the frame is showing.
   */
  const usableLaneIds = ['exa.search', 'github.repositories', 'example.documents'];

  // The shipped world names one preset `fixture-fast`, and the lanes tab
  // prints preset names in its lower third — so a frame of that tab would
  // carry the fixture's own vocabulary into a public page.
  //
  // The rename has to happen on `inherited_configuration`, not on
  // `configuration`: the server rebuilds `configuration.presets` from the
  // inherited block plus `config.presets`, so a preset renamed only in the
  // projection is silently replaced by the inherited one and the frame still
  // reads `fixture-fast`.
  const PRESET = 'quick-web';
  const LANES = ['exa.search', 'github.repositories'];
  const inheritedPresets = Object.fromEntries(
    Object.keys(inherited.inherited_configuration?.presets ?? {}).map(() => [PRESET, { lanes: LANES }]),
  );
  return {
    ...world,
    config: {
      ...world.config,
      nb_search_source: { reuse_local_config: true },
      nb_search: {
        presets: { 'fixture-fast': null, [PRESET]: { lanes: LANES } },
      },
    },
    nbSearchCapabilities: {
      ...inherited,
      inherited_configuration: {
        ...inherited.inherited_configuration,
        presets: inheritedPresets,
        // The inherited block is what the server projects the running default
        // from — `inherited.default_search_lane` wins over the `search` block's
        // own value — and the shipped one is `github.repositories`, a
        // repository-only lane. The lanes frame would then have offered a
        // reader "use the current default" for a method that only searches
        // repositories, with the overview's "In effect" line agreeing. A
        // general web-search lane is the honest default for a page
        // documenting what WebSearch runs on.
        default_search_lane: 'exa.search',
      },
      search: {
        ...inherited.search,
        // The default lane the overview reports as "In effect", and the one the
        // lanes frame shows checked.
        default_lane: 'exa.search',
        lanes: usableLaneIds.map(readyLane),
      },
      fetch: {
        ...inherited.fetch,
        // A two-step chain that actually works: fetch the page directly, and
        // fall back to a reader that renders it when the direct request comes
        // back too thin to use. The fallback sentence under the chain is the
        // page's own copy, and it is only true if the second step can run.
        chains: [{ input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch', 'jina.reader'] }],
        pipelines: [
          readyPipeline('direct.fetch'),
          readyPipeline('jina.reader'),
          // The keyless renderer, kept in the dropdown the way a reader would
          // leave it: a third option that exists and works, so the chain's
          // ordering is visibly a choice rather than the only arrangement.
          readyPipeline('browser.render'),
        ],
      },
      config_source: {
        reuse_local_config: true,
        layers: ['defaults', 'local', 'environment', 'kiki'],
        local_config: 'present',
        availability: 'ready',
        issues: [],
      },
      // Provider instances are the third term in `anyPartial`, so an instance
      // carrying a credential issue keeps the summary line red even with both
      // tools reporting Ready. Only the instances this world's lanes actually
      // route through are kept, and each is reported as configured: this is
      // the state of a server whose search setup is complete.
      providers: {
        ...inherited.providers,
        instances: ['exa.default', 'github.default', 'jina-reader.default', 'direct-http.default', 'example.default']
          .map((id) => inherited.providers.instances.find((instance) => instance.id === id))
          .filter((instance) => instance !== undefined)
          .map((instance) => ({
            ...instance,
            availability: 'ready',
            issues: [],
            credential: { ...instance.credential, configured: true },
          })),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// ce-freedom-permissions — a session, because the permission control lives
// in the composer and nowhere else
// ---------------------------------------------------------------------------

const PERMISSION_SID = 'session_fixture_ce_permissions';

/**
 * A session whose only job is to carry a composer.
 *
 * The permission mode control has no settings page: it is the approvals chip
 * in the composer's status line, and the four modes live in the menu that
 * chip opens. A settings-shaped world therefore cannot carry this frame at
 * all — it needs a session, and a transcript beside the composer is what makes
 * the chip's meaning legible ("how often it asks" is a question about the
 * work, not about a preference).
 *
 * The turn is deliberately one ordinary tool call that went through on its
 * own. That is the state the Auto row describes, so the menu is not a list of
 * abstractions floating above an empty session.
 */
export function buildFreedomPermissions(locale) {
  const world = settingsWorld();
  const now = Date.now();
  // The composer's status line prints the session's model and thinking effort
  // beside the approvals chip, and the base settings world's model is called
  // "Kiki Pro" — a name no real provider has, so it reads as a fixture
  // artifact inside the very control this frame is about. Point the session
  // at the same neutral hosted model the connections frames use.
  const MODEL = 'kimi-code/kimi-k2';
  return {
    ...world,
    models: [
      { provider: 'managed:kimi-code', model: MODEL, display_name: 'Kimi K2', max_context_size: 262_144, capabilities: ['chat', 'reasoning'] },
    ],
    providers: [
      {
        id: 'managed:kimi-code', type: 'kimi', base_url: 'https://api.kimi.example.test/coding/v1',
        has_api_key: false, status: 'connected', default_model: MODEL, models: [MODEL],
      },
    ],
    sessions: [sessionRecord(PERMISSION_SID, {
      title: pick(locale, 'Release checklist', '发布清单'),
      agent_config: { model: MODEL, executor: '' },
    })],
    snapshots: {
      [PERMISSION_SID]: {
        messages: [{
          id: 'msg_ce_perm_user', part: 'user',
          text: pick(locale, 'Check the release checklist and tell me what is still open.', '看一下发布清单，告诉我还有哪些没做。'),
          created_at: new Date(now - 240_000).toISOString(),
        }],
        has_more: false,
      },
    },
    config: {
      ...world.config,
      default_provider: 'managed:kimi-code',
      default_model: MODEL,
      // `review` is the mode this frame selects. The walker still presses the
      // row, because the chip resolves from live session state first and this
      // is only the fallback.
      default_permission_mode: 'review',
      providers: { 'managed:kimi-code': { type: 'kimi', has_api_key: false } },
    },
    auth: { ready: true, providers_count: 1, default_model: MODEL, managed_provider: null },
  };
}

// ---------------------------------------------------------------------------
// ce-freedom-prompts — prompt field overrides
// ---------------------------------------------------------------------------

/**
 * Prompt field overrides, seeded so the editor and its live preview have real
 * values.
 *
 * The frame replaces the existing `freedom-prompt-overrides` master, which
 * shows the same screen with the card's heading cut in half at the top edge
 * and its preview cropped at the bottom. The values here are also a better
 * match for the prose: the page's example field id is
 * `tool.web-search.description`, and the old master overrode
 * `tool.grep.description` instead — a tool the sentence never mentions.
 */
export function buildFreedomPrompts(locale) {
  const world = settingsWorld();
  return {
    ...world,
    config: {
      ...world.config,
      // The whole prompt config lives under `config.prompt`, and inside it
      // `variables` sits beside `overrides` (which holds the files and the
      // fields). Seeding `variables`/`overrides` at the top level of the
      // config parses as a server with no prompt config at all, and the
      // editor then opens on the empty draft a first-time visitor sees — a
      // different frame from the one this page is about.
      prompt: {
        variables: { product: 'sample-app', audience: pick(locale, 'the release team', '发布团队') },
        overrides: {
          files: ['prompts/release-checklist.md'],
          fields: {
            'tool.web-search.description': pick(
              locale,
              'Search the web for current information. Pass a path to narrow it.',
              '检索网页上的当前信息；传入 path 可以缩小范围。',
            ),
            'agent.identity': 'You are working on ${product} with ${audience}.',
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// ce-ecosystem-engines — the external-executor direction
// ---------------------------------------------------------------------------

/**
 * External engines. Ecosystem's third section is the reversed direction: a
 * profile carries an `executor` and runs on another harness, and Settings →
 * External engines checks whether each one is installed and lists the steps
 * that remain.
 *
 * The list is that surface. Four rows sit together on purpose: two ready with
 * a version, one ready but signed out (so the setup steps are the content
 * rather than an error), and one missing with the install command. A reader
 * meets all of these on a real machine, and a frame that showed only the ready
 * rows would imply the product only ever says yes.
 */
export function buildEcosystemEngines(_locale) {
  const world = settingsWorld();
  return {
    ...world,
    // The base settings world ships two providers named literally `fixture`
    // and `alt`. They are not wrong data, but a public frame with a connection
    // called `fixture` on it is a fixture artifact, and this frame's whole
    // subject is a list of engines — the connection list above it is context,
    // not the point, so it should not be carrying a giveaway either.
    providers: [
      {
        id: 'managed:kimi-code', type: 'kimi', base_url: 'https://api.kimi.example.test/coding/v1',
        has_api_key: false, status: 'connected', default_model: 'kimi-code/kimi-k2',
        models: ['kimi-code/kimi-k2'],
      },
      {
        id: 'byo-endpoint', type: 'openai', base_url: 'https://api.example.test/v1',
        has_api_key: true, status: 'connected', default_model: 'kimi-code/kimi-k2',
        models: ['kimi-code/kimi-k2'],
      },
    ],
    models: [
      { provider: 'managed:kimi-code', model: 'kimi-code/kimi-k2', display_name: 'Kimi K2', max_context_size: 262_144, capabilities: ['chat', 'reasoning'] },
    ],
    config: {
      ...world.config,
      providers: { 'managed:kimi-code': { type: 'kimi', has_api_key: false } },
    },
    executors: [
      { id: 'native', label: 'Kiki', protocol: 'native', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' },
      {
        id: 'claude-acp', label: 'Claude Code', protocol: 'acp-v1', status: 'ready', version: '0.84.0',
        model_binding: 'mapped', thinking_binding: 'unavailable', default_profile: true,
        capabilities: { prompt_deliveries: ['preamble'], steer: 'next_turn_preamble', permission: { via: 'session_mode', trust_engine_settings: true }, thinking_binding: false },
        connection: { command: 'claude', source: 'path', install_hint: 'npm install -g @anthropic-ai/claude-code' },
      },
      {
        // Ready as a program, but it has not signed in. The remaining step is
        // a login command, which is the honest state on a fresh machine.
        id: 'codex', label: 'Codex', protocol: 'codex-app-server', status: 'ready', version: '0.52.0',
        model_binding: 'mapped', thinking_binding: 'mapped',
        capabilities: { prompt_deliveries: ['preamble'], steer: 'next_turn_preamble', permission: { via: 'tool', trust_engine_settings: false }, thinking_binding: true },
        connection: { command: 'codex', source: 'path' },
      },
      {
        // Not on this machine: the row is the install instruction.
        id: 'gemini-cli', label: 'Gemini CLI', protocol: 'acp-v1', status: 'unavailable',
        model_binding: 'mapped', thinking_binding: 'mapped',
        capabilities: { prompt_deliveries: ['preamble'], steer: 'next_turn_preamble', permission: { via: 'session_mode', trust_engine_settings: true }, thinking_binding: false },
        connection: { command: 'gemini', source: 'path', install_hint: 'npm install -g @google/gemini-cli' },
      },
    ],
    // What a check returns for each. `login_status` is the field the row's
    // "signed out" line reads, and Codex is the one that carries it.
    executorChecks: {
      'claude-acp': {
        id: 'claude-acp', status: 'ready', version: '0.84.0', command: 'claude',
        selected_source: 'path', resolved_args: [], login_status: 'logged_in', diagnostics: [],
      },
      codex: {
        id: 'codex', status: 'warning', version: '0.52.0', command: 'codex',
        selected_source: 'path', resolved_args: [], login_status: 'logged_out',
        diagnostics: [{ severity: 'warning', message: 'Codex is installed but not signed in. Run `codex login` to sign in.' }],
      },
      'gemini-cli': {
        id: 'gemini-cli', status: 'unavailable', version: null, command: 'gemini',
        selected_source: 'path', resolved_args: [], login_status: 'unknown',
        diagnostics: [{ severity: 'error', message: 'gemini was not found on PATH.' }],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// ce-ecosystem-import — native history import, the sources and the losses
// ---------------------------------------------------------------------------

/**
 * History import. Ecosystem's first section is a promise about losses, and the
 * preview card is the one confirmation the conversation gets.
 *
 * The existing `ecosystem-history-import` frame already shows this well, so
 * this world exists to give the page a second angle it currently has none of:
 * the **source list itself** with two homes probed, one readable and one not.
 * That is a different claim from the preview — that a source can be unreadable
 * and you find out before you commit — and it is the claim a reader has to
 * make before they trust the preview.
 */
export function buildEcosystemImport(locale) {
  const world = settingsWorld();
  const HISTORY_PLUGIN = 'kiki-history';
  const source = (id, label) => ({ pluginId: HISTORY_PLUGIN, id, label, formatVersion: `${id}.history.v1` });
  const record = (id, part, role, text) => ({ id, part, role, text });
  const title = pick(locale, 'Migrate the search index to the new analyzer', '把搜索索引迁到新的分析器');
  return {
    ...world,
    pluginImport: {
      hostShipped: { [HISTORY_PLUGIN]: true },
      sources: [
        source('claude-code', 'Claude Code'),
        source('codex', 'Codex'),
        source('pi', 'Pi'),
        source('grok', 'Grok'),
        source('opencode', 'OpenCode'),
        source('custom', pick(locale, 'Custom script', '自定义脚本')),
      ],
      homes: {
        // One home with conversations, so the discovery list is not empty.
        [`${HISTORY_PLUGIN}:claude-code:C:/Users/you/.claude`]: {
          probe: {
            revision: 'rev_ce_import_1',
            title,
            formatVersion: 'claude-code.history.v1',
            status: 'partial',
            losses: [],
            totalBytes: 184_200,
            sourceHome: 'C:/Users/you/.claude',
          },
          entries: [
            { externalId: 'conv_search_index', title },
            { externalId: 'conv_docs', title: pick(locale, 'Rewrite the docs landing page', '重写文档首页') },
            { externalId: 'conv_flake', title: pick(locale, 'Track down the flaky settings test', '定位那个不稳定的设置测试') },
          ],
          pages: [{ records: [record('r1', 0, 'user', pick(locale, 'Can we migrate the search index to the new analyzer?', '能把搜索索引迁到新分析器吗？'))], cursor: null, losses: [], bytesRead: 4_100 }],
        },
        // A second home that is genuinely empty, so the "this source has
        // nothing" state is visible beside the one that has something.
        [`${HISTORY_PLUGIN}:codex:C:/Users/you/.codex`]: {
          probe: { revision: 'rev_ce_import_2', title: '', formatVersion: 'codex.history.v1', status: 'empty', losses: [], totalBytes: 0, sourceHome: 'C:/Users/you/.codex' },
          entries: [],
          pages: [],
        },
      },
      destination: { kind: 'native-session', workDir: 'C:/Projects/sample-app' },
    },
  };
}
