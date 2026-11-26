const POSIX_SAFE_RE = /^[A-Za-z0-9_./:=@%^,+-]+$/;

/**
 * Shell-escape a single argument for POSIX `sh` (mirrors Python's `shlex.quote`).
 * Empty strings become `''`; safe unquoted tokens pass through unchanged;
 * all other values are single-quoted with embedded `'` escaped as `'"'"'`.
 */
export function quotePosixShellArg(arg: string): string {
  if (arg === '') return "''";
  if (POSIX_SAFE_RE.test(arg)) return arg;
  return "'" + arg.replaceAll("'", "'\"'\"'") + "'";
}

/**
 * Quote a single argument for Windows `cmd.exe` command lines.
 */
export function quoteCmdShellArg(arg: string): string {
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * Quote a single argument for the current (or specified) host platform shell.
 */
export function quoteShellArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? quoteCmdShellArg(arg) : quotePosixShellArg(arg);
}
