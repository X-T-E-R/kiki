function formatValue(value: unknown): string {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function fieldName(key: string): string {
  return key.replaceAll(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

const INTERNAL_TASK_FIELDS = new Set(['parentSteering']);

export function formatPlainObject(record: object): string {
  return Object.entries(record)
    .filter(([key, value]) => !INTERNAL_TASK_FIELDS.has(key) && value !== undefined && value !== null)
    .map(([key, value]) => `${fieldName(key)}: ${formatValue(value)}`)
    .join('\n');
}
