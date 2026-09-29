import type { ConfigDiagnostic } from './config';
import { isPlainObject } from './configPure';
import { camelToSnake } from './toml';

const SUBAGENT_BINDING_REPLACEMENT =
  'Subagent models come from an explicit dispatch model_alias, the agent profile (or its route or caller lease), ' +
  'or [subagent].default_model when no model is pinned. Effort follows explicit dispatch, profile, and model defaults.';

const REMOVED_SECTION_SNAKE = 'secondary_model';

function removedKeyMessage(snakeDomain: string, snakeKey: string): string {
  return (
    `[${snakeDomain}] '${snakeKey}' was removed and is no longer read. ` +
    SUBAGENT_BINDING_REPLACEMENT +
    ' Run /kiki-ops fix this configuration warning.'
  );
}

export function collectRemovedKeyDiagnostics(
  domain: string,
  rawSection: unknown,
  snakeKeys: readonly string[],
): ConfigDiagnostic[] {
  if (!isPlainObject(rawSection)) return [];
  const diagnostics: ConfigDiagnostic[] = [];
  const snakeDomain = camelToSnake(domain);
  for (const snakeKey of snakeKeys) {
    if (rawSection[snakeKey] === undefined) continue;
    diagnostics.push({ domain, severity: 'warning', message: removedKeyMessage(snakeDomain, snakeKey) });
  }
  return diagnostics;
}

export function collectRemovedSectionDiagnostics(
  rawSnake: Record<string, unknown>,
): ConfigDiagnostic[] {
  if (!isPlainObject(rawSnake[REMOVED_SECTION_SNAKE])) return [];
  return [
    {
      domain: 'secondaryModel',
      severity: 'warning',
      message:
        `[${REMOVED_SECTION_SNAKE}] was removed and is no longer read. ` +
        SUBAGENT_BINDING_REPLACEMENT +
        ' Run /kiki-ops fix this configuration warning.',
    },
  ];
}
