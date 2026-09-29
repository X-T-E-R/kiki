/**
 * Persistent permission rules written from outside the settings page (the
 * approval card's "always allow"). The server stores `permission.rules` as
 * one list, so a write reads the current list and patches it back with the
 * new rule appended — the same full-list write the settings editor makes.
 */

import type { KikiClient } from './client';
import type { KikiConfigResponse } from '@kiki/session-core/transport';

type PermissionRule = NonNullable<NonNullable<KikiConfigResponse['permission']>['rules']>[number];

/** Settings route where saved rules are listed and can be removed. */
export const PERMISSION_RULES_ROUTE = '/settings/permissions';

/**
 * Appends a user-scope allow rule for `pattern` unless an identical one is
 * already saved. Returns the config the server echoed (or the unchanged one).
 */
export async function saveAllowRule(client: KikiClient, pattern: string): Promise<KikiConfigResponse> {
  const config = await client.getConfig();
  const rules: PermissionRule[] = [...(config.permission?.rules ?? [])];
  if (rules.some((rule) => rule.decision === 'allow' && rule.scope === 'user' && rule.pattern === pattern)) {
    return config;
  }
  rules.push({ decision: 'allow', scope: 'user', pattern });
  return client.patchConfig({ permission: { rules } });
}
