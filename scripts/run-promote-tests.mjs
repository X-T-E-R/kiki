import { spawnSync } from 'node:child_process';

const commands = [
  ['exec', 'vitest', 'run', '--project=!kap-server'],
  ['-C', 'packages/kap-server', 'run', 'test:fast'],
  ['-C', 'packages/kap-server', 'run', 'test:mcp-bin-smoke'],
  ['-C', 'packages/pi-tui', 'test'],
];

let failed = false;
for (const args of commands) {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
    stdio: 'inherit',
  });
  if (result.status !== 0) failed = true;
}

process.exitCode = failed ? 1 : 0;
