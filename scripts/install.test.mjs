import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const installScript = join(root, 'scripts/install.sh');

function resolveSh() {
  if (process.platform !== 'win32') return '/bin/sh';
  for (const candidate of [
    'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
    'C:\\Program Files\\Git\\bin\\sh.exe',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'sh';
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => { rejectListen(error); };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolveListen();
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => {
      if (error === undefined) {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectProcess);
    child.once('close', (status, signal) => { resolveProcess({ status, signal, stdout, stderr }); });
  });
}

async function createFakeUname(fakeBinDir, osName, archName) {
  await mkdir(fakeBinDir, { recursive: true });
  const unamePath = join(fakeBinDir, 'uname');
  await writeFile(
    unamePath,
    `#!/bin/sh
case "\${1:-}" in
  -s) printf '%s\\n' '${osName}' ;;
  -m) printf '%s\\n' '${archName}' ;;
  *)  printf '%s %s\\n' '${osName}' '${archName}' ;;
esac
`,
    'utf8',
  );
  await chmod(unamePath, 0o755);
}

function buildMockBinary(versionLabel = 'kiki 0.6.0-test') {
  return Buffer.from(
    `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' '${versionLabel}'
  exit 0
fi
if [ -n "\${MOCK_KIKI_LOG:-}" ]; then
  : > "$MOCK_KIKI_LOG"
  for arg in "$@"; do
    printf '%s\\n' "$arg" >> "$MOCK_KIKI_LOG"
  done
fi
exit 0
`,
    'utf8',
  );
}

async function runInstaller({
  scratch,
  osName,
  archName,
  installDir,
  args = [],
  extraEnv = {},
  mockLogPath,
}) {
  const fakeBin = join(scratch, `fake-bin-${osName}-${archName}`);
  await createFakeUname(fakeBin, osName, archName);
  await mkdir(installDir, { recursive: true });

  const sh = resolveSh();
  const harness = [
    'set -eu',
    'fake_bin_posix="$(cd "$TEST_FAKE_BIN" && pwd)"',
    'install_dir_posix="$(cd "$TEST_INSTALL_DIR" && pwd)"',
    'export PATH="$fake_bin_posix:$PATH"',
    'exec sh "$TEST_INSTALL_SCRIPT" --install-dir "$install_dir_posix" "$@"',
  ].join('\n');

  const env = {
    ...process.env,
    NO_PROXY: '*',
    no_proxy: '*',
    TEST_FAKE_BIN: fakeBin,
    TEST_INSTALL_DIR: installDir,
    TEST_INSTALL_SCRIPT: installScript.replaceAll('\\', '/'),
    ...(mockLogPath === undefined ? {} : { MOCK_KIKI_LOG: mockLogPath.replaceAll('\\', '/') }),
    ...extraEnv,
  };
  for (const key of [
    'KIKI_CHANNEL',
    'KIKI_VERSION',
    'KIKI_GITHUB_REPO',
    'KIKI_DOWNLOAD_BASE_URL',
    'KIKI_INSTALL_DIR',
    'KIKI_GITHUB_WEB_URL',
    'KIKI_GITHUB_API_URL',
    'GH_TOKEN',
    'GITHUB_TOKEN',
  ]) {
    if (!(key in extraEnv)) delete env[key];
  }

  return runProcess(sh, ['-c', harness, 'install-harness', ...args], { cwd: scratch, env });
}

void test('install.sh uses LF endings, POSIX sh shebang, and passes sh -n', async () => {
  const source = await readFile(installScript, 'utf8');
  assert.ok(source.startsWith('#!/bin/sh\n'), 'install.sh must start with #!/bin/sh and LF');
  assert.ok(!source.includes('\r'), 'install.sh must not contain CR bytes');
  const syntax = await runProcess(resolveSh(), ['-n', installScript.replaceAll('\\', '/')]);
  assert.equal(syntax.status, 0, `${syntax.stdout}\n${syntax.stderr}`);
});

void test('valid SHA-256 installs kiki and forwards repeatable --apply, --override, --home, and --yes', async (t) => {
  await mkdir(join(root, '.tmp'), { recursive: true });
  const scratch = await mkdtemp(join(root, '.tmp/install-sh-valid-'));
  const mockBinary = buildMockBinary('kiki 0.6.0-local');
  const validSha = sha256Hex(mockBinary).toUpperCase();
  const requests = [];

  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/mirror/kiki-linux-x64') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(mockBinary);
      return;
    }
    if (req.url === '/mirror/kiki-linux-x64.sha256') {
      res.setHeader('content-type', 'text/plain');
      res.end(`${validSha}  kiki-linux-x64\r\n`);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  t.after(async () => {
    await closeServer(server);
    await rm(scratch, { recursive: true, force: true });
  });

  await listen(server);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/mirror`;
  const installDir = join(scratch, 'bin');
  const mockLog = join(scratch, 'kiki-args.log');

  const result = await runInstaller({
    scratch,
    osName: 'Linux',
    archName: 'x86_64',
    installDir,
    mockLogPath: mockLog,
    args: [
      '--base-url',
      baseUrl,
      '--apply',
      'a.kiki.age',
      '--apply',
      'b.kiki.age',
      '--override',
    ],
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(requests, ['/mirror/kiki-linux-x64', '/mirror/kiki-linux-x64.sha256']);
  assert.match(result.stdout, /Installed kiki 0\.6\.0-local -> /);
  assert.match(result.stdout, /Add to PATH: export PATH="/);

  const installedBytes = await readFile(join(installDir, 'kiki'));
  assert.deepEqual(installedBytes, mockBinary);

  const recordedArgs = (await readFile(mockLog, 'utf8')).trim().split(/\r?\n/);
  assert.deepEqual(recordedArgs, [
    'space',
    'apply',
    'a.kiki.age',
    'b.kiki.age',
    '--override',
    '--yes',
  ]);

  const homeLog = join(scratch, 'kiki-home-args.log');
  const withHome = await runInstaller({
    scratch,
    osName: 'Linux',
    archName: 'x86_64',
    installDir,
    mockLogPath: homeLog,
    args: [
      '--base-url',
      baseUrl,
      '--apply',
      '/content/drive/My Drive/main.kiki.age',
      '--home',
      '/tmp/kiki-colab-home',
    ],
  });
  assert.equal(withHome.status, 0, `${withHome.stdout}\n${withHome.stderr}`);
  const recordedHomeArgs = (await readFile(homeLog, 'utf8')).trim().split(/\r?\n/);
  assert.deepEqual(recordedHomeArgs, [
    'space',
    'apply',
    '/content/drive/My Drive/main.kiki.age',
    '--home',
    '/tmp/kiki-colab-home',
    '--yes',
  ]);

  const yesLog = join(scratch, 'kiki-yes-args.log');
  const withYes = await runInstaller({
    scratch,
    osName: 'Linux',
    archName: 'x86_64',
    installDir,
    mockLogPath: yesLog,
    args: [
      '--base-url',
      baseUrl,
      '--apply',
      'foo.kiki.age',
      '--yes',
      '-y',
    ],
  });
  assert.equal(withYes.status, 0, `${withYes.stdout}\n${withYes.stderr}`);
  const recordedYesArgs = (await readFile(yesLog, 'utf8')).trim().split(/\r?\n/);
  assert.deepEqual(recordedYesArgs, ['space', 'apply', 'foo.kiki.age', '--yes']);
});

void test('tampered SHA-256 fails non-zero and never writes kiki into install-dir', async (t) => {
  await mkdir(join(root, '.tmp'), { recursive: true });
  const scratch = await mkdtemp(join(root, '.tmp/install-sh-tampered-'));
  const mockBinary = buildMockBinary('kiki 0.6.0-tampered');
  const wrongSha = '0'.repeat(64);

  const server = createServer((req, res) => {
    if (req.url === '/mirror/kiki-linux-x64') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(mockBinary);
      return;
    }
    if (req.url === '/mirror/kiki-linux-x64.sha256') {
      res.setHeader('content-type', 'text/plain');
      res.end(`${wrongSha}  kiki-linux-x64\n`);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  t.after(async () => {
    await closeServer(server);
    await rm(scratch, { recursive: true, force: true });
  });

  await listen(server);
  const { port } = server.address();
  const installDir = join(scratch, 'clean-bin');
  const mockLog = join(scratch, 'never-called.log');

  const result = await runInstaller({
    scratch,
    osName: 'Linux',
    archName: 'x86_64',
    installDir,
    mockLogPath: mockLog,
    args: [
      '--base-url',
      `http://127.0.0.1:${port}/mirror`,
      '--apply',
      'a.kiki.age',
    ],
  });

  assert.notEqual(result.status, 0, 'tampered checksum must fail non-zero');
  assert.match(result.stderr, /SHA-256 verification failed/);
  assert.deepEqual(await readdir(installDir), []);
  assert.equal(existsSync(mockLog), false);
});

