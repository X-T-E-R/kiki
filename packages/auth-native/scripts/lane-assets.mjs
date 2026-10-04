import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';

export const AUTH_NATIVE_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function walk(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, path));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
    else throw new Error(`Unsupported auth-native lane entry: ${path}`);
  }
  return files.sort();
}

export async function stageAuthNativeLane({ packageRoot, artifactRoot, target }) {
  if (!AUTH_NATIVE_TARGETS.includes(target)) throw new Error(`Unsupported auth-native lane: ${target}`);
  const destination = resolve(artifactRoot, target);
  const files = ['package.json', 'index.cjs', 'index.d.ts', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
    `prebuilds/${target}/auth-native.node`, ...(await walk(join(packageRoot, 'licenses'))).map((path) => `licenses/${path}`)];
  const entries = [];
  for (const name of files.sort()) {
    const bytes = await readFile(join(packageRoot, name));
    const path = join(destination, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    entries.push({ path: name, sha256: hash(bytes) });
  }
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  await writeFile(join(destination, 'lane.json'), `${JSON.stringify({ version: 1, target, packageVersion: packageJson.version, files: entries }, null, 2)}\n`);
  return destination;
}

export async function mergeAuthNativeLanes({ artifactRoot, destination, expectedTargets = AUTH_NATIVE_TARGETS }) {
  let sharedHash;
  for (const target of expectedTargets) {
    if (!AUTH_NATIVE_TARGETS.includes(target)) throw new Error(`Unsupported auth-native lane: ${target}`);
    const laneRoot = resolve(artifactRoot, target);
    const lane = JSON.parse(await readFile(join(laneRoot, 'lane.json'), 'utf8'));
    if (lane.version !== 1 || lane.target !== target || !Array.isArray(lane.files)) throw new Error(`Invalid auth-native lane manifest: ${target}`);
    const required = ['package.json', 'index.cjs', 'index.d.ts', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
      'licenses/Apache-2.0.txt', 'licenses/rust-dependencies.json', 'licenses/upstream-mit.txt', `prebuilds/${target}/auth-native.node`];
    const names = new Set();
    const shared = [];
    const verified = [];
    for (const file of lane.files) {
      if (typeof file.path !== 'string' || file.path.includes('\\') || file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
        /^[A-Za-z]:|^[\\/]/.test(file.path) || names.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) {
        throw new Error(`Unsafe auth-native lane entry: ${target}`);
      }
      names.add(file.path);
      if (file.path.startsWith('prebuilds/') && file.path !== `prebuilds/${target}/auth-native.node`) throw new Error(`Foreign native binding in ${target} lane`);
      const path = join(laneRoot, file.path);
      const bytes = await readFile(path);
      if (hash(bytes) !== file.sha256) throw new Error(`Auth-native lane hash mismatch: ${target}/${file.path}`);
      if (!file.path.startsWith('prebuilds/') && !file.path.startsWith('licenses/rust')) shared.push(`${file.path}:${file.sha256}`);
      verified.push({ path, name: file.path });
    }
    for (const name of required) if (!names.has(name)) throw new Error(`Auth-native lane ${target} is missing ${name}`);
    const packageJson = JSON.parse(await readFile(join(laneRoot, 'package.json'), 'utf8'));
    if (packageJson.name !== '@kiki/auth-native' || packageJson.version !== lane.packageVersion) throw new Error(`Auth-native lane package mismatch: ${target}`);
    const signature = shared.sort().join('\n');
    if (sharedHash !== undefined && sharedHash !== signature) throw new Error(`Auth-native shared runtime differs across lanes: ${target}`);
    sharedHash = signature;
    for (const file of verified) {
      const output = file.name.startsWith('licenses/rust')
        ? join(destination, 'licenses/targets', target, file.name.slice('licenses/'.length))
        : join(destination, file.name);
      await mkdir(dirname(output), { recursive: true });
      await cp(file.path, output);
    }
  }
}
