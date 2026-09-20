/**
 * V2 config.toml validation for `kimi doctor`.
 *
 * Loaded lazily (dynamic import) by the doctor command on the default
 * agent-core-v2 path, so the v2 module graph stays off the legacy doctor path.
 * Validation uses the engine's own section registry instead of the legacy
 * whole-document strict schema:
 * importing the package root runs every built-in section's side-effect
 * registration ("import = register"), and `ConfigRegistry` is then
 * constructed directly — no DI container, no `ConfigService`, no file IO.
 *
 * Semantics deliberately mirror the v2 engine rather than v1:
 *  - a registered section that fails schema validation is an error (the
 *    engine would silently ignore that section at runtime; surfacing it is
 *    doctor's job);
 *  - a top-level key with no registered section passes through the engine
 *    untouched, so it is reported as a non-fatal warning — except the known
 *    schema-less domains the engine consumes directly (`default_model`, …);
 *  - unknown top-level keys are reported as non-fatal warnings, matching the
 *    engine's treatment of unregistered sections.
 */

import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import { ConfigRegistry } from '@kiki/agent-core-v2';
import {
  camelToSnake,
  describeTomlSyntaxError,
  transformTomlData,
} from '@kiki/agent-core-v2/app/config/toml';

/**
 * Top-level domains the v2 engine reads via `IConfigService.get` / `inspect`
 * without registering a schema (free-form values, structurally validated
 * nowhere): `defaultModel` / `defaultProvider` (`kosongConfig` default
 * pointers) and `modelOverrides` (`llmRequester` / `profile`).
 */
const SCHEMALESS_DOMAINS: ReadonlySet<string> = new Set([
  'defaultModel',
  'defaultProvider',
  'modelOverrides',
]);

interface V2ConfigValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * Matches the shape `handleDoctor` extracts from `error.details` (the SDK's
 * `KimiConfigValidationIssue` list), so the doctor formatter renders v2
 * issues exactly like v1 ones.
 */
class V2ConfigValidationError extends Error {
  readonly details: { readonly validationIssues: readonly V2ConfigValidationIssue[] };

  constructor(issues: readonly V2ConfigValidationIssue[]) {
    super('v2 config validation failed');
    this.details = { validationIssues: issues };
  }
}

/**
 * Validate `text` as config.toml against the v2 engine's section registry.
 * Throws on TOML syntax errors and on any registered section failing its
 * schema; returns non-fatal warnings (one per line) for unknown top-level
 * keys.
 */
export function validateConfigTomlV2(text: string, filePath: string): string | undefined {
  let data: Record<string, unknown> = {};
  if (text.trim().length > 0) {
    try {
      data = parseToml(text) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Invalid TOML in ${filePath}: ${describeTomlSyntaxError(error)}`, {
        cause: error,
      });
    }
  }

  const registry = new ConfigRegistry();
  const transformed = transformTomlData(data, registry);

  const issues: V2ConfigValidationIssue[] = [];
  const unknownKeys: string[] = [];
  for (const [domain, value] of Object.entries(transformed)) {
    if (registry.getSection(domain) === undefined) {
      if (!SCHEMALESS_DOMAINS.has(domain)) unknownKeys.push(camelToSnake(domain));
      continue;
    }
    try {
      registry.validate(domain, value);
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      for (const issue of error.issues) {
        issues.push({
          path: [
            domain,
            ...issue.path.map((segment) =>
              typeof segment === 'number' ? segment : String(segment),
            ),
          ],
          message: issue.message,
        });
      }
    }
  }

  if (issues.length > 0) throw new V2ConfigValidationError(issues);

  const warnings: string[] = [];
  if (unknownKeys.length > 0) {
    warnings.push(
      `Unknown top-level ${unknownKeys.length === 1 ? 'key' : 'keys'} ignored by the v2 engine: ${unknownKeys.join(', ')}.`,
    );
  }
  return warnings.length > 0 ? warnings.join('\n') : undefined;
}
