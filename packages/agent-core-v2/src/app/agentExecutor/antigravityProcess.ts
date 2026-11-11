import type { HostProcessLike, HostProcessServiceLike } from '@kiki/acp-client';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'pathe';

import { antigravityAuthSettings, antigravityCredentialEnvToRemove } from '#/os/backends/node-local/antigravitySettings';
import { prepareAntigravityRuntime, removeAntigravityRuntimeTemp } from '#/os/backends/node-local/antigravityRuntime';
import { executorSourceId, type AgentExecutorDescriptor } from './agentExecutor';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { executorProcessEnv } from './executorOverrides';

export const ANTIGRAVITY_BROWSER_MARKER = '__KIKI_ANTIGRAVITY_AUTH_URL__';
export const ANTIGRAVITY_BROWSER_HELPER_SOURCE = `process.stderr.on("error",()=>process.exit(0)).write("${ANTIGRAVITY_BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",()=>process.exit(0))`;

const POLLUTED_ENV = [
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_GENAI_USE_VERTEXAI', 'GCLOUD_PROJECT', 'CLOUDSDK_CORE_PROJECT', 'AGY_ACP_CCPA_PROJECT',
  'AGY_ACP_ENABLE_OAUTH', 'GOOGLE_GEMINI_BASE_URL', 'CHROME_CRASHPAD_PIPE_NAME', 'BROWSER',
  'GEMINI_HOME', 'AGY_ACP_FORCE_FILE_STORAGE', 'ANTIGRAVITY_HARNESS_PATH', 'ELECTRON_RUN_AS_NODE',
] as const;

export function antigravityProcessService(processes: HostProcessServiceLike, descriptor: AgentExecutorDescriptor, bootstrap: IBootstrapService): HostProcessServiceLike {
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
      const env = { ...executorProcessEnv(descriptor), ...options?.env };
      const home = antigravitySettingsHome(env, bootstrap, descriptor.id);
      const tempHome = antigravityRuntimeTempHome(bootstrap, descriptor.id);
      await prepareAntigravityRuntime({ profileHome: home, tempHome, userHome: antigravityUserHome(env, bootstrap), platform: bootstrap.platform });
      try {
        const method = await antigravityAuthSettings(home);
        const envUnset = new Set([...options?.envUnset ?? [], ...POLLUTED_ENV, ...antigravityCredentialEnvToRemove(method)]);
        if (method === 'gemini-api-key') envUnset.delete('GEMINI_API_KEY');
        if (method === 'agent-platform') envUnset.delete('GOOGLE_API_KEY');
        for (const key of Object.keys(env)) {
          for (const removed of envUnset) {
            if (key.toUpperCase() === removed.toUpperCase()) delete env[key];
          }
        }
        const harness = descriptor.selectedSource === 'agy-cli' ? undefined : join(dirname(command), bootstrap.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external');
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
        if (harness !== undefined) {
          env['ANTIGRAVITY_HARNESS_PATH'] = harness;
          envUnset.delete('ANTIGRAVITY_HARNESS_PATH');
        }
        for (const key of ['GEMINI_HOME', 'AGY_ACP_FORCE_FILE_STORAGE', 'BROWSER', 'PYTHONUNBUFFERED', 'ELECTRON_RUN_AS_NODE', 'TEMP', 'TMP', 'TMPDIR']) envUnset.delete(key);
        const child = await processes.spawn(command, args, { ...options, env, envUnset: [...envUnset] }, startupSignal);
        return withTempCleanup(child, tempHome);
      } catch (error) {
        await removeAntigravityRuntimeTemp(tempHome);
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

function withTempCleanup(child: HostProcessLike, tempHome: string): HostProcessLike {
  const exit = child.wait().finally(() => removeAntigravityRuntimeTemp(tempHome));
  void exit.catch(() => undefined);
  return {
    get pid() { return child.pid; },
    get exitCode() { return child.exitCode; },
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    wait: () => exit,
    kill: (signal) => child.kill(signal),
    dispose: () => child.dispose(),
  };
}
