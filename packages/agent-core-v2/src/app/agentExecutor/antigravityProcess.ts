import type { HostProcessLike, HostProcessServiceLike } from '@kiki/acp-client';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, normalize } from 'pathe';

import { Error2, ErrorCodes } from '#/errors';
import {
  readAntigravityProfileSecrets,
  removeDirectoryForce,
  syncAntigravityUserConfig,
} from '#/os/backends/node-local/antigravityHostOps';
import { antigravityAuthSettings, antigravityCredentialEnvToRemove } from '#/os/backends/node-local/antigravitySettings';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { executorSourceId, type AgentExecutorDescriptor } from './agentExecutor';
import { antigravityCacheRoot } from './antigravityDistribution';
import { executorProcessEnv } from './executorOverrides';
import { isRemoteHostProcessService } from './windowsNodeShim';

export const ANTIGRAVITY_BROWSER_MARKER = '__KIKI_ANTIGRAVITY_AUTH_URL__';
export const ANTIGRAVITY_BROWSER_HELPER_SOURCE = `process.stderr.on("error",()=>process.exit(0)).write("${ANTIGRAVITY_BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",()=>process.exit(0))`;
export const ANTIGRAVITY_SSH_CONNECTION_SENTINEL = '127.0.0.1 0 127.0.0.1 0';
export const ANTIGRAVITY_APP_DATA_DIR_NAME = 'antigravity-acp';

const POLLUTED_ENV = [
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_GENAI_USE_VERTEXAI', 'GCLOUD_PROJECT', 'CLOUDSDK_CORE_PROJECT', 'AGY_ACP_CCPA_PROJECT',
  'AGY_ACP_ENABLE_OAUTH', 'GOOGLE_GEMINI_BASE_URL', 'CHROME_CRASHPAD_PIPE_NAME', 'BROWSER',
  'GEMINI_HOME', 'AGY_ACP_FORCE_FILE_STORAGE', 'ANTIGRAVITY_HARNESS_PATH', 'ELECTRON_RUN_AS_NODE',
] as const;

const leasedVersionDirectories = new Map<string, number>();

export function acquireAntigravityBinaryLease(commandPath: string, cacheRoot: string): () => void {
  const versionDirectory = managedOfficialVersionDirectory(commandPath, cacheRoot);
  if (versionDirectory === undefined) return () => undefined;
  leasedVersionDirectories.set(versionDirectory, (leasedVersionDirectories.get(versionDirectory) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (leasedVersionDirectories.get(versionDirectory) ?? 1) - 1;
    if (count <= 0) leasedVersionDirectories.delete(versionDirectory);
    else leasedVersionDirectories.set(versionDirectory, count);
  };
}

export function activeAntigravityLeasedDirectories(): ReadonlySet<string> {
  return new Set(leasedVersionDirectories.keys());
}

export function isOfficialAntigravityCliCommand(
  command: string,
  descriptor?: Pick<AgentExecutorDescriptor, 'selectedSource' | 'launchArgs'>,
  args?: readonly string[],
): boolean {
  const base = basename(command).replace(/\.(?:exe|par|cmd|bat|com)$/i, '').toLowerCase();
  if (base === 'agy_acp_server') return false;
  if (
    descriptor?.selectedSource === 'agy-cli' ||
    descriptor?.selectedSource === 'antigravity-cli' ||
    descriptor?.selectedSource === 'kiki-managed-cli'
  ) {
    return true;
  }
  if (args?.[0] === 'acp' || descriptor?.launchArgs?.[0] === 'acp') return true;
  return base === 'agy' || base === 'antigravity';
}

export function shouldAppendOfficialAntigravityArgs(
  command: string,
  descriptor?: Pick<AgentExecutorDescriptor, 'launchArgs'>,
  args?: readonly string[],
): boolean {
  const base = basename(command).replace(/\.(?:exe|par|cmd|bat|com)$/i, '').toLowerCase();
  if (base === 'agy_acp_server') return false;
  if (args?.[0] === 'acp' || descriptor?.launchArgs?.[0] === 'acp') return true;
  return base === 'agy' || base === 'antigravity';
}

export function antigravityOfficialCliArgs(args: readonly string[], profileHome: string): readonly string[] {
  const next = args[0] === 'acp' ? [...args] : ['acp', ...args];
  if (!next.includes('--gemini-dir')) {
    next.push('--gemini-dir', profileHome);
  }
  if (!next.includes('--app-data-dir')) {
    next.push('--app-data-dir', ANTIGRAVITY_APP_DATA_DIR_NAME);
  }
  return next;
}

export function antigravitySshConnectionValue(
  env: Record<string, string>,
  bootstrap: IBootstrapService,
): string {
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === 'SSH_CONNECTION' && value.trim() !== '') {
      return value.trim();
    }
  }
  const inherited = bootstrap.getEnv('SSH_CONNECTION')?.trim();
  return inherited !== undefined && inherited !== '' ? inherited : ANTIGRAVITY_SSH_CONNECTION_SENTINEL;
}

