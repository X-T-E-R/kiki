import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { executorInstanceConfigSchema, executorInstanceIdSchema, executorInstancesPatchSchema, executorProxyUrl, publicExecutorInstance, sameExecutorProxyAddress, supportsExecutorPluginAccount, type ExecutorInstanceConfig, type ExecutorInstanceIssue } from '@kiki/protocol';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import { isPlainObject, withoutUndefined } from '#/app/config/configPure';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import type { AgentExecutorDescriptor } from './agentExecutor';
import { CLAUDE_CREDENTIAL_ENV_VARS, CLAUDE_EXTERNAL_BACKEND_ENV_VARS } from './claudeCredentials';

export const AGENT_EXECUTOR_INSTANCES_SECTION = 'agentExecutorInstances';
export const AgentExecutorInstancesSchema = z.preprocess(
  (value) => mapProxyAuthorizationMask(value, undefined),
  z.record(executorInstanceIdSchema, executorInstanceConfigSchema),
);
export type AgentExecutorInstances = z.infer<typeof AgentExecutorInstancesSchema>;

type InstanceProxy = ExecutorInstanceConfig['proxy'];
type StoredInstanceProxy = InstanceProxy | (Omit<Extract<InstanceProxy, { kind: 'url' }>, 'authorization'> & { authorization: false });
type StoredInstances = Record<string, Omit<ExecutorInstanceConfig, 'proxy'> & { proxy: StoredInstanceProxy }>;

function mapProxyAuthorizationMask(value: unknown, replacement: null | undefined): unknown {
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([id, instance]) => {
    if (!isPlainObject(instance)) return [id, instance];
    const proxy = instance['proxy'];
    return isPlainObject(proxy) && proxy['kind'] === 'url' && proxy['authorization'] === false
      ? [id, { ...instance, proxy: { ...proxy, authorization: replacement } }]
      : [id, instance];
  }));
}

function instanceProxyRecord(instance: unknown): Record<string, unknown> | undefined {
  const proxy = isPlainObject(instance) ? instance['proxy'] : undefined;
  return isPlainObject(proxy) ? proxy : undefined;
}

function mergeInstanceProxyLayers(base: unknown, home: unknown, merged: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(home) || !isPlainObject(merged)) return merged;
  return Object.fromEntries(Object.entries(merged).map(([id, instance]) => {
    const lower = instanceProxyRecord(base[id]);
    const upper = instanceProxyRecord(home[id]);
    const effective = instanceProxyRecord(instance);
    if (!lower || !upper || !effective || !isPlainObject(instance)) return [id, instance];
    const proxy = upper['kind'] !== undefined && upper['kind'] !== lower['kind'] ? { ...upper } : { ...effective };
    if (proxy['kind'] === 'url') {
      const owner = Object.hasOwn(upper, 'authorization') ? upper : lower;
      const authorization = owner['authorization'];
      const origin = owner['url'];
      const destination = proxy['url'];
      const sameAddress = typeof origin === 'string' && typeof destination === 'string' && sameExecutorProxyAddress(origin, destination);
      proxy['authorization'] = authorization === false || sameAddress ? authorization : undefined;
    }
    return [id, { ...instance, proxy }];
  }));
}

registerConfigSection(AGENT_EXECUTOR_INSTANCES_SECTION, AgentExecutorInstancesSchema, {
  fromToml: (value) => value,
  toToml: (value) => withoutUndefined(value),
  layerMerge: mergeInstanceProxyLayers,
  merge: (base: StoredInstances | undefined, patch): StoredInstances => {
    if (!isPlainObject(patch)) return patch as StoredInstances;
    const result = { ...base };
    for (const [id, entry] of Object.entries(executorInstancesPatchSchema.parse(mapProxyAuthorizationMask(patch, null)))) {
      if (entry === null) delete result[id];
      else if (entry.proxy.kind === 'url') {
        const { url, authorization } = entry.proxy;
        const previous = result[id]?.proxy;
        const previousUrl = previous !== undefined && 'url' in previous ? previous.url : undefined;
        const previousAuthorization = previous !== undefined && 'authorization' in previous ? previous.authorization : undefined;
        const sameAddress = (previous?.kind === undefined || previous.kind === 'url') && previousUrl !== undefined && sameExecutorProxyAddress(previousUrl, url);
        const next = authorization === null ? false : authorization ?? (sameAddress
          ? previousAuthorization : previous?.kind !== undefined || previousUrl !== undefined ? false : undefined);
        result[id] = { ...entry, proxy: { kind: 'url', url, authorization: next } };
      } else result[id] = { ...entry, proxy: entry.proxy };
    }
    return result;
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
  let instanceProxyUrl: string | undefined;
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
    if (configuration.kind === 'plugin_account') {
      if (!supportsExecutorPluginAccount(base)) issue = 'instance_configuration_unsupported';
      for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'KIKI_HARNESS_API_KEY', 'KIKI_AGY_ACCOUNT_MODELS']) envUnset.add(key);
    } else if (configuration.kind === 'config_directory') {
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
      if (proxy.kind === 'url' && proxy.authorization !== undefined) {
        address.username = encodeURIComponent(proxy.authorization.username);
        address.password = encodeURIComponent(proxy.authorization.password);
        proxyValue = address.href;
      }
      if (configuration.kind === 'plugin_account') instanceProxyUrl = proxyValue;
      if (configuration.kind === 'plugin_account' && proxy.kind === 'url' && proxy.authorization !== undefined) {
        for (const key of [...PROXY_URL_ENV, ...PROXY_BYPASS_ENV]) envUnset.add(key);
      } else {
        for (const key of PROXY_URL_ENV) env[key] = proxyValue;
        for (const key of PROXY_BYPASS_ENV) env[key] = LOOPBACK_BYPASS;
      }
      if (proxy.kind === 'env' || address.username || address.password) {
        const username = decodeURIComponent(address.username);
        const password = decodeURIComponent(address.password);
        proxySecrets.push(proxyValue, address.username, address.password, username, password);
        if (address.username || address.password) proxySecrets.push(Buffer.from(`${username}:${password}`).toString('base64'));
      }
    }
  }
  for (const key of envUnset) delete env[key];
  return {
    protocol: 'unavailable',
    ...base,
    args: base?.args ?? [],
    modelProbe: configuration.kind === 'plugin_account' ? undefined : base?.modelProbe,
    versionProbe: configuration.kind === 'plugin_account' && base?.id === 'agy-cli'
      ? { args: ['--kiki-harness-account-version'] } : base?.versionProbe,
    id,
    label: instance.label,
    instance: publicExecutorInstance(instance),
    instanceProxyUrl,
    instanceIssue: issue,
    defaultProfile: false,
    homeDir,
    claudeSettingsFile,
    env,
    envUnset: [...envUnset],
    launchSecrets: [credential, ...proxySecrets].filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length),
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
