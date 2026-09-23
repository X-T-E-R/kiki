import { execFile } from 'node:child_process';

export function openUrl(url: string): void {
  const command: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        // The quoted target keeps `&` and friends inside one `start` argument:
        // an unquoted target with no whitespace would reach `cmd.exe /c`
        // verbatim and everything after `&` would run as a second command.
        ? ['cmd', ['/c', 'start', '', quoteCmdStartTarget(url)]]
        : ['xdg-open', [url]];
  execFile(command[0], command[1], () => {});
}

function quoteCmdStartTarget(target: string): string {
  return `"${target.replaceAll('"', '""')}"`;
}