export function antigravityProcessService(
  processes: HostProcessServiceLike,
  descriptor: AgentExecutorDescriptor,
  bootstrap: IBootstrapService,
): HostProcessServiceLike {
  const sourceId = executorSourceId(descriptor);
  if (sourceId === 'agy-cli') {
    const auditDir = join(bootstrap.homeDir, 'tools', 'agy-cli', 'audit');
    return {
      ...processes,
      spawn: async (command, args, options, startupSignal) => {
        const env = { ...executorProcessEnv(descriptor), ...options?.env };
        if (env['AGY_BRIDGE_AUDIT_DIR'] === undefined || env['AGY_BRIDGE_AUDIT_DIR'].trim() === '') {
          env['AGY_BRIDGE_AUDIT_DIR'] = auditDir;
        }
        return processes.spawn(command, args, { ...options, env }, startupSignal);
      },
    };
  }
  if (sourceId !== 'antigravity-acp') return processes;
  return {
    spawn: async (command, args, options, startupSignal) => {
      if (isRemoteHostProcessService(processes)) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          'Google Antigravity ACP requires a local runtime; remote SSH execution cannot use local Antigravity profiles or OAuth tokens.',
        );
      }
      const env = { ...executorProcessEnv(descriptor), ...options?.env };
      const home = antigravitySettingsHome(env, bootstrap, descriptor.id);
      const tempHome = antigravityRuntimeTempHome(bootstrap, descriptor.id);
      await syncAntigravityUserConfig({
        profileHome: home,
        tempHome,
        userHome: antigravityUserHome(env, bootstrap),
        platform: bootstrap.platform,
      });
      const releaseLease = acquireAntigravityBinaryLease(command, antigravityCacheRoot(bootstrap.homeDir));
      try {
        const method = await antigravityAuthSettings(home);
        const secrets = await readAntigravityProfileSecrets(home);
        const official = isOfficialAntigravityCliCommand(command, descriptor, args);
        const envUnset = new Set([...options?.envUnset ?? [], ...POLLUTED_ENV, ...antigravityCredentialEnvToRemove(method)]);
        if (method === 'gemini-api-key') envUnset.delete('GEMINI_API_KEY');
        if (method === 'agent-platform') envUnset.delete('GOOGLE_API_KEY');
        for (const key of Object.keys(env)) {
          for (const removed of envUnset) {
            if (key.toUpperCase() === removed.toUpperCase()) delete env[key];
          }
        }
        if (method === 'gemini-api-key' && !hasEnvKey(env, 'GEMINI_API_KEY') && secrets?.geminiApiKey) {
          env['GEMINI_API_KEY'] = secrets.geminiApiKey;
        }
        if (method === 'agent-platform' && !hasEnvKey(env, 'GOOGLE_API_KEY') && secrets?.googleApiKey) {
          env['GOOGLE_API_KEY'] = secrets.googleApiKey;
        }
        Object.assign(env, {
          GEMINI_HOME: home,
          AGY_ACP_FORCE_FILE_STORAGE: '1',
          BROWSER: antigravityBrowserCommand(),
          PYTHONUNBUFFERED: '1',
          ELECTRON_RUN_AS_NODE: '1',
          TEMP: tempHome,
          TMP: tempHome,
          TMPDIR: tempHome,
        });
        for (const key of ['GEMINI_HOME', 'AGY_ACP_FORCE_FILE_STORAGE', 'BROWSER', 'PYTHONUNBUFFERED', 'ELECTRON_RUN_AS_NODE', 'TEMP', 'TMP', 'TMPDIR']) {
          envUnset.delete(key);
        }
        let spawnArgs = args ?? [];
        if (official) {
          env['AGY_CLI_DISABLE_AUTO_UPDATE'] = '1';
          envUnset.delete('AGY_CLI_DISABLE_AUTO_UPDATE');
          if (method === 'oauth-personal') {
            const sshConnection = antigravitySshConnectionValue(env, bootstrap);
            deleteEnvCaseInsensitive(env, 'SSH_CONNECTION');
            env['SSH_CONNECTION'] = sshConnection;
            envUnset.delete('SSH_CONNECTION');
          }
          if (shouldAppendOfficialAntigravityArgs(command, descriptor, spawnArgs)) {
            spawnArgs = antigravityOfficialCliArgs(spawnArgs, home);
          }
        } else {
          env['ANTIGRAVITY_HARNESS_PATH'] = join(
            dirname(command),
            bootstrap.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external',
          );
          envUnset.delete('ANTIGRAVITY_HARNESS_PATH');
        }
        const child = await processes.spawn(
          command,
          spawnArgs,
          { ...options, env, envUnset: [...envUnset], ownedProcessTree: true },
          startupSignal,
        );
        return withRuntimeCleanup(child, tempHome, releaseLease);
      } catch (error) {
        releaseLease();
        await removeDirectoryForce(tempHome);
        throw error;
      }
    },
  };
}

