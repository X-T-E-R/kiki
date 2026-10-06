import { hostname } from 'node:os';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { ICapabilityService } from '#/app/capability/capability';
import type { CapabilityStatus } from '#/app/capability/types';
import { ConfigTarget, IConfigService } from '#/app/config/config';
import { EXPERIMENTAL_SECTION, IFlagService } from '#/app/flag/flag';
import { IPluginService } from '#/app/plugin/plugin';
import { readDefaultPluginCatalog } from '#/app/plugin/defaultCatalog';
import { isRecognizedWebbridgePluginSource } from '#/app/plugin/prerequisites';
import { LifecycleScope } from '#/app/scopes';
import { IBrowserControlService } from './browser';
import { IBrowserConnectionStore } from './browserConnectionStore';
import { BrowserIdSchema } from './browserConfig';
import { BrowserError } from './errors';
import { IBrowserSetupService, type BrowserPresetId, type BrowserSetupConnectInput, type BrowserSetupStatus, type BrowserSetupStep } from './browserSetup';
import { readWebbridgeStatus, probeWebbridgeConnection } from './browserWebbridge';

const KIMI_HELP = 'https://www.kimi.com/en/help/kimi-webbridge/kimi-webbridge-introduction';
const CODEX_HELP = 'https://developers.openai.com/codex/app/chrome-extension';
const CHROME_STORE = 'https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc';
const EDGE_STORE = 'https://microsoftedge.microsoft.com/addons/detail/kimi-webbridge/bnlffdbcfnanfbknnlaflhlhkocccckg';
const INDEPENDENT_ID = 'independent-browser';

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
          { id: 'prepare' }, { id: 'connect' },
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
      actions: installing ? [{ id: 'cancel' }] : blocked?.reason === 'feature_forced_off' ? [] : [{ id: 'prepare' }, { id: 'connect' }],
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
