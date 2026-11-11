import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archivePath = resolve(appRoot, 'dist-android', 'kiki-dist.tar.xz');

if (!existsSync(archivePath)) {
  throw new Error(`kiki-dist.tar.xz not found at ${archivePath}; run build:android-bundle first`);
}

function assertNoAncestorNodeModules(dir) {
  let cur = resolve(dir);
  for (;;) {
    if (existsSync(join(cur, 'node_modules'))) {
      throw new Error(`Scratch directory ${dir} has an ancestor node_modules at ${cur}`);
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}

async function extractTarXz(tarXz, destDir) {
  const posixTar = tarXz.replaceAll('\\', '/');
  const posixDest = destDir.replaceAll('\\', '/');
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('tar', ['-xJf', posixTar, '-C', posixDest, '--force-local'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`tar exited with ${code}: ${stderr}`));
    });
  });
}

async function waitForFrame(frames, predicate, label, getDiag, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = frames.find(predicate);
    if (hit) return hit;
    const diag = getDiag?.();
    if (diag?.exited) {
      throw new Error(`Child exited early waiting for ${label}: ${JSON.stringify(diag)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for @@kiki frame (${label}); seen=${JSON.stringify(frames)}; diag=${JSON.stringify(getDiag?.())}`);
}

async function startKeystoreBroker(secretToken) {
  const store = new Map();
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${secretToken}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/secret/list') {
      const service = url.searchParams.get('service') ?? '';
      const accounts = [];
      for (const [key] of store) {
        const idx = key.indexOf('\0');
        if (key.slice(0, idx) === service) accounts.push(key.slice(idx + 1));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accounts }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c.toString(); });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      const key = `${payload.service}\0${payload.account}`;
      if (url.pathname === '/v1/secret/get') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ value: store.get(key) ?? null }));
      } else if (url.pathname === '/v1/secret/put') {
        store.set(key, payload.value);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else if (url.pathname === '/v1/secret/delete') {
        const deleted = store.delete(key);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ deleted }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function runBootstrapSmoke(bundleDir, scratchRoot) {
  const homeDir = join(scratchRoot, 'home-bootstrap');
  const workspaceDir = join(scratchRoot, 'workspace-bootstrap');
  mkdirSync(workspaceDir, { recursive: true });
  const ownerToken = 'android_owner_smoke_token_1234567890abcdef';
  const brokerSecret = 'broker_secret_123';
  const broker = await startKeystoreBroker(brokerSecret);
  const entryPath = join(bundleDir, 'entry.mjs');

  const frames = [];
  let stderrLog = '';

  const child = spawn(process.execPath, [entryPath], {
    cwd: bundleDir,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: scratchRoot,
      TMP: scratchRoot,
      KIKI_ANDROID_BOOTSTRAP_STDIN: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.startsWith('@@kiki ')) {
      frames.push(JSON.parse(line.slice('@@kiki '.length)));
    }
  });
  child.stderr.on('data', (chunk) => { stderrLog += chunk.toString(); });

  let exitedInfo = null;
  const exitPromise = new Promise((resolveExit) => {
    child.on('exit', (code, signal) => {
      exitedInfo = { code, signal };
      resolveExit(exitedInfo);
    });
  });
  const getDiag = () => ({ exited: exitedInfo, stderr: stderrLog });

  try {
    child.stdin.write(
      `${JSON.stringify({
        v: 1,
        type: 'bootstrap',
        homeDir,
        localOwnerToken: ownerToken,
        preferredPort: 0,
        gateway: {
          url: broker.url,
          secretToken: brokerSecret,
          mcpUrl: `${broker.url}/mcp`,
          mcpToken: 'mcp_secret_456',
        },
      })}\n`,
    );

    const ready = await waitForFrame(frames, (f) => f.type === 'ready', 'ready', getDiag, 60_000);
    if (typeof ready.port !== 'number' || ready.port <= 0) {
      throw new Error(`Invalid ready port: ${JSON.stringify(ready)}`);
    }

    child.stdin.write(`${JSON.stringify({ type: 'ping', seq: 7 })}\n`);
    const pong = await waitForFrame(frames, (f) => f.type === 'pong' && f.seq === 7, 'pong');
    if (pong.seq !== 7) throw new Error('Unexpected pong seq');

    const baseUrl = `http://127.0.0.1:${ready.port}`;
    const authHeaders = {
      authorization: `Bearer ${ownerToken}`,
      'content-type': 'application/json',
    };

    const healthRes = await fetch(`${baseUrl}/api/healthz`);
    if (healthRes.status !== 200) throw new Error(`/api/healthz returned ${healthRes.status}`);
    const healthJson = await healthRes.json();
    if (healthJson?.data?.ok !== true && healthJson?.ok !== true) {
      throw new Error(`Unexpected /api/healthz payload: ${JSON.stringify(healthJson)}`);
    }

    const guiRes = await fetch(`${baseUrl}/`);
    if (guiRes.status !== 200) throw new Error(`GET / returned ${guiRes.status}`);
    const guiHtml = await guiRes.text();
    if (!guiHtml.includes('<div id="root">')) {
      throw new Error('GET / did not serve Kiki GUI HTML');
    }

    const unauthRes = await fetch(`${baseUrl}/api/meta`);
    if (unauthRes.status !== 401) {
      throw new Error(`Expected unauthenticated /api/meta to return 401, got ${unauthRes.status}`);
    }

    const metaRes = await fetch(`${baseUrl}/api/meta`, { headers: authHeaders });
    if (metaRes.status !== 200) throw new Error(`/api/meta returned ${metaRes.status}`);
    const metaJson = await metaRes.json();
    if (metaJson.code !== 0) throw new Error(`/api/meta envelope failed: ${JSON.stringify(metaJson)}`);

    const createSessionRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ work_dir: workspaceDir }),
    });
    if (createSessionRes.status !== 200) {
      throw new Error(`POST /api/sessions returned ${createSessionRes.status}: ${await createSessionRes.text()}`);
    }
    const createdSession = await createSessionRes.json();
    if (createdSession.code !== 0 || !createdSession.data?.id) {
      throw new Error(`POST /api/sessions failed: ${JSON.stringify(createdSession)}`);
    }

    const listSessionsRes = await fetch(`${baseUrl}/api/sessions`, { headers: authHeaders });
    const listSessionsJson = await listSessionsRes.json();
    if (listSessionsJson.code !== 0 || !Array.isArray(listSessionsJson.data?.items)) {
      throw new Error(`GET /api/sessions failed: ${JSON.stringify(listSessionsJson)}`);
    }

    const agentsRes = await fetch(
      `${baseUrl}/api/agents?cwd=${encodeURIComponent(workspaceDir)}`,
      { headers: authHeaders },
    );
    const agentsJson = await agentsRes.json();
    if (agentsJson.code !== 0) {
      throw new Error(`/api/agents failed: ${JSON.stringify(agentsJson)}`);
    }
    const profileNames = (agentsJson.data?.items ?? []).map((p) => p.name);
    if (!profileNames.includes('android-operator')) {
      throw new Error(`Expected android-operator profile in /api/agents, got: ${JSON.stringify(profileNames)}`);
    }

    const capsRes = await fetch(
      `${baseUrl}/api/agents/capabilities?cwd=${encodeURIComponent(workspaceDir)}&profile=android-operator`,
      { headers: authHeaders },
    );
    const capsJson = await capsRes.json();
    if (capsJson.code !== 0) {
      throw new Error(`/api/agents/capabilities failed: ${JSON.stringify(capsJson)}`);
    }

    const searchRes = await fetch(`${baseUrl}/api/search`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ query: 'smoke' }),
    });
    const searchJson = await searchRes.json();
    if (searchJson.code !== 0) {
      throw new Error(`POST /api/search failed: ${JSON.stringify(searchJson)}`);
    }

    const mcpJson = JSON.parse(readFileSync(join(homeDir, 'mcp.json'), 'utf8'));
    if (mcpJson?.mcpServers?.['android-phone']?.url !== `${broker.url}/mcp`) {
      throw new Error(`Managed android-phone MCP was not written properly: ${JSON.stringify(mcpJson)}`);
    }
    if (existsSync(join(homeDir, 'server.local-owner')) || existsSync(join(homeDir, 'server.token'))) {
      throw new Error('Expected in-memory auth tokens without persisting server.local-owner or server.token on disk');
    }

    child.stdin.write(`${JSON.stringify({ type: 'network', state: 'available' })}\n`);
    child.stdin.write(`${JSON.stringify({ type: 'cancel_active_turns' })}\n`);
    await waitForFrame(frames, (f) => f.type === 'turns_cancelled', 'turns_cancelled', getDiag);

    child.stdin.write(`${JSON.stringify({ type: 'shutdown', graceMs: 5000 })}\n`);
    const exited = await Promise.race([
      exitPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Shutdown timed out')), 15_000)),
    ]);
    if (exited.code !== 0) {
      throw new Error(`Expected exit code 0 on shutdown, got ${JSON.stringify(exited)}; stderr=${stderrLog}`);
    }
    if (stderrLog.includes('ERR_MODULE_NOT_FOUND') || stderrLog.includes('Cannot find package')) {
      throw new Error(`Unexpected module error in stderr: ${stderrLog}`);
    }
    console.log(`[smoke-android-bundle] Bootstrap stdin smoke passed on port ${ready.port} (session=${createdSession.data.id})`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await broker.close();
  }
}

