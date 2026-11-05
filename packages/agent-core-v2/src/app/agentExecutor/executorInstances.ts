import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { executorInstanceConfigSchema, executorInstanceIdSchema, executorProxyUrl, type ExecutorInstanceConfig, type ExecutorInstanceIssue } from '@kiki/protocol';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import { isPlainObject } from '#/app/config/configPure';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import type { AgentExecutorDescriptor } from './agentExecutor';
import { CLAUDE_CREDENTIAL_ENV_VARS, CLAUDE_EXTERNAL_BACKEND_ENV_VARS } from './claudeCredentials';

export const AGENT_EXECUTOR_INSTANCES_SECTION = 'agentExecutorInstances';
export const AgentExecutorInstancesSchema = z.record(executorInstanceIdSchema, executorInstanceConfigSchema);
export type AgentExecutorInstances = z.infer<typeof AgentExecutorInstancesSchema>;

registerConfigSection(AGENT_EXECUTOR_INSTANCES_SECTION, AgentExecutorInstancesSchema, {
  fromToml: (value) => value,
  toToml: (value) => value,
  merge: (base, patch) => {
    if (!isPlainObject(patch)) return patch as AgentExecutorInstances;
    const result = { ...base } as Record<string, unknown>;
    for (const [id, entry] of Object.entries(patch)) {
      if (entry === null) delete result[id];
      else result[id] = entry;
    }
    return result as AgentExecutorInstances;
  },
});

const PROXY_URL_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const PROXY_BYPASS_ENV = ['NO_PROXY', 'no_proxy'];
const LOOPBACK_BYPASS = 'localhost,.localhost,127.0.0.1,::1,[::1]';

export const INSTANCE_ISSUE_MESSAGE: Record<ExecutorInstanceIssue, string> = {
  instance_source_unavailable: 'The source engine is unavailable. Restore its registration or choose another source engine.',
  instance_configuration_unsupported: 'The source engine does not support this configuration or credential source.',
  instance_configuration_path: 'The configuration path must be an existing absolute path on the Kiki host.',
  instance_credential_unset: 'The credential environment variable is missing or empty on the Kiki host.',
  instance_proxy_unavailable: 'The proxy environment variable is missing or does not contain a valid HTTP(S) or SOCKS proxy origin.',
};

export function materializeExecutorInstance(
  id: string,
  instance: ExecutorInstanceConfig,
  base: AgentExecutorDescriptor | undefined,
  hostEnv: (name: string) => string | undefined,
): AgentExecutorDescriptor {
  const { configuration, proxy } = instance;
  const env = { ...base?.env };
  const envUnset = new Set<string>();
  let homeDir: string | undefined;
  let claudeSettingsFile = base?.claudeSettingsFile;
  let issue: ExecutorInstanceIssue | undefined;
  let credential: string | undefined;
  let proxyValue: string | undefined;
  const proxySecrets: string[] = [];
  const claude = base?.id === 'claude-acp' || base?.claudeSettingsFile !== undefined;
  if (base === undefined || base.protocol === 'native') {
    issue = 'instance_source_unavailable';
  } else if (configuration.kind !== 'inherit') {
    claudeSettingsFile = undefined;
    if (claude) {
      for (const key of [...CLAUDE_CREDENTIAL_ENV_VARS, ...CLAUDE_EXTERNAL_BACKEND_ENV_VARS]) envUnset.add(key);
    } else if (base.apiKeyEnv !== undefined) {
      envUnset.add(base.apiKeyEnv);
    }
    if (configuration.kind === 'config_directory') {
      if (base.homeEnv === undefined) issue = 'instance_configuration_unsupported';
      else if (!isAbsolute(configuration.path)) issue = 'instance_configuration_path';
      else {
        delete env[base.homeEnv];
        homeDir = configuration.path;
      }
    } else if (configuration.kind === 'claude_settings') {
      if (!claude) issue = 'instance_configuration_unsupported';
      else if (!isAbsolute(configuration.path)) issue = 'instance_configuration_path';
      else claudeSettingsFile = configuration.path;
    } else if (base.apiKeyEnv === undefined) {
      issue = 'instance_configuration_unsupported';
    } else {
      credential = hostEnv(configuration.name)?.trim();
      if (!credential) issue = 'instance_credential_unset';
      else {
        env[base.apiKeyEnv] = credential;
        envUnset.delete(base.apiKeyEnv);
      }
    }
  }
  if (proxy.kind === 'direct') {
    for (const key of [...PROXY_URL_ENV, ...PROXY_BYPASS_ENV]) envUnset.add(key);
  } else if (proxy.kind !== 'inherit') {
    proxyValue = proxy.kind === 'url' ? proxy.url : hostEnv(proxy.name)?.trim();
    const address = proxyValue === undefined ? undefined : executorProxyUrl(proxyValue, proxy.kind === 'env');
    if (proxyValue === undefined || address === undefined) {
      issue ??= 'instance_proxy_unavailable';
    } else {
      for (const key of PROXY_URL_ENV) env[key] = proxyValue;
      for (const key of PROXY_BYPASS_ENV) env[key] = LOOPBACK_BYPASS;
      if (proxy.kind === 'env') proxySecrets.push(proxyValue, address.username, address.password,
        decodeURIComponent(address.username), decodeURIComponent(address.password));
    }
  }
  for (const key of envUnset) delete env[key];
  return {
    protocol: 'unavailable',
    ...base,
    args: base?.args ?? [],
    modelProbe: base?.modelProbe,
    id,
    label: instance.label,
    instance,
    instanceIssue: issue,
    defaultProfile: false,
    homeDir,
    claudeSettingsFile,
    env,
    envUnset: [...envUnset],
    launchSecrets: [credential, ...proxySecrets].filter((value): value is string => Boolean(value)),
    revision: createHash('sha256').update(JSON.stringify([
      base?.id, base?.revision, base?.homeEnv, base?.apiKeyEnv, configuration, proxy, credential, proxyValue,
    ])).digest('hex'),
  };
}

export async function executorInstanceIssue(descriptor: AgentExecutorDescriptor, fs: IHostFileSystem): Promise<ExecutorInstanceIssue | undefined> {
  if (descriptor.instanceIssue !== undefined) return descriptor.instanceIssue;
  const configuration = descriptor.instance?.configuration;
  if (configuration?.kind !== 'config_directory' && configuration?.kind !== 'claude_settings') return undefined;
  try {
    const stat = await fs.stat(configuration.path);
    if (configuration.kind === 'config_directory' ? stat.isDirectory : stat.isFile) return undefined;
  } catch {}
  return 'instance_configuration_path';
}
