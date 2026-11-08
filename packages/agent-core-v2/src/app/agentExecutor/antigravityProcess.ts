import type { HostProcessServiceLike } from '@kiki/acp-client';
import { join } from 'pathe';

import { antigravityAuthSettings, antigravityCredentialEnvToRemove } from '#/os/backends/node-local/antigravitySettings';
import { executorSourceId, type AgentExecutorDescriptor } from './agentExecutor';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { executorProcessEnv } from './executorOverrides';

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
    spawn: async (command, args, options) => {
      const env = { ...executorProcessEnv(descriptor), ...options?.env };
      const home = antigravitySettingsHome(env, bootstrap);
      const method = await antigravityAuthSettings(home);
      const envUnset = antigravityCredentialEnvToRemove(method);
      for (const key of envUnset) delete env[key];
      return processes.spawn(command, args, {
        ...options,
        env: { ...env, GEMINI_HOME: home, PYTHONUNBUFFERED: '1' },
        envUnset: [...options?.envUnset ?? [], ...envUnset],
      });
    },
  };
}

export function antigravitySettingsHome(env: Record<string, string> | undefined, bootstrap: IBootstrapService): string {
  const childHome = env?.['HOME'] ?? bootstrap.getEnv('HOME') ?? bootstrap.osHomeDir;
  const configured = env?.['GEMINI_HOME'] ?? bootstrap.getEnv('GEMINI_HOME');
  const home = configured === undefined || configured === '' ? join(childHome, '.gemini') : configured;
  return home === '~' ? childHome
    : home.startsWith('~/') || home.startsWith('~\\') ? join(childHome, home.slice(2)) : home;
}
