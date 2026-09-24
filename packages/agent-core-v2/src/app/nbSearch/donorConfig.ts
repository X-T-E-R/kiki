import { homedir } from 'node:os';
import { resolve } from 'node:path';

import {
  builtInProviderRegistrations,
  parseResolvedConfig,
  stableFingerprint,
  type CanonicalConfig,
  type CanonicalConfigPatch,
  type ProviderInstanceConfig,
} from '@nb-corp/nb-search';
import { findUnknownNbSearchProviderOptions } from '@kiki/protocol';

import { mergeNbSearchConfig } from './configSection';

/**
 * @license MIT
 * Copyright (c) 2026 nb-search contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Port of nb-search 0.4.0 config-sources defaults at f7cbfde0 with Kiki's
 * Tavily lanes. The public runtime revision is checked against this resolver
 * before any credential-bearing operation.
 */
export function defaultNbSearchConfiguration(home: string): CanonicalConfig {
  const instance = (provider_id: string, credential_slot_id?: string, options: Record<string, unknown> = {}): ProviderInstanceConfig => ({ provider_id, enabled: true, credential_slot_id, options });
  return {
    schema_version: '4', home, jobs_root: resolve(home, 'jobs'), retention_hours: 72, log_level: 'warn',
    provider_instances: {
      'exa.default': instance('exa', 'exa.default'), 'tavily.default': instance('tavily', 'tavily.default'),
      'jina-reader.default': instance('jina-reader', 'jina-reader.default'), 'firecrawl.default': instance('firecrawl', 'firecrawl.default'),
      'brave.default': instance('brave', 'brave.default'),
      'context7.default': instance('context7', 'context7.default'), 'zhipu.default': instance('zhipu', 'zhipu.default'),
      'github.default': instance('github', 'github.default'), 'duckduckgo.default': instance('duckduckgo'),
      'parallel.default': instance('parallel', 'parallel.default'), 'searxng.default': instance('searxng'),
      'openai-compatible.default': instance('openai-compatible', 'openai-compatible.default'),
      'grok.default': instance('grok', 'grok.default', { model: 'grok-4.1-fast' }),
      'grok-multi-agent.default': instance('grok-multi-agent', 'grok-multi-agent.default', { model: 'grok-4.20-multi-agent-xhigh', reasoning_effort: 'xhigh' }),
      'direct-http.default': instance('direct-http'), 'wayback.default': instance('wayback'),
      'browser-render.default': instance('browser-render'),
    },
    credential_slots: {
      'exa.default': { provider_id: 'exa', env: 'NB_SEARCH_EXA_API_KEY' }, 'tavily.default': { provider_id: 'tavily', env: 'NB_SEARCH_TAVILY_API_KEY' },
      'jina-reader.default': { provider_id: 'jina-reader', env: 'NB_SEARCH_JINA_API_KEY' }, 'firecrawl.default': { provider_id: 'firecrawl', env: 'NB_SEARCH_FIRECRAWL_API_KEY' },
      'brave.default': { provider_id: 'brave', env: 'NB_SEARCH_BRAVE_API_KEY' },
      'context7.default': { provider_id: 'context7', env: 'NB_SEARCH_CONTEXT7_API_KEY' }, 'zhipu.default': { provider_id: 'zhipu', env: 'NB_SEARCH_ZHIPU_API_KEY' },
      'github.default': { provider_id: 'github', env: 'NB_SEARCH_GITHUB_TOKEN' },
      'parallel.default': { provider_id: 'parallel', env: 'NB_SEARCH_PARALLEL_API_KEY' }, 'openai-compatible.default': { provider_id: 'openai-compatible', env: 'NB_SEARCH_OAC_API_KEY' },
      'grok.default': { provider_id: 'grok', env: 'NB_SEARCH_GROK_API_KEY' }, 'grok-multi-agent.default': { provider_id: 'grok-multi-agent', env: 'NB_SEARCH_GROK_API_KEY' },
    },
    lanes: {
      'exa.search': { provider_instance_id: 'exa.default', operation_id: 'search', latency: 'fast', cost: 'cheap', evidence_groups: ['exa'] },
      'exa.synthesis': { provider_instance_id: 'exa.default', operation_id: 'synthesis', latency: 'medium', cost: 'expensive' },
      'exa.contents': { provider_instance_id: 'exa.default', operation_id: 'contents', latency: 'fast', cost: 'cheap' },
      'tavily.search': { provider_instance_id: 'tavily.default', operation_id: 'search', latency: 'fast', cost: 'cheap', evidence_groups: ['tavily'] },
      'tavily.synthesis': { provider_instance_id: 'tavily.default', operation_id: 'synthesis', latency: 'medium', cost: 'cheap' },
      'tavily.crawl': { provider_instance_id: 'tavily.default', operation_id: 'crawl', latency: 'slow', cost: 'cheap' },
      'tavily.research': { provider_instance_id: 'tavily.default', operation_id: 'research', latency: 'slow', cost: 'expensive' },
      'tavily.extract': { provider_instance_id: 'tavily.default', operation_id: 'extract', latency: 'fast', cost: 'cheap' },
      'context7.docs': { provider_instance_id: 'context7.default', operation_id: 'docs', latency: 'medium', cost: 'cheap' },
      'zhipu.search': { provider_instance_id: 'zhipu.default', operation_id: 'search', latency: 'fast', cost: 'cheap', evidence_groups: ['zhipu'] },
      'github.repositories': { provider_instance_id: 'github.default', operation_id: 'repositories', latency: 'fast', cost: 'free', evidence_groups: ['github'] },
      'duckduckgo.search': { provider_instance_id: 'duckduckgo.default', operation_id: 'search', latency: 'medium', cost: 'free', evidence_groups: ['duckduckgo'] },
      'parallel.search': { provider_instance_id: 'parallel.default', operation_id: 'search', latency: 'fast', cost: 'cheap', evidence_groups: ['parallel'] },
      'searxng.search': { provider_instance_id: 'searxng.default', operation_id: 'search', latency: 'medium', cost: 'free', evidence_groups: ['searxng'] },
      'oac.synthesis': { provider_instance_id: 'openai-compatible.default', operation_id: 'synthesis', latency: 'slow', cost: 'expensive' },
      'oac.fetch': { provider_instance_id: 'openai-compatible.default', operation_id: 'fetch', latency: 'slow', cost: 'expensive' },
      'jina.reader': { provider_instance_id: 'jina-reader.default', operation_id: 'reader', latency: 'medium', cost: 'free' },
      'firecrawl.search': { provider_instance_id: 'firecrawl.default', operation_id: 'search', latency: 'fast', cost: 'cheap', evidence_groups: ['firecrawl'] },
      'firecrawl.scrape': { provider_instance_id: 'firecrawl.default', operation_id: 'scrape', latency: 'medium', cost: 'cheap' },
      'grok.synthesis': { provider_instance_id: 'grok.default', operation_id: 'synthesis', latency: 'slow', cost: 'expensive' },
      'grok.x-synthesis': { provider_instance_id: 'grok.default', operation_id: 'x-synthesis', latency: 'slow', cost: 'expensive' },
      'brave.search': { provider_instance_id: 'brave.default', operation_id: 'search', latency: 'fast', cost: 'cheap', evidence_groups: ['brave'] },
      'gma.research': { provider_instance_id: 'grok-multi-agent.default', operation_id: 'research', latency: 'slow', cost: 'expensive' },
      'direct.fetch': { provider_instance_id: 'direct-http.default', operation_id: 'fetch', latency: 'fast', cost: 'free' },
      'direct.local': { provider_instance_id: 'direct-http.default', operation_id: 'local', latency: 'fast', cost: 'free' },
      'wayback.fetch': { provider_instance_id: 'wayback.default', operation_id: 'fetch', latency: 'medium', cost: 'free' },
      'browser.render': { provider_instance_id: 'browser-render.default', operation_id: 'render', latency: 'slow', cost: 'free' },
    },
    defaults: { search_lane: 'github.repositories', fetch_chain: [{ input_kind: 'url', pipelines: ['direct.fetch', 'jina.reader'] }, { input_kind: 'inline_text', pipelines: ['direct.local'] }, { input_kind: 'inline_bytes', pipelines: ['direct.local'] }, { input_kind: 'file', pipelines: ['direct.local'] }] },
    presets: {}, fetch: { file_scopes: [] },
    execution: { max_provider_calls: 64, max_concurrency: 8, retry_count: 1, search_timeout_ms: 30_000, fetch_timeout_ms: 60_000, max_inline_bytes: 16 * 1024 * 1024, fetch: { max_source_bytes: 2097152, max_response_bytes: 2097152, max_content_chars: 200_000, max_redirects: 5, quality: { min_content_chars: 0, blocked_markers: [] } } },
  };
}

