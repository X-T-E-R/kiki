import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import { join } from 'pathe';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ICapabilityService } from '#/app/capability/capability';
import type { CapabilityStatus } from '#/app/capability/types';
import { runCommand } from '#/app/capability/host';
import { windowsPowerShellPath } from '#/app/capability/entries/kimiCu';
import { installedBrowserChrome } from '#/app/capability/entries/browserResourceStore';
import { ConfigTarget, IConfigService } from '#/app/config/config';
import { EXPERIMENTAL_SECTION, IFlagService } from '#/app/flag/flag';
import { IPluginService } from '#/app/plugin/plugin';
import { readDefaultPluginCatalog } from '#/app/plugin/defaultCatalog';
import { isRecognizedWebbridgePluginSource } from '#/app/plugin/prerequisites';
import { LifecycleScope } from '#/app/scopes';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IBrowserControlService, type BrowserStatus } from './browser';
import { browserResponse } from './browserControlService';
import { IBrowserConnectionStore } from './browserConnectionStore';
import { BrowserIdSchema } from './browserConfig';
import { BrowserError } from './errors';
import { IBrowserSetupService, type BrowserPresetId, type BrowserSetupConnectInput, type BrowserSetupOpenInput, type BrowserSetupUpdateInput, type BrowserSetupShortcutInput, type BrowserSetupStatus, type BrowserSetupStep } from './browserSetup';
import { readWebbridgeStatus, probeWebbridgeConnection } from './browserWebbridge';

const KIMI_HELP = 'https://www.kimi.com/en/help/kimi-webbridge/kimi-webbridge-introduction';
const CODEX_HELP = 'https://developers.openai.com/codex/app/chrome-extension';
const CHROME_STORE = 'https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc';
const EDGE_STORE = 'https://microsoftedge.microsoft.com/addons/detail/kimi-webbridge/bnlffdbcfnanfbknnlaflhlhkocccckg';
const INDEPENDENT_ID = 'independent-browser';
const SHORTCUT_DESKTOP_FIXTURE = 'KIKI_BROWSER_SHORTCUT_DESKTOP';
const SHORTCUT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'if ($args.Count -ne 1) { throw "Shortcut payload path is required" }',
  '$json = Get-Content -LiteralPath $args[0] -Raw -Encoding UTF8',
  'if ($json.Length -gt 0 -and $json[0] -eq [char]0xFEFF) { $json = $json.Substring(1) }',
  '$payload = $json | ConvertFrom-Json',
  '$desktop = [string]$payload.desktop',
  '$name = [string]$payload.name',
  '$target = [string]$payload.target',
  '$arguments = [string]$payload.arguments',
  "if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path -LiteralPath $desktop -PathType Container)) { throw 'Desktop folder not found' }",
  "if ([string]::IsNullOrWhiteSpace($name) -or $name -match '[\\\\/:]' -or $name -eq '..' -or $name -eq '.') { throw 'Invalid shortcut name' }",
  "$shortcutName = $name + '.lnk'",
  "if ([System.IO.Path]::GetFileName($shortcutName) -ne $shortcutName) { throw 'Invalid shortcut name' }",
  '$shortcutPath = Join-Path -Path $desktop -ChildPath $shortcutName',
  "$desktopFull = [System.IO.Path]::GetFullPath($desktop).TrimEnd('\\')",
  "$shortcutFull = [System.IO.Path]::GetFullPath($shortcutPath)",
  "if (-not $shortcutFull.StartsWith($desktopFull + '\\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Shortcut path escaped the desktop' }",
  '$shell = New-Object -ComObject WScript.Shell',
  'if (Test-Path -LiteralPath $shortcutPath) {',
  '  $existing = $shell.CreateShortcut($shortcutPath)',
  "  $existingTarget = ''",
  '  if ($existing.TargetPath) { $existingTarget = [System.IO.Path]::GetFullPath([string]$existing.TargetPath) }',
  '  $wantedTarget = [System.IO.Path]::GetFullPath($target)',
  '  if ($existingTarget -ne $wantedTarget -or [string]$existing.Arguments -ne $arguments) {',
  '    throw "Existing unrelated shortcut found at $shortcutPath"',
  '  }',
  '}',
  '$created = $shell.CreateShortcut($shortcutPath)',
  '$created.TargetPath = $target',
  '$created.Arguments = $arguments',
  '$created.Save()',
].join('\r\n');

