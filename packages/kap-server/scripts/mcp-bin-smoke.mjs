#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(pkgRoot, 'dist', 'mcp', 'stdio.mjs');
const coreImport = '@kiki/agent-core-v2';
const relativeImport = /(?:from|import)\s*["'](\.\.?\/[^"']+)["']/g;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) fail('npm_execpath is unset; run via pnpm run test:mcp-bin-smoke');

try {
  execFileSync(process.execPath, [npmExecPath, 'run', 'build'], {
    cwd: pkgRoot,
    stdio: 'inherit',
  });
} catch (error) {
  fail(`kap-server build failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (!existsSync(bin)) fail(`kiki-mcp bin missing after build: ${bin}`);

const reachable = new Set();
const queue = [bin];
while (queue.length > 0) {
  const file = queue.pop();
  if (reachable.has(file)) continue;
  reachable.add(file);
  if (!existsSync(file)) fail(`built chunk missing: ${file}`);
  const text = readFileSync(file, 'utf8');
  if (text.includes(coreImport)) fail(`built chunk still imports ${coreImport}: ${file}`);
  for (const match of text.matchAll(relativeImport)) {
    queue.push(resolve(dirname(file), match[1]));
  }
}

const result = spawnSync(process.execPath, [bin], {
  env: {},
  encoding: 'utf8',
  timeout: 15_000,
  windowsHide: true,
});
if (result.error) fail(`kiki-mcp spawn failed: ${result.error.message}`);
if (result.status !== 1) fail(`kiki-mcp expected exit status 1, got ${String(result.status)}`);
if (!result.stderr.includes('Kiki MCP configuration is invalid.')) {
  fail(`kiki-mcp stderr missing invalid-config message: ${JSON.stringify(result.stderr)}`);
}

const seatOnly = spawnSync(process.execPath, [bin], {
  env: {
    KIKI_KAP_ENDPOINT: 'http://127.0.0.1:58627',
    KIKI_DELEGATION_TOKEN: 'SEAT_TOKEN',
    KIKI_SESSION_ID: 'session-test',
    KIKI_WORKSPACE_PATH: pkgRoot,
  },
  input: '',
  encoding: 'utf8',
  timeout: 15_000,
  windowsHide: true,
});
if (seatOnly.error) fail(`seat-only kiki-mcp spawn failed: ${seatOnly.error.message}`);
if (seatOnly.status !== 0) {
  fail(`seat-only kiki-mcp expected exit status 0, got ${String(seatOnly.status)}: ${JSON.stringify(seatOnly.stderr)}`);
}

process.stdout.write(`kiki-mcp bin smoke ok (${reachable.size} chunks)\n`);