void test('--channel beta selects newest non-draft kiki-v0.6.0-beta.1 tag from mock /releases JSON', async (t) => {
  await mkdir(join(root, '.tmp'), { recursive: true });
  const scratch = await mkdtemp(join(root, '.tmp/install-sh-beta-'));
  const mockBinary = buildMockBinary('kiki 0.6.0-beta.1');
  const validSha = sha256Hex(mockBinary);
  const requests = [];
  let apiAuthHeader = '';

  const releasesPayload = JSON.stringify([
    {
      tag_name: 'kiki-v0.7.0-beta.9',
      draft: true,
      prerelease: true,
      body: 'Draft should be ignored',
      assets: [{ name: 'kiki-darwin-arm64' }],
    },
    {
      tag_name: 'unrelated-v9.9.9',
      draft: false,
      prerelease: true,
      body: 'Non-kiki tag should be ignored',
    },
    {
      body: 'Release notes with tricky text: "draft": true } { "tag_name": "kiki-v9.9.9" \\"quoted\\"',
      assets: [{ name: 'kiki-darwin-arm64', uploader: { login: 'bot' } }],
      prerelease: true,
      draft: false,
      tag_name: 'kiki-v0.6.0-beta.1',
    },
    {
      tag_name: 'kiki-v0.5.9',
      draft: false,
      prerelease: false,
      body: 'Older stable release',
    },
  ]);

  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/repos/X-T-E-R/kiki/releases?per_page=100&page=1') {
      apiAuthHeader = String(req.headers.authorization ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(releasesPayload);
      return;
    }
    if (req.url === '/X-T-E-R/kiki/releases/download/kiki-v0.6.0-beta.1/kiki-darwin-arm64') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(mockBinary);
      return;
    }
    if (req.url === '/X-T-E-R/kiki/releases/download/kiki-v0.6.0-beta.1/kiki-darwin-arm64.sha256') {
      res.setHeader('content-type', 'text/plain');
      res.end(`${validSha}  kiki-darwin-arm64\n`);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  t.after(async () => {
    await closeServer(server);
    await rm(scratch, { recursive: true, force: true });
  });

  await listen(server);
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const installDir = join(scratch, 'beta-bin');

  const result = await runInstaller({
    scratch,
    osName: 'Darwin',
    archName: 'arm64',
    installDir,
    args: ['--channel', 'beta'],
    extraEnv: {
      KIKI_GITHUB_API_URL: origin,
      KIKI_GITHUB_WEB_URL: origin,
      GH_TOKEN: 'fixture-gh-token',
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(apiAuthHeader, 'Bearer fixture-gh-token');
  assert.deepEqual(requests, [
    '/repos/X-T-E-R/kiki/releases?per_page=100&page=1',
    '/X-T-E-R/kiki/releases/download/kiki-v0.6.0-beta.1/kiki-darwin-arm64',
    '/X-T-E-R/kiki/releases/download/kiki-v0.6.0-beta.1/kiki-darwin-arm64.sha256',
  ]);
  assert.match(result.stdout, /Installed kiki 0\.6\.0-beta\.1 -> /);
  assert.deepEqual(await readFile(join(installDir, 'kiki')), mockBinary);
});

void test('stable channel falls back from latest/download to first non-prerelease kiki-v* release', async (t) => {
  await mkdir(join(root, '.tmp'), { recursive: true });
  const scratch = await mkdtemp(join(root, '.tmp/install-sh-stable-fallback-'));
  const mockBinary = buildMockBinary('kiki 0.5.9');
  const validSha = sha256Hex(mockBinary);
  const requests = [];

  const releasesPayload = JSON.stringify(
    [
      { tag_name: 'kiki-v0.6.0-beta.1', draft: false, prerelease: true },
      { tag_name: 'kiki-v0.5.10', draft: true, prerelease: false },
      { tag_name: 'kiki-v0.5.9', draft: false, prerelease: false },
    ],
    null,
    2,
  );

  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/repos/X-T-E-R/kiki/releases?per_page=100&page=1') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify([
          { tag_name: 'kiki-v0.6.0-beta.2', draft: false, prerelease: true },
          { tag_name: 'other-tool-v2.0.0', draft: false, prerelease: false },
        ]),
      );
      return;
    }
    if (req.url === '/repos/X-T-E-R/kiki/releases?per_page=100&page=2') {
      res.setHeader('content-type', 'application/json');
      res.end(releasesPayload);
      return;
    }
    if (req.url === '/X-T-E-R/kiki/releases/download/kiki-v0.5.9/kiki-linux-arm64') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(mockBinary);
      return;
    }
    if (req.url === '/X-T-E-R/kiki/releases/download/kiki-v0.5.9/kiki-linux-arm64.sha256') {
      res.setHeader('content-type', 'text/plain');
      res.end(`${validSha}  kiki-linux-arm64\n`);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  t.after(async () => {
    await closeServer(server);
    await rm(scratch, { recursive: true, force: true });
  });

  await listen(server);
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const installDir = join(scratch, 'stable-bin');

  const result = await runInstaller({
    scratch,
    osName: 'Linux',
    archName: 'aarch64',
    installDir,
    extraEnv: {
      KIKI_GITHUB_API_URL: origin,
      KIKI_GITHUB_WEB_URL: origin,
    },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(requests, [
    '/X-T-E-R/kiki/releases/latest/download/kiki-linux-arm64',
    '/repos/X-T-E-R/kiki/releases?per_page=100&page=1',
    '/repos/X-T-E-R/kiki/releases?per_page=100&page=2',
    '/X-T-E-R/kiki/releases/download/kiki-v0.5.9/kiki-linux-arm64',
    '/X-T-E-R/kiki/releases/download/kiki-v0.5.9/kiki-linux-arm64.sha256',
  ]);
  assert.match(result.stdout, /Installed kiki 0\.5\.9 -> /);
});

void test('unsupported OS or architecture fails with a single clear error line', async (t) => {
  await mkdir(join(root, '.tmp'), { recursive: true });
  const scratch = await mkdtemp(join(root, '.tmp/install-sh-unsupported-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const result = await runInstaller({
    scratch,
    osName: 'Linux',
    archName: 'riscv64',
    installDir: join(scratch, 'bin'),
  });

  assert.notEqual(result.status, 0);
  const stderrLines = result.stderr.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(stderrLines.length, 1, `expected 1-line error, got: ${result.stderr}`);
  assert.match(stderrLines[0], /unsupported platform: Linux riscv64/);
});

void test('stable fast path avoids GitHub API and supports piped sh -s -- and --version pinning', async (t) => {
  await mkdir(join(root, '.tmp'), { recursive: true });
  const scratch = await mkdtemp(join(root, '.tmp/install-sh-fast-path-'));
  const latestBinary = buildMockBinary('kiki 0.6.0');
  const pinnedBinary = buildMockBinary('kiki 0.5.8');
  const requests = [];

  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/X-T-E-R/kiki/releases/latest/download/kiki-darwin-x64') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(latestBinary);
      return;
    }
    if (req.url === '/X-T-E-R/kiki/releases/latest/download/kiki-darwin-x64.sha256') {
      res.setHeader('content-type', 'text/plain');
      res.end(`${sha256Hex(latestBinary)}  kiki-darwin-x64\n`);
      return;
    }
    if (req.url === '/X-T-E-R/kiki/releases/download/kiki-v0.5.8/kiki-darwin-x64') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(pinnedBinary);
      return;
    }
    if (req.url === '/X-T-E-R/kiki/releases/download/kiki-v0.5.8/kiki-darwin-x64.sha256') {
      res.setHeader('content-type', 'text/plain');
      res.end(`${sha256Hex(pinnedBinary)}  kiki-darwin-x64\n`);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  t.after(async () => {
    await closeServer(server);
    await rm(scratch, { recursive: true, force: true });
  });

  await listen(server);
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const fakeBin = join(scratch, 'fake-bin');
  const installDir = join(scratch, 'pipe-bin');
  await createFakeUname(fakeBin, 'Darwin', 'x86_64');
  await mkdir(installDir, { recursive: true });

  const pipeHarness = [
    'set -eu',
    'fake_bin_posix="$(cd "$TEST_FAKE_BIN" && pwd)"',
    'install_dir_posix="$(cd "$TEST_INSTALL_DIR" && pwd)"',
    'export PATH="$fake_bin_posix:$PATH"',
    'sh -s -- --install-dir "$install_dir_posix" "$@" < "$TEST_INSTALL_SCRIPT"',
  ].join('\n');

  const baseEnv = {
    ...process.env,
    NO_PROXY: '*',
    no_proxy: '*',
    TEST_FAKE_BIN: fakeBin,
    TEST_INSTALL_DIR: installDir,
    TEST_INSTALL_SCRIPT: installScript.replaceAll('\\', '/'),
    KIKI_GITHUB_API_URL: origin,
    KIKI_GITHUB_WEB_URL: origin,
  };
  for (const key of ['KIKI_CHANNEL', 'KIKI_VERSION', 'KIKI_GITHUB_REPO', 'KIKI_DOWNLOAD_BASE_URL', 'KIKI_INSTALL_DIR']) {
    delete baseEnv[key];
  }

  const piped = await runProcess(resolveSh(), ['-c', pipeHarness, 'pipe-harness'], {
    cwd: scratch,
    env: baseEnv,
  });
  assert.equal(piped.status, 0, `${piped.stdout}\n${piped.stderr}`);
  assert.deepEqual(requests, [
    '/X-T-E-R/kiki/releases/latest/download/kiki-darwin-x64',
    '/X-T-E-R/kiki/releases/latest/download/kiki-darwin-x64.sha256',
  ]);
  assert.match(piped.stdout, /Installed kiki 0\.6\.0 -> /);

  requests.length = 0;
  const pinned = await runInstaller({
    scratch,
    osName: 'Darwin',
    archName: 'x86_64',
    installDir,
    args: ['--version', '0.5.8'],
    extraEnv: {
      KIKI_GITHUB_API_URL: origin,
      KIKI_GITHUB_WEB_URL: origin,
    },
  });
  assert.equal(pinned.status, 0, `${pinned.stdout}\n${pinned.stderr}`);
  assert.deepEqual(requests, [
    '/X-T-E-R/kiki/releases/download/kiki-v0.5.8/kiki-darwin-x64',
    '/X-T-E-R/kiki/releases/download/kiki-v0.5.8/kiki-darwin-x64.sha256',
  ]);
  assert.match(pinned.stdout, /Installed kiki 0\.5\.8 -> /);
});

