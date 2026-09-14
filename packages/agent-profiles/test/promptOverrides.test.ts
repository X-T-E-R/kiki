import { describe, expect, it } from 'vitest';

import {
  mergeResolvedPromptOverrides,
  parsePromptOverrideDocument,
  PromptOverridesSchema,
  resolvePromptOverrideLayer,
  validatePromptOverridePath,
} from '#/promptOverrides';

describe('prompt overrides', () => {
  it('accepts file and inline forms while rejecting false and null values', () => {
    expect(PromptOverridesSchema.parse({
      files: ['prompts/base.toml'],
      fields: { 'system.language': 'English' },
    })).toEqual({
      files: ['prompts/base.toml'],
      fields: { 'system.language': 'English' },
    });
    expect(() => PromptOverridesSchema.parse({ fields: { 'system.language': false } })).toThrow();
    expect(() => PromptOverridesSchema.parse({ fields: { 'system.language': null } })).toThrow();
  });

  it('merges files in declaration order, then inline fields, and keeps the source chain', () => {
    const layer = resolvePromptOverrideLayer({
      surface: 'profile',
      files: [
        {
          ref: 'first.toml',
          document: { schema_version: 1, fields: { 'system.language': 'first', 'system.coding': 'coding' } },
          lines: { 'system.language': 4 },
        },
        {
          ref: 'second.toml',
          document: { schema_version: 1, fields: { 'system.language': 'second' } },
          lines: { 'system.language': 3 },
        },
      ],
      inline: { 'system.language': 'inline' },
      inlinePath: '/agents/example.md',
    });

    expect(layer.values).toEqual({
      'system.language': 'inline',
      'system.coding': 'coding',
    });
    expect(layer.sources['system.language']).toEqual([
      { surface: 'profile', kind: 'file', path: 'first.toml', fileIndex: 0, line: 4 },
      { surface: 'profile', kind: 'file', path: 'second.toml', fileIndex: 1, line: 3 },
      { surface: 'profile', kind: 'inline', path: '/agents/example.md', line: undefined },
    ]);
  });

  it('merges scope layers from low to high while preserving overwritten provenance', () => {
    const global = resolvePromptOverrideLayer({
      surface: 'global',
      inline: { 'system.language': 'global' },
    });
    const model = resolvePromptOverrideLayer({
      surface: 'model',
      inline: { 'system.language': 'model' },
    });
    const profileModel = resolvePromptOverrideLayer({
      surface: 'profile-model',
      inline: { 'system.language': 'profile-model' },
    });

    const merged = mergeResolvedPromptOverrides(global, model, profileModel);
    expect(merged.values['system.language']).toBe('profile-model');
    expect(merged.sources['system.language']?.map((source) => source.surface)).toEqual([
      'global',
      'model',
      'profile-model',
    ]);
  });

  it('rejects absolute and traversal paths', () => {
    expect(validatePromptOverridePath('prompts/fields.toml')).toBe('prompts/fields.toml');
    for (const ref of ['/tmp/fields.toml', 'C:\\temp\\fields.toml', '../fields.toml', 'a/../fields.toml']) {
      expect(() => validatePromptOverridePath(ref)).toThrow();
    }
  });

  it('validates the closed external document and records field lines', () => {
    const text = 'schema_version = 1\n\n[fields]\n"system.language" = "English"\n';
    expect(parsePromptOverrideDocument({
      schema_version: 1,
      fields: { 'system.language': 'English' },
    }, { path: 'fields.toml', text })).toEqual({
      document: { schema_version: 1, fields: { 'system.language': 'English' } },
      lines: { 'system.language': 4 },
    });
    expect(() => parsePromptOverrideDocument({ schema_version: 2, fields: {} }, { path: 'fields.toml' })).toThrow(/schema_version/);
    expect(() => parsePromptOverrideDocument({ schema_version: 1, fields: {}, files: [] }, { path: 'fields.toml' })).toThrow();
  });

  it('uses registry policy metadata to reject disallowed empty strings', () => {
    expect(() => resolvePromptOverrideLayer({
      surface: 'global',
      inline: { 'system.language': '' },
      fieldPolicy: () => ({ allowEmpty: false }),
    })).toThrow(/does not allow an empty/);
    expect(resolvePromptOverrideLayer({
      surface: 'global',
      inline: { 'system.shared': '' },
      fieldPolicy: () => ({ allowEmpty: true }),
    }).values['system.shared']).toBe('');
  });
});
