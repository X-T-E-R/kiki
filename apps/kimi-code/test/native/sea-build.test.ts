import { describe, expect, it } from 'vitest';

import { seaCodeCacheEnabled, seaExecArgv } from '../../scripts/native/02-sea-blob.mjs';

// Cache blobs are tied to the V8 build host, not a cross-target asset label.
describe('SEA build options', () => {
  it.each(['win32-x64', 'linux-x64', 'darwin-arm64'])('uses code cache only for native builds on %s', (host) => {
    expect(seaCodeCacheEnabled(host, host)).toBe(true);
    expect(seaCodeCacheEnabled('cross-target', host)).toBe(false);
  });

  it('defaults to the actual build host', () => {
    expect(seaCodeCacheEnabled(`${process.platform}-${process.arch}`)).toBe(true);
  });

  it('preserves the local daemon heap limit and release environment override policy', () => {
    expect(seaExecArgv('local')).toEqual(['--max-old-space-size=8192']);
    expect(seaExecArgv('release')).toEqual([]);
  });
});
