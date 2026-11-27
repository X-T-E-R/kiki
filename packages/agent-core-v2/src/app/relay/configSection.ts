import {
  relayNodeConfigSchema,
  relaySubscriptionConfigSchema,
  type RelayNodeConfig,
  type RelaySubscriptionConfig,
} from '@kiki/protocol';
import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import { isPlainObject, plainObjectToToml, transformPlainObject } from '#/app/config/toml';

export const RELAY_CONFIG_SECTION = 'relay';

export const RelayConfigSchema = z.object({
  nodes: z.array(relayNodeConfigSchema).max(64).default([]),
  subscriptions: z.array(relaySubscriptionConfigSchema).max(32).default([]),
}).strict().superRefine((value, context) => {
  const nodeIds = new Set<string>();
  value.nodes.forEach((node, index) => {
    if (nodeIds.has(node.id)) {
      context.addIssue({ code: 'custom', path: ['nodes', index, 'id'], message: 'Relay node IDs must be unique.' });
    }
    nodeIds.add(node.id);
  });
  const subIds = new Set<string>();
  value.subscriptions.forEach((sub, index) => {
    if (subIds.has(sub.id)) {
      context.addIssue({ code: 'custom', path: ['subscriptions', index, 'id'], message: 'Relay subscription IDs must be unique.' });
    }
    subIds.add(sub.id);
  });
});

export type RelayConfig = z.infer<typeof RelayConfigSchema>;
export type { RelayNodeConfig, RelaySubscriptionConfig };

export const DEFAULT_RELAY_CONFIG: RelayConfig = {
  nodes: [],
  subscriptions: [],
};

/** Converts TOML snake_case `[relay]` payloads (including `nodes` and `subscriptions` arrays) to camelCase. */
export function relayConfigFromToml(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const value = transformPlainObject(raw);
  if (Array.isArray(value['nodes'])) {
    value['nodes'] = value['nodes'].map((entry) => (isPlainObject(entry) ? transformPlainObject(entry) : entry));
  }
  if (Array.isArray(value['subscriptions'])) {
    value['subscriptions'] = value['subscriptions'].map((entry) => (isPlainObject(entry) ? transformPlainObject(entry) : entry));
  }
  return value;
}

/** Converts camelCase `[relay]` config values back to TOML snake_case tables. */
export function relayConfigToToml(value: unknown, raw: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const converted = plainObjectToToml(value, raw);
  if (Array.isArray(converted['nodes'])) {
    converted['nodes'] = converted['nodes'].map((entry) => (isPlainObject(entry) ? plainObjectToToml(entry, undefined) : entry));
  }
  if (Array.isArray(converted['subscriptions'])) {
    converted['subscriptions'] = converted['subscriptions'].map((entry) => (isPlainObject(entry) ? plainObjectToToml(entry, undefined) : entry));
  }
  return converted;
}

registerConfigSection(RELAY_CONFIG_SECTION, RelayConfigSchema, {
  defaultValue: DEFAULT_RELAY_CONFIG,
  fromToml: relayConfigFromToml,
  toToml: relayConfigToToml,
});