async function runEnvSmoke(bundleDir, scratchRoot) {
  const homeDir = join(scratchRoot, 'home-env');
  const ownerToken = 'android_env_smoke_token_abcdef1234567890';
  const entryPath = join(bundleDir, 'entry.mjs');
  const frames = [];
  let stderrLog = '';

  const child = spawn(process.execPath, [entryPath], {
    cwd: bundleDir,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: scratchRoot,
      TMP: scratchRoot,
      KIKI_HOME: homeDir,
      KIKI_SERVER_AUTH_TOKEN: ownerToken,
      KIKI_PORT: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.startsWith('@@kiki ')) {
      frames.push(JSON.parse(line.slice('@@kiki '.length)));
    }
  });
  child.stderr.on('data', (chunk) => { stderrLog += chunk.toString(); });
  let exitedInfo = null;
  const exitPromise = new Promise((resolveExit) => {
    child.on('exit', (code, signal) => {
      exitedInfo = { code, signal };
      resolveExit(exitedInfo);
    });
  });
  const getDiag = () => ({ exited: exitedInfo, stderr: stderrLog });

  try {
    const ready = await waitForFrame(frames, (f) => f.type === 'ready', 'env-ready', getDiag, 60_000);
    const healthRes = await fetch(`http://127.0.0.1:${ready.port}/api/healthz`);
    if (healthRes.status !== 200) throw new Error(`Env mode /api/healthz returned ${healthRes.status}`);
    child.stdin.write(`${JSON.stringify({ type: 'shutdown', graceMs: 5000 })}\n`);
    const exited = await exitPromise;
    if (exited.code !== 0) throw new Error(`Env mode shutdown exited with ${JSON.stringify(exited)}; stderr=${stderrLog}`);
    console.log(`[smoke-android-bundle] Env startup smoke passed on port ${ready.port}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
}

const scratchRoot = mkdtempSync(join(tmpdir(), 'kiki-android-smoke-'));
try {
  assertNoAncestorNodeModules(scratchRoot);
  const bundleDir = join(scratchRoot, 'bundle');
  rmSync(bundleDir, { recursive: true, force: true });
  await import('node:fs/promises').then((fs) => fs.mkdir(bundleDir, { recursive: true }));
  await extractTarXz(archivePath, bundleDir);

  const manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'));
  if (manifest.entry !== 'entry.mjs' || manifest.webDir !== 'web') {
    throw new Error(`Invalid manifest.json: ${JSON.stringify(manifest)}`);
  }

  await runBootstrapSmoke(bundleDir, scratchRoot);
  await runEnvSmoke(bundleDir, scratchRoot);
  console.log('[smoke-android-bundle] ALL OUT-OF-TREE ANDROID BUNDLE SMOKE CHECKS PASSED.');
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
}
