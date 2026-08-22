import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertReleaseVersion,
  createReleaseManifest,
  writeReleaseFiles,
} from './desktop-release-manifest.mjs';

test('manifest pins the tag URL and embeds the complete signature file content', () => {
  const manifest = createReleaseManifest({
    version: '1.4.0-beta.2',
    tag: 'kiki-v1.4.0-beta.2',
    installerName: 'Kiki_1.4.0-beta.2_x64-setup.exe',
    signature: 'untrusted comment: signature\nRWQexample\n',
    pubDate: '2026-03-22T10:00:00Z',
    notes: 'Beta release',
  });

  assert.equal(manifest.version, '1.4.0-beta.2');
  assert.equal(manifest.pub_date, '2026-03-22T10:00:00.000Z');
  assert.equal(
    manifest.platforms['windows-x86_64'].url,
    'https://github.com/X-T-E-R/kiki/releases/download/kiki-v1.4.0-beta.2/Kiki_1.4.0-beta.2_x64-setup.exe',
  );
  assert.equal(
    manifest.platforms['windows-x86_64'].signature,
    'untrusted comment: signature\nRWQexample',
  );
});

test('release version requires an exact kiki-v semantic-version tag', () => {
  assert.doesNotThrow(() => assertReleaseVersion('2.0.0', 'kiki-v2.0.0'));
  assert.throws(() => assertReleaseVersion('2.0', 'kiki-v2.0'), /Invalid semantic version/);
  assert.throws(() => assertReleaseVersion('2.0.0', 'v2.0.0'), /Release tag must be/);
});

test('writes latest.json and a SHA256 file for the installer', () => {
  const root = mkdtempSync(join(tmpdir(), 'kiki-release-manifest-'));
  try {
    const installer = join(root, 'Kiki_1.2.3_x64-setup.exe');
    const signature = `${installer}.sig`;
    const latest = join(root, 'latest.json');
    const checksum = `${installer}.sha256`;
    writeFileSync(installer, 'installer bytes');
    writeFileSync(signature, 'signature bytes\n');

    writeReleaseFiles({
      installerPath: installer,
      signaturePath: signature,
      manifestPath: latest,
      checksumPath: checksum,
      version: '1.2.3',
      tag: 'kiki-v1.2.3',
      pubDate: '2026-03-22T10:00:00Z',
      notes: '',
    });

    assert.equal(
      readFileSync(checksum, 'utf8'),
      'e34210a6de4f653edf588301431c3d69a633638cbf587345cc50a7fed9f38f4c  Kiki_1.2.3_x64-setup.exe\n',
    );
    assert.equal(JSON.parse(readFileSync(latest, 'utf8')).platforms['windows-x86_64'].signature, 'signature bytes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
