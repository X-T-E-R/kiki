/**
 * Maximum serialized UTF-8 JSON request size, including base64 expansion and metadata.
 * Shared with the KAP call and prompt routes. Oversized client requests reject with
 * RPCError code 40001 before fetch, without mutating the caller's input.
 */
export const HTTP_REQUEST_BODY_LIMIT_BYTES = Math.ceil(((8 << 20) * 4) / 3) + (64 << 10);
