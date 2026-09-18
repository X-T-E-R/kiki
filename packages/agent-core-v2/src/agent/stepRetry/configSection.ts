import { z } from 'zod';

import type { ConfigDiagnostic } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import {
  cloneRecord,
  isPlainObject,
  plainObjectToToml,
  setDefined,
  transformPlainObject,
} from '#/app/config/toml';

import { isValidRetryPattern } from './retryPolicy';

export const RETRY_SECTION = 'retry';

/**
 * One `[[retry.policies]]` entry — a per-error override of the step-retry
 * decision. `match` is a regular expression tested against the failed error's
 * code (`provider.rate_limit`) and its name (`APIProviderRateLimitError`); the
 * first entry that matches decides. `retry = false` suppresses retrying that
 * error even though the built-in classification would retry it. `max_attempts`
 * replaces the section budget for that error, and `backoff` is a fixed delay in
 * milliseconds applied before every retry of that error, replacing the default
 * exponential backoff. An entry whose `match` is not a valid regular expression
 * is reported as a load-time warning and ignored.
 */
export const RetryPolicySchema = z
  .object({
    match: z.string().min(1),
    maxAttempts: z.number().int().min(1).optional(),
    backoff: z.number().int().min(0).optional(),
    retry: z.boolean().default(true),
  })
  .strict();

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

/**
 * `[retry]` — engine step-retry policy. `max_attempts` bounds the total attempts
 * for one step, the first attempt included, and takes precedence over
 * `[loop_control] max_attempts_per_step`. A provider retry-after hint still wins
 * over any configured `backoff`.
 */
export const RetryConfigSchema = z
  .object({
    maxAttempts: z.number().int().min(1).optional(),
    policies: z.array(RetryPolicySchema).optional(),
  })
  .strict();

export type RetryConfig = z.infer<typeof RetryConfigSchema>;

export const retryFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const raw = transformPlainObject(rawSnake);
  const policies = raw['policies'];
  if (isPlainObject(policies)) {
    raw['policies'] = [transformPlainObject(policies)];
  } else if (Array.isArray(policies)) {
    raw['policies'] = policies.map((entry) =>
      isPlainObject(entry) ? transformPlainObject(entry) : entry,
    );
  }
  return raw;
};

export const retryToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const out = cloneRecord(rawSnake);
  delete out['max_attempts'];
  delete out['policies'];
  setDefined(out, 'max_attempts', value['maxAttempts']);
  const policies = value['policies'];
  if (Array.isArray(policies)) {
    out['policies'] = policies.map((entry) =>
      isPlainObject(entry) ? plainObjectToToml(entry, undefined) : entry,
    );
  }
  return out;
};

export function collectRetryDiagnostics(rawSection: unknown): readonly ConfigDiagnostic[] {
  if (!isPlainObject(rawSection)) return [];
  const rawPolicies = rawSection['policies'];
  if (rawPolicies === undefined) return [];
  const diagnostics: ConfigDiagnostic[] = [];
  const entries = Array.isArray(rawPolicies) ? rawPolicies : [rawPolicies];
  for (const [index, entry] of entries.entries()) {
    if (!isPlainObject(entry)) continue;
    const pattern = entry['match'];
    if (typeof pattern !== 'string' || isValidRetryPattern(pattern)) continue;
    diagnostics.push({
      domain: RETRY_SECTION,
      severity: 'warning',
      message:
        `[retry] policies[${index}].match ${JSON.stringify(pattern)} is not a valid ` +
        'regular expression; that policy is ignored.',
    });
  }
  return diagnostics;
}

registerConfigSection(RETRY_SECTION, RetryConfigSchema, {
  fromToml: retryFromToml,
  toToml: retryToToml,
  collectDiagnostics: collectRetryDiagnostics,
});
