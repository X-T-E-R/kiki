import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { downloadToFile, runCommand } from '../host';
import { cuMacArtifact, CU_WINDOWS_EXECUTABLE_SHA256, CU_WINDOWS_RUNTIME_METADATA,
  CU_WINDOWS_RUNTIME_VERSION } from '../verifiedArtifacts';
import type {
  CapabilityDetectResult,
  CapabilityEntry,
  CapabilityInstallReporter,
  CapabilityStep,
} from '../types';
import type { CapabilityEntryContext } from './context';

const MAC_PLUGIN_ID = 'kimi-cu';
const WINDOWS_PLUGIN_ID = 'kimi-cu-win';
const APP_BUNDLE = 'KimiCU.app';
const COMMAND_TIMEOUT_MS = 30_000;
const PERMISSIONS_TIMEOUT_MS = 15_000;
const DETECT_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_WINDOWS_SYSTEM_ROOT = 'C:\\Windows';
const DEFAULT_WINDOWS_PROGRAM_FILES = 'C:\\Program Files';

interface PluginLayerConfig {
  readonly id: string;
}

function macPlugin(): PluginLayerConfig {
  return { id: MAC_PLUGIN_ID };
}

function windowsPlugin(): PluginLayerConfig {
  return { id: WINDOWS_PLUGIN_ID };
}

