import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';

export const FsErrors = {
  codes: {
    FS_PATH_NOT_FOUND: 'fs.path_not_found',
    FS_PERMISSION_DENIED: 'fs.permission_denied',
    FS_PATH_ESCAPES: 'fs.path_escapes',
    FS_IS_DIRECTORY: 'fs.is_directory',
    FS_IS_BINARY: 'fs.is_binary',
    FS_TOO_LARGE: 'fs.too_large',
    FS_ALREADY_EXISTS: 'fs.already_exists',
    FS_TOO_MANY_RESULTS: 'fs.too_many_results',
    FS_GREP_TIMEOUT: 'fs.grep_timeout',
    FS_GIT_UNAVAILABLE: 'fs.git_unavailable',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(FsErrors);

export function guiWorkspacePathError(
  path: string,
  target: string,
  legacyReason: string,
): Error2 {
  const reason = legacyReason === 'empty' || legacyReason === 'absolute'
    ? 'invalid_path'
    : 'gui_workspace_escape';
  const recovery = reason === 'invalid_path'
    ? 'Use a non-empty workspace-relative path (absolute paths are not accepted by the GUI workspace API).'
    : 'Choose a path within the GUI workspace; use the agent file tools with an explicit absolute path for external files.';
  return new Error2(
    FsErrors.codes.FS_PATH_ESCAPES,
    `[${reason}] Path "${path}" resolves to "${target}". ${recovery}`,
    { details: { path, target, reason, legacyReason, recovery } },
  );
}