export function nbSearchPaths(env: NodeJS.ProcessEnv) {
  const home = resolve(nonempty(env['NB_SEARCH_HOME']) ?? resolve(homedir(), '.nb-search'));
  return { home, canonical: resolve(nonempty(env['NB_SEARCH_CONFIG']) ?? resolve(home, 'config.json')), secrets: resolve(home, 'secrets.json'), lock: resolve(home, '.config-access.lock') };
}

export function resolveNbSearchConfig(env: NodeJS.ProcessEnv, canonical: CanonicalConfigPatch | undefined, kiki: CanonicalConfigPatch | undefined): CanonicalConfig {
  const sources = [defaultNbSearchConfiguration(nbSearchPaths(env).home), canonical, environmentPatch(env), kiki];
  let merged: CanonicalConfigPatch = {};
  for (const source of sources) if (source !== undefined) merged = mergeNbSearchConfig(merged, source);
  return parseResolvedConfig(merged);
}

export function nbSearchConfigIssues(error: unknown, config?: CanonicalConfigPatch, issue = 'EFFECTIVE_CONFIG_INVALID'): string[] {
  const unknownOption = config === undefined ? undefined : findUnknownNbSearchProviderOptions(
    config,
    builtInProviderRegistrations().map((registration) => registration.descriptor),
  )[0];
  const diagnostic = unknownOption === undefined
    ? nbSearchConfigDiagnostic(error)
    : unknownOption.option_key === undefined
      ? `CONFIGURATION_ERROR:provider_instances.${unknownOption.provider_instance_id}.provider_id`
      : `CONFIGURATION_ERROR:provider_instances.${unknownOption.provider_instance_id}.options.${unknownOption.option_key}`;
  return diagnostic === undefined || diagnostic === issue ? [issue] : [issue, diagnostic];
}

