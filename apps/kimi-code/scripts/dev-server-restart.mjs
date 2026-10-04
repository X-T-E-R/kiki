#!/usr/bin/env node
// Press-Enter-to-restart wrapper for the local server. No file watcher.
//
// Spawns `tsx ./src/main.ts serve --debug-endpoints --idle-exit 0ms …extraArgs`.
// Enter sends SIGTERM to the foreground daemon and restarts after it exits.
// The serve shutdown handler releases registration and WebSocket connections.
// This development-only restart also ends the daemon's sessions and tasks;
// ordinary `kiki web` changes browser access in place without restarting it.
// Extra arguments such as `--port 58628 --home /isolated/home` go to serve.

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, '..');

const tsxBin = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === '--') cliArgs.shift();

const tsxArgs = [
  '--tsconfig',
  './tsconfig.dev.json',
  '--import',
  '../../build/register-raw-text-loader.mjs',
  './src/main.ts',
  'serve',
  '--debug-endpoints',
  '--idle-exit',
  '0ms',
  ...cliArgs,
];

let child = null;
let restarting = false;
let shuttingDown = false;
let killTimer = null;

function start() {
  console.error('[dev:server:restart] starting server…');
  child = spawn(tsxBin, tsxArgs, {
    cwd: APP_ROOT,
    env: { ...process.env, KIKI_DEV_SERVER: '1' },
    // Server does not read stdin; keep ours free for the Enter trigger.
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  child.on('error', (err) => {
    console.error(`[dev:server:restart] spawn error: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    if (killTimer !== null) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    const prev = child;
    child = null;
    if (shuttingDown) {
      process.exit(code ?? 0);
      return;
    }
    if (restarting) {
      restarting = false;
      start();
      return;
    }
    // Server died on its own (port conflict, runtime error, etc.). Stay alive
    // so the user can fix the issue and press Enter to retry.
    const tag = signal !== null ? `signal=${signal}` : `code=${code}`;
    console.error(
      `[dev:server:restart] server exited (${tag}). Press Enter to restart, Ctrl+C to quit.`,
    );
    void prev; // silence unused warning
  });
}

function restart() {
  if (shuttingDown) return;
  if (child === null) {
    // Previous run already exited; just spin up a new one.
    start();
    return;
  }
  if (restarting) return; // debounce — multiple Enters during shutdown collapse
  restarting = true;
  console.error('[dev:server:restart] restarting…');
  child.kill('SIGTERM');
  // Safety net: if the child ignores SIGTERM, force-kill after 5s so the
  // restart loop doesn't wedge.
  killTimer = setTimeout(() => {
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      console.error('[dev:server:restart] SIGTERM timed out, sending SIGKILL');
      child.kill('SIGKILL');
    }
  }, 5000);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  // Any newline (Enter on most terminals) triggers a restart. Empty Enter is
  // the canonical signal; typing `r<Enter>` works too.
  if (chunk.includes('\n') || chunk.includes('\r')) {
    restart();
  }
});

const onShutdownSignal = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child !== null) {
    child.kill(signal);
    // Give the server a moment to flush logs / release the lock.
    setTimeout(() => process.exit(0), 1000).unref();
  } else {
    process.exit(0);
  }
};
process.on('SIGINT', () => onShutdownSignal('SIGINT'));
process.on('SIGTERM', () => onShutdownSignal('SIGTERM'));

start();
