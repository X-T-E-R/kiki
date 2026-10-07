import { describe, expect, it } from 'vitest';

import { recipeSummarySchema, recipeValueOriginSchema, resolvedRecipeSchema, type RecipeSummary } from '@kiki/protocol';

import {
  recipeBranchIsEmpty,
  recipeFileNames,
  recipeKeptManualPromptCount,
  recipeIsSelectable,
  recipeLocatorLabel,
  recipeNeedsAttention,
  recipeOriginFor,
  recipeRevisionShort,
} from './recipes';

/**
 * Fixtures are parsed through the shared schemas rather than annotated with
 * hand-written types. A hand-written copy is a second DTO: it drifts the first
 * time the contract grows a field, and it drifts silently.
 */
const summary = (over: Record<string, unknown> = {}): RecipeSummary => recipeSummarySchema.parse({
  installation_id: 'inst-1',
  manifest_id: 'clear-work',
  name: 'Clear work',
  version: '1.0.0',
  revision: 'sha256:0123456789abcdef0123',
  source: { locator: 'https://example.com/recipes/clear-work/recipe.toml' },
  update_mode: 'follow',
  health: 'ready',
  ...over,
});

const resolved = (over: Record<string, unknown> = {}) => resolvedRecipeSchema.parse({
  revision: 'sha256:0123456789abcdef0123',
  branches: {
    main: { fields: {} },
    sub: { fields: {} },
    independent: { fields: {} },
  },
  dependencies: [],
  origins: [],
  ...over,
});

const origin = (over: Record<string, unknown> = {}) => recipeValueOriginSchema.parse({
  position: 'main',
  slot: 'system',
  source: 'https://example.com/recipe.toml',
  manifest_id: 'clear-work',
  version: '1.0.0',
  ...over,
});

describe('recipeRevisionShort', () => {
  it('drops the digest prefix and truncates to 12 characters', () => {
    expect(recipeRevisionShort('sha256:0123456789abcdef0123')).toBe('0123456789ab');
  });

  it('leaves a short revision alone', () => {
    expect(recipeRevisionShort('abc')).toBe('abc');
  });
});

describe('recipeIsSelectable', () => {
  it('keeps a package selectable when a failed update left the old copy usable', () => {
    expect(recipeIsSelectable(summary({ health: 'ready', last_error: { code: 'x', message: 'boom' } }))).toBe(true);
  });

  it('refuses one the server reports as unavailable', () => {
    expect(recipeIsSelectable(summary({ health: 'unavailable' }))).toBe(false);
  });
});

describe('recipeNeedsAttention', () => {
  it('is false for a healthy, current package', () => {
    expect(recipeNeedsAttention(summary())).toBe(false);
  });

  it('is true when an update is waiting', () => {
    expect(recipeNeedsAttention(summary({ update_available: true }))).toBe(true);
  });

  it('is true when the last update check failed', () => {
    expect(recipeNeedsAttention(summary({ last_error: { code: 'x', message: 'boom' } }))).toBe(true);
  });
});

describe('recipeKeptManualPromptCount', () => {
  it('counts only the items a model actually saved', () => {
    expect(recipeKeptManualPromptCount({})).toBe(0);
    expect(recipeKeptManualPromptCount({ cognition: {}, prompt_overrides: undefined })).toBe(0);
  });

  it('counts a saved cognition and a saved override table', () => {
    expect(recipeKeptManualPromptCount({
      cognition: { overlay: 'a.md' },
      prompt_overrides: { files: ['b.md'] },
    })).toBe(2);
  });
});

describe('recipeOriginFor', () => {
  it('finds the provenance recorded for one slot of one branch', () => {
    const value = resolved({ origins: [origin({ file: 'main.md' })] });
    expect(recipeOriginFor(value, 'main', 'system')?.file).toBe('main.md');
  });

  it('does not leak one branch origin into another branch', () => {
    const value = resolved({ origins: [origin()] });
    expect(recipeOriginFor(value, 'sub', 'system')).toBeUndefined();
  });

  it('keeps every origin of one slot rather than only the first', () => {
    const value = resolved({ origins: [origin({ file: 'a.md' }), origin({ file: 'b.md' })] });
    expect(value.origins.filter((entry) => entry.position === 'main' && entry.slot === 'system')).toHaveLength(2);
  });
});

describe('recipeBranchIsEmpty', () => {
  it('treats an off branch as empty rather than as blank content', () => {
    expect(recipeBranchIsEmpty({ fields: {} })).toBe(true);
  });

  it('is false as soon as a slot or field carries something', () => {
    expect(recipeBranchIsEmpty({ system: 'x', fields: {} })).toBe(false);
    expect(recipeBranchIsEmpty({ fields: { 'system.language': 'en' } })).toBe(false);
  });
});

describe('recipeFileNames', () => {
  it('lists the manifest last so it reads as the anchor', () => {
    expect(recipeFileNames({ 'recipe.toml': '', 'main.md': '', 'steering.md': '' }))
      .toEqual(['main.md', 'steering.md', 'recipe.toml']);
  });

  it('copes with a package that has no manifest', () => {
    expect(recipeFileNames({ 'b.md': '', 'a.md': '' })).toEqual(['a.md', 'b.md']);
  });
});

describe('recipeLocatorLabel', () => {
  it('shows the tail of a URL rather than the whole address', () => {
    expect(recipeLocatorLabel('https://example.com/recipes/clear-work/recipe.toml')).toBe('recipe.toml');
  });

  it('keeps a managed installation locator intact', () => {
    expect(recipeLocatorLabel('installation:inst-1')).toBe('installation:inst-1');
  });
});
