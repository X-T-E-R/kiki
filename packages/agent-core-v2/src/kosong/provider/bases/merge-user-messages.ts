export function mergeConsecutiveUserMessages<T>(
  messages: readonly T[],
  mergePolicy: {
    readonly isUser: (message: T) => boolean;
    readonly isToolResultOnly: (message: T) => boolean;
    readonly canMerge?: (last: T, next: T) => boolean;
    readonly merge: (last: T, next: T) => T;
  },
): T[] {
  const out: T[] = [];
  for (const message of messages) {
    const lastIndex = out.length - 1;
    const last = lastIndex >= 0 ? out[lastIndex] : undefined;
    const canMerge = last !== undefined && (
      mergePolicy.canMerge !== undefined
        ? mergePolicy.canMerge(last, message)
        : mergePolicy.isToolResultOnly(last) || !mergePolicy.isToolResultOnly(message)
    );
    if (
      last !== undefined &&
      mergePolicy.isUser(last) &&
      mergePolicy.isUser(message) &&
      canMerge
    ) {
      out[lastIndex] = mergePolicy.merge(last, message);
    } else {
      out.push(message);
    }
  }
  return out;
}
