import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { OfficeError } from './paths.mjs';

export const OFFICECLI_VERSION = '1.0.152';
export const CHECKSUMS_SHA256 = '7b9125b7ce0cca5c08202692d17145de94ed689df84017217530a87447d9f271';
const RELEASE = `https://github.com/iOfficeAI/OfficeCLI/releases/download/v${OFFICECLI_VERSION}`;
const ASSETS = { 'win32-x64': 'officecli-win-x64.exe', 'darwin-arm64': 'officecli-mac-arm64', 'linux-x64': 'officecli-linux-x64' };
const MAX_BINARY_BYTES = 80 * 1024 * 1024;
const ENV = { OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_NO_AUTO_RESIDENT: '1', OFFICECLI_RESIDENT_FLUSH: 'each' };

export function platformAsset(platform = process.platform, arch = process.arch) {
  const asset = ASSETS[`${platform}-${arch}`];
  if (!asset) throw new OfficeError('PLATFORM_UNSUPPORTED', `No pinned OfficeCLI binary for ${platform}-${arch}.`, 'Use Windows x64, macOS arm64, or Linux x64.');
  return asset;
}

async function fetchPinned(url, maxBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`OfficeCLI release returned HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('OfficeCLI release exceeds the size limit');
  if (!response.body) throw new Error('OfficeCLI release response has no body');
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) { await response.body.cancel().catch(() => undefined); throw new Error('OfficeCLI release exceeds the size limit'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export function parseChecksum(text, asset) {
  const match = text.split(/\r?\n/).map((row) => /^([a-fA-F0-9]{64})\s+\*?([^\s]+)$/.exec(row)).find((row) => row?.[2] === asset);
  if (!match) throw new OfficeError('CHECKSUM_MISSING', `Official SHA256SUMS does not list ${asset}.`, 'Retry from the pinned official OfficeCLI release.');
  return match[1].toLowerCase();
}

// This method is callable only by a host-driven, explicitly consented install flow; tools never call it.
export async function installPinnedBinary({ consent, destination, fetchRelease = fetchPinned }) {
  if (consent !== true) throw new OfficeError('CONSENT_REQUIRED', 'Installing OfficeCLI requires explicit user consent.', 'Approve the OfficeCLI binary download in Kiki first.');
  const asset = platformAsset();
  const manifest = await fetchRelease(`${RELEASE}/SHA256SUMS`, 16_384);
  if (createHash('sha256').update(manifest).digest('hex') !== CHECKSUMS_SHA256) {
    throw new OfficeError('CHECKSUM_INVALID', 'OfficeCLI checksum manifest differs from the pinned release.', 'Stop installation and verify the official release.');
  }
  const expected = parseChecksum(manifest.toString('utf8'), asset);
  const binary = await fetchRelease(`${RELEASE}/${asset}`, MAX_BINARY_BYTES);
  if (binary.length > MAX_BINARY_BYTES || createHash('sha256').update(binary).digest('hex') !== expected) {
    throw new OfficeError('CHECKSUM_INVALID', 'OfficeCLI binary does not match the official SHA256SUMS.', 'Retry the download from the pinned official release.');
  }
  await mkdir(path.dirname(destination), { recursive: true });
  if (await stat(destination).catch(() => undefined)) {
    throw new OfficeError('FILE_EXISTS', `Binary already exists: ${destination}`, 'Choose an empty versioned plugin data directory; do not overwrite an existing executable.');
  }
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    const writer = createWriteStream(temporary, { flags: 'wx', mode: 0o700 });
    await pipeline(Readable.from([binary]), writer);
    await chmod(temporary, 0o700);
    await copyFile(temporary, destination, constants.COPYFILE_EXCL);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return destination;
}

export async function runProcess(binary, args, { input, signal, maxBytes = 64 * 1024, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...ENV } });
    let stdout = '';
    let stderr = '';
    let failed;
    const timeout = setTimeout(() => { failed = new OfficeError('ENGINE_TIMEOUT', 'OfficeCLI timed out.', 'Try a smaller document or a narrower selection.'); child.kill(); }, timeoutMs);
    const abort = () => { failed = new OfficeError('CANCELLED', 'OfficeCLI call was cancelled.', 'Retry the operation if it is still needed.'); child.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', () => undefined);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > maxBytes) { failed = new OfficeError('RESULT_TOO_LARGE', 'OfficeCLI output exceeds the fixed window.', 'Narrow the query or specify a smaller view range.'); child.kill(); }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.on('error', (error) => { failed = error; });
    child.on('close', (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (failed) reject(failed);
      else resolve({ code, stdout, stderr });
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

export async function findBinary({ binaryPath, signal } = {}) {
  const home = os.homedir();
  const candidates = binaryPath ? [binaryPath] : [
    process.platform === 'win32' ? path.join(home, 'AppData', 'Local', 'OfficeCLI', 'officecli.exe') : path.join(home, '.local', 'bin', 'officecli'),
    process.platform === 'win32' ? 'officecli.exe' : 'officecli'];
  let mismatch;
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const { code, stdout } = await runProcess(candidate, ['--version'], { signal, timeoutMs: 5000 });
      if (code === 0 && stdout.trim() === OFFICECLI_VERSION) return candidate;
      mismatch = stdout.trim();
    } catch (error) {
      if (error.code === 'CANCELLED') throw error;
    }
  }
  if (mismatch) throw new OfficeError('VERSION_MISMATCH', `Installed OfficeCLI is ${mismatch}; plugin pins ${OFFICECLI_VERSION}.`, 'Install the pinned version through the plugin prerequisite flow.');
  throw new OfficeError('ENGINE_MISSING', `OfficeCLI ${OFFICECLI_VERSION} was not found.`, 'Install the pinned binary from the plugin prerequisite screen after approving the download.');
}
