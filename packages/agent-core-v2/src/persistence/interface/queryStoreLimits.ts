/** Hard ceiling on a single serialized UTF-8 JSON value in the shared SQLite query store. */
export const QUERY_STORE_MAX_VALUE_BYTES = 8 * 1024 * 1024;

/** Raised when a single query-store value exceeds {@link QUERY_STORE_MAX_VALUE_BYTES}. */
export class QueryStoreValueTooLargeError extends Error {
  readonly code = 'query_store.value_too_large';
  readonly collection: string;
  readonly actualBytes: number;
  readonly maxBytes: number;
  constructor(collection: string, actualBytes: number, maxBytes = QUERY_STORE_MAX_VALUE_BYTES) {
    super(
      `Query store value in collection "${collection}" exceeds max serialized size (${actualBytes} > ${maxBytes} bytes)`,
    );
    this.name = 'QueryStoreValueTooLargeError';
    this.collection = collection;
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

export function isQueryStoreValueTooLarge(error: unknown): boolean {
  return (
    error instanceof QueryStoreValueTooLargeError ||
    (error as { code?: unknown } | null)?.code === 'query_store.value_too_large'
  );
}
