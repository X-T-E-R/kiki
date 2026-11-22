#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadChaosMatrix } from './matrix/loader.mjs';
import { evaluateCcpRunVerdict, EXIT_HARNESS_FAIL } from './verify/verdict.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_MANIFEST_PATH = path.join(import.meta.dirname, 'corpus-manifest.json');
const NODE_TARGET_VERSION = '24.22.1';
const PNPM_TARGET_VERSION = '10.33.0';

export function resolveManifestPath(env = process.env) {
  const override = typeof env?.KIKI_CHAOS_MANIFEST_PATH === 'string' ? env.KIKI_CHAOS_MANIFEST_PATH.trim() : '';
  return override.length > 0 ? override : DEFAULT_MANIFEST_PATH;
}

export function resolveAccountSources(manifest = null, env = process.env) {
  const fromManifest =
    manifest && typeof manifest.account_sources === 'object' && manifest.account_sources !== null && !Array.isArray(manifest.account_sources)
      ? manifest.account_sources
      : {};
  const rawEnv = typeof env?.KIKI_CHAOS_ACCOUNT_SOURCES_JSON === 'string' ? env.KIKI_CHAOS_ACCOUNT_SOURCES_JSON.trim() : '';
  if (!rawEnv) {
    return { ...fromManifest };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawEnv);
  } catch (error) {
    throw new Error(`Invalid KIKI_CHAOS_ACCOUNT_SOURCES_JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('KIKI_CHAOS_ACCOUNT_SOURCES_JSON must be a JSON object mapping account IDs to source configs');
  }
  return { ...fromManifest, ...parsed };
}

function log(msg) {
  process.stderr.write(`[ccp-orchestrator] ${msg}\n`);
}

let cachedCcpLauncher = null;
function resolveCcpLauncher() {
  if (cachedCcpLauncher) return cachedCcpLauncher;
  if (process.platform === 'win32') {
    const whereRes = spawnSync('where.exe', ['ccp'], { encoding: 'utf8' });
    const candidates = String(whereRes.stdout ?? '')
      .split(/\r?\n/u)
      .map((l) => l.trim())
      .filter(Boolean);
    const cmdFile = candidates.find((p) => p.toLowerCase().endsWith('.cmd') || p.toLowerCase().endsWith('.bat'));
    if (cmdFile && fs.existsSync(cmdFile)) {
      const content = fs.readFileSync(cmdFile, 'utf8');
      const m = /"([^"]+\.exe)"\s+-m\s+ccp\.cli/iu.exec(content);
      if (m && fs.existsSync(m[1])) {
        cachedCcpLauncher = { bin: m[1], prefixArgs: ['-m', 'ccp.cli'], shell: false };
        return cachedCcpLauncher;
      }
    }
    const exeFile = candidates.find((p) => p.toLowerCase().endsWith('.exe'));
    if (exeFile && fs.existsSync(exeFile)) {
      cachedCcpLauncher = { bin: exeFile, prefixArgs: [], shell: false };
      return cachedCcpLauncher;
    }
  }
  cachedCcpLauncher = { bin: 'ccp', prefixArgs: [], shell: false };
  return cachedCcpLauncher;
}

function runCcp(args, { timeoutMs = 180_000, allowFail = false } = {}) {
  const launcher = resolveCcpLauncher();
  const res = spawnSync(launcher.bin, [...launcher.prefixArgs, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    shell: launcher.shell,
  });
  if (!allowFail && res.status !== 0) {
    throw new Error(
      `ccp ${args.join(' ')} failed (exit=${res.status}):\nSTDOUT: ${String(res.stdout ?? '').slice(0, 1000)}\nSTDERR: ${String(res.stderr ?? '').slice(0, 1000)}`,
    );
  }
  return res;
}

function parseJsonFromOutput(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(trimmed.slice(first, last + 1));
      } catch {}
    }
    return null;
  }
}

function runSshCommandWithSentinel(sshSessionId, remoteCmd, { timeoutMs = 2_400_000, streamOutput = true } = {}) {
  const token = randomUUID().slice(0, 8);
  const sentinelPrefix = `__CCP_DONE_${token}__=`;
  const remoteScript = `/tmp/ccp-cmd-${token}.sh`;
  const scriptBody = [
    'set +e',
    'set -o pipefail',
    '(',
    remoteCmd,
    ') </dev/null',
    '__ccp_rc=$?',
    `printf '\\n${sentinelPrefix}%d\\n' "$__ccp_rc"`,
    'exit "$__ccp_rc"',
  ].join('\n');
  const b64 = Buffer.from(scriptBody, 'utf8').toString('base64');
  const wrappedCmd = `echo ${b64} | base64 -d > ${remoteScript} && bash -l ${remoteScript} </dev/null; rc=$?; rm -f ${remoteScript}; exit $rc`;

  return new Promise((resolve, reject) => {
    const launcher = resolveCcpLauncher();
    const child = spawn(launcher.bin, [...launcher.prefixArgs, 'ssh', 'connect', sshSessionId, '--command', wrappedCmd], {
      cwd: REPO_ROOT,
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
      shell: launcher.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let sentinelExitCode = null;
    let settled = false;
    let lingerTimer = null;

    const finish = (code, viaSentinel = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (lingerTimer) clearTimeout(lingerTimer);
      if (viaSentinel) {
        try {
          child.kill('SIGTERM');
        } catch {}
      }
      resolve({ exitCode: code, stdout, stderr, viaSentinel });
    };

    const hardTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(
        new Error(
          `SSH command timed out after ${timeoutMs}ms.\nLast stdout:\n${stdout.slice(-1500)}\nLast stderr:\n${stderr.slice(-1500)}`,
        ),
      );
    }, timeoutMs);

    const checkSentinel = () => {
      if (sentinelExitCode !== null) return;
      const combined = stdout + '\n' + stderr;
      const idx = combined.indexOf(sentinelPrefix);
      if (idx >= 0) {
        const tail = combined.slice(idx + sentinelPrefix.length);
        const m = /^(\d+)\b/u.exec(tail);
        if (m) {
          sentinelExitCode = Number.parseInt(m[1], 10);
          lingerTimer = setTimeout(() => finish(sentinelExitCode, true), 2000);
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (streamOutput) process.stderr.write(text);
      checkSentinel();
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      if (streamOutput) process.stderr.write(text);
      checkSentinel();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (lingerTimer) clearTimeout(lingerTimer);
      reject(err);
    });
    child.on('close', (code) => {
      finish(sentinelExitCode !== null ? sentinelExitCode : (code ?? 1), false);
    });
  });
}

function runSftpBatch(sshSessionId, commands, scratchDir, { timeoutMs = 600_000, allowFail = false } = {}) {
  const batchPath = path.join(scratchDir, `sftp-${randomUUID().slice(0, 8)}.batch`);
  fs.writeFileSync(batchPath, `${commands.join('\n')}\n`, 'utf8');
  try {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const res = runCcp(['ssh', 'sftp', sshSessionId, '--batch', batchPath], {
        timeoutMs,
        allowFail: allowFail || attempt < 4,
      });
      if (res.status === 0 || allowFail) return res;
      const errText = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
      if (attempt < 4 && (errText.includes('SSH_UPSTREAM_UNAVAILABLE') || errText.includes('HTTP 503'))) {
        log(`SFTP upstream not ready yet (attempt ${attempt}/4); waiting ${attempt * 3}s before retry...`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 3000);
        continue;
      }
      throw new Error(
        `ccp ssh sftp ${sshSessionId} failed (exit=${res.status}):\nSTDOUT: ${String(res.stdout ?? '').slice(0, 1000)}\nSTDERR: ${String(res.stderr ?? '').slice(0, 1000)}`,
      );
    }
    return null;
  } finally {
    fs.rmSync(batchPath, { force: true });
  }
}

function buildCleanRepoTarball(scratchDir, { baselineHeadCode = false } = {}) {
  const baseTarPath = path.join(scratchDir, 'kiki-chaos-src.tar.gz');
  const overlayTarPath = path.join(scratchDir, 'kiki-chaos-overlay.tar.gz');

  const archiveRes = spawnSync('git', ['archive', '--format=tar.gz', '-o', baseTarPath, 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (archiveRes.status !== 0) throw new Error(`git archive failed: ${archiveRes.stderr}`);

  const statusRes = spawnSync('git', ['status', '--porcelain=v1', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const entries = (statusRes.stdout ?? '').split('\0').filter(Boolean);
  const overlayFiles = [];
  const deletedFiles = [];
  for (const line of entries) {
    const code = line.slice(0, 2);
    const relPath = line.slice(3).trim().replaceAll('\\', '/');
    if (
      !relPath ||
      relPath.startsWith('.tmp/') ||
      relPath.includes('.env') ||
      relPath.endsWith('.key') ||
      relPath.endsWith('.pem') ||
      (baselineHeadCode && !relPath.startsWith('scripts/ccp-chaos/') && relPath !== '.oxlintrc.json')
    ) {
      continue;
    }
    const srcAbs = path.join(REPO_ROOT, relPath);
    if (code.includes('D')) {
      deletedFiles.push(relPath);
    } else if (fs.existsSync(srcAbs) && fs.statSync(srcAbs).isFile()) {
      overlayFiles.push(relPath);
    } else if (fs.existsSync(srcAbs) && fs.statSync(srcAbs).isDirectory()) {
      const walk = (dirRel) => {
        for (const ent of fs.readdirSync(path.join(REPO_ROOT, dirRel), { withFileTypes: true })) {
          const childRel = `${dirRel}/${ent.name}`;
          if (ent.name.startsWith('.env') || ent.name.endsWith('.key') || ent.name.endsWith('.pem')) continue;
          if (ent.isDirectory()) walk(childRel);
          else if (ent.isFile()) overlayFiles.push(childRel);
        }
      };
      walk(relPath.replace(/\/+$/u, ''));
    }
  }

  let hasOverlay = false;
  if (overlayFiles.length > 0) {
    const listName = 'overlay-files.txt';
    fs.writeFileSync(path.join(scratchDir, listName), `${overlayFiles.join('\n')}\n`, 'utf8');
    const packRes = spawnSync('tar', ['-czf', 'kiki-chaos-overlay.tar.gz', '-C', REPO_ROOT, '-T', listName], {
      cwd: scratchDir,
      encoding: 'utf8',
    });
    if (packRes.status !== 0) {
      const altPack = spawnSync('tar', ['-czf', 'kiki-chaos-overlay.tar.gz', '-C', REPO_ROOT, ...overlayFiles], {
        cwd: scratchDir,
        encoding: 'utf8',
      });
      if (altPack.status !== 0) throw new Error(`overlay tar pack failed: ${altPack.stderr}`);
    }
    hasOverlay = true;
  }

  const stat = fs.statSync(baseTarPath);
  return {
    tarPath: baseTarPath,
    overlayTarPath: hasOverlay ? overlayTarPath : null,
    deletedFiles,
    sizeBytes: stat.size,
  };
}

function readRawManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readExistingManifest(manifestPath) {
  const parsed = readRawManifest(manifestPath);
  if (parsed?.binding?.drive_file_id && parsed?.account_id && parsed?.runner_source_id) return parsed;
  return null;
}

function buildRemoteSyncCodeOnlyScript(deletedFiles = []) {
  return [
    'set -euo pipefail',
    `export PATH="/tmp/kiki-tools/node-v${NODE_TARGET_VERSION}-linux-x64/bin:$PATH"`,
    'mkdir -p /tmp/kiki-work',
    'tar -xzf /tmp/kiki-chaos-src.tar.gz -C /tmp/kiki-work',
    'rm -f /tmp/kiki-chaos-src.tar.gz',
    'if [ -f /tmp/kiki-chaos-overlay.tar.gz ]; then tar -xzf /tmp/kiki-chaos-overlay.tar.gz -C /tmp/kiki-work && rm -f /tmp/kiki-chaos-overlay.tar.gz; fi',
    ...deletedFiles.map((f) => `rm -f ${JSON.stringify(`/tmp/kiki-work/${f}`)}`),
    'cd /tmp/kiki-work',
    'echo "=== INCREMENTAL BUILD TS WORKSPACE PACKAGES ==="',
    'pnpm --filter @kiki/plugin-sdk --filter @kiki/lexical --filter @kiki/protocol --filter @kiki/transcript --filter @kiki/transcript-live --filter @kiki/kaos --filter @kiki/oauth --filter @kiki/cordis-runtime --filter @kiki/agent-profiles --filter @kiki/tree-sitter-bash --filter @kiki/klient --filter @kiki/session-core --filter @kiki/gui run build',
    'echo "SYNC_CODE_ONLY_OK"',
  ].join('\n');
}

function buildRemotePrepareScript(deletedFiles = []) {
  return [
    'set -euo pipefail',
    'echo "=== HOST HARDWARE ==="',
    'uname -a',
    'nproc',
    'free -h',
    'df -h /tmp /content',
    'ulimit -n 1048576 2>/dev/null || ulimit -n 65536 2>/dev/null || true',
    'echo "ulimit -n: $(ulimit -n)"',
    'which zstd >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq zstd ripgrep >/dev/null 2>&1) || true',
    'which rg >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq ripgrep >/dev/null 2>&1) || true',
    'mkdir -p /tmp/kiki-work /tmp/kiki-tools /tmp/kiki-chaos-nvme /content/corpus-seed',
    'tar -xzf /tmp/kiki-chaos-src.tar.gz -C /tmp/kiki-work',
    'rm -f /tmp/kiki-chaos-src.tar.gz',
    'if [ -f /tmp/kiki-chaos-overlay.tar.gz ]; then tar -xzf /tmp/kiki-chaos-overlay.tar.gz -C /tmp/kiki-work && rm -f /tmp/kiki-chaos-overlay.tar.gz; fi',
    ...deletedFiles.map((f) => `rm -f ${JSON.stringify(`/tmp/kiki-work/${f}`)}`),
    `if [ ! -x "/tmp/kiki-tools/node-v${NODE_TARGET_VERSION}-linux-x64/bin/node" ]; then`,
    `  curl -fsSL "https://nodejs.org/dist/v${NODE_TARGET_VERSION}/node-v${NODE_TARGET_VERSION}-linux-x64.tar.xz" -o /tmp/kiki-tools/node.tar.xz`,
    '  tar -xJf /tmp/kiki-tools/node.tar.xz -C /tmp/kiki-tools',
    '  rm -f /tmp/kiki-tools/node.tar.xz',
    'fi',
    `export PATH="/tmp/kiki-tools/node-v${NODE_TARGET_VERSION}-linux-x64/bin:$PATH"`,
    'node -v',
    `npm install -g "pnpm@${PNPM_TARGET_VERSION}" >/dev/null 2>&1`,
    'pnpm -v',
    'cd /tmp/kiki-work',
    'echo "=== PNPM INSTALL ==="',
    'pnpm install --frozen-lockfile --ignore-scripts',
    'echo "=== BUILD TS WORKSPACE PACKAGES ==="',
    'pnpm --filter @kiki/plugin-sdk --filter @kiki/lexical --filter @kiki/protocol --filter @kiki/transcript --filter @kiki/transcript-live --filter @kiki/kaos --filter @kiki/oauth --filter @kiki/cordis-runtime --filter @kiki/agent-profiles --filter @kiki/tree-sitter-bash --filter @kiki/klient --filter @kiki/session-core --filter @kiki/gui run build',
    'echo "=== PLAYWRIGHT CHROMIUM CHECK ==="',
    'pnpm --filter @kiki/kap-server exec playwright install chromium --with-deps >/tmp/playwright-install.log 2>&1 || pnpm --filter @kiki/kap-server exec playwright install chromium >/tmp/playwright-install.log 2>&1 || true',
    'echo "PREPARE_OK"',
  ].join('\n');
}

async function releaseAndVerifyRuntime(runtimeId, sshSessionId) {
  if (sshSessionId) {
    log(`Revoking SSH session ${sshSessionId}...`);
    runCcp(['ssh', 'revoke', sshSessionId], { allowFail: true, timeoutMs: 30_000 });
  }
  if (!runtimeId) return null;
  log(`Releasing CCP runtime ${runtimeId}...`);
  runCcp(['runtimes', 'release', runtimeId], { allowFail: true, timeoutMs: 60_000 });
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const inspectRes = runCcp(['runtimes', 'inspect', runtimeId], { allowFail: true, timeoutMs: 30_000 });
    const parsed = parseJsonFromOutput(inspectRes.stdout);
    const state = parsed?.state ?? null;
    log(`Runtime ${runtimeId} inspect attempt ${attempt}: state=${state}`);
    if (state === 'RELEASED') return parsed;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const finalInspect = runCcp(['runtimes', 'inspect', runtimeId], { allowFail: true, timeoutMs: 30_000 });
  return parseJsonFromOutput(finalInspect.stdout);
}

export async function runChaosOnCcp(options = {}) {
  const startedAt = performance.now();
  const giantGiB = options.giantGiB ?? 3.1;
  const concurrency = options.concurrency ?? 128;
  const extremeConcurrency = options.extremeConcurrency ?? 1000;
  const maxOldSpaceMb = options.maxOldSpaceMb ?? 2048;
  const runVitest = options.runVitest !== false;
  const runBrowser = options.runBrowser !== false;
  const regenCorpus = Boolean(options.regenCorpus);
  const s6Only = Boolean(options.s6Only);
  const s7Only = Boolean(options.s7Only);
  const s8Only = Boolean(options.s8Only);
  const s9Only = Boolean(options.s9Only);
  const runS7S8 = Boolean(options.runS7S8);
  const runAll = Boolean(options.runAll);
  const resolvedMatrix = options.matrix
    ? loadChaosMatrix(options.matrix)
    : options.workstationCliff
      ? loadChaosMatrix('workstation-cliff')
      : null;
  const tier = options.tier === 'smoke' || resolvedMatrix?.tier === 'smoke' ? 'smoke' : 'full';
  const isolatedOnly = s6Only || s7Only || s8Only || s9Only || runS7S8;
  const runS6 = s6Only || runAll || Boolean(options.runS6);
  const runS9 = s9Only || runAll || Boolean(options.runS9);
  const s7Cycles = options.s7Cycles ?? 200;
  const tenKSubagentCount = options.tenKSubagentCount ?? 10_000;
  const s6StepTimeoutMs = options.s6StepTimeoutMs ?? 45_000;
  const keepRuntime = Boolean(options.keepRuntime);
  const syncCodeOnly = Boolean(options.syncCodeOnly);
  const runtimeTtlMinutes = options.ttlMinutes ?? 240;
  const idleTimeoutMinutes = options.idleTimeoutMinutes ?? 60;
  const runtimeStateFile = options.runtimeStateFile ? path.resolve(options.runtimeStateFile) : null;
  const outDir = path.resolve(options.outDir ?? path.join(REPO_ROOT, '.tmp', 'ccp-chaos-live'));
  fs.mkdirSync(outDir, { recursive: true });
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiki-ccp-orch-'));

  const manifestPath = resolveManifestPath();
  const rawManifest = readRawManifest(manifestPath);
  const accountSources = resolveAccountSources(rawManifest);
  const existingManifest = regenCorpus ? null : readExistingManifest(manifestPath);
  let runtimeId = null;
  let sshSessionId = null;
  let releasedSnapshot = null;

  const emergencyRelease = () => {
    if (sshSessionId) {
      try {
        runCcp(['ssh', 'revoke', sshSessionId], { allowFail: true, timeoutMs: 15_000 });
      } catch {}
    }
    if (runtimeId) {
      try {
        runCcp(['runtimes', 'release', runtimeId], { allowFail: true, timeoutMs: 30_000 });
      } catch {}
    }
  };
  process.once('SIGINT', () => {
    emergencyRelease();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    emergencyRelease();
    process.exit(143);
  });

  try {
    if (!options.skipUploadAndPrep) {
      log(`Packaging clean repo tarball (zero secrets, baselineHeadCode=${Boolean(options.baselineHeadCode)})...`);
      const pkg = buildCleanRepoTarball(scratchDir, { baselineHeadCode: Boolean(options.baselineHeadCode) });
      log(`Tarball ready: ${(pkg.sizeBytes / (1024 * 1024)).toFixed(2)} MiB`);
      options._pkg = pkg;
    }

    const preferredAccounts = existingManifest
      ? [existingManifest.account_id]
      : Object.keys(accountSources);

    let rtInfo = null;
    if (options.reuseRuntimeId) {
      log(`Inspecting existing CCP runtime ${options.reuseRuntimeId} for reuse (will still release in finally)...`);
      const inspRes = runCcp(['runtimes', 'inspect', options.reuseRuntimeId], { timeoutMs: 60_000 });
      rtInfo = parseJsonFromOutput(inspRes.stdout);
      runtimeId = rtInfo?.id ?? options.reuseRuntimeId;
      if (!runtimeId || rtInfo?.state !== 'READY') {
        throw new Error(`Reused CCP runtime ${options.reuseRuntimeId} is not READY: ${inspRes.stdout.slice(0, 600)}`);
      }
    } else {
      const idemKey = `kiki-chaos-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const reqArgs = [
        'runtimes',
        'request',
        '--accelerator',
        'CPU',
        '--shape',
        'HIGHMEM',
        '--no-mount-drive',
        '--ttl',
        String(runtimeTtlMinutes),
        '--idle-timeout',
        String(idleTimeoutMinutes),
        '--label',
        s9Only ? 'kiki-chaos-s9-browser' : s6Only ? 'kiki-chaos-10k-subagents' : 'kiki-chaos-scale-suite',
        '--idempotency-key',
        idemKey,
        '--follow',
      ];
      for (const acc of preferredAccounts) {
        reqArgs.push('--prefer-account-id', acc);
      }

      log(`Requesting CCP CPU HIGHMEM runtime (--no-mount-drive --ttl ${runtimeTtlMinutes} --idle-timeout ${idleTimeoutMinutes})...`);
      const reqRes = runCcp(reqArgs, { timeoutMs: 180_000 });
      rtInfo = parseJsonFromOutput(reqRes.stdout);
      runtimeId =
        rtInfo?.runtime_id ??
        (typeof rtInfo?.id === 'string' && rtInfo.id.startsWith('rt_') ? rtInfo.id : null);
      const rtState = rtInfo?.runtime_state ?? rtInfo?.state;
      if (!runtimeId || rtState !== 'READY') {
        throw new Error(`CCP runtime allocation did not reach READY: ${reqRes.stdout.slice(0, 800)}`);
      }
    }
    const accountId = rtInfo.account_id;
    log(`Active CCP runtime ${runtimeId} (account=${accountId}, shape=${rtInfo.shape})`);
    if (keepRuntime && runtimeStateFile) {
      fs.mkdirSync(path.dirname(runtimeStateFile), { recursive: true });
      fs.writeFileSync(
        runtimeStateFile,
        `${JSON.stringify(
          {
            runtimeId,
            accountId,
            providerEndpoint: rtInfo?.provider_endpoint ?? null,
            shape: rtInfo?.shape ?? 'HIGHMEM',
            accelerator: rtInfo?.accelerator ?? 'CPU',
            state: 'READY',
            provisionedAt: new Date().toISOString(),
            corpusDir: '/tmp/kiki-chaos-nvme',
            workDir: '/tmp/kiki-work',
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    }

    const sshRes = runCcp(['ssh', 'prepare', runtimeId, '--ttl-seconds', '7200'], { timeoutMs: 60_000 });
    const sshInfo = parseJsonFromOutput(sshRes.stdout);
    sshSessionId = sshInfo?.id ?? sshInfo?.session_id;
    if (!sshSessionId) throw new Error(`Failed to prepare CCP SSH session: ${sshRes.stdout.slice(0, 600)}`);
    log(`Prepared SSH session ${sshSessionId}`);

    if (!options.skipUploadAndPrep) {
      const pkg = options._pkg;
      const prepScriptLocal = path.join(scratchDir, 'prep-remote.sh');
      fs.writeFileSync(
        prepScriptLocal,
        syncCodeOnly ? buildRemoteSyncCodeOnlyScript(pkg.deletedFiles) : buildRemotePrepareScript(pkg.deletedFiles),
        'utf8',
      );
      const sftpPuts = [
        `put "${pkg.tarPath.replaceAll('\\', '/')}" /tmp/kiki-chaos-src.tar.gz`,
        ...(pkg.overlayTarPath ? [`put "${pkg.overlayTarPath.replaceAll('\\', '/')}" /tmp/kiki-chaos-overlay.tar.gz`] : []),
        `put "${prepScriptLocal.replaceAll('\\', '/')}" /tmp/prep-remote.sh`,
      ];
      runSftpBatch(sshSessionId, sftpPuts, scratchDir, { timeoutMs: 300_000 });

      log(
        syncCodeOnly
          ? 'Syncing updated code onto warm CCP Linux runtime and running incremental package build...'
          : 'Bootstrapping Node 24.22.1 + pnpm + deps + Playwright Chromium on CCP Linux...',
      );
      const prepOut = await runSshCommandWithSentinel(sshSessionId, 'chmod +x /tmp/prep-remote.sh && /tmp/prep-remote.sh', {
        timeoutMs: 900_000,
      });
      if (prepOut.exitCode !== 0) {
        throw new Error(`Remote bootstrap failed (exit=${prepOut.exitCode})`);
      }
    } else {
      log('Skipping tarball upload & bootstrap (reusing warm baseline /tmp/kiki-work)...');
    }

    const nodeBinPath = `/tmp/kiki-tools/node-v${NODE_TARGET_VERSION}-linux-x64/bin`;
    const driveTransferMetrics = { mode: 'generated', restoreMs: null, extractMs: null, saveMs: null, archiveBytes: null, sha256: null };
    let usedExistingCorpus = false;

    if (syncCodeOnly || options.reuseWarmCorpus) {
      log('Reusing warm NVMe corpus already staged in /tmp/kiki-chaos-nvme...');
      driveTransferMetrics.mode = 'reused_warm_nvme';
      usedExistingCorpus = true;
    } else if (existingManifest && existingManifest.account_id === accountId) {
      log(`Restoring sanitized 3.1 GiB corpus from Google Drive via DIRECT_HTTPS (${existingManifest.binding.drive_file_id})...`);
      const bindingsFile = path.join(scratchDir, 'corpus-bindings.json');
      fs.writeFileSync(bindingsFile, JSON.stringify([existingManifest.binding], null, 2), 'utf8');
      const restoreT0 = performance.now();
      const restoreKey = `kiki-corpus-restore-${Date.now()}-${randomUUID().slice(0, 6)}`;
      const restoreRes = runCcp(
        [
          'assets',
          'restore',
          runtimeId,
          '/content/corpus-seed',
          '--runner-source-id',
          existingManifest.runner_source_id,
          '--bindings',
          bindingsFile,
          '--idempotency-key',
          restoreKey,
          '--wait',
        ],
        { timeoutMs: 600_000 },
      );
      driveTransferMetrics.restoreMs = Number((performance.now() - restoreT0).toFixed(2));
      log(`DIRECT_HTTPS restore completed in ${driveTransferMetrics.restoreMs}ms (${restoreRes.stdout.slice(0, 200)})`);

      const extractT0 = performance.now();
      const extractOut = await runSshCommandWithSentinel(
        sshSessionId,
        `rm -rf /tmp/kiki-chaos-nvme && mkdir -p /tmp/kiki-chaos-nvme && zstd -d -T0 -c /content/corpus-seed/${existingManifest.binding.relative_path} | tar -xf - -C /tmp/kiki-chaos-nvme && rm -rf /content/corpus-seed`,
        { timeoutMs: 300_000 },
      );
      if (extractOut.exitCode !== 0) {
        throw new Error(`Corpus zstd extract failed (exit=${extractOut.exitCode})`);
      }
      driveTransferMetrics.extractMs = Number((performance.now() - extractT0).toFixed(2));
      driveTransferMetrics.mode = 'restored_direct_https';
      driveTransferMetrics.archiveBytes = existingManifest.binding.size_bytes;
      driveTransferMetrics.sha256 = existingManifest.sha256;
      usedExistingCorpus = true;
      log(`Extracted 3.1 GiB corpus from zstd archive onto NVMe in ${driveTransferMetrics.extractMs}ms`);
    } else {
      log(`Generating deterministic ${giantGiB} GiB synthetic corpus on CCP NVMe and compressing with zstd -T0...`);
      const genCmd = [
        `export PATH="${nodeBinPath}:$PATH"`,
        'cd /tmp/kiki-work',
        `if [ ! -f /content/kiki-chaos-corpus-v1.tar.zst ] || [ ! -d /tmp/kiki-chaos-nvme/home ]; then`,
        `  node scripts/ccp-chaos/corpus-generator.mjs --dir /tmp/kiki-chaos-nvme --giant-gib ${giantGiB} --subagents 1520 > /tmp/corpus-gen.json`,
        '  tar -cf - -C /tmp/kiki-chaos-nvme . | zstd -q -T0 -3 -f -o /content/kiki-chaos-corpus-v1.tar.zst',
        'fi',
        'SHA=$(sha256sum /content/kiki-chaos-corpus-v1.tar.zst | awk \'{print $1}\')',
        'SZ=$(stat -c %s /content/kiki-chaos-corpus-v1.tar.zst)',
        'echo "ARCHIVE_META sha256=$SHA size_bytes=$SZ"',
      ].join('\n');
      const genOut = await runSshCommandWithSentinel(sshSessionId, genCmd, { timeoutMs: 600_000 });
      if (genOut.exitCode !== 0) throw new Error(`Remote corpus generation/zstd failed (exit=${genOut.exitCode})`);
      const metaMatch = /ARCHIVE_META sha256=([0-9a-f]{64}) size_bytes=(\d+)/u.exec(genOut.stdout);
      const archiveSha = metaMatch?.[1] ?? null;
      const archiveBytes = metaMatch ? Number(metaMatch[2]) : null;
      driveTransferMetrics.sha256 = archiveSha;
      driveTransferMetrics.archiveBytes = archiveBytes;
      usedExistingCorpus = true;

      const sourceCfg = accountSources[accountId];
      if (sourceCfg && archiveSha && archiveBytes) {
        log(`Persisting kiki-chaos-corpus-v1.tar.zst (${(archiveBytes / (1024 * 1024)).toFixed(2)} MiB) to Google Drive via ccp assets save (DIRECT_HTTPS Keep Forever)...`);
        const saveT0 = performance.now();
        const saveKey = `kiki-corpus-save-${Date.now()}-${randomUUID().slice(0, 6)}`;
        const saveRes = runCcp(
          [
            'assets',
            'save',
            runtimeId,
            '/content/kiki-chaos-corpus-v1.tar.zst',
            '--runner-source-id',
            sourceCfg.runnerSourceId,
            '--drive-folder-id',
            sourceCfg.driveFolderId,
            '--idempotency-key',
            saveKey,
            '--wait',
          ],
          { timeoutMs: 600_000 },
        );
        driveTransferMetrics.saveMs = Number((performance.now() - saveT0).toFixed(2));
        const saveJson = parseJsonFromOutput(saveRes.stdout);
        const outEntry = saveJson?.outputs?.[0] ?? saveJson?.manifest?.[0];
        if (saveJson?.state === 'COMPLETED' && outEntry?.drive_file_id) {
          const newManifest = {
            version: 1,
            created_at: new Date().toISOString(),
            description: 'Zero-PII deterministic 3.1 GiB Kiki chaos-scale NVMe corpus (zstd compressed, Keep Forever)',
            account_id: accountId,
            runner_source_id: sourceCfg.runnerSourceId,
            drive_folder_id: sourceCfg.driveFolderId,
            save_operation_id: saveJson.id,
            sha256: archiveSha,
            giant_wire_gib: giantGiB,
            subagent_count: 1520,
            binding: {
              drive_source: 'ACCOUNT',
              relative_path: outEntry.relative_path ?? 'kiki-chaos-corpus-v1.tar.zst',
              drive_file_id: outEntry.drive_file_id,
              drive_version: String(outEntry.drive_version),
              drive_head_revision_id: outEntry.drive_head_revision_id,
              size_bytes: outEntry.size_bytes ?? archiveBytes,
            },
          };
          fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
          fs.writeFileSync(manifestPath, `${JSON.stringify(newManifest, null, 2)}\n`, 'utf8');
          log(`Saved corpus manifest to ${manifestPath} (drive_file_id=${outEntry.drive_file_id}, saveMs=${driveTransferMetrics.saveMs}ms)`);

          log('Verifying DIRECT_HTTPS fast pull via ccp assets restore on the same runtime...');
          const bindingsFile = path.join(scratchDir, 'verify-bindings.json');
          fs.writeFileSync(bindingsFile, JSON.stringify([newManifest.binding], null, 2), 'utf8');
          const verifyT0 = performance.now();
          runCcp(
            [
              'assets',
              'restore',
              runtimeId,
              '/content/corpus-restore-verify',
              '--runner-source-id',
              sourceCfg.runnerSourceId,
              '--bindings',
              bindingsFile,
              '--idempotency-key',
              `kiki-corpus-verify-${Date.now()}`,
              '--wait',
            ],
            { timeoutMs: 300_000 },
          );
          driveTransferMetrics.restoreMs = Number((performance.now() - verifyT0).toFixed(2));
          driveTransferMetrics.mode = 'generated_saved_and_restore_verified';
          await runSshCommandWithSentinel(
            sshSessionId,
            `sha256sum /content/corpus-restore-verify/${newManifest.binding.relative_path} && rm -rf /content/corpus-restore-verify /content/kiki-chaos-corpus-v1.tar.zst`,
            { timeoutMs: 120_000 },
          );
        }
      }
    }

    const runId = options.runId ?? `ccp_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const gitHead = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const buildId = options.buildId ?? ((gitHead.status === 0 ? gitHead.stdout.trim() : 'unknown') || 'unknown');
    const remoteRunDir = `/tmp/kiki-chaos-run-${runId}`;
    const s10Only = Boolean(options.s10Only);
    const s17Only = Boolean(options.s17Only || options.workstationCliff);
    const runS10 = s10Only || runAll || Boolean(options.runS10);
    const runS17 = s17Only || runAll || Boolean(options.runS17 || options.matrix || options.v23Smoke || options.v23Full);
    const effectiveIsolatedOnly =
      isolatedOnly || s10Only || s17Only || Boolean(options.matrix || options.v23Smoke || options.v23Full);

    // Clean stale local result artifacts in outDir so a failed run can never read an old green JSON
    for (const staleName of [
      'kiki-chaos-results.json',
      'kiki-vitest-results.json',
      'kiki-hygiene-results.json',
      'run-receipt.json',
      'verdict.json',
    ]) {
      fs.rmSync(path.join(outDir, staleName), { force: true });
    }

    log(
      effectiveIsolatedOnly
        ? `Running targeted Chaos-Scale scenarios (runId=${runId}, tier=${tier}, matrix=${options.matrix ?? 'default'}, s6=${s6Only || runS6}, s7=${s7Only || runS7S8}, s8=${s8Only || runS7S8}, s9=${s9Only || runS9}, s10=${runS10}, s17=${runS17}) on CCP Linux (keepRuntime=${keepRuntime})...`
        : `Running test hygiene, node --test, full S1-S5${runAll ? '+S6-S10+S17' : runS9 ? '+S9' : ''} Chaos-Scale + 1000-way + Playwright UX suite (runId=${runId}) on CCP Linux...`,
    );
    const runnerFlags = [
      '--dir /tmp/kiki-chaos-nvme',
      `--run-id ${runId}`,
      `--build-id ${buildId}`,
      `--tier ${tier}`,
      ...(options.matrix || options.workstationCliff ? [] : [`--giant-gib ${giantGiB}`]),
      `--concurrency ${concurrency}`,
      `--extreme-concurrency ${extremeConcurrency}`,
      `--max-old-space-mb ${maxOldSpaceMb}`,
      ...(usedExistingCorpus ? ['--existing-corpus'] : []),
      ...(runBrowser ? [] : ['--no-browser']),
      ...(runAll ? ['--run-all'] : []),
      ...(options.v23Smoke ? ['--v23-smoke'] : []),
      ...(options.v23Full ? ['--v23-full'] : []),
      ...(options.matrix ? [`--matrix "${options.matrix}"`] : []),
      ...(options.workstationCliff ? ['--workstation-cliff'] : []),
      ...(options.manifestPath ? [`--manifest "${options.manifestPath}"`] : []),
      ...(s6Only ? ['--s6-only'] : options.runS6 ? ['--run-s6'] : []),
      ...(s7Only ? ['--s7-only'] : options.runS7 ? ['--run-s7'] : []),
      ...(s8Only ? ['--s8-only'] : options.runS8 ? ['--run-s8'] : []),
      ...(s9Only ? ['--s9-only'] : options.runS9 ? ['--run-s9'] : []),
      ...(s10Only ? ['--s10-only'] : options.runS10 ? ['--run-s10'] : []),
      ...(options.s17Only ? ['--s17-only'] : options.runS17 ? ['--run-s17'] : []),
      ...(runS7S8 ? ['--run-s7-s8'] : []),
      ...(s7Only || runS7S8 || runAll || options.runS7 ? [`--s7-cycles ${s7Cycles}`] : []),
      ...(runS6 || runS9 ? [`--tenk-subagents ${tenKSubagentCount}`, `--s6-step-timeout-ms ${s6StepTimeoutMs}`] : []),
      ...(syncCodeOnly || options.reuseWarmCorpus ? ['--reuse-10k-session'] : []),
      `--out ${remoteRunDir}/kiki-chaos-results.json`,
    ].join(' ');
    const runScript = [
      'set -o pipefail',
      `export PATH="${nodeBinPath}:$PATH"`,
      'export UV_THREADPOOL_SIZE=16',
      'ulimit -n 1048576 2>/dev/null || ulimit -n 65536 2>/dev/null || true',
      `rm -rf "${remoteRunDir}" && mkdir -p "${remoteRunDir}"`,
      'rm -f /tmp/kiki-chaos-results.json /tmp/kiki-vitest-results.json /tmp/kiki-hygiene-results.json',
      'cd /tmp/kiki-work',
      ...(runBrowser
        ? [
            'if [ ! -f apps/kiki-gui/dist/index.html ]; then pnpm --filter @kiki/gui build || true; fi',
          ]
        : []),
      `node scripts/ccp-chaos/check-test-hygiene.mjs --json > "${remoteRunDir}/kiki-hygiene-results.json"`,
      'HYGIENE_RC=$?',
      'echo "HYGIENE_EXIT=$HYGIENE_RC"',
      'node --test scripts/ccp-chaos/ccp-chaos.test.mjs scripts/ccp-chaos/verdict.test.mjs',
      'UNIT_RC=$?',
      'echo "UNIT_TESTS_EXIT=$UNIT_RC"',
      `node scripts/ccp-chaos/chaos-scale-runner.mjs ${runnerFlags}`,
      'CHAOS_RC=$?',
      'echo "CHAOS_RUNNER_EXIT=$CHAOS_RC"',
      ...(runVitest && !effectiveIsolatedOnly
        ? [
            `pnpm exec vitest run packages/protocol/test packages/transcript/test packages/kap-server/test/remotePairing.test.ts --reporter=json --outputFile="${remoteRunDir}/kiki-vitest-results.json"`,
            'VITEST_RC=$?',
            'echo "VITEST_EXIT=$VITEST_RC"',
          ]
        : ['VITEST_RC=0', `echo "{}" > "${remoteRunDir}/kiki-vitest-results.json"`]),
      'FINAL_RC=0',
      'if [ "$HYGIENE_RC" -ne 0 ] || [ "$UNIT_RC" -ne 0 ]; then FINAL_RC=2; fi',
      'if [ "$VITEST_RC" -ne 0 ] && [ "$FINAL_RC" -eq 0 ]; then FINAL_RC=1; fi',
      'if [ "$CHAOS_RC" -ne 0 ]; then',
      '  if [ "$CHAOS_RC" -eq 2 ]; then FINAL_RC=2; elif [ "$FINAL_RC" -eq 0 ]; then FINAL_RC=1; fi',
      'fi',
      `cat > "${remoteRunDir}/run-receipt.json" <<RECEIPT_EOF`,
      '{',
      `  "runId": "${runId}",`,
      `  "buildId": "${buildId}",`,
      '  "completedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",',
      '  "remoteExitCode": $FINAL_RC,',
      '  "stages": {',
      '    "hygiene": { "exitCode": $HYGIENE_RC },',
      '    "unitTests": { "exitCode": $UNIT_RC },',
      '    "chaos": { "exitCode": $CHAOS_RC },',
      '    "vitest": { "exitCode": $VITEST_RC }',
      '  }',
      '}',
      'RECEIPT_EOF',
      `cat > "${remoteRunDir}/manifest.json" <<MANIFEST_EOF`,
      '{',
      `  "runId": "${runId}",`,
      `  "buildId": "${buildId}",`,
      `  "tier": "${options.v23Full ? 'v23-full' : options.v23Smoke ? 'v23-smoke' : tier}",`,
      `  "requireAllV23Scenarios": ${Boolean(options.v23Full || options.v23Smoke)},`,
      `  "requiredStages": ${JSON.stringify(runVitest && !effectiveIsolatedOnly ? ['hygiene', 'unitTests', 'chaos', 'vitest'] : ['hygiene', 'unitTests', 'chaos'])}`,
      '}',
      'MANIFEST_EOF',
      `node scripts/ccp-chaos/verify/verdict.mjs "${remoteRunDir}" > "${remoteRunDir}/remote-verdict.json"`,
      'VERDICT_RC=$?',
      'echo "REMOTE_VERDICT_EXIT=$VERDICT_RC"',
      'if [ "$VERDICT_RC" -ne 0 ] && [ "$FINAL_RC" -eq 0 ]; then FINAL_RC=$VERDICT_RC; fi',
      ...(keepRuntime ? ['echo "KEEPING_WARM_NVME_CORPUS=/tmp/kiki-chaos-nvme"'] : ['rm -rf /tmp/kiki-chaos-nvme']),
      'exit $FINAL_RC',
    ].join('\n');
    const runScriptLocal = path.join(scratchDir, 'exec-chaos-remote.sh');
    fs.writeFileSync(runScriptLocal, runScript, 'utf8');
    runSftpBatch(sshSessionId, [`put "${runScriptLocal.replaceAll('\\', '/')}" /tmp/exec-chaos-remote.sh`], scratchDir, {
      timeoutMs: 60_000,
    });

    const execOutcome = await runSshCommandWithSentinel(
      sshSessionId,
      'chmod +x /tmp/exec-chaos-remote.sh && /tmp/exec-chaos-remote.sh',
      { timeoutMs: 7_200_000, streamOutput: true, allowFail: true },
    );
    fs.writeFileSync(path.join(outDir, 'remote-run.log'), `${execOutcome.stdout}\n---STDERR---\n${execOutcome.stderr}\n`, 'utf8');

    const localChaosJson = path.join(outDir, 'kiki-chaos-results.json');
    const localVitestJson = path.join(outDir, 'kiki-vitest-results.json');
    const localHygieneJson = path.join(outDir, 'kiki-hygiene-results.json');
    const localReceiptJson = path.join(outDir, 'run-receipt.json');
    log(`Downloading fresh run-id-stamped JSON artifacts from ${remoteRunDir} via ccp ssh sftp...`);
    runSftpBatch(
      sshSessionId,
      [
        `-get ${remoteRunDir}/kiki-chaos-results.json "${localChaosJson.replaceAll('\\', '/')}"`,
        `-get ${remoteRunDir}/kiki-vitest-results.json "${localVitestJson.replaceAll('\\', '/')}"`,
        `-get ${remoteRunDir}/kiki-hygiene-results.json "${localHygieneJson.replaceAll('\\', '/')}"`,
        `-get ${remoteRunDir}/run-receipt.json "${localReceiptJson.replaceAll('\\', '/')}"`,
      ],
      scratchDir,
      { timeoutMs: 120_000, allowFail: true },
    );

    const safeReadJson = (p) => {
      if (!fs.existsSync(p)) return null;
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        return null;
      }
    };
    const chaosResults = safeReadJson(localChaosJson);
    const vitestResults = safeReadJson(localVitestJson);
    const hygieneResults = safeReadJson(localHygieneJson);
    const runReceipt = safeReadJson(localReceiptJson);

    const requiredStages = runVitest && !effectiveIsolatedOnly
      ? ['hygiene', 'unitTests', 'chaos', 'vitest']
      : ['hygiene', 'unitTests', 'chaos'];
    fs.writeFileSync(
      path.join(outDir, 'manifest.json'),
      `${JSON.stringify(
        {
          runId,
          buildId,
          requiredStages,
          tier: options.v23Full ? 'v23-full' : options.v23Smoke ? 'v23-smoke' : tier,
          requireAllV23Scenarios: Boolean(options.v23Full || options.v23Smoke),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const verdict = evaluateCcpRunVerdict({
      expectedRunId: runId,
      expectedBuildId: buildId,
      expectedTier: options.v23Full ? 'v23-full' : options.v23Smoke ? 'v23-smoke' : tier,
      remoteExitCode: execOutcome.exitCode,
      receipt: runReceipt,
      chaosReport: chaosResults,
      requiredStages,
      enforceMandatoryStages: true,
      requireAllV23Scenarios: Boolean(options.v23Full || options.v23Smoke),
    });
    fs.writeFileSync(path.join(outDir, 'verdict.json'), `${JSON.stringify({ runId, buildId, ...verdict }, null, 2)}\n`, 'utf8');

    fs.writeFileSync(
      path.join(outDir, 'drive-transfer-metrics.json'),
      `${JSON.stringify(driveTransferMetrics, null, 2)}\n`,
      'utf8',
    );

    if (keepRuntime && runtimeStateFile) {
      fs.mkdirSync(path.dirname(runtimeStateFile), { recursive: true });
      fs.writeFileSync(
        runtimeStateFile,
        `${JSON.stringify(
          {
            runtimeId,
            accountId,
            providerEndpoint: rtInfo?.provider_endpoint ?? null,
            shape: rtInfo?.shape ?? 'HIGHMEM',
            accelerator: rtInfo?.accelerator ?? 'CPU',
            state: 'READY',
            keptAliveAt: new Date().toISOString(),
            corpusDir: '/tmp/kiki-chaos-nvme',
            workDir: '/tmp/kiki-work',
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      log(`Recorded warm CCP runtime state to ${runtimeStateFile}`);
    }

    return {
      runId,
      buildId,
      runtimeId,
      accountId,
      providerEndpoint: rtInfo.provider_endpoint,
      sshSessionId,
      keptAlive: keepRuntime,
      remoteExitCode: execOutcome.exitCode,
      exitCode: verdict.exitCode,
      verdict,
      driveTransferMetrics,
      totalOrchestratorWallMs: Number((performance.now() - startedAt).toFixed(2)),
      outDir,
      runReceipt,
      chaosResults,
      vitestResults,
      hygieneResults,
    };
  } finally {
    if (keepRuntime) {
      if (sshSessionId) {
        log(`Revoking temporary SSH session ${sshSessionId} while KEEPING CCP runtime ${runtimeId} alive for Pass 2...`);
        runCcp(['ssh', 'revoke', sshSessionId], { allowFail: true, timeoutMs: 30_000 });
      }
      fs.rmSync(scratchDir, { recursive: true, force: true });
      log(`Warm CCP runtime ${runtimeId} kept ALIVE (caller owns future release via ccp runtimes release ${runtimeId}).`);
    } else {
      releasedSnapshot = await releaseAndVerifyRuntime(runtimeId, sshSessionId);
      fs.rmSync(scratchDir, { recursive: true, force: true });
      if (runtimeId) {
        log(`Final runtime ${runtimeId} state: ${releasedSnapshot?.state ?? 'UNKNOWN'}`);
        fs.writeFileSync(
          path.join(outDir, 'ccp-release-receipt.json'),
          `${JSON.stringify({ runtimeId, sshSessionId, releasedSnapshot }, null, 2)}\n`,
          'utf8',
        );
      }
    }
  }
}

export function parseCcpCliArgs(args) {
  const opts = {
    tier: 'full',
    giantGiB: 3.1,
    concurrency: 128,
    extremeConcurrency: 1000,
    maxOldSpaceMb: 2048,
    runVitest: true,
    runBrowser: true,
    regenCorpus: false,
    s6Only: false,
    s7Only: false,
    s8Only: false,
    s9Only: false,
    s10Only: false,
    s17Only: false,
    workstationCliff: false,
    matrix: undefined,
    runS7S8: false,
    runAll: false,
    v23Smoke: false,
    v23Full: false,
    manifestPath: undefined,
    runS6: false,
    runS7: false,
    runS8: false,
    runS9: false,
    runS10: false,
    runS17: false,
    s7Cycles: 200,
    tenKSubagentCount: 10_000,
    s6StepTimeoutMs: 45_000,
    keepRuntime: false,
    syncCodeOnly: false,
    reuseWarmCorpus: false,
    ttlMinutes: 240,
    idleTimeoutMinutes: 60,
  };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--tier' && args[i + 1]) opts.tier = args[++i];
    else if (args[i] === '--giant-gib' && args[i + 1]) opts.giantGiB = Number(args[++i]);
    else if (args[i] === '--concurrency' && args[i + 1]) opts.concurrency = Number(args[++i]);
    else if (args[i] === '--extreme-concurrency' && args[i + 1]) opts.extremeConcurrency = Number(args[++i]);
    else if (args[i] === '--max-old-space-mb' && args[i + 1]) opts.maxOldSpaceMb = Number(args[++i]);
    else if (args[i] === '--no-vitest') opts.runVitest = false;
    else if (args[i] === '--no-browser') opts.runBrowser = false;
    else if (args[i] === '--regen-corpus') opts.regenCorpus = true;
    else if (args[i] === '--s6-only') opts.s6Only = true;
    else if (args[i] === '--s7-only') opts.s7Only = true;
    else if (args[i] === '--s8-only') opts.s8Only = true;
    else if (args[i] === '--s9-only') opts.s9Only = true;
    else if (args[i] === '--s10-only') opts.s10Only = true;
    else if (args[i] === '--s17-only') opts.s17Only = true;
    else if (args[i] === '--workstation-cliff') opts.workstationCliff = true;
    else if (args[i] === '--matrix' && args[i + 1]) opts.matrix = args[++i];
    else if (args[i] === '--run-s7-s8') opts.runS7S8 = true;
    else if (args[i] === '--run-all') opts.runAll = true;
    else if (args[i] === '--v23-smoke') opts.v23Smoke = true;
    else if (args[i] === '--v23-full') { opts.v23Full = true; opts.tier = 'full'; }
    else if (args[i] === '--manifest' && args[i + 1]) opts.manifestPath = args[++i];
    else if (args[i] === '--run-s6') opts.runS6 = true;
    else if (args[i] === '--run-s7') opts.runS7 = true;
    else if (args[i] === '--run-s8') opts.runS8 = true;
    else if (args[i] === '--run-s9') opts.runS9 = true;
    else if (args[i] === '--run-s10') opts.runS10 = true;
    else if (args[i] === '--run-s17') opts.runS17 = true;
    else if (args[i] === '--s7-cycles' && args[i + 1]) opts.s7Cycles = Number(args[++i]);
    else if (args[i] === '--tenk-subagents' && args[i + 1]) opts.tenKSubagentCount = Number(args[++i]);
    else if (args[i] === '--s6-step-timeout-ms' && args[i + 1]) opts.s6StepTimeoutMs = Number(args[++i]);
    else if (args[i] === '--keep-runtime') opts.keepRuntime = true;
    else if (args[i] === '--sync-code-only') opts.syncCodeOnly = true;
    else if (args[i] === '--reuse-warm-corpus') opts.reuseWarmCorpus = true;
    else if (args[i] === '--ttl' && args[i + 1]) opts.ttlMinutes = Number(args[++i]);
    else if (args[i] === '--idle-timeout' && args[i + 1]) opts.idleTimeoutMinutes = Number(args[++i]);
    else if (args[i] === '--runtime-state-file' && args[i + 1]) opts.runtimeStateFile = args[++i];
    else if (args[i] === '--reuse-runtime' && args[i + 1]) opts.reuseRuntimeId = args[++i];
    else if (args[i] === '--skip-upload-and-prep') opts.skipUploadAndPrep = true;
    else if (args[i] === '--baseline-head-code') opts.baselineHeadCode = true;
    else if (args[i] === '--out-dir' && args[i + 1]) opts.outDir = args[++i];
  }
  return opts;
}

const isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename);
if (isMain) {
  const opts = parseCcpCliArgs(process.argv.slice(2));
  const outcome = await runChaosOnCcp(opts);
  const finalExitCode = typeof outcome.exitCode === 'number' ? outcome.exitCode : EXIT_HARNESS_FAIL;
  process.stdout.write(
    `${JSON.stringify(
      {
        runId: outcome.runId,
        buildId: outcome.buildId,
        runtimeId: outcome.runtimeId,
        providerEndpoint: outcome.providerEndpoint,
        keptAlive: outcome.keptAlive,
        remoteExitCode: outcome.remoteExitCode,
        exitCode: finalExitCode,
        verdict: outcome.verdict,
        driveTransferMetrics: outcome.driveTransferMetrics,
        totalOrchestratorWallMs: outcome.totalOrchestratorWallMs,
        outDir: outcome.outDir,
        overallPassed: Boolean(outcome.verdict?.passed),
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = finalExitCode;
}
