import type { ConfigDiagnostic, ConfigSection } from './config';
import { isPlainObject } from './configPure';
import { camelToSnake } from './toml';

export function collectKeyDeprecations(
  rawSnake: Record<string, unknown>,
  sections: readonly ConfigSection[],
): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  for (const section of sections) {
    const deprecations = section.deprecations;
    if (deprecations === undefined || deprecations.length === 0) continue;
    const snakeDomain = camelToSnake(section.domain);
    const rawSection = rawSnake[snakeDomain];
    if (!isPlainObject(rawSection)) continue;
    for (const deprecation of deprecations) {
      if (rawSection[deprecation.key] === undefined) continue;
      diagnostics.push({
        domain: section.domain,
        severity: 'warning',
        message:
          `[${snakeDomain}] '${deprecation.key}' is deprecated and no longer used; ` +
          `rename it to '${deprecation.replacement}'.` +
          (deprecation.message === undefined ? '' : ` ${deprecation.message}`) +
          ' Run /kiki-ops fix this configuration warning.',
      });
    }
  }
  return diagnostics;
}

const SUBAGENT_BINDING_REPLACEMENT =
  'Subagent model and effort bindings come from the agent profile (or its route or the caller ' +
  'lease), or from an explicit model_alias and effort at dispatch.';

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