export function antigravitySettingsHome(env: Record<string, string> | undefined, bootstrap: IBootstrapService, instanceId = 'antigravity-acp'): string {
  const childHome = env?.['HOME'] ?? bootstrap.getEnv('HOME') ?? bootstrap.osHomeDir;
  const configured = env?.['GEMINI_HOME'];
  if (configured === undefined || configured === '') {
    const key = createHash('sha256').update(instanceId).digest('hex');
    return join(bootstrap.homeDir, 'tools', 'antigravity-acp', 'profiles', key);
  }
  return configured === '~' ? childHome
    : configured.startsWith('~/') || configured.startsWith('~\\') ? join(childHome, configured.slice(2)) : configured;
}

export function antigravityBrowserCommand(nodePath = basename(process.execPath).toLowerCase().startsWith('node') ? process.execPath : 'node'): string {
  const executable = nodePath.replaceAll('\\', '/');
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  return [executable, '-e', ANTIGRAVITY_BROWSER_HELPER_SOURCE, '--', '%s'].map(quote).join(' ');
}

function antigravityRuntimeTempHome(bootstrap: IBootstrapService, instanceId: string): string {
  const key = createHash('sha256').update(instanceId).digest('hex').slice(0, 16);
  return join(bootstrap.homeDir, 'tools', 'antigravity-acp', 'tmp', key, randomUUID());
}

function antigravityUserHome(env: Record<string, string>, bootstrap: IBootstrapService): string {
  if (bootstrap.platform === 'win32') {
    return env['USERPROFILE'] ?? bootstrap.getEnv('USERPROFILE') ??
      (env['HOMEDRIVE'] && env['HOMEPATH'] ? `${env['HOMEDRIVE']}${env['HOMEPATH']}` : bootstrap.osHomeDir);
  }
  return env['HOME'] ?? bootstrap.getEnv('HOME') ?? bootstrap.osHomeDir;
}

function managedOfficialVersionDirectory(commandPath: string, cacheRoot: string): string | undefined {
  const normalizedCommand = normalize(commandPath);
  const versionsPrefix = `${normalize(join(cacheRoot, 'versions'))}/`;
  const compareCommand = process.platform === 'win32' ? normalizedCommand.toLowerCase() : normalizedCommand;
  const comparePrefix = process.platform === 'win32' ? versionsPrefix.toLowerCase() : versionsPrefix;
  if (!compareCommand.startsWith(comparePrefix)) return undefined;
  const rest = normalizedCommand.slice(versionsPrefix.length);
  const slashIndex = rest.indexOf('/');
  if (slashIndex <= 0) return undefined;
  return normalize(join(cacheRoot, 'versions', rest.slice(0, slashIndex)));
}

function hasEnvKey(env: Record<string, string>, target: string): boolean {
  const upper = target.toUpperCase();
  return Object.entries(env).some(([key, value]) => key.toUpperCase() === upper && value.trim() !== '');
}

function deleteEnvCaseInsensitive(env: Record<string, string>, target: string): void {
  const upper = target.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper) delete env[key];
  }
}

function withRuntimeCleanup(
  child: HostProcessLike,
  tempHome: string,
  releaseLease: () => void,
): HostProcessLike {
  const exit = child.wait().finally(async () => {
    releaseLease();
    await removeDirectoryForce(tempHome);
  });
  void exit.catch(() => undefined);
  return {
    get pid() { return child.pid; },
    get exitCode() { return child.exitCode; },
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    wait: () => exit,
    kill: (signal) => child.kill(signal),
    dispose: () => {
      releaseLease();
      return child.dispose();
    },
  };
}
