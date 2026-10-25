import { describe, expect, it } from 'vitest';

import { parsePluginInstallArgs } from '../../../src/tui/utils/plugin-install-args';

const DIGEST = 'ab'.repeat(32);

describe('parsePluginInstallArgs', () => {
  it('keeps a bare source and a leading trust flag', () => {
    expect(parsePluginInstallArgs('C:\\plugins\\local')).toEqual({ source: 'C:\\plugins\\local', sha256: undefined, trust: false });
    expect(parsePluginInstallArgs('--trust C:\\plugins\\local')).toEqual({ source: 'C:\\plugins\\local', sha256: undefined, trust: true });
    expect(parsePluginInstallArgs('--trust')).toEqual({ source: '', sha256: undefined, trust: true });
  });

  it('accepts a publisher checksum before the source, in either flag order', () => {
    const source = 'https://downloads.example.test/plugin name.zip';
    expect(parsePluginInstallArgs(`--sha256 ${DIGEST.toUpperCase()} ${source}`)).toEqual({ source, sha256: DIGEST, trust: false });
    expect(parsePluginInstallArgs(`--trust --sha256 ${DIGEST} ${source}`)).toEqual({ source, sha256: DIGEST, trust: true });
    expect(parsePluginInstallArgs(`--sha256 ${DIGEST} --trust ${source}`)).toEqual({ source, sha256: DIGEST, trust: true });
  });

  it('rejects a missing or conflicting checksum flag', () => {
    expect(() => parsePluginInstallArgs('--sha256')).toThrow('--sha256');
    expect(() => parsePluginInstallArgs('--sha256 nope https://downloads.example.test/a.zip')).toThrow('--sha256');
    expect(() => parsePluginInstallArgs(`--sha256 ${DIGEST} --sha256 ${'c'.repeat(64)} ./plugin`)).toThrow('--sha256');
  });
});
