import type { AgentModelConstraints } from './agentProfile';

export const MODEL_CONSTRAINT_KEYS = [
  'allowed_models', 'deny_models', 'allowed_efforts',
  'preferred_models', 'discouraged_models', 'preferred_efforts',
] as const;

export class ModelConstraintParseError extends Error {
  readonly code = 'validation.failed';
}

export function parseModelConstraintFields(
  record: Record<string, unknown>,
  path: string,
  prefix = '',
): AgentModelConstraints {
  const list = (key: typeof MODEL_CONSTRAINT_KEYS[number], wildcard: boolean): readonly string[] | undefined => {
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    const raw = typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : value;
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string' || item.trim() === '')) {
      throw new ModelConstraintParseError(`${prefix}${key} in ${path} must be a list of non-empty strings`);
    }
    const values: string[] = raw.map((item: string) => item.trim());
    if (values.includes('*')) {
      if (wildcard && values.length === 1) return undefined;
      throw new ModelConstraintParseError(`${prefix}${key} in ${path} cannot mix "*" with names or use a deny wildcard`);
    }
    return !wildcard && values.length === 0 ? undefined : values;
  };
  return {
    allowedModels: list('allowed_models', true),
    denyModels: list('deny_models', false),
    allowedEfforts: list('allowed_efforts', true),
    preferredModels: list('preferred_models', true),
    discouragedModels: list('discouraged_models', false),
    preferredEfforts: list('preferred_efforts', true),
  };
}
