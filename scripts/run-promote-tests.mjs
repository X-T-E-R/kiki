import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PROMOTE_TEST_COMMANDS = [
  { label: 'root Vitest collection excluding kap-server', args: ['exec', 'vitest', 'run', '--project=!kap-server'] },
  { label: 'kap-server fast tests', args: ['-C', 'packages/kap-server', 'run', 'test:fast'] },
  { label: 'kap-server integration tests', args: ['-C', 'packages/kap-server', 'run', 'test:integration'] },
  { label: 'kap-server MCP binary smoke', args: ['-C', 'packages/kap-server', 'run', 'test:mcp-bin-smoke'] },
  { label: 'pi-tui node:test suite', args: ['-C', 'packages/pi-tui', 'test'] },
];

export function pnpmLaunch(args, env = process.env) {
  if (env.npm_execpath) return { command: process.execPath, args: [env.npm_execpath, ...args] };
  return { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args };
}

export function pnpmSpawnOptions(env = process.env) {
  return !env.npm_execpath && process.platform === 'win32' ? { shell: true } : {};
}

export function pnpmSpawnArgs(args, env = process.env) {
  if (!pnpmSpawnOptions(env).shell) return args;
  return args.map((value) => {
    if (/[\r\n\"&|<>^%!]/.test(value)) throw new Error(`unsafe Windows pnpm argument: ${value}`);
    return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value);
  });
}

export function runPromoteTests({ spawn = spawnSync, env = process.env } = {}) {
  let failed = false;
  for (const entry of PROMOTE_TEST_COMMANDS) {
    const launch = pnpmLaunch(entry.args, env);
    const result = spawn(launch.command, pnpmSpawnArgs(launch.args, env), { stdio: 'inherit', env, ...pnpmSpawnOptions(env) });
    if (result.error || result.status !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runPromoteTests();
}
