import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PROMOTE_TEST_COMMANDS = [
  { label: 'complete root Vitest collection', args: ['exec', 'vitest', 'run', '--maxWorkers=2'] },
  { label: 'kap-server MCP binary smoke', args: ['-C', 'packages/kap-server', 'run', 'test:mcp-bin-smoke'] },
  { label: 'pi-tui node:test suite', args: ['-C', 'packages/pi-tui', 'test'] },
];

function pnpmLaunch(args, env = process.env) {
  if (env.npm_execpath) return { command: process.execPath, args: [env.npm_execpath, ...args] };
  return { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args };
}

export function runPromoteTests({ spawn = spawnSync, env = process.env } = {}) {
  let failed = false;
  for (const entry of PROMOTE_TEST_COMMANDS) {
    const launch = pnpmLaunch(entry.args, env);
    const result = spawn(launch.command, launch.args, { stdio: 'inherit', env });
    if (result.status !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runPromoteTests();
}
