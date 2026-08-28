/**
 * The server does not keep its own numbering. `@moonshot-ai/protocol` owns the
 * single table: a code the server sends but the published enum lacks is a
 * number no client can name, which is how `SESSION_LOCKED` (40933) and the
 * catalog / capability / plugin / agent-profile ranges stayed readable only as
 * 50001 for clients switching on the public enum.
 */
export { ErrorCode } from '@moonshot-ai/protocol';
