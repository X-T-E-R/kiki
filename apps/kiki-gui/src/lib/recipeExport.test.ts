import { describe, expect, it } from 'vitest';

import { zipSync, unzipSync, strFromU8 } from 'fflate';

import { recipeExportZipName, zipRecipeFiles } from './recipeExport';

const read = (files: Record<string, Uint8Array>, name: string): string => {
  const entry = files[name];
  if (entry === undefined) throw new Error(`missing ${name}`);
  return strFromU8(entry);
};

describe('zipRecipeFiles', () => {
  it('packs every package file and reads it back byte for byte', () => {
    const files = { 'recipe.toml': 'schema_version = 1\n', 'main.md': '# Prompt\n\nBody.\n' };
    const zip = zipRecipeFiles(files);
    const out = unzipSync(zip);
    expect(Object.keys(out).toSorted()).toEqual(['main.md', 'recipe.toml']);
    expect(read(out, 'recipe.toml')).toBe(files['recipe.toml']);
    expect(read(out, 'main.md')).toBe(files['main.md']);
  });

  it('keeps a file whose name has a path inside the package', () => {
    const files = { 'recipe.toml': 'a=1', 'docs/prompt.md': 'nested' };
    const out = unzipSync(zipRecipeFiles(files));
    expect(read(out, 'docs/prompt.md')).toBe('nested');
  });
});

describe('recipeExportZipName', () => {
  it('names the archive from the manifest id and version', () => {
    expect(recipeExportZipName({ name: 'clear-work', version: '1.2.0' } as { name: string; version?: string }))
      .toBe('clear-work-1.2.0.zip');
  });

  it('falls back to the export name when the manifest has no version', () => {
    expect(recipeExportZipName({ name: 'clear-work' } as { name: string; version?: string }))
      .toBe('clear-work.zip');
  });

  it('never produces a name the filesystem would refuse', () => {
    expect(recipeExportZipName({ name: 'a/b:c*d' } as { name: string; version?: string }))
      .toBe('a-b-c-d.zip');
  });
});