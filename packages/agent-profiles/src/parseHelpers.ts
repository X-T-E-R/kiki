export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function parseOptionalString(
  value: unknown,
  onInvalid: () => Error,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw onInvalid();
  }
  return value.trim();
}

export function parseRequiredString(
  value: unknown,
  onMissing: () => Error,
  onInvalid: () => Error,
): string {
  const parsed = parseOptionalString(value, onInvalid);
  if (parsed === undefined) throw onMissing();
  return parsed;
}
