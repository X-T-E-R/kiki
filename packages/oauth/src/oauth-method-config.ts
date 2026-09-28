/**
 * Config write-back for the device-flow sign-in methods: after a sign-in (or
 * an explicit model refresh) the method's provider and its model aliases are
 * written into the config shape the managed Kimi Code path already uses.
 * Unlike Kimi Code, a method never replaces an existing default model; it only
 * seeds one when the config has none (or the old one disappeared).
 */

import { mergeRefreshedModelAlias, MANAGED_KIMI_MODEL_FIELDS } from './model-alias-merge';
import type { ManagedKimiConfigShape, ManagedKimiModelAlias } from './managed-kimi-code';
import type { OAuthMethodDescriptor, OAuthMethodModel } from './oauth-method-types';
import { isRecord } from './utils';

export interface ApplyOAuthMethodConfigOptions {
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly models: readonly OAuthMethodModel[];
}

export interface ApplyOAuthMethodConfigResult {
  readonly added: number;
  readonly removed: number;
  readonly defaultModel: string | undefined;
}

export function oauthMethodModelAlias(method: OAuthMethodDescriptor, modelId: string): string {
  return `${method.aliasPrefix}/${modelId}`;
}

function toAlias(method: OAuthMethodDescriptor, model: OAuthMethodModel): ManagedKimiModelAlias {
  return {
    provider: method.providerName,
    model: model.id,
    maxContextSize: model.contextLength,
    capabilities: [...model.capabilities],
    displayName: model.displayName,
    supportEfforts: model.supportEfforts,
    defaultEffort: model.defaultEffort,
    protocol: model.protocol === undefined || model.protocol === method.protocol
      ? undefined
      : (model.protocol as ManagedKimiModelAlias['protocol']),
  };
}

function ownedAliases(config: ManagedKimiConfigShape, method: OAuthMethodDescriptor): string[] {
  const prefix = `${method.aliasPrefix}/`;
  return Object.entries(config.models ?? {})
    .filter(([key, model]) => isRecord(model) && model['provider'] === method.providerName && key.startsWith(prefix))
    .map(([key]) => key);
}

export function applyOAuthMethodConfig(
  config: ManagedKimiConfigShape,
  method: OAuthMethodDescriptor,
  options: ApplyOAuthMethodConfigOptions,
): ApplyOAuthMethodConfigResult {
  if (options.models.length === 0) {
    throw new Error(`${method.label} returned no usable models for this account.`);
  }
  const existing = isRecord(config.providers[method.providerName]) ? config.providers[method.providerName] : {};
  config.providers[method.providerName] = {
    ...existing,
    type: method.protocol,
    baseUrl: options.baseUrl,
    apiKey: undefined,
    oauth: { storage: 'file', key: method.oauthKey },
    customHeaders: options.headers === undefined ? undefined : { ...options.headers },
    modelSource: 'static',
  };

  const models = { ...config.models };
  const before = new Set(ownedAliases(config, method));
  const next = new Set(options.models.map((model) => oauthMethodModelAlias(method, model.id)));
  for (const key of before) {
    if (!next.has(key)) delete models[key];
  }
  for (const model of options.models) {
    const key = oauthMethodModelAlias(method, model.id);
    models[key] = mergeRefreshedModelAlias(models[key], toAlias(method, model), MANAGED_KIMI_MODEL_FIELDS);
  }
  config.models = models;

  if (config.defaultModel === undefined || config.defaultModel === '' || models[config.defaultModel] === undefined) {
    const first = options.models[0];
    config.defaultModel = first === undefined ? undefined : oauthMethodModelAlias(method, first.id);
  }

  let added = 0;
  for (const key of next) if (!before.has(key)) added += 1;
  let removed = 0;
  for (const key of before) if (!next.has(key)) removed += 1;
  return { added, removed, defaultModel: config.defaultModel };
}

export interface ClearOAuthMethodConfigResult {
  readonly removedProvider: boolean;
  readonly removedModels: readonly string[];
  readonly defaultModelCleared: boolean;
}

export function clearOAuthMethodConfig(
  config: ManagedKimiConfigShape,
  method: OAuthMethodDescriptor,
): ClearOAuthMethodConfigResult {
  const removedProvider = Object.hasOwn(config.providers, method.providerName);
  delete config.providers[method.providerName];
  const removedModels: string[] = [];
  const models = { ...config.models };
  for (const key of ownedAliases(config, method)) {
    delete models[key];
    removedModels.push(key);
  }
  config.models = models;
  const defaultModelCleared = typeof config.defaultModel === 'string' && removedModels.includes(config.defaultModel);
  if (defaultModelCleared) config.defaultModel = undefined;
  return { removedProvider, removedModels, defaultModelCleared };
}
