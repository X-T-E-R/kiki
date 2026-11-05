import type { HostProcessServiceLike } from '@kiki/acp-client';
import { stringify } from 'smol-toml';

import { ILogService } from '#/_base/log/log';
import { executorSourceId, IAgentExecutorRegistry, type AgentExecutorContext, type AgentExecutorDescriptor } from '#/app/agentExecutor/agentExecutor';
import { redactExecutorOutput } from '#/app/agentExecutor/executorOverrides';
import { IPluginHostService } from '#/app/plugin/pluginHostService';
import { Error2, ErrorCodes } from '#/errors';

export const CODEX_ACCOUNT_MODEL_PROVIDER = 'kiki_harness_account';
export const AGY_ACCOUNT_SWITCH = '--kiki-harness-account';

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const BYPASS = 'localhost,.localhost,127.0.0.1,::1,[::1]';
const CODEX_KEY = 'KIKI_HARNESS_API_KEY';

export class HarnessAccountStartupError extends Error2 {}

export function harnessAccountError(descriptor: AgentExecutorDescriptor, error: unknown): unknown {
  const configuration = descriptor.instance?.configuration;
  return configuration?.kind === 'plugin_account' ? new Error(
    `Executor instance "${descriptor.label ?? descriptor.id}" (${configuration.source}): ${error instanceof Error ? error.message : 'Engine request failed'}`,
    { cause: error },
  ) : error;
}

export function harnessAccountProcess(processes: HostProcessServiceLike, context: AgentExecutorContext, runtimeId: string) {
  const { descriptor } = context;
  const instance = descriptor.instance;
  const account = instance?.configuration;
  if (instance === undefined || account?.kind !== 'plugin_account') return { processes };
  const engineId = executorSourceId(descriptor);
  const gemini = engineId === 'agy-cli';
  const fail = (reason: string) => new HarnessAccountStartupError(ErrorCodes.CONFIG_INVALID,
    `Executor instance "${descriptor.label ?? descriptor.id}" (${account.source}): ${reason}`,
    { details: { executorId: descriptor.id, accountSource: account.source } });
  let sensitive: readonly string[] = [];
  const redact = (text: string) => sensitive.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), redactExecutorOutput(descriptor, text));
  const wrapped: HostProcessServiceLike = {
    redactDiagnostic: redact,
    spawn: async (command, args, options, startupSignal) => {
      if (command !== descriptor.command) return processes.spawn(command, args, options);
      if (runtimeId !== 'local') throw fail('A plugin account connection requires an engine running on the Kiki host.');
      const signal = startupSignal ?? AbortSignal.timeout(30_000);
      const proxy = instance.proxy;
      const proxyUrl = proxy.kind === 'url' ? proxy.url : descriptor.env?.['HTTPS_PROXY'];
      const mode = proxy.kind === 'inherit' ? 'system' : proxy.kind === 'direct' ? 'direct' : 'custom';
      if (mode === 'custom' && proxyUrl === undefined) throw fail('The configured proxy is unavailable.');
      const hosts = context.agent.accessor.get(IPluginHostService);
      const lease = await hosts.prepareHarnessAccount(account.source, {
        engineId, accountId: account.account_id, instanceId: descriptor.id,
        proxy: { mode, url: mode === 'custom' ? proxyUrl : undefined },
      }, signal).catch(() => {
        signal.throwIfAborted();
        throw fail('Could not connect to the selected account. Check the instance or sign in again in the source plugin.');
      });
      const log = context.agent.accessor.get(ILogService);
      const release = () => lease.release().catch(() => {
        log.warn('Harness account connection cleanup failed', { executorId: descriptor.id, source: account.source });
      });
      try {
        signal.throwIfAborted();
        const { connection } = lease;
        sensitive = [connection.apiKey, connection.baseUrl];
        const models = [...new Set(connection.modelIds)];
        if (connection.protocol !== (gemini ? 'gemini-v1beta' : 'openai-responses') || models.length === 0
          || models.some((id) => id === 'engine-default' || /\s/u.test(id))) {
          throw fail('The source did not provide a compatible connection and model list.');
        }
        const selected = context.binding.modelAlias;
        if (selected !== undefined && !models.includes(selected)) throw fail('The bound model is not available for the selected account.');
        const endpoint = new URL(connection.baseUrl);
        if (endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw fail('The source returned an invalid connection endpoint.');
        const launchEnv: Record<string, string> = gemini ? {
          GEMINI_API_KEY: connection.apiKey,
          GOOGLE_GEMINI_BASE_URL: connection.baseUrl,
          KIKI_AGY_ACCOUNT_MODELS: JSON.stringify(models),
        } : { [CODEX_KEY]: connection.apiKey };
        const launchArgs = gemini ? [AGY_ACCOUNT_SWITCH] : [
          '-c', codexConfig('model_provider', CODEX_ACCOUNT_MODEL_PROVIDER),
          '-c', codexConfig('model', selected ?? models[0]!),
          '-c', codexConfig(`model_providers.${CODEX_ACCOUNT_MODEL_PROVIDER}`, {
            name: 'Kiki account source', base_url: connection.baseUrl, env_key: CODEX_KEY,
            wire_api: 'responses', requires_openai_auth: false, supports_websockets: false,
            request_max_retries: 0, stream_max_retries: 0,
          }),
        ];
        const env = { ...options?.env, ...launchEnv, NO_PROXY: BYPASS, no_proxy: BYPASS };
        const unset = [...options?.envUnset ?? [], ...PROXY_VARS].filter((key) => !Object.hasOwn(launchEnv, key) && key !== 'NO_PROXY' && key !== 'no_proxy');
        const child = await processes.spawn(command, [...args ?? [], ...launchArgs], { ...options, env, envUnset: unset });
        const waited = child.wait();
        void waited.then(release, release);
        if (!gemini) context.agent.accessor.get(IAgentExecutorRegistry).recordNegotiated?.(descriptor.id,
          descriptor.version, { models }, descriptor.registryRevision);
        return child;
      } catch (error) {
        await release();
        signal.throwIfAborted();
        if (error instanceof HarnessAccountStartupError) throw error;
        throw fail('Could not start the engine with its selected account connection.');
      }
    },
  };
  return { processes: wrapped };
}

function codexConfig(key: string, value: string | Record<string, string | number | boolean>): string {
  if (typeof value === 'string') return `${key}=${stringify({ value }).trim().slice('value = '.length)}`;
  return `${key}={${Object.entries(value).map(([name, field]) => stringify({ [name]: field }).trim()).join(', ')}}`;
}
