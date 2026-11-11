#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

const DEFAULT_DIST_TAR = path.resolve(REPO_ROOT, '..', 'kimi-code', 'dist-android', 'kiki-dist.tar.xz');
const DEFAULT_ASSETS_OUT = path.join(REPO_ROOT, 'kiki-runtime', 'build', 'generated', 'assets', 'kiki');

function parseArgs(argv) {
  let tarPath = process.env.KIKI_DIST_TAR?.trim() ? path.resolve(process.env.KIKI_DIST_TAR) : '';
  let tarPathProvided = Boolean(tarPath);
  let outDir = DEFAULT_ASSETS_OUT;
  let forceFallback = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tar' && argv[i + 1]) {
      tarPath = path.resolve(argv[++i]);
      tarPathProvided = true;
    } else if (arg.startsWith('--tar=')) {
      tarPath = path.resolve(arg.slice(6));
      tarPathProvided = true;
    } else if (arg === '--out' && argv[i + 1]) {
      outDir = path.resolve(argv[++i]);
    } else if (arg.startsWith('--out=')) {
      outDir = path.resolve(arg.slice(6));
    } else if (arg === '--fallback') {
      forceFallback = true;
    }
  }
  return { tarPath, tarPathProvided, outDir, forceFallback };
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createSelfCheckEntryMjs() {
  return `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');

function emitFrame(obj) {
  process.stdout.write('@@kiki ' + JSON.stringify(obj) + '\\n');
}

const state = {
  bootstrap: null,
  ownerToken: '',
  gatewayUrl: '',
  mcpUrl: '',
  secretToken: '',
  mcpToken: '',
  sqliteInfo: null,
  activeTurns: 0,
  networkState: 'available',
  sessions: [],
};

function initSqlite(homeDir) {
  const dbDir = path.join(homeDir, 'store');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'kiki-host-probe.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL);');
  db.exec('CREATE TABLE IF NOT EXISTS boot_log (id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, at INTEGER NOT NULL);');
  db.prepare('INSERT INTO boot_log (version, at) VALUES (?, ?)').run(process.version, Date.now());
  const journalRow = db.prepare('PRAGMA journal_mode').get();
  const bootCount = db.prepare('SELECT COUNT(*) AS n FROM boot_log').get();
  return {
    db,
    dbPath,
    journalMode: journalRow?.journal_mode ?? 'unknown',
    backupAvailable: typeof backup === 'function',
    bootCount: Number(bootCount?.n ?? 0),
  };
}

function checkBearer(req) {
  if (!state.ownerToken) return false;
  const auth = req.headers['authorization'] || '';
  if (auth === 'Bearer ' + state.ownerToken) return true;
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.searchParams.get('token') === state.ownerToken) return true;
  return false;
}

async function callMcp(method, params = {}) {
  const res = await fetch(state.mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
      'authorization': 'Bearer ' + state.mcpToken,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }),
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) };
}

async function callSecret(op, payload) {
  const res = await fetch(state.gatewayUrl + '/v1/secret/' + op, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + state.secretToken,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function startServer(preferredPort) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/api/healthz') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          node: process.version,
          pid: process.pid,
          platform: process.platform,
          arch: process.arch,
          sqlite: {
            journalMode: state.sqliteInfo?.journalMode,
            backupAvailable: state.sqliteInfo?.backupAvailable,
            bootCount: state.sqliteInfo?.bootCount,
          },
        }));
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        if (!checkBearer(req)) {
          res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
          return;
        }
        if (url.pathname === '/api/host-status') {
          const mcpTools = await callMcp('tools/list', {}).catch((e) => ({ status: 500, body: { error: String(e) } }));
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            node: process.version,
            pid: process.pid,
            abi: state.bootstrap?.device?.abi,
            sdk: state.bootstrap?.device?.sdk,
            sqlite: {
              journalMode: state.sqliteInfo?.journalMode,
              backupAvailable: state.sqliteInfo?.backupAvailable,
              bootCount: state.sqliteInfo?.bootCount,
            },
            mcpToolCount: mcpTools.body?.result?.tools?.length ?? 0,
            mcpTools: (mcpTools.body?.result?.tools ?? []).map((t) => t.name),
          }));
          return;
        }
        if (url.pathname === '/api/mcp-call' && req.method === 'POST') {
          const body = await readJsonBody(req);
          state.activeTurns++;
          emitFrame({ type: 'turns', active: state.activeTurns, executing: true, pendingInteraction: false });
          try {
            const out = await callMcp('tools/call', { name: body.name, arguments: body.arguments || {} });
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(out));
          } finally {
            state.activeTurns = Math.max(0, state.activeTurns - 1);
            emitFrame({ type: 'turns', active: state.activeTurns, executing: state.activeTurns > 0, pendingInteraction: false });
          }
          return;
        }
        if (url.pathname === '/api/secret-selfcheck' && req.method === 'POST') {
          const putRes = await callSecret('put', { service: 'kiki.selfcheck', account: 'probe', value: 'verified-' + process.pid });
          const getRes = await callSecret('get', { service: 'kiki.selfcheck', account: 'probe' });
          const delRes = await callSecret('delete', { service: 'kiki.selfcheck', account: 'probe' });
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ putStatus: putRes.status, got: getRes.body?.value, deleteStatus: delRes.status }));
          return;
        }
      }

      let relPath = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\\/+/, '');
      let target = path.join(WEB_DIR, relPath);
      if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        target = path.join(WEB_DIR, 'index.html');
      }
      const data = fs.readFileSync(target);
      res.writeHead(200, { 'content-type': contentTypeFor(target), 'cache-control': 'no-store' });
      res.end(data);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
  });

  const tryListen = (port) =>
    new Promise((resolve, reject) => {
      const onError = (e) => {
        server.off('listening', onListening);
        reject(e);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });

  let boundPort;
  try {
    boundPort = await tryListen(preferredPort || 0);
  } catch {
    boundPort = await tryListen(0);
  }
  return { server, boundPort };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let booted = false;

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    process.stderr.write('[kiki-entry] invalid JSON on stdin: ' + String(e) + '\\n');
    return;
  }

  if (!booted && msg.type === 'bootstrap') {
    booted = true;
    state.bootstrap = msg;
    state.ownerToken = msg.localOwnerToken || process.env.KIKI_SERVER_AUTH_TOKEN || '';
    state.gatewayUrl = msg.gateway?.url || process.env.KIKI_SECRET_BROKER_URL || '';
    state.mcpUrl = msg.gateway?.mcpUrl || process.env.KIKI_ANDROID_MCP_URL || (state.gatewayUrl + '/mcp');
    state.secretToken = msg.gateway?.secretToken || process.env.KIKI_SECRET_BROKER_TOKEN || '';
    state.mcpToken = msg.gateway?.mcpToken || process.env.KIKI_ANDROID_MCP_TOKEN || '';

    process.env.KIKI_SECRET_BROKER_URL = state.gatewayUrl;
    process.env.KIKI_SECRET_BROKER_TOKEN = state.secretToken;
    process.env.KIKI_ANDROID_MCP_URL = state.mcpUrl;
    process.env.KIKI_ANDROID_MCP_TOKEN = state.mcpToken;

    const homeDir = process.env.KIKI_HOME || process.cwd();
    fs.mkdirSync(homeDir, { recursive: true });
    state.sqliteInfo = initSqlite(homeDir);

    const { boundPort } = await startServer(msg.preferredPort || 0);
    emitFrame({
      type: 'ready',
      port: boundPort,
      pid: process.pid,
      version: '0.1.0-android-bootstrap',
      guiPath: '/',
    });
    return;
  }

  if (msg.type === 'ping') {
    emitFrame({ type: 'pong', seq: msg.seq ?? 0 });
  } else if (msg.type === 'network') {
    state.networkState = msg.state || 'available';
  } else if (msg.type === 'cancel_active_turns') {
    state.activeTurns = 0;
    emitFrame({ type: 'turns', active: 0, executing: false, pendingInteraction: false });
  } else if (msg.type === 'shutdown') {
    try {
      state.sqliteInfo?.db?.close();
    } catch {}
    process.exit(0);
  }
});
`;
}

function createSelfCheckIndexHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
  <title>Kiki Space</title>
  <style>
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --ink: #0f172a;
      --muted: #64748b;
      --line: #e2e8f0;
      --accent: #0f766e;
      --ok: #15803d;
      --safe-top: var(--kiki-safe-top, env(safe-area-inset-top, 0px));
      --safe-bottom: var(--kiki-safe-bottom, env(safe-area-inset-bottom, 0px));
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
      background: var(--bg);
      color: var(--ink);
      min-height: 100dvh;
      padding: calc(var(--safe-top) + 20px) 20px calc(var(--safe-bottom) + 24px);
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--line);
    }
    h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
    .badge {
      font-size: 12px;
      font-weight: 500;
      color: var(--ok);
      background: #dcfce7;
      padding: 4px 10px;
      border-radius: 999px;
    }
    main {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .row {
      display: flex;
      justify-content: space-between;
      font-size: 14px;
      line-height: 1.5;
    }
    .label { color: var(--muted); }
    .val { font-weight: 500; font-variant-numeric: tabular-nums; }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    button {
      appearance: none;
      border: 1px solid var(--line);
      background: var(--surface);
      color: var(--ink);
      font-size: 14px;
      font-weight: 500;
      padding: 10px 16px;
      border-radius: 10px;
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
    }
    pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: var(--muted);
      background: #f1f5f9;
      padding: 12px;
      border-radius: 10px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <header>
    <h1>Kiki Space</h1>
    <span id="auth-state" class="badge">等待握手</span>
  </header>
  <main>
    <section class="panel">
      <div class="row"><span class="label">Node 内核</span><span id="node-ver" class="val">-</span></div>
      <div class="row"><span class="label">SQLite 日志模式</span><span id="sqlite-mode" class="val">-</span></div>
      <div class="row"><span class="label">安卓 MCP 工具数</span><span id="mcp-count" class="val">-</span></div>
      <div class="row"><span class="label">无障碍 / 悬浮窗</span><span id="perm-state" class="val">-</span></div>
      <div class="actions">
        <button class="primary" id="btn-observe">读取屏幕</button>
        <button id="btn-settings">权限设置</button>
      </div>
    </section>
    <pre id="output">正在连接本机 Kiki 内核…</pre>
  </main>
  <script>
    let adoptedToken = null;
    function consumeStagedToken() {
      const raw = document.__kikiShellStagedCredential;
      try { delete document.__kikiShellStagedCredential; } catch {}
      if (raw && typeof raw.token === 'string' && raw.token.trim()) {
        adoptedToken = raw.token.trim();
        return true;
      }
      return false;
    }
    async function refreshStatus() {
      if (!adoptedToken) consumeStagedToken();
      const out = document.getElementById('output');
      if (!adoptedToken) {
        out.textContent = '尚未收到同源凭证';
        return;
      }
      document.getElementById('auth-state').textContent = '同源已认证';
      const res = await fetch('/api/host-status', {
        headers: { Authorization: 'Bearer ' + adoptedToken }
      });
      const data = await res.json();
      document.getElementById('node-ver').textContent = data.node + ' (PID ' + data.pid + ')';
      document.getElementById('sqlite-mode').textContent = (data.sqlite?.journalMode || '-').toUpperCase();
      document.getElementById('mcp-count').textContent = String(data.mcpToolCount || 0);
      async function updatePermsFromBridge() {
        const api = window.kikiAndroid;
        if (api && typeof api.capabilities === 'function') {
          try {
            const caps = await api.capabilities();
            const p = caps.permissions || {};
            document.getElementById('perm-state').textContent =
              (p.accessibility ? '已开启' : '未开启') + ' / ' + (p.overlay ? '已开启' : '未开启');
          } catch {}
        }
      }
      updatePermsFromBridge();
      out.textContent = JSON.stringify(data, null, 2);
    }
    window.addEventListener('kiki:android', (ev) => {
      if (ev.detail && ev.detail.type === 'permissions' && ev.detail.data) {
        const p = ev.detail.data.permissions || {};
        document.getElementById('perm-state').textContent =
          (p.accessibility ? '已开启' : '未开启') + ' / ' + (p.overlay ? '已开启' : '未开启');
      }
    });
    window.addEventListener('kiki:shell-token', (ev) => {
      consumeStagedToken();
      if (!adoptedToken && ev.detail && ev.detail.token) adoptedToken = ev.detail.token;
      refreshStatus();
    });
    document.getElementById('btn-observe').addEventListener('click', async () => {
      const res = await fetch('/api/mcp-call', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + adoptedToken
        },
        body: JSON.stringify({ name: 'phone_observe', arguments: {} })
      });
      document.getElementById('output').textContent = JSON.stringify(await res.json(), null, 2);
    });
    document.getElementById('btn-settings').addEventListener('click', () => {
      if (window.kikiAndroid && typeof window.kikiAndroid.openMikaSettings === 'function') {
        window.kikiAndroid.openMikaSettings();
      }
    });
    refreshStatus();
  </script>