function shortcutStem(name: string): string {
  const stem = name.trim();
  if (stem.length < 1 || stem.length > 240 || stem === '.' || stem === '..' || path.win32.basename(stem) !== stem) {
    throw new BrowserError('browser.invalid', 'Shortcut name must be a single file name on the desktop');
  }
  if (/[<>:"|?*\\/\u0000-\u001f]/.test(stem) || stem.endsWith('.') || stem.endsWith(' ')) {
    throw new BrowserError('browser.invalid', 'Shortcut name must be a single file name on the desktop');
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(stem)) {
    throw new BrowserError('browser.invalid', 'Shortcut name must be a single file name on the desktop');
  }
  return stem;
}

function profileShortcutArguments(profilePath: string): string {
  if (profilePath.length === 0 || /[\0\r\n"]/.test(profilePath)) {
    throw new BrowserError('browser.invalid', 'Browser profile path cannot be stored in a shortcut');
  }
  return `--user-data-dir="${profilePath}"`;
}

function diskUpdateFact(note: string | undefined): { reason: string; detail: string } | undefined {
  if (note === 'webbridge-disk-updated' || note === 'browser-components-updated-on-disk') {
    return { reason: 'disk_updated', detail: 'Files on disk were replaced. A browser or daemon that is already running was not switched.' };
  }
  if (note === 'webbridge-disk-updated-running-daemon-unchanged') {
    return { reason: 'disk_updated_running_unchanged', detail: 'Files on disk were replaced. The running WebBridge daemon was not stopped or switched.' };
  }
  return undefined;
}

export class BrowserSetupService implements IBrowserSetupService {
  declare readonly _serviceBrand: undefined;
  private readonly preparing = new Map<BrowserPresetId, Promise<void>>();
  private readonly errors = new Map<BrowserPresetId, string>();
  private readonly checked = new Map<BrowserPresetId, string>();
  private independentConnectionId = INDEPENDENT_ID;

  constructor(
    @ICapabilityService private readonly capabilities: ICapabilityService,
    @IPluginService private readonly plugins: IPluginService,
    @IBrowserControlService private readonly control: IBrowserControlService,
    @IBrowserConnectionStore private readonly connections: IBrowserConnectionStore,
    @IFlagService private readonly flags: IFlagService,
    @IConfigService private readonly config: IConfigService,
    @ILogService private readonly log: ILogService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostProcessService private readonly hostProcess: IHostProcessService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
  ) {}

  list(): Promise<{ readonly presets: readonly BrowserSetupStatus[] }> {
    return Promise.all((['kimi-webbridge', 'independent-browser', 'codex-browser'] as const).map((preset) => this.status(preset))).then((presets) => ({ presets }));
  }

  async status(preset: BrowserPresetId): Promise<BrowserSetupStatus> {
    if (preset === 'codex-browser') return {
      preset, displayName: 'Codex / ChatGPT browser extension', controlSurface: 'external-app', supported: false,
      state: 'external_only', executionHost: hostname(), sourceUrl: CODEX_HELP,
      reason: 'external_app_required', steps: [{ id: 'desktop-app', state: 'user_action', reason: 'external_app_required' }],
      actions: [{ id: 'open_instructions', url: CODEX_HELP, target: 'documentation' }],
    };
    if (preset !== 'kimi-webbridge' && preset !== 'independent-browser') throw new BrowserError('browser.invalid', 'Unknown browser setup preset');
    const capability = await this.capabilities.getCapability(preset === 'kimi-webbridge' ? preset : 'kiki-browser');
    const installing = this.preparing.has(preset) || capability.install.running;
    const error = this.errors.get(preset) ?? capability.install.error;
    if (preset === 'kimi-webbridge') {
      const bridge = await readWebbridgeStatus();
      const steps = this.capabilitySteps(capability);
      if (this.preparing.has(preset)) steps.push({ id: 'plugin', state: 'running', reason: 'preparing_plugin' });
      if (bridge?.versionMismatch === true) steps.push({ id: 'compatibility', state: 'warning', reason: 'version_mismatch' });
      const ready = capability.steps.filter((step) => !step.optional).every((step) => step.state === 'ok') && bridge?.extensionConnected === true;
      return {
        preset, displayName: 'Kimi Browser Extension', controlSurface: 'plugin-skill', pluginId: preset, skill: preset,
        capabilityId: preset, supported: capability.supported, executionHost: hostname(), sourceUrl: KIMI_HELP,
        state: installing ? 'preparing' : error !== undefined ? 'failed' : !capability.supported ? 'unsupported'
          : ready ? this.checked.has(preset) ? 'connected' : 'ready' : bridge?.running === true ? 'needs_user_action' : 'not_prepared',
        steps, error, checkedAt: ready ? this.checked.get(preset) : undefined,
        actions: installing ? [] : [
          { id: 'prepare' },
          ...(ready ? [{ id: 'open' as const }] : []),
          { id: 'connect' },
          { id: 'update' },
          { id: 'install_extension', url: CHROME_STORE, target: 'chrome' }, { id: 'install_extension', url: EDGE_STORE, target: 'edge' },
          { id: 'open_instructions', url: KIMI_HELP, target: 'documentation' },
        ],
      };
    }
    const connection = (await this.connections.list()).connections.find((item) => item.id === this.independentConnectionId);
    const status = connection === undefined ? undefined : await this.control.status(connection.id);
    const feature = this.flags.enabled('native_browser');
    const blocked = feature ? undefined : this.featureBlock();
    const steps = this.capabilitySteps(capability);
    const prepared = capability.state === 'ready' || connection?.executablePath !== undefined && steps.find((step) => step.id === 'driver')?.state === 'ready';
    if (blocked !== undefined) steps.push({ id: 'feature', state: 'user_action', ...blocked });
    return {
      preset, displayName: 'Independent browser', controlSurface: 'browser-connection', capabilityId: 'kiki-browser',
      supported: capability.supported, executionHost: hostname(), sourceUrl: 'https://github.com/vercel-labs/agent-browser',
      state: installing ? 'preparing' : error !== undefined ? 'failed' : !capability.supported ? 'unsupported'
        : blocked?.reason === 'feature_forced_off' ? 'needs_user_action' : !prepared ? 'not_prepared' : !feature ? 'needs_user_action' : status?.state === 'failed' || status?.state === 'unconfirmed' ? 'failed' : status?.state === 'ready' || status?.state === 'running' ? 'connected' : 'ready',
      steps, error: error ?? status?.error, reason: blocked?.reason, connectionId: connection?.id, connection: status,
      actions: installing ? [{ id: 'cancel' }] : blocked?.reason === 'feature_forced_off' ? [] : [
        { id: 'prepare' },
        ...(prepared ? [
          { id: 'open' as const },
          { id: 'connect' as const },
          { id: 'update' as const },
          ...(process.platform === 'win32' ? [{ id: 'shortcut' as const }] : []),
        ] : [{ id: 'connect' as const }]),
      ],
    };
  }

  async prepare(preset: BrowserPresetId, input: { readonly consent: true }): Promise<BrowserSetupStatus> {
    if (input.consent !== true) throw new BrowserError('browser.invalid', 'Confirm installation and plugin enablement before preparing browser access');
    if (preset === 'codex-browser') return this.status(preset);
    if (preset !== 'kimi-webbridge' && preset !== 'independent-browser') throw new BrowserError('browser.invalid', 'Unknown browser setup preset');
    if (this.preparing.has(preset)) return this.status(preset);
    this.errors.delete(preset);
    this.checked.delete(preset);
    const work = Promise.resolve().then(async () => {
      if (preset === 'kimi-webbridge') {
        const existing = (await this.plugins.listPlugins()).find((plugin) => plugin.id === preset);
        if (existing === undefined) {
          const catalog = await readDefaultPluginCatalog();
          const entry = catalog.marketplace.plugins.find((plugin) => plugin.id === preset && isRecognizedWebbridgePluginSource(preset, plugin.source));
          if (entry?.sha256 === undefined) throw new Error('The official Kimi browser plugin has no verified install source; refresh the plugin catalog and retry');
          const plan = await this.plugins.previewPlugin({ source: entry.source, sha256: entry.sha256 });
          if (plan.id !== preset || plan.unsupported.length > 0) throw new Error('The Kimi browser plugin package is incompatible; update Kiki or use the official instructions');
          await this.plugins.installPlugin({ source: entry.source, sha256: entry.sha256, fingerprint: plan.fingerprint, consent: true });
        }
        await this.plugins.setPluginEnabled({ id: preset, enabled: true });
      }
      const id = preset === 'kimi-webbridge' ? preset : 'kiki-browser';
      const capability = await this.capabilities.getCapability(id);
      if (preset === 'independent-browser' && (!capability.supported || !this.flags.enabled('native_browser') && this.featureBlock().reason === 'feature_forced_off')) return;
      if (!capability.install.running && capability.state !== 'ready') await this.capabilities.installCapability(id, capability.plan?.artifact.sha256, preset === 'independent-browser' ? 'managed-browser' : undefined);
      if (preset === 'independent-browser' && !this.flags.enabled('native_browser')) await this.config.set(EXPERIMENTAL_SECTION, { native_browser: true }, ConfigTarget.User);
    }).catch((error: unknown) => {
      this.errors.set(preset, error instanceof Error ? error.message : 'Browser preparation failed; retry');
      this.log.warn('browser setup preparation failed', { preset, error });
    }).finally(() => { this.preparing.delete(preset); });
    this.preparing.set(preset, work);
    return this.status(preset);
  }

  async connect(preset: BrowserPresetId, input: BrowserSetupConnectInput): Promise<BrowserSetupStatus> {
    if (preset === 'codex-browser') return this.status(preset);
    this.errors.delete(preset);
    const ready = await this.status(preset);
    if (ready.state === 'preparing' || ready.state === 'unsupported') return ready;
    if (preset === 'kimi-webbridge') {
      if (ready.state !== 'ready' && ready.state !== 'connected') return ready;
      try {
        await probeWebbridgeConnection();
        this.checked.set(preset, new Date().toISOString());
      } catch (error) {
        this.checked.delete(preset);
        this.errors.set(preset, error instanceof Error ? error.message : 'WebBridge connection failed');
      }
      return this.status(preset);
    }
    if (preset !== 'independent-browser') throw new BrowserError('browser.invalid', 'Unknown browser setup preset');
    const id = input.connectionId ?? INDEPENDENT_ID;
    if (!BrowserIdSchema.safeParse(id).success) throw new BrowserError('browser.invalid', 'Invalid browser connection id');
    const existing = (await this.connections.list()).connections.find((connection) => connection.id === id);
    if (existing !== undefined && existing.type !== 'agent-browser-profile') return { ...ready, state: 'needs_user_action', reason: 'connection_conflict', actions: [{ id: 'choose_connection' }] };
    const componentsReady = this.flags.enabled('native_browser') && ready.steps.find((step) => step.id === 'driver')?.state === 'ready'
      && (existing?.executablePath !== undefined || ready.steps.find((step) => step.id === 'chrome')?.state === 'ready');
    if (!componentsReady) return ready;
    if (existing === undefined) await this.control.upsert(id, { type: 'agent-browser-profile', name: input.name ?? 'Independent browser', enabled: true, headed: true });
    this.independentConnectionId = id;
    const status = await this.control.connect(id);
    if (status.state === 'ready' && input.setDefault === true) await this.connections.setDefault(id);
    return { ...await this.status(preset), connectionId: id, connection: status,
      state: status.state === 'ready' ? 'connected' : 'failed', error: status.error, reason: status.failure?.reason };
  }

  async cancel(preset: BrowserPresetId): Promise<BrowserSetupStatus> {
    if (preset !== 'independent-browser') throw new BrowserError('browser.invalid', 'This preset has no cancellable component installation');
    await this.preparing.get(preset);
    await this.capabilities.cancelCapability('kiki-browser');
    this.errors.delete(preset);
    return { ...await this.status(preset), reason: 'cancelled' };
  }

  async open(preset: BrowserPresetId, input: BrowserSetupOpenInput = {}): Promise<BrowserSetupStatus> {
    if (preset === 'codex-browser') return this.status(preset);
    if (preset === 'kimi-webbridge') return this.connect(preset, input);
    if (preset !== 'independent-browser') throw new BrowserError('browser.invalid', 'Unknown browser setup preset');
    this.errors.delete(preset);
    const id = input.connectionId ?? this.independentConnectionId;
    if (!BrowserIdSchema.safeParse(id).success) throw new BrowserError('browser.invalid', 'Invalid browser connection id');
    const existing = (await this.connections.list()).connections.find((c) => c.id === id);
    if (existing !== undefined && existing.type !== 'agent-browser-profile') {
      return { ...await this.status(preset), connectionId: id, connection: undefined, state: 'needs_user_action', reason: 'connection_conflict', actions: [{ id: 'choose_connection' }] };
    }
    if (existing?.enabled === false) {
      return { ...await this.status(preset), connectionId: id, connection: undefined, state: 'needs_user_action', reason: 'connection_disabled', error: 'This browser connection is disabled', actions: [{ id: 'choose_connection' }] };
    }
    if (!this.flags.enabled('native_browser')) return this.status(preset);
    const prepared = await this.status(preset);
    if (prepared.state === 'preparing' || prepared.state === 'unsupported' || prepared.state === 'not_prepared') return prepared;
    try {
      if (existing === undefined) {
        await this.control.upsert(id, { type: 'agent-browser-profile', name: 'Independent browser', enabled: true, headed: true });
      } else if (existing.headed !== true) {
        await this.control.upsert(id, { type: 'agent-browser-profile', name: existing.name, enabled: existing.enabled, headed: true, profilePath: existing.profilePath, executablePath: existing.executablePath, driverPath: existing.driverPath });
      }
      this.independentConnectionId = id;
      const current = await this.control.status(id);
      if (current.state !== 'ready') {
        const status = await this.control.connect(id);
        return this.openResult(preset, id, status);
      }
      const invoked = await this.control.invoke({
        browser: id, caller: { sessionId: 'browser-setup', agentId: 'main' }, tool: 'agent_browser_open', args: {},
      });
      const body = browserResponse(invoked.result);
      if (invoked.result.isError === true || body.success !== true) {
        const message = body.error ?? 'Browser open was not confirmed';
        this.errors.set(preset, message);
        const status = await this.control.status(id);
        return { ...await this.status(preset), connectionId: id, connection: status, state: 'failed', error: message };
      }
      return this.openResult(preset, id, await this.control.status(id));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Browser open failed';
      this.errors.set(preset, message);
      this.log.warn('browser setup open failed', { preset, connectionId: id, error });
      return { ...await this.status(preset), connectionId: id, state: 'failed', error: message };
    }
  }

  async update(preset: BrowserPresetId, _input: BrowserSetupUpdateInput = {}): Promise<BrowserSetupStatus> {
    if (preset === 'codex-browser') return this.status(preset);
    if (preset !== 'kimi-webbridge' && preset !== 'independent-browser') throw new BrowserError('browser.invalid', 'Unknown browser setup preset');
    this.errors.delete(preset);
    const id = preset === 'kimi-webbridge' ? preset : 'kiki-browser';
    try {
      await this.capabilities.updateCapability(id);
    } catch (error) {
      this.errors.set(preset, error instanceof Error ? error.message : 'Browser update failed; retry');
      this.log.warn('browser setup update failed', { preset, error });
      return this.status(preset);
    }
    const capability = await this.capabilities.getCapability(id);
    const status = await this.status(preset);
    if (capability.install.error !== undefined || status.state === 'failed') return status;
    const disk = diskUpdateFact(capability.install.note);
    if (disk === undefined) return status;
    return { ...status, reason: disk.reason, steps: [...status.steps, { id: 'update', state: 'ready', reason: disk.reason, detail: disk.detail }] };
  }

  async createShortcut(preset: BrowserPresetId, input: BrowserSetupShortcutInput = {}): Promise<BrowserSetupStatus> {
    if (preset !== 'independent-browser') throw new BrowserError('browser.invalid', 'Desktop shortcut is only available for independent browser');
    const shortcutName = shortcutStem(input.name ?? 'Kiki Independent Browser');
    if (process.platform !== 'win32') throw new BrowserError('browser.unsupported', 'Desktop shortcut creation is supported on Windows execution hosts only');
    if (!this.flags.enabled('native_browser') && this.featureBlock().reason === 'feature_forced_off') {
      throw new BrowserError('browser.disabled', this.featureBlock().detail);
    }
    const id = input.connectionId ?? this.independentConnectionId;
    const resolved = await this.connections.resolve(id);
    if (resolved.type !== 'agent-browser-profile') throw new BrowserError('browser.invalid', 'Desktop shortcut requires a profile-based browser connection');
    if (resolved.enabled === false) throw new BrowserError('browser.disabled', 'This browser connection is disabled');
    const executable = resolved.executablePath ?? (await installedBrowserChrome(this.bootstrap.homeDir))?.executable;
    if (executable === undefined) throw new BrowserError('browser.not_found', 'No browser executable found to create shortcut');
    const profilePath = resolved.profilePath ?? join(this.bootstrap.homeDir, 'browser', 'profiles', resolved.id);
    const desktop = path.win32.resolve(await this.shortcutDesktop());
    const shortcutPath = path.win32.join(desktop, `${shortcutName}.lnk`);
    if (path.win32.resolve(path.win32.dirname(shortcutPath)) !== desktop) {
      throw new BrowserError('browser.invalid', 'Shortcut name must be a single file name on the desktop');
    }
    const requestDir = join(this.bootstrap.homeDir, 'browser', 'shortcut-requests', randomUUID());
    const scriptPath = join(requestDir, 'create-shortcut.ps1');
    const payloadPath = join(requestDir, 'payload.json');
    await this.hostFs.mkdir(requestDir, { recursive: true });
    try {
      await this.hostFs.writeText(scriptPath, SHORTCUT_SCRIPT);
      await this.hostFs.writeText(payloadPath, `\uFEFF${JSON.stringify({
        desktop, name: shortcutName, target: executable, arguments: profileShortcutArguments(profilePath),
      })}`);
      const res = await runCommand(this.hostProcess, windowsPowerShellPath(), [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, payloadPath,
      ], { timeout: 15_000 });
      if (res.code !== 0) {
        const msg = (res.stderr || res.stdout || 'Failed to create desktop shortcut').trim();
        throw new BrowserError('browser.execution_failed', msg);
      }
    } finally {
      await this.hostFs.remove(requestDir);
    }
    return this.status(preset);
  }

  private async shortcutDesktop(): Promise<string> {
    const fixture = process.env[SHORTCUT_DESKTOP_FIXTURE];
    const candidate = fixture !== undefined && fixture.trim().length > 0 ? fixture.trim() : await this.queryDesktop();
    if (!path.win32.isAbsolute(candidate)) throw new BrowserError('browser.execution_failed', 'Desktop folder not found');
    const stat = await this.hostFs.stat(candidate);
    if (!stat.isDirectory) throw new BrowserError('browser.execution_failed', 'Desktop folder not found');
    return candidate;
  }

  private async queryDesktop(): Promise<string> {
    const res = await runCommand(this.hostProcess, windowsPowerShellPath(), [
      '-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('Desktop')",
    ], { timeout: 15_000 });
    if (res.code !== 0) throw new BrowserError('browser.execution_failed', (res.stderr || res.stdout || 'Desktop folder not found').trim());
    return res.stdout.trim();
  }

  private async openResult(preset: BrowserPresetId, id: string, status: BrowserStatus): Promise<BrowserSetupStatus> {
    return { ...await this.status(preset), connectionId: id, connection: status,
      state: status.state === 'ready' ? 'connected' : 'failed', error: status.error, reason: status.failure?.reason };
  }

  private featureBlock(): { reason: string; detail: string } {
    const flag = this.flags.explain('native_browser');
    if (flag?.source === 'env' && !flag.enabled) return { reason: 'feature_forced_off', detail: `${flag.env} disables browser control on this execution host; preparation cannot override the environment` };
    if (this.config.inspect<Record<string, boolean>>(EXPERIMENTAL_SECTION).memoryValue?.['native_browser'] === false) return { reason: 'feature_forced_off', detail: 'A runtime configuration override disables browser control on this execution host; preparation cannot override it' };
    return { reason: 'feature_disabled', detail: 'Prepare installs the required components and enables browser control with your confirmation' };
  }

  private capabilitySteps(capability: CapabilityStatus): BrowserSetupStep[] {
    const steps: BrowserSetupStep[] = capability.steps.filter((step) => !step.optional).map((step) => ({
      id: step.id, state: step.state === 'ok' ? 'ready' : step.state === 'failed' ? 'failed' : step.id === 'extension' ? 'user_action' : 'missing',
      reason: step.reason, detail: step.detail,
    }));
    if (capability.install.running) steps.push({ id: capability.install.step ?? 'install', state: 'running', percent: capability.install.percent });
    return steps;
  }
}

registerScopedService(LifecycleScope.App, IBrowserSetupService, BrowserSetupService, ScopeActivation.OnDemand, 'browser');