function nbSearchConfigDiagnostic(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const code = 'code' in error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(error.code)
    ? error.code
    : 'CONFIGURATION_ERROR';
  const message = 'message' in error && typeof error.message === 'string' ? error.message : undefined;
  const path = message?.match(/^(?:resolved configuration|local nb-search configuration) is invalid: (defaults\.(?:search_lane|fetch_chain)):/)?.[1];
  return path === undefined ? code : `${code}:${path}`;
}

export function nbSearchConfigRevision(config: CanonicalConfig): string {
  return `config-4-${stableFingerprint(config).slice(0, 16)}`;
}

export function pinnedNbSearchConfig(config: CanonicalConfig): CanonicalConfigPatch {
  const defaults = defaultNbSearchConfiguration(config.home ?? '');
  const result: Record<string, unknown> = { ...structuredClone(config) };
  for (const key of Object.keys(defaults)) if (result[key] === undefined) result[key] = null;
  for (const key of ['provider_instances', 'credential_slots', 'lanes', 'presets', 'defaults'] as const) {
    const value: Record<string, unknown> = { ...config[key] };
    for (const inherited of Object.keys(defaults[key])) if (value[inherited] === undefined) value[inherited] = null;
    result[key] = value;
  }
  return result as CanonicalConfigPatch;
}

function environmentPatch(env: NodeJS.ProcessEnv): CanonicalConfigPatch {
  const provider_instances: Record<string, Record<string, unknown>> = {};
  const set = (id: string, key: string, value: unknown): void => { if (value !== undefined) (provider_instances[id] ??= {})[key] = value; };
  const endpoints = { exa: 'EXA', tavily: 'TAVILY', 'jina-reader': 'JINA', firecrawl: 'FIRECRAWL', brave: 'BRAVE', zhipu: 'ZHIPU', searxng: 'SEARXNG', 'openai-compatible': 'OAC', grok: 'GROK', 'grok-multi-agent': 'GROK_MULTI_AGENT' };
  for (const [provider, name] of Object.entries(endpoints)) set(`${provider}.default`, 'base_url', nonempty(env[`NB_SEARCH_${name}_BASE_URL`]));
  for (const [provider, name] of Object.entries({ 'openai-compatible': 'OAC', grok: 'GROK', 'grok-multi-agent': 'GROK_MULTI_AGENT' })) {
    const model = nonempty(env[`NB_SEARCH_${name}_MODEL`]);
    if (model !== undefined) set(`${provider}.default`, 'options', { model });
  }
  return { provider_instances, jobs_root: nonempty(env['NB_SEARCH_JOBS_ROOT']), retention_hours: integer(env['NB_SEARCH_RETENTION_HOURS']), log_level: nonempty(env['NB_SEARCH_LOG_LEVEL']) as CanonicalConfig['log_level'] | undefined };
}

function integer(value: string | undefined): number | undefined {
  const raw = nonempty(value);
  if (raw === undefined) return undefined;
  const number = Number(raw);
  if (!Number.isSafeInteger(number)) throw new Error('Invalid nb-search environment configuration.');
  return number;
}

function nonempty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}
