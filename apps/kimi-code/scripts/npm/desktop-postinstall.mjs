import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, rename } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const asset = process.platform === 'win32'
  ? `Kiki_${version}_x64-setup.exe`
  : process.platform === 'darwin'
    ? `Kiki_${version}_${process.arch === 'arm64' ? 'aarch64' : 'x64'}.dmg`
    : `Kiki_${version}_amd64.AppImage`;
const supported = (process.platform === 'win32' && process.arch === 'x64')
  || (process.platform === 'darwin' && ['x64', 'arm64'].includes(process.arch))
  || (process.platform === 'linux' && process.arch === 'x64');

if (!supported) {
  throw new Error(`No Kiki desktop npm bundle for ${process.platform}-${process.arch}. Use kiki-agent-lite or download the platform release asset.`);
}

const url = `https://github.com/X-T-E-R/kiki/releases/download/kiki-v${version}/${asset}`;
const checksumResponse = await fetch(`${url}.sha256`);
if (!checksumResponse.ok) throw new Error(`Desktop checksum download failed (${checksumResponse.status}): ${url}.sha256`);
const checksum = await checksumResponse.text();
const match = /^([a-f0-9]{64})  (\S+)\s*$/.exec(checksum);
if (!match || match[2] !== asset) throw new Error(`Invalid desktop checksum for ${asset}`);

const response = await fetch(url);
if (!response.ok || !response.body) throw new Error(`Desktop download failed (${response.status}): ${url}`);
const folder = resolve(root, 'desktop');
await mkdir(folder, { recursive: true });
const partial = resolve(folder, `${asset}.partial`);
const downloaded = resolve(folder, asset);
try {
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(partial)) hash.update(chunk);
  if (hash.digest('hex') !== match[1]) throw new Error(`Desktop checksum mismatch for ${asset}`);
  await rename(partial, downloaded);
} finally {
  await rm(partial, { force: true });
}

if (process.platform === 'win32') {
  execFileSync(downloaded, ['/S'], { stdio: 'inherit', timeout: 600_000 });
} else if (process.platform === 'linux') {
  const binary = resolve(folder, 'kiki-desktop.AppImage');
  await copyFile(downloaded, binary);
  await chmod(binary, 0o755);
} else {
  const mount = await mkdtemp(join(tmpdir(), 'kiki-npm-dmg-'));
  let attached = false;
  try {
    execFileSync('hdiutil', ['attach', downloaded, '-readonly', '-nobrowse', '-mountpoint', mount], { stdio: 'ignore' });
    attached = true;
    const apps = (await readdir(mount)).filter((entry) => entry.endsWith('.app'));
    if (apps.length !== 1) throw new Error(`Expected one desktop app in ${asset}, found ${apps.length}`);
    const destination = join(homedir(), 'Applications');
    await mkdir(destination, { recursive: true });
    await cp(join(mount, apps[0]), join(destination, apps[0]), { recursive: true, force: true });
  } finally {
    if (attached) execFileSync('hdiutil', ['detach', mount], { stdio: 'ignore' });
    await rm(mount, { recursive: true, force: true });
  }
}
console.log(`Installed Kiki desktop from ${basename(downloaded)} (SHA-256 verified).`);
