import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { seaCodeCacheEnabled, seaExecArgv } from '../../scripts/native/02-sea-blob.mjs';
import { checkBundle } from '../../scripts/native/check-bundle.mjs';

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

describe('SEA bundle dependency check', () => {
  let dir: string;
  let bundle: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kiki-bundle-check-'));
    bundle = join(dir, 'main.cjs');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('allows Discord optional compression probes and existing optional native requires', () => {
    writeFileSync(bundle, `
try { require('zlib-sync'); } catch {}
const getZlibSync = () => import('zlib-sync').then(mod => mod.default).catch(() => null);
require('bufferutil');
require('utf-8-validate');
require('node:zlib');
`);
    expect(checkBundle(bundle)).toEqual([]);
  });

  it.each([
    ["require('example-required-package');", 'external require remains: example-required-package'],
    ["try { require('example-required-package'); } catch {}", 'external require remains: example-required-package'],
    ["import('example-required-package').catch(() => null);", 'external dynamic import remains: example-required-package'],
    ["import dependency from 'example-required-package';", 'external import remains: example-required-package'],
    ["import 'example-required-package';", 'external import remains: example-required-package'],
    ["require('zlib-sync/unknown');", 'external require remains: zlib-sync/unknown'],
    ["require('./missing.cjs');", 'relative require remains: ./missing.cjs'],
  ])('still rejects an unbundled dependency in %s', (source, error) => {
    writeFileSync(bundle, source);
    expect(checkBundle(bundle)).toEqual([error]);
  });

  it('does not allow optional main-bundle dependencies in self-contained workers', () => {
    writeFileSync(bundle, "try { require('zlib-sync'); } catch {}\nimport('zlib-sync').catch(() => null);\n");
    expect(checkBundle(bundle, { worker: true })).toEqual([
      'external require remains: zlib-sync',
      'external dynamic import remains: zlib-sync',
    ]);
  });
});
