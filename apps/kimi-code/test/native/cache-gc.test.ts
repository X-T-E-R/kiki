import { mkdirSync, statSync, utimesSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupStaleCacheTree, cleanupStaleNativeCache } from '#/native/native-assets';

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

  it('prunes older versions and stale web cache siblings via cleanupStaleCacheTree', async () => {
    const t = 'darwin-arm64';
    const makeNsDir = (ns: 'native' | 'web', version: string, hash: string, mtimeOffset: number): string => {
      const dir = join(root, ns, version, t, hash);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'marker.txt'), hash);
      const now = Math.floor(Date.now() / 1000);
      utimesSync(dir, now + mtimeOffset, now + mtimeOffset);
      utimesSync(join(root, ns, version), now + mtimeOffset, now + mtimeOffset);
      return dir;
    };

    makeNsDir('native', '0.1.0', 'h1', -500);
    makeNsDir('native', '0.2.0', 'h2', -300);
    makeNsDir('native', '0.3.0', 'h3', -100);
    const currentNative = makeNsDir('native', '0.4.0', 'h4', 0);

    makeNsDir('web', '0.1.0', 'w1', -500);
    makeNsDir('web', '0.3.0', 'w3', -100);
    const webOldSibling = makeNsDir('web', '0.4.0', 'wa', -400);
    const webRecentSibling = makeNsDir('web', '0.4.0', 'wb', -50);
    const currentWeb = makeNsDir('web', '0.4.0', 'wc', 0);

    const nativeResult = await cleanupStaleCacheTree({
      cacheBase: root,
      namespace: 'native',
      version: '0.4.0',
      target: t,
      currentRoot: currentNative,
      maxOldVersions: 1,
    });
    expect(nativeResult.errors).toEqual([]);
    expect(readdirSync(join(root, 'native')).toSorted()).toEqual(['0.3.0', '0.4.0']);

    const webResult = await cleanupStaleCacheTree({
      cacheBase: root,
      namespace: 'web',
      version: '0.4.0',
      target: t,
      currentRoot: currentWeb,
      maxOldVersions: 1,
    });
    expect(webResult.errors).toEqual([]);
    expect(readdirSync(join(root, 'web')).toSorted()).toEqual(['0.3.0', '0.4.0']);
    expect(readdirSync(join(root, 'web', '0.4.0', t)).toSorted()).toEqual(['wb', 'wc']);
    expect(webResult.removed).toContain(webOldSibling);
    expect(webResult.kept).toContain(webRecentSibling);
  });
});
