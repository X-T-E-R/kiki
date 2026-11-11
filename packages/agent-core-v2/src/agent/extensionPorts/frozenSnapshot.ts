export function frozenExtensionSnapshot<T>(value: T): T {
  const snapshot = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (typeof item !== 'object' || item === null || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(snapshot);
  return snapshot;
}
