import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { NbSearchCredentialFileStore } from '#/app/nbSearch/credentialFileStore';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

let disposables: DisposableStore;
const readBytes = vi.fn();
const lstat = vi.fn();
let store: NbSearchCredentialFileStore;

const entry = { isFile: true, isDirectory: false, isSymbolicLink: false, size: 2, ino: 1, mtimeMs: 1 };

beforeEach(() => {
  disposables = new DisposableStore();
  readBytes.mockReset().mockResolvedValue(new TextEncoder().encode('{}'));
  lstat.mockReset().mockResolvedValue(entry);
  const ix = createServices(disposables, {
    additionalServices: (reg) => {
      reg.definePartialInstance(IHostFileSystem, { lstat, readBytes });
    },
  });
  store = new NbSearchCredentialFileStore(ix.get(IHostFileSystem));
});

afterEach(() => {
  disposables.dispose();
});

describe('NbSearchCredentialFileStore', () => {
  it('returns undefined for a missing file', async () => {
    lstat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'os.fs.not_found' }));
    await expect(store.read('C:/fixture/nb-search/secrets.json')).resolves.toBeUndefined();
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('reads file bytes without ACL or symlink inspection', async () => {
    lstat.mockResolvedValue({ ...entry, isSymbolicLink: true });
    await expect(store.read('C:/fixture/nb-search/secrets.json')).resolves.toBe('{}');
    expect(readBytes).toHaveBeenCalledTimes(1);
  });

  it('rejects non-file or oversized entries', async () => {
    lstat.mockResolvedValue({ ...entry, isFile: false });
    await expect(store.read('C:/fixture/secrets.json')).rejects.toMatchObject({ issue: 'LOCAL_CREDENTIALS_UNREADABLE' });
    lstat.mockResolvedValue({ ...entry, size: 5 * 1024 * 1024 });
    await expect(store.read('C:/fixture/secrets.json')).rejects.toMatchObject({ issue: 'LOCAL_CREDENTIALS_UNREADABLE' });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('detects content changes between stat and read', async () => {
    let calls = 0;
    lstat.mockImplementation(async () => {
      calls += 1;
      return calls > 1 ? { ...entry, mtimeMs: 2 } : entry;
    });
    await expect(store.read('C:/fixture/secrets.json')).rejects.toMatchObject({ issue: 'LOCAL_CONFIG_CHANGED' });
  });

  it('fails busy while the config access lock exists', async () => {
    await expect(store.assertUnlocked('C:/fixture/nb-search')).rejects.toMatchObject({ issue: 'LOCAL_CONFIG_BUSY' });
    lstat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'os.fs.not_found' }));
    await expect(store.assertUnlocked('C:/fixture/nb-search')).resolves.toBeUndefined();
  });
});
