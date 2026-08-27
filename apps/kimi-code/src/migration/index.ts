/**
 * Leftovers of the kimi-cli → kimi-code import path. The importer itself is
 * gone with the v1 engine; sessions it already wrote still carry the
 * `imported_from_kimi_cli` flag, so the session picker keeps rendering the
 * `[imported]` badge for them.
 */
export { formatSessionLabel, isImportedSession, type SessionLabelInput } from './badge';