</body>
</html>
`;
}

function buildFallbackDist(outDir) {
  const tempRoot = path.dirname(outDir);
  fs.mkdirSync(tempRoot, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(tempRoot, 'kiki-fallback-dist-'));
  try {
    const bundleRoot = path.join(workDir, 'bundle');
    fs.mkdirSync(path.join(bundleRoot, 'web'), { recursive: true });
    const entryCode = createSelfCheckEntryMjs();
    const indexHtml = createSelfCheckIndexHtml();
    fs.writeFileSync(path.join(bundleRoot, 'entry.mjs'), entryCode, 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'web', 'index.html'), indexHtml, 'utf8');

    const manifest = {
      version: '0.1.0-bootstrap',
      kind: 'bootstrap-selfcheck',
      entry: 'entry.mjs',
      webDir: 'web',
    };
    fs.writeFileSync(path.join(bundleRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const tarFile = path.join(workDir, 'kiki-dist.tar');
    execFileSync('tar', ['--force-local', '-cf', tarFile, '-C', bundleRoot, 'manifest.json', 'entry.mjs', 'web'], { stdio: 'inherit' });
    execFileSync('xz', ['-z', '-f', '-6', tarFile], { stdio: 'inherit' });

    const xzFile = `${tarFile}.xz`;
    const sha256 = sha256File(xzFile);
    fs.mkdirSync(outDir, { recursive: true });
    const destTar = path.join(outDir, 'kiki-dist.tar.xz');
    fs.copyFileSync(xzFile, destTar);
    const meta = {
      version: `0.1.0-bootstrap-${sha256.slice(0, 8)}`,
      sha256,
      bytes: fs.statSync(destTar).size,
      source: 'bootstrap-selfcheck',
    };
    fs.writeFileSync(path.join(outDir, 'kiki-dist.meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    console.log(`[stage-dist] Built fallback self-check kiki-dist.tar.xz (${meta.bytes} bytes, sha256=${sha256.slice(0, 12)})`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function stageExternalTar(sourceTar, outDir) {
  const sha256 = sha256File(sourceTar);
  fs.mkdirSync(outDir, { recursive: true });
  const destTar = path.join(outDir, 'kiki-dist.tar.xz');
  fs.copyFileSync(sourceTar, destTar);
  const meta = {
    version: `kiki-${sha256.slice(0, 12)}`,
    sha256,
    bytes: fs.statSync(destTar).size,
    source: 'external-tar',
  };
  fs.writeFileSync(path.join(outDir, 'kiki-dist.meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  console.log(`[stage-dist] Staged real Kiki bundle from ${sourceTar} (${meta.bytes} bytes, sha256=${sha256.slice(0, 12)})`);
}

function main() {
  const { tarPath, tarPathProvided, outDir, forceFallback } = parseArgs(process.argv.slice(2));
  if (!forceFallback) {
    const selectedTar = tarPathProvided ? tarPath : DEFAULT_DIST_TAR;
    if (fs.existsSync(selectedTar)) {
      stageExternalTar(selectedTar, outDir);
      return;
    }
    console.warn(`[stage-dist] No distribution tar found at ${selectedTar}; building the self-check bundle.`);
  }
  buildFallbackDist(outDir);
}

main();