interface PermissionStatus {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

interface LegacyMcpFile {
  readonly raw: string;
  readonly value: Record<string, unknown>;
  readonly servers: Record<string, unknown>;
}

export function parsePermissionStatus(output: string): PermissionStatus | undefined {
  const match =
    /(?:permissions|permissionStatus):\s*accessibility=(true|false)\s+screenRecording=(true|false)/.exec(
      output,
    );
  if (match === null) return undefined;
  return { accessibility: match[1] === 'true', screenRecording: match[2] === 'true' };
}

export function parseWindowsDoctorOutput(
  output: string,
): { readonly version?: string } | undefined {
  const fields = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  if (fields.get('mcp') !== 'true' || fields.get('helper') !== 'embedded') return undefined;
  const version = fields.get('version');
  return version === undefined ? {} : { version };
}

export function windowsPowerShellPath(
  systemRoot = process.env['SystemRoot'] ?? DEFAULT_WINDOWS_SYSTEM_ROOT,
): string {
  const root = path.win32.isAbsolute(systemRoot) ? systemRoot : DEFAULT_WINDOWS_SYSTEM_ROOT;
  return path.win32.join(
    root,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

export function windowsPowerShell7Path(
  programFiles =
    process.env['ProgramW6432'] ??
    process.env['ProgramFiles'] ??
    DEFAULT_WINDOWS_PROGRAM_FILES,
): string {
  const root = path.win32.isAbsolute(programFiles)
    ? programFiles
    : DEFAULT_WINDOWS_PROGRAM_FILES;
  return path.win32.join(root, 'PowerShell', '7', 'pwsh.exe');
}

export async function readAppBundleVersion(infoPlistPath: string): Promise<string | undefined> {
  try {
    const xml = await readFile(infoPlistPath, 'utf-8');
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function detectPluginLayer(
  ctx: CapabilityEntryContext,
  config: PluginLayerConfig,
): Promise<{ readonly step: CapabilityStep; readonly integrity: CapabilityStep; readonly version?: string }> {
  const installed = await ctx.plugins.listPlugins();
  const plugin = installed.find((candidate) => candidate.id === config.id);
  const mcpGap =
    plugin !== undefined && plugin.enabledMcpServerCount !== plugin.mcpServerCount
      ? `mcp ${plugin.enabledMcpServerCount}/${plugin.mcpServerCount} enabled`
      : undefined;
  return {
    step: {
      id: 'plugin',
      state: plugin?.enabled === true && plugin.state === 'ok' && plugin.hasErrors !== true && mcpGap === undefined ? 'ok' : 'missing',
      detail: plugin === undefined ? 'Plugin is not installed' :
        !plugin.enabled ? 'Plugin is disabled' :
        plugin.state !== 'ok' || plugin.hasErrors === true ? 'Plugin reports an error' : mcpGap,
    },
    integrity: {
      id: 'plugin-integrity', state: 'missing', optional: true,
      detail: 'Unverified: installed plugin ZIP integrity and runtime compatibility have not been attested',
    },
    version: plugin?.version,
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseLegacyMcpFile(raw: string, appBin: string): LegacyMcpFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const root = objectRecord(value);
  const servers = objectRecord(root?.['mcpServers']);
  const legacy = objectRecord(servers?.['kimi-cu']);
  if (root === undefined || servers === undefined || legacy === undefined) return undefined;
  if (legacy['command'] !== appBin) return undefined;
  if (legacy['enabled'] === false) return undefined;
  const args = legacy['args'];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return undefined;
  const isKnownArgs =
    (args.length === 1 && args[0] === 'mcp') ||
    (args.length === 3 && args[0] === 'mcp' && args[1] === '-s' && args[2] === 'user');
  if (!isKnownArgs) return undefined;
  const knownKeys = new Set(['args', 'command']);
  if (Object.keys(legacy).some((key) => !knownKeys.has(key))) return undefined;
  return { raw, value: root, servers };
}

function createMacKimiCuEntry(ctx: CapabilityEntryContext): CapabilityEntry {
  const applicationsDir = ctx.applicationsDir ?? '/Applications';
  const appPath = path.join(applicationsDir, APP_BUNDLE);
  const appBin = path.join(appPath, 'Contents', 'MacOS', 'kimi-cu');
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  const probeTimeoutMs = ctx.detectProbeTimeoutMs ?? DETECT_PROBE_TIMEOUT_MS;
  const commandTimeoutMs = ctx.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  const supported = ctx.platform === 'darwin' && cuMacArtifact(ctx.arch) !== undefined;
  const userMcpConfigPath = path.join(ctx.kimiHomeDir, 'mcp.json');

  async function exists(p: string): Promise<boolean> {
    return access(p).then(
      () => true,
      () => false,
    );
  }

  async function executable(p: string): Promise<boolean> {
    return access(p, constants.X_OK).then(
      () => true,
      () => false,
    );
  }

  async function verifyInstalledApp(): Promise<{ readonly verified: boolean; readonly detail?: string; readonly version?: string }> {
    const artifact = cuMacArtifact(ctx.arch);
    if (artifact === undefined || !(await exists(appBin)) || !(await exists(infoPlist)) || !(await executable(appBin))) {
      return { verified: false, detail: 'App bundle is absent or incomplete' };
    }
    const version = await readAppBundleVersion(infoPlist);
    if (version !== artifact.version) {
      return { verified: false, detail: `Unverified: app version ${version ?? 'unknown'} does not match pinned ${artifact.version}`, version };
    }
    const verified = await runCommand(ctx.hostProcess, 'codesign', ['--verify', '--deep', '--strict', appPath], {
      timeout: commandTimeoutMs,
    });
    const signer = await runCommand(ctx.hostProcess, 'codesign', ['-dv', '--verbose=4', appPath], {
      timeout: commandTimeoutMs,
    });
    if (verified.code !== 0 || signer.code !== 0 ||
      !/\bTeamIdentifier=2J9472RW75\b/.test(`${signer.stderr}\n${signer.stdout}`)) {
      return { verified: false, detail: 'Unverified: app signature or publisher team identifier did not match', version };
    }
    return { verified: true, detail: version, version };
  }

  async function serviceRunning(): Promise<boolean> {
    if (!(await exists(appBin))) return false;
    const result = await runCommand(ctx.hostProcess, appBin, ['service-status'], {
      timeout: probeTimeoutMs,
    });
    return /status=1\b/.test(result.stdout);
  }

  async function permissionStatus(): Promise<PermissionStatus | undefined> {
    if (!(await exists(appBin))) return undefined;
    const result = await runCommand(ctx.hostProcess, appBin, ['xpc-ping'], {
      timeout: probeTimeoutMs,
    });
    return parsePermissionStatus(result.stdout);
  }

  async function legacyMcpFile(): Promise<LegacyMcpFile | undefined> {
    try {
      return parseLegacyMcpFile(await readFile(userMcpConfigPath, 'utf8'), appBin);
    } catch {
      return undefined;
    }
  }

  async function detect(): Promise<CapabilityDetectResult> {
    const steps: CapabilityStep[] = [];

    const plugin = await detectPluginLayer(ctx, macPlugin());
    steps.push(plugin.step, plugin.integrity);

    if ((await legacyMcpFile()) !== undefined) {
      steps.push({
        id: 'legacy-mcp',
        state: 'missing',
        detail: 'duplicate standalone kimi-cu MCP registration',
        optional: true,
      });
    }

    const app = await verifyInstalledApp();
    steps.push({ id: 'app', state: app.verified ? 'ok' : 'missing', detail: app.detail });
    if (!app.verified) {
      steps.push({ id: 'service', state: 'missing', detail: 'Unverified: app must pass signature and version checks before probing its service' });
      steps.push({ id: 'permissions', state: 'missing', detail: 'Unverified: app has not passed publisher checks' });
      return { steps, version: app.version ?? plugin.version };
    }

    try {
      steps.push({ id: 'service', state: (await serviceRunning()) ? 'ok' : 'missing' });
    } catch (error) {
      steps.push({ id: 'service', state: 'failed', detail: errorMessage(error) });
    }

    let permissions: PermissionStatus | undefined;
    let permissionsProbeError: string | undefined;
    try {
      permissions = await permissionStatus();
    } catch (error) {
      permissionsProbeError = errorMessage(error);
    }
    if (permissionsProbeError !== undefined) {
      steps.push({ id: 'permissions', state: 'failed', detail: permissionsProbeError });
    } else {
      const granted =
        permissions !== undefined && permissions.accessibility && permissions.screenRecording;
      const missingPermissions = permissions === undefined
        ? undefined
        : [
            ...(permissions.accessibility ? [] : ['accessibility']),
            ...(permissions.screenRecording ? [] : ['screenRecording']),
          ].join(',');
      steps.push({
        id: 'permissions',
        state: granted ? 'ok' : 'missing',
        detail:
          granted || missingPermissions === undefined || missingPermissions.length === 0
            ? undefined
            : missingPermissions,
      });
    }

    return {
      steps,
      version: app.version ?? plugin.version,
    };
  }

  async function moveAppIntoPlace(unzippedApp: string): Promise<void> {
    if (await exists(appPath)) throw new Error('Computer Use app already exists; refusing overwrite');
    const direct = await runCommand(ctx.hostProcess, 'ditto', [unzippedApp, appPath], {
      timeout: commandTimeoutMs,
    });
    if (direct.code !== 0) {
      throw new Error(`Could not install ${APP_BUNDLE} at ${applicationsDir} without administrator privileges: ${direct.stderr.trim() || direct.code}`);
    }
  }

  async function install(report: CapabilityInstallReporter): Promise<string | undefined> {
    if (!supported) {
      throw new Error(`kimi-cu is only supported on macOS (current: ${ctx.platform})`);
    }

    const artifact = cuMacArtifact(ctx.arch);
    if (artifact === undefined) throw new Error(`No pinned Computer Use app for ${ctx.arch}`);
    const before = await detect();
    const stepStates = new Map(before.steps.map((step) => [step.id, step.state]));
    const installApp = stepStates.get('app') !== 'ok';
    if (installApp) {
      if (await exists(appPath)) throw new Error('Computer Use app already exists; refusing download or overwrite');
      const workDir = await mkdtemp(path.join(tmpdir(), 'kimi-cu-install-'));
      try {
        report('download', 0);
        const zipPath = path.join(workDir, 'KimiCU.app.zip');
        await downloadToFile(
          artifact.url,
          zipPath,
          (percent) => {
            report('download', percent);
          },
          ctx.fetchImpl,
          { sha256: artifact.sha256, maxBytes: artifact.maxBytes },
        );

        report('app');
        const unzipDir = path.join(workDir, 'unzipped');
        const unzipped = await runCommand(ctx.hostProcess, 'ditto', ['-x', '-k', zipPath, unzipDir], {
          timeout: 120_000,
        });
        if (unzipped.code !== 0) {
          throw new Error(`Failed to unzip KimiCU.app: ${unzipped.stderr || unzipped.stdout}`);
        }
        const extracted = path.join(unzipDir, APP_BUNDLE);
        const verified = await runCommand(ctx.hostProcess, 'codesign', ['--verify', '--deep', '--strict', extracted], {
          timeout: commandTimeoutMs,
        });
        const signer = await runCommand(ctx.hostProcess, 'codesign', ['-dv', '--verbose=4', extracted], {
          timeout: commandTimeoutMs,
        });
        if (verified.code !== 0 || signer.code !== 0 ||
          !/\bTeamIdentifier=2J9472RW75\b/.test(`${signer.stderr}\n${signer.stdout}`) ||
          (await readAppBundleVersion(path.join(extracted, 'Contents', 'Info.plist'))) !== artifact.version) {
          throw new Error('Computer Use app signature, publisher team identifier or pinned version could not be verified');
        }
        if (await exists(appPath)) throw new Error('Computer Use app already exists; will not replace an external installation');
        await moveAppIntoPlace(extracted);
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    const installedApp = await verifyInstalledApp();
    if (!installedApp.verified) throw new Error(installedApp.detail ?? 'Computer Use app is unverified; refusing to launch');
    if (installApp || stepStates.get('service') !== 'ok') {
      report('service');
      const registered = await runCommand(ctx.hostProcess, appBin, ['install'], {
        timeout: commandTimeoutMs,
      });
      if (registered.code !== 0) {
        throw new Error(`kimi-cu install failed: ${registered.stderr || registered.stdout}`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
      const running = await serviceRunning().catch(() => false);
      if (!running) {
        throw new Error('kimi-cu background service is not running after install');
      }
    }

    if (stepStates.get('permissions') !== 'ok') {
      report('permissions');
      await runCommand(
        ctx.hostProcess,
        appBin,
        ['request-permissions', '--ax', '--screen'],
        { timeout: PERMISSIONS_TIMEOUT_MS },
      ).catch(() => undefined);
    }
    return undefined;
  }

  return {
    id: 'kimi-cu',
    pluginId: MAC_PLUGIN_ID,
    displayName: 'Kimi Computer Use',
    description:
      'macOS GUI automation in the background — read app UIs and click, type, scroll, and drag without taking over your mouse or foregrounding apps.',
    supported,
    plan: cuMacArtifact(ctx.arch) === undefined ? undefined : {
      artifact: cuMacArtifact(ctx.arch)!, destination: appPath,
      note: 'Pinned app SHA-256 comes from publisher metadata; macOS signature and team ID are also checked. The plugin package needs separate user installation; system permission prompts require OS approval. Existing apps are never overwritten.',
    },
    detect,
    install,
  };
}

function createWindowsKimiCuEntry(ctx: CapabilityEntryContext): CapabilityEntry {
  const supported = ctx.platform === 'win32' && ctx.arch === 'x64';
  const probeTimeoutMs = ctx.detectProbeTimeoutMs ?? DETECT_PROBE_TIMEOUT_MS;
  const pinnedExecutableSha256 = ctx.windowsCuExecutableSha256 ?? CU_WINDOWS_EXECUTABLE_SHA256;

  async function matchesPinnedExecutable(executable: string): Promise<boolean> {
    if (!path.isAbsolute(executable) || !/^[0-9a-f]{64}$/.test(pinnedExecutableSha256)) return false;
    try {
      const before = await lstat(executable);
      if (!before.isFile() || before.isSymbolicLink()) return false;
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(executable)) hash.update(chunk);
      const after = await lstat(executable);
      return after.isFile() && !after.isSymbolicLink() &&
        before.dev === after.dev && before.ino === after.ino &&
        before.size === after.size && before.mtimeMs === after.mtimeMs &&
        hash.digest('hex') === pinnedExecutableSha256;
    } catch {
      return false;
    }
  }

  async function detectRuntimeStep(): Promise<{
    readonly step: CapabilityStep;
    readonly version?: string;
  }> {
    if (!supported) return { step: { id: 'runtime', state: 'missing' } };
    const candidates = [
      process.env['KIKI_CU_WINDOWS_EXE'],
      process.env['KIKI_CU_WINDOWS_HOME'] === undefined ? undefined :
        path.win32.join(process.env['KIKI_CU_WINDOWS_HOME'], 'kimi-cu.exe'),
      process.env['LOCALAPPDATA'] === undefined ? undefined :
        path.win32.join(process.env['LOCALAPPDATA'], 'KimiCU', 'kimi-cu.exe'),
      process.env['ProgramFiles'] === undefined ? undefined :
        path.win32.join(process.env['ProgramFiles'], 'KimiCU', 'kimi-cu.exe'),
    ];
    for (const candidate of new Set(candidates.filter((value): value is string =>
      typeof value === 'string' && value.trim().length > 0))) {
      if (!(await matchesPinnedExecutable(candidate))) continue;
      const result = await runCommand(ctx.hostProcess, candidate, ['doctor'], { timeout: probeTimeoutMs });
      if (result.code !== 0) {
        return { step: { id: 'runtime', state: 'failed',
          detail: result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}` } };
      }
      const doctor = parseWindowsDoctorOutput(result.stdout);
      if (doctor === undefined || doctor.version !== CU_WINDOWS_RUNTIME_VERSION) {
        return { step: { id: 'runtime', state: 'missing',
          detail: `Unverified: doctor version ${doctor?.version ?? 'unknown'} does not match pinned ${CU_WINDOWS_RUNTIME_VERSION}` },
          version: doctor?.version };
      }
      return { step: { id: 'runtime', state: 'ok', detail: doctor.version }, version: doctor.version };
    }
    return { step: { id: 'runtime', state: 'missing',
      detail: 'Unverified: no Windows Computer Use executable matched the pinned publisher SHA-256; doctor was not run' } };
  }

  async function detect(): Promise<CapabilityDetectResult> {
    const [plugin, runtime] = await Promise.all([
      detectPluginLayer(ctx, windowsPlugin()),
      detectRuntimeStep(),
    ]);
    return {
      steps: [plugin.step, runtime.step, plugin.integrity, {
        id: 'runtime-identity', state: 'missing', optional: true,
        detail: 'Unverified: publisher metadata SHA-256 and doctor output do not independently authenticate the running process',
      }],
      version: runtime.version ?? plugin.version,
    };
  }

  async function install(): Promise<string | undefined> {
    if (!supported) throw new Error(`Computer Use is not supported on ${ctx.platform}/${ctx.arch}`);
    const runtime = await detectRuntimeStep();
    if (runtime.step.state === 'ok') return 'existing-runtime-reused';
    throw new Error(
      `${runtime.step.detail ?? 'Windows Computer Use runtime is unavailable'}. ` +
      `The current setup_windows.ps1 installer has no verified digest in ${CU_WINDOWS_RUNTIME_METADATA} ` +
      'and may execute additional writes. Automatic setup is blocked before download or plugin enablement; ' +
      'install with the publisher outside Kiki and retry the health check.',
    );
  }

  return {
    id: 'kimi-cu',
    pluginId: WINDOWS_PLUGIN_ID,
    displayName: 'Kimi Computer Use for Windows',
    description:
      'Windows GUI automation — read app UIs and click, type, scroll, and drag in desktop apps.',
    supported,
    detect,
    install,
  };
}

export function createKimiCuEntry(ctx: CapabilityEntryContext): CapabilityEntry {
  return ctx.platform === 'win32' ? createWindowsKimiCuEntry(ctx) : createMacKimiCuEntry(ctx);
}
