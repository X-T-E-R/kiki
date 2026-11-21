import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROMOTE_TEST_COMMANDS = [
  { label: 'root Vitest collection excluding kap-server', args: ['exec', 'vitest', 'run', '--project=!kap-server'] },
  { label: 'kap-server fast tests', args: ['-C', 'packages/kap-server', 'run', 'test:fast'] },
  { label: 'kap-server integration tests', args: ['-C', 'packages/kap-server', 'run', 'test:integration'] },
  { label: 'kap-server MCP binary smoke', args: ['-C', 'packages/kap-server', 'run', 'test:mcp-bin-smoke'] },
  { label: 'pi-tui node:test suite', args: ['-C', 'packages/pi-tui', 'test'] },
  {
    label: 'kiki-gui visual proof headless smoke',
    args: ['-C', 'apps/kiki-gui', 'exec', 'node', 'scripts/visual-proof.mjs', '--config', 'scripts/visual-proof-headless-smoke.mjs'],
  },
  {
    label: 'kiki-gui mobile rigor visual & geometry gate',
    args: ['-C', 'apps/kiki-gui', 'run', 'proof:mobile-rigor'],
  },
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
    if (/[\r\n"&|<>^%!]/.test(value)) throw new Error(`unsafe Windows pnpm argument: ${value}`);
    return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value);
  });
}

export const LOCAL_REAL_CORPUS_PROMOTE_COMMAND = {
  label: 'real-corpus quick performance gate',
  args: ['run', 'perf:real-corpus:quick'],
};

export function readVerifiedGitHead(cwd = process.cwd(), spawn = spawnSync) {
  const head = spawn('git', ['rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf8' });
  if (head.error || head.status !== 0) {
    throw new Error(`unable to resolve git HEAD: ${head.stderr || head.error?.message || head.status}`);
  }
  const sha = String(head.stdout).trim();
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`unexpected git HEAD SHA: ${sha}`);
  const status = spawn('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  const dirty = status.status === 0 && String(status.stdout).trim().length > 0;
  return { gitHead: sha, worktreeDirty: dirty };
}

export function verifyPromoteReceipt(
  receiptPath,
  { cwd = process.cwd(), spawn = spawnSync, allowDirty = false, withRealCorpus = false } = {},
) {
  const receipt = JSON.parse(readFileSync(resolve(cwd, receiptPath), 'utf8'));
  const { gitHead, worktreeDirty } = readVerifiedGitHead(cwd, spawn);
  if (receipt?.schemaVersion !== 1 || receipt?.passed !== true) {
    throw new Error(`promote receipt is not a passing receipt: ${receiptPath}`);
  }
  if (typeof receipt.gitHead !== 'string' || receipt.gitHead !== gitHead) {
    throw new Error(`promote receipt HEAD mismatch: receipt=${String(receipt.gitHead)} current=${gitHead}`);
  }
  if (!allowDirty && (receipt.worktreeDirty === true || worktreeDirty)) {
    throw new Error(`promote receipt cannot certify a dirty worktree for HEAD ${gitHead}`);
  }
  const expectedCommands = withRealCorpus
    ? [...PROMOTE_TEST_COMMANDS, LOCAL_REAL_CORPUS_PROMOTE_COMMAND]
    : PROMOTE_TEST_COMMANDS;
  if (!Array.isArray(receipt.commands) || receipt.commands.length < expectedCommands.length || receipt.commands.some((c) => c.status !== 0)) {
    throw new Error(`promote receipt has incomplete or failed command results: ${receiptPath}`);
  }
  for (const expected of expectedCommands) {
    const matched = receipt.commands.find(
      (entry) =>
        entry?.label === expected.label &&
        entry?.status === 0 &&
        Array.isArray(entry?.args) &&
        entry.args.length === expected.args.length &&
        entry.args.every((arg, index) => arg === expected.args[index]),
    );
    if (!matched) {
      throw new Error(`promote receipt is missing required passing command "${expected.label}": ${receiptPath}`);
    }
  }
  return receipt;
}

export function runPromoteTests({
  spawn = spawnSync,
  env = process.env,
  withRealCorpus = false,
  receiptPath = undefined,
  cwd = process.cwd(),
} = {}) {
  let failed = false;
  const commands = withRealCorpus
    ? [...PROMOTE_TEST_COMMANDS, LOCAL_REAL_CORPUS_PROMOTE_COMMAND]
    : PROMOTE_TEST_COMMANDS;
  const results = [];
  for (const entry of commands) {
    const launch = pnpmLaunch(entry.args, env);
    const result = spawn(launch.command, pnpmSpawnArgs(launch.args, env), { cwd, stdio: 'inherit', env, ...pnpmSpawnOptions(env) });
    const status = result.error ? 1 : (result.status ?? 1);
    results.push({ label: entry.label, args: entry.args, status });
    if (status !== 0) failed = true;
  }
  if (receiptPath !== undefined && !failed) {
    const { gitHead, worktreeDirty } = readVerifiedGitHead(cwd, spawn);
    const resolved = resolve(cwd, receiptPath);
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(
      resolved,
      `${JSON.stringify({ schemaVersion: 1, gitHead, worktreeDirty, passed: true, commands: results, finishedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const receiptIdx = process.argv.indexOf('--write-receipt');
  const receiptPath = receiptIdx >= 0 ? process.argv[receiptIdx + 1] : undefined;
  process.exitCode = runPromoteTests({
    withRealCorpus: process.argv.includes('--with-real-corpus'),
    receiptPath,
  });
}
