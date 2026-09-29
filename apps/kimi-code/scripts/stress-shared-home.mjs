import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const cli = process.env.KIKI_CLI ?? resolve(root, 'dist/main.mjs');
const workers = Number.parseInt(process.env.KIKI_STRESS_WORKERS ?? '8', 10);
const rounds = Number.parseInt(process.env.KIKI_STRESS_ROUNDS ?? '3', 10);
const staggerMs = Number.parseInt(process.env.KIKI_STRESS_STAGGER_MS ?? '2500', 10);
const timeoutMs = Number.parseInt(process.env.KIKI_STRESS_TIMEOUT_MS ?? '120000', 10);
const keepHome = process.env.KIKI_STRESS_KEEP_HOME === '1';
const home = process.env.KIKI_STRESS_HOME ?? await mkdtemp(join(tmpdir(), 'kiki-shared-home-'));
const prompt = process.env.KIKI_STRESS_PROMPT ?? 'Reply with exactly OK.';

if (!Number.isInteger(workers) || workers < 4 || workers > 8) throw new Error('KIKI_STRESS_WORKERS must be between 4 and 8');
if (!Number.isInteger(rounds) || rounds < 3) throw new Error('KIKI_STRESS_ROUNDS must be at least 3');
if (!Number.isInteger(staggerMs) || staggerMs < 0) throw new Error('KIKI_STRESS_STAGGER_MS must be non-negative');

function commandForCli() {
  return cli.endsWith('.mjs') || cli.endsWith('.js')
    ? { command: process.execPath, args: [cli] }
    : { command: cli, args: [] };
}

function runCli(args, worker) {
  const entry = commandForCli();
  return new Promise((resolveRun) => {
    const child = spawn(entry.command, [...entry.args, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, KIKI_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      const resume = out.match(/"type":"session\.resume_hint"[^\n]*"session_id":"([^"]+)"/);
      resolveRun({ worker, code, signal, stdout: out, stderr: err, sessionId: resume?.[1] });
    });
  });
}

function classify(result) {
  const text = `${result.stderr}\n${result.stdout}`;
  if (text.includes('active in another process')) return 'session-lock';
  if (text.includes('thread mailbox call timed out')) return 'mailbox';
  if (text.includes('runtime write-owner failed')) return 'runtime-owner';
  if (text.includes('session index mirror') || text.includes('batch failed on')) return 'session-index';
  return result.code === 0 ? undefined : 'other';
}

async function staggered(items, run) {
  const results = [];
  for (const item of items) {
    results.push(run(item));
    if (staggerMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, staggerMs));
  }
  return Promise.all(results);
}

const first = await staggered([...Array(workers).keys()], (worker) =>
  runCli(['-p', '--agent', 'agent', '--output-format', 'stream-json', prompt], worker),
);
const sessions = first.filter((result) => result.sessionId).map((result) => result.sessionId);
const all = [...first];
for (let round = 0; round < rounds; round += 1) {
  const batch = await staggered(sessions.map((sessionId, worker) => ({ sessionId, worker })), ({ sessionId, worker }) =>
    runCli(['-p', '-S', sessionId, '--output-format', 'stream-json', `${prompt} Round ${round + 1}`], worker),
  );
  all.push(...batch);
}

const failures = all.filter((result) => result.code !== 0 || result.signal !== null);
const byKind = {};
for (const failure of failures) {
  const kind = classify(failure) ?? 'other';
  byKind[kind] = (byKind[kind] ?? 0) + 1;
}
const report = {
  home,
  workers,
  rounds,
  calls: all.length,
  successes: all.length - failures.length,
  failures: failures.length,
  byKind,
  sessions: sessions.length,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!keepHome && process.env.KIKI_STRESS_HOME === undefined) await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
process.exitCode = failures.length === 0 && sessions.length === workers ? 0 : 1;
