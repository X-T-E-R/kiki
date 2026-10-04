import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, chmod, copyFile, link, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { downloadToFile, runCommand } from '../host';
import { isRecognizedWebbridgePluginSource } from '../../plugin/prerequisites';
import { webbridgeArtifact } from '../verifiedArtifacts';
import type { CapabilityDetectResult, CapabilityEntry, CapabilityInstallReporter, CapabilityStep } from '../types';
import type { CapabilityEntryContext } from './context';

const PLUGIN_ID = 'kimi-webbridge';
const DAEMON_BASE_URL = 'http://127.0.0.1:10086';
const BROWSER_EXTENSION_URL = 'https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc';

interface DaemonStatus {
  readonly running?: boolean;
  readonly version?: string;
  readonly extension_connected?: boolean;
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function createKimiWebbridgeEntry(ctx: CapabilityEntryContext): CapabilityEntry {
  const artifact = ctx.webbridgeArtifact ?? webbridgeArtifact(ctx.platform, ctx.arch);
  const baseUrl = ctx.webbridgeBaseUrl ?? DAEMON_BASE_URL;
  const binDir = path.join(ctx.userHomeDir, '.kimi-webbridge', 'bin');
  const binPath = path.join(binDir, ctx.platform === 'win32' ? 'kimi-webbridge.exe' : 'kimi-webbridge');

  async function exists(file: string): Promise<boolean> {
    return access(file).then(() => true, () => false);
  }

  async function fetchDaemonStatus(): Promise<DaemonStatus | undefined> {
    if (baseUrl !== DAEMON_BASE_URL) return undefined;
    try {
      const resp = await (ctx.fetchImpl ?? fetch)(`${DAEMON_BASE_URL}/status`, {
        signal: AbortSignal.timeout(1_500),
        redirect: 'manual',
      });
      if (!resp.ok) return undefined;
      const payload: unknown = await resp.json();
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
      const data = payload as Record<string, unknown>;
      if (typeof data['running'] !== 'boolean' || typeof data['version'] !== 'string' ||
          typeof data['extension_connected'] !== 'boolean') return undefined;
      return {
        running: data['running'],
        version: data['version'],
        extension_connected: data['extension_connected'],
      };
    } catch {
      return undefined;
    }
  }

  async function detect(): Promise<CapabilityDetectResult> {
    const binaryPresent = await exists(binPath);
    const binaryUsable = binaryPresent &&
      (ctx.platform === 'win32' || await access(binPath, constants.X_OK).then(() => true, () => false));
    const binaryVerified = binaryUsable && artifact !== undefined &&
      (await sha256Of(binPath)) === artifact.sha256;
    const daemon = await fetchDaemonStatus();
    const running = daemon?.running === true;
    const plugin = (await ctx.plugins.listPlugins()).find((item) => item.id === PLUGIN_ID);
    const pluginEnabled = plugin?.enabled === true && plugin.state === 'ok' &&
      plugin.hasErrors !== true && plugin.enabledMcpServerCount === plugin.mcpServerCount;
    const knownSource = isRecognizedWebbridgePluginSource(PLUGIN_ID, plugin?.originalSource);
    const steps: CapabilityStep[] = [
      { id: 'daemon-binary', state: binaryVerified ? 'ok' : 'missing', optional: running,
        reason: binaryPresent && !binaryUsable ? 'binary_not_executable'
          : binaryUsable && !binaryVerified ? 'binary_unverified' : undefined,
        detail: binaryPresent && !binaryUsable ? 'not executable' :
          binaryUsable && !binaryVerified ? 'Unverified: installed daemon binary does not match the pinned release SHA-256' : undefined },
      { id: 'daemon', state: running ? 'ok' : 'missing',
        reason: running ? 'daemon_loopback_unauthenticated' : undefined,
        detail: running ? `Loopback status reports running (${daemon.version}); responding process identity is not authenticated` : undefined },
      { id: 'skill', state: pluginEnabled ? 'ok' : 'missing',
        reason: plugin === undefined ? 'plugin_not_installed'
          : !plugin.enabled ? 'plugin_disabled'
          : plugin.state !== 'ok' || plugin.hasErrors === true ? 'plugin_error'
          : plugin.enabledMcpServerCount !== plugin.mcpServerCount ? 'plugin_mcp_partial' : undefined,
        detail: plugin === undefined ? 'Install the plugin package separately; it will remain disabled until explicitly enabled' :
          !plugin.enabled ? 'Plugin is disabled' :
          plugin.state !== 'ok' || plugin.hasErrors === true ? 'Plugin reports an error' :
          plugin.enabledMcpServerCount !== plugin.mcpServerCount ? 'Plugin MCP servers are not all enabled' : undefined },
      { id: 'extension', state: running && daemon.extension_connected === true ? 'ok' : 'missing',
        reason: running && daemon.extension_connected === false ? 'extension_not_connected'
          : running && daemon.extension_connected === true ? 'extension_reported_unauthenticated' : undefined,
        detail: running && daemon.extension_connected === false ? 'Browser extension is not connected (installation cannot be inferred)' :
          running && daemon.extension_connected === true ? 'Connection is reported by the loopback service, not independently authenticated' : undefined },
      { id: 'daemon-identity', state: 'missing', optional: true,
        reason: 'daemon_identity_unverified',
        detail: 'Unverified: the loopback status cannot authenticate the responding process or browser extension' },
      { id: 'plugin-integrity', state: 'missing', optional: true,
        reason: knownSource ? 'plugin_integrity_unverified' : 'plugin_source_unknown',
        detail: knownSource ? 'Unverified: publisher URL and plugin version do not prove ZIP integrity or daemon compatibility' :
          'Unverified: local or unknown plugin source and daemon compatibility have not been attested' },
    ];
    return { steps, version: daemon?.version };
  }

  async function install(report: CapabilityInstallReporter): Promise<string | undefined> {
    if (artifact === undefined) throw new Error(`WebBridge has no verified artifact for ${ctx.platform}/${ctx.arch}`);
    const status = await fetchDaemonStatus();
    if (status?.running === true) return 'existing-loopback-daemon-observed-identity-unverified';
    if (!(await exists(binPath))) {
      report('download', 0);
      const workDir = await mkdtemp(path.join(tmpdir(), 'kiki-webbridge-'));
      const staging = path.join(workDir, 'daemon');
      const sibling = path.join(binDir, `.${path.basename(binPath)}-${process.pid}-${Date.now()}.tmp`);
      try {
        await downloadToFile(artifact.url, staging, (percent) => report('download', percent),
          ctx.fetchImpl, { sha256: artifact.sha256, maxBytes: artifact.maxBytes });
        if (await sha256Of(staging) !== artifact.sha256) throw new Error('WebBridge staging checksum changed');
        await mkdir(binDir, { recursive: true });
        await copyFile(staging, sibling, constants.COPYFILE_EXCL);
        if (await sha256Of(sibling) !== artifact.sha256) throw new Error('WebBridge copy checksum changed');
        if (ctx.platform !== 'win32') await chmod(sibling, 0o755);
        await link(sibling, binPath);
      } finally {
        await rm(sibling, { force: true }).catch(() => undefined);
        await rm(workDir, { recursive: true, force: true });
      }
    }
    if (await sha256Of(binPath) !== artifact.sha256) {
      throw new Error(`Existing WebBridge binary is not the pinned ${artifact.version} artifact; no overwrite or launch was attempted`);
    }
    report('daemon');
    const started = await runCommand(ctx.hostProcess, binPath, ['start'], { timeout: 30_000 });
    if (started.code !== 0) throw new Error(`WebBridge start failed: ${started.stderr || started.stdout}`);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await fetchDaemonStatus())?.running === true) return 'loopback-daemon-observed-identity-and-extension-unverified';
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('WebBridge daemon did not report a valid status on 127.0.0.1:10086');
  }

  return {
    id: 'kimi-webbridge',
    pluginId: PLUGIN_ID,
    displayName: 'Kimi Browser Extension',
    description: 'Control your browser through a local WebBridge daemon and a browser-approved extension.',
    supported: artifact !== undefined,
    plan: artifact === undefined ? undefined : {
      artifact, destination: binPath,
      browserExtensionUrl: BROWSER_EXTENSION_URL,
      note: 'The pinned SHA-256 comes from the publisher release metadata, not an independently verified signature. The plugin package and browser extension require separate user action. Existing binaries are never replaced.',
    },
    detect,
    install,
  };
}