test('installer forwards HTTPS --apply and --subscribe URLs to kiki space commands', async (t) => {
  const scratch = await mkdtemp(join(root, '.tmp-install-sub-'));
  const binary = Buffer.from(
    `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf 'kiki 0.6.0-test\\n'
  exit 0
fi
if [ -n "\${MOCK_KIKI_LOG:-}" ]; then
  for arg in "$@"; do
    printf '%s\\n' "$arg" >> "$MOCK_KIKI_LOG"
  done
  printf -- '---\\n' >> "$MOCK_KIKI_LOG"
fi
exit 0
`,
    'utf8',
  );
  const server = createServer((req, res) => {
    if (req.url === '/X-T-E-R/kiki/releases/latest/download/kiki-linux-x64') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(binary);
      return;
    }
    if (req.url === '/X-T-E-R/kiki/releases/latest/download/kiki-linux-x64.sha256') {
      res.setHeader('content-type', 'text/plain');
      res.end(`${sha256Hex(binary)}  kiki-linux-x64\n`);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  t.after(async () => {
    await closeServer(server);
    await rm(scratch, { recursive: true, force: true });
  });

  await listen(server);
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const installDir = join(scratch, 'bin');
  const logFile = join(scratch, 'kiki-calls.log');

  const result = await runInstaller({
    scratch,
    osName: 'Linux',
    archName: 'x86_64',
    installDir,
    args: [
      '--apply', 'https://api.example.test/packs/base.tgz',
      '--subscribe', 'https://api.example.test/api/sub/token1234567890abcdef.tgz',
      '--yes',
    ],
    extraEnv: {
      KIKI_GITHUB_API_URL: origin,
      KIKI_GITHUB_WEB_URL: origin,
      MOCK_KIKI_LOG: logFile,
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const recorded = (await readFile(logFile, 'utf8')).trim().split('\n');
  assert.deepEqual(recorded, [
    'space',
    'apply',
    'https://api.example.test/packs/base.tgz',
    '--yes',
    '---',
    'space',
    'subscribe',
    'https://api.example.test/api/sub/token1234567890abcdef.tgz',
    '--yes',
    '---',
  ]);
});
