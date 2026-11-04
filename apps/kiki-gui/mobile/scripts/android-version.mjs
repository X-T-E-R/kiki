import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function androidVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.exec(version);
  if (match === null) throw new Error(`Unsupported Android product version: ${version}`);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const versionCode = major * 1000000 + minor * 1000 + patch;
  if (minor > 999 || patch > 999 || !Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) {
    throw new Error(`Android versionCode is out of range for ${version}`);
  }
  return { versionName: version, versionCode };
}

export function readAndroidVersion(root = resolve(import.meta.dirname, '../../../..')) {
  return androidVersion(JSON.parse(readFileSync(resolve(root, 'apps/kiki-gui/package.json'), 'utf8')).version);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.stdout.write(`${JSON.stringify(readAndroidVersion())}\n`);
}
