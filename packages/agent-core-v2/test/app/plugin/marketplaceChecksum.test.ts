import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readBundledPluginCatalog } from '#/app/plugin/defaultCatalog';
import { catalogSha256ForSource, isMarketplaceEntryInstallable } from '#/app/plugin/marketplace';

const ZIP = 'https://github.com/X-T-E-R/kiki-plugins/releases/download/plugins-cloudflare-20261010.1/kiki-cloudflare-0.1.1.zip';
const DIGEST = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);

describe('catalog ZIP checksum binding', () => {
  it('binds one agreed digest and refuses a conflict or an unknown archive', () => {
    const plugins = [
      { source: ` ${ZIP} `, sha256: DIGEST.toUpperCase() },
      { source: ZIP, sha256: DIGEST },
      { source: 'https://downloads.example.test/other.zip', sha256: 'not-a-digest' },
    ];
    expect(catalogSha256ForSource(plugins, ZIP)).toBe(DIGEST);
    expect(catalogSha256ForSource(plugins, `${ZIP}\n`)).toBe(DIGEST);
    expect(catalogSha256ForSource([...plugins, { source: ZIP, sha256: OTHER }], ZIP)).toBeUndefined();
    expect(catalogSha256ForSource(plugins, 'https://downloads.example.test/unknown.zip')).toBeUndefined();
    expect(catalogSha256ForSource(plugins, '')).toBeUndefined();
  });

  it('marks a release ZIP installable only when the catalog publishes a digest', () => {
    const local = resolve('/plugins/local');
    expect(isMarketplaceEntryInstallable({ source: 'https://github.com/X-T-E-R/example', sha256: undefined })).toBe(true);
    expect(isMarketplaceEntryInstallable({ source: 'https://github.com/X-T-E-R/example/releases/tag/v1', sha256: undefined })).toBe(true);
    expect(isMarketplaceEntryInstallable({ source: local, sha256: undefined })).toBe(true);
    expect(isMarketplaceEntryInstallable({ source: ZIP, sha256: undefined })).toBe(false);
    expect(isMarketplaceEntryInstallable({ source: ZIP, sha256: 'short' })).toBe(false);
    expect(isMarketplaceEntryInstallable({ source: ZIP, sha256: DIGEST })).toBe(true);
    expect(isMarketplaceEntryInstallable({ source: 'https://cdn.example.test/plugin.zip', sha256: undefined })).toBe(false);
    expect(isMarketplaceEntryInstallable({ source: '', sha256: DIGEST })).toBe(false);
    expect(isMarketplaceEntryInstallable({ source: 'relative/plugin', sha256: DIGEST })).toBe(false);
  });

  it('finds one digest for every bundled official archive', () => {
    const plugins = readBundledPluginCatalog().marketplace.plugins;
    const official = plugins.filter((entry) => entry.tier === 'official');
    expect(official.length).toBeGreaterThan(0);
    for (const entry of official) {
      expect(entry.sha256, entry.id).toMatch(/^[0-9a-f]{64}$/);
      expect(catalogSha256ForSource(plugins, entry.source), entry.id).toBe(entry.sha256);
      expect(isMarketplaceEntryInstallable(entry), entry.id).toBe(true);
    }
  });
});
