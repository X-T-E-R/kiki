import { describe, expect, it } from 'vitest';
import { relevantPlugins } from '#/app/plugin/relevance';
import type { PluginMarketplaceEntry } from '#/app/plugin/marketplace';

const catalog: PluginMarketplaceEntry[] = [
  { id: 'office', displayName: 'Office', source: 'local', tier: 'official', relevance: { fileGlobs: ['**/*.docx'] } },
  { id: 'vercel', displayName: 'Vercel', source: 'remote', tier: 'curated', relevance: { dependencies: ['next'] } },
  { id: 'unreviewed', displayName: 'Unreviewed', source: 'remote', relevance: { fileGlobs: ['**/*.docx'] } },
];

describe('local plugin relevance', () => {
  it('matches official or curated signals only; never installs plugins', () => {
    expect(relevantPlugins(catalog, { files: ['draft.DOCX'], dependencies: ['next'], commands: [] }, new Set(), new Set())
      .map((item) => item.id)).toEqual(['office', 'vercel']);
  });
  it('suppresses installed and dismissed entries', () => {
    expect(relevantPlugins(catalog, { files: ['draft.docx'], dependencies: ['next'], commands: [] },
      new Set(['office']), new Set(['vercel']))).toEqual([]);
  });
});
