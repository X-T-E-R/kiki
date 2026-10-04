import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, cp, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AUTH_NATIVE_TARGETS, stageAuthNativeLane, mergeAuthNativeLanes } from '../scripts/lane-assets.mjs';
const packageRoot = resolve(import.meta.dirname, '..');
const scratch = resolve(packageRoot, '../../.tmp/auth-native-build');

test('six lane complete units merge by target with hashes; missing/corrupt/foreign assets fail closed', async () => {
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, 'lanes-'));
  try {
    const fixture = join(dir, 'package');
    await mkdir(fixture);
    for (const name of ['package.json', 'index.cjs', 'index.d.ts', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(join(packageRoot, name), join(fixture, name));
    for (const name of ['Apache-2.0.txt', 'upstream-mit.txt', 'rust-dependencies.json']) {
      await mkdir(join(fixture, 'licenses'), { recursive: true });
      await cp(join(packageRoot, 'licenses', name), join(fixture, 'licenses', name));
    }
    const artifacts = join(dir, 'artifacts');
    for (const target of AUTH_NATIVE_TARGETS) {
      const binding = join(fixture, 'prebuilds', target, 'auth-native.node');
      await mkdir(dirname(binding), { recursive: true });
      await writeFile(binding, `fake-${target}-binding`);
      await stageAuthNativeLane({ packageRoot: fixture, artifactRoot: artifacts, target });
    }
    const merged = join(dir, 'merged');
    await mergeAuthNativeLanes({ artifactRoot: artifacts, destination: merged });
    for (const target of AUTH_NATIVE_TARGETS) assert.equal(await readFile(join(merged, 'prebuilds', target, 'auth-native.node'), 'utf8'), `fake-${target}-binding`);
    assert.equal(await readFile(join(merged, 'index.cjs'), 'utf8'), await readFile(join(packageRoot, 'index.cjs'), 'utf8'));
    const prepared = execFileSync(process.execPath, [join(packageRoot, 'scripts/build.mjs')], {
      env: { ...process.env, PATH: '', KIKI_AUTH_NATIVE_ARTIFACT_ROOT: artifacts }, encoding: 'utf8',
    });
    assert.match(prepared, /Verified all six existing auth-native lane artifacts/);
    const badPath = join(artifacts, 'win32-arm64/prebuilds/win32-arm64/auth-native.node');
    await writeFile(badPath, 'corrupted');
    await assert.rejects(mergeAuthNativeLanes({ artifactRoot: artifacts, destination: join(dir, 'bad') }), /hash mismatch/);
    await stageAuthNativeLane({ packageRoot: fixture, artifactRoot: artifacts, target: 'win32-arm64' });
    await rm(join(artifacts, 'darwin-arm64'), { recursive: true });
    await assert.rejects(mergeAuthNativeLanes({ artifactRoot: artifacts, destination: join(dir, 'missing') }), /ENOENT/);
    await stageAuthNativeLane({ packageRoot: fixture, artifactRoot: artifacts, target: 'darwin-arm64' });
    const manifestPath = join(artifacts, 'linux-x64/lane.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files[0].path = '../escape';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(mergeAuthNativeLanes({ artifactRoot: artifacts, destination: join(dir, 'escape') }), /Unsafe/);
    await stageAuthNativeLane({ packageRoot: fixture, artifactRoot: artifacts, target: 'linux-x64' });
    const foreign = JSON.parse(await readFile(manifestPath, 'utf8'));
    foreign.files.push({ path: 'prebuilds/win32-x64/auth-native.node', sha256: '0'.repeat(64) });
    await writeFile(manifestPath, JSON.stringify(foreign));
    await assert.rejects(mergeAuthNativeLanes({ artifactRoot: artifacts, destination: join(dir, 'foreign') }), /Foreign native binding/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
