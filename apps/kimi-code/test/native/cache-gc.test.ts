import { mkdirSync, statSync, utimesSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupStaleNativeCache } from '#/native/native-assets';

describe('cleanupStaleNativeCache', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kimi-cache-gc-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  function makeHashDir(version: string, target: string, hash: string, mtimeOffset = 0): string {
    const dir = join(root, 'native', version, target, hash);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'marker.txt'), hash);
    const now = Math.floor(Date.now() / 1000);
    utimesSync(dir, now + mtimeOffset, now + mtimeOffset);
    return dir;
  }

  it('keeps currentRoot + most recently modified sibling, deletes the rest', () => {
    const v = '1.0.0';
    const t = 'darwin-arm64';
    const oldest = makeHashDir(v, t, 'aaaa', -300);
    const middle = makeHashDir(v, t, 'bbbb', -200);
    const recent = makeHashDir(v, t, 'cccc', -100);
    const current = makeHashDir(v, t, 'dddd', 0);

    const result = cleanupStaleNativeCache({
      cacheBase: root,
      version: v,
      target: t,
      currentRoot: current,
    });

    expect(result.kept.toSorted()).toEqual([recent, current].toSorted());
    expect(result.removed.toSorted()).toEqual([oldest, middle].toSorted());

    expect(readdirSync(join(root, 'native', v, t)).toSorted()).toEqual(['cccc', 'dddd']);
  });

  it('no-op when only currentRoot exists', () => {
    const v = '1.0.0';
    const t = 'darwin-arm64';
    const current = makeHashDir(v, t, 'dddd');

    const result = cleanupStaleNativeCache({
      cacheBase: root,
      version: v,
      target: t,
      currentRoot: current,
    });

    expect(result.kept).toEqual([current]);
    expect(result.removed).toEqual([]);
  });

  it('no-op when target dir does not exist', () => {
    const result = cleanupStaleNativeCache({
      cacheBase: root,
      version: '1.0.0',
      target: 'darwin-arm64',
      currentRoot: join(root, 'native', '1.0.0', 'darwin-arm64', 'absent'),
    });
    expect(result.kept).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('does not touch other targets or versions', () => {
    const current = makeHashDir('1.0.0', 'darwin-arm64', 'dddd');
    const otherTarget = makeHashDir('1.0.0', 'linux-x64', 'eeee');
    const otherVersion = makeHashDir('0.9.0', 'darwin-arm64', 'ffff');

    cleanupStaleNativeCache({
      cacheBase: root,
      version: '1.0.0',
      target: 'darwin-arm64',
      currentRoot: current,
    });

    expect(statSync(otherTarget).isDirectory()).toBe(true);
    expect(statSync(otherVersion).isDirectory()).toBe(true);
  });

  it('errors array is empty on clean run', () => {
    const current = makeHashDir('1.0.0', 'darwin-arm64', 'dddd');
    const result = cleanupStaleNativeCache({
      cacheBase: root,
      version: '1.0.0',
      target: 'darwin-arm64',
      currentRoot: current,
    });
    expect(result.errors).toEqual([]);
  });
});
