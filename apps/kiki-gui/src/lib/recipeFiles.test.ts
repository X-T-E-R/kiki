import { describe, expect, it } from 'vitest';

import {
  RECIPE_MANIFEST,
  RecipeManifestError,
  manifestWouldReformat,
  parseRecipeManifest,
  readDeclaration,
  referencedFiles,
  renderManifest,
  slotBufferTarget,
  writeBranchMode,
  writeCadence,
  writeField,
  writeModel,
  writeSlot,
} from './recipeFiles';
import type { PromptGroupDeclaration } from './recipeFiles';

/** Narrow a branch to its object form; the literals are asserted separately. */
const group = (
  branch: PromptGroupDeclaration | 'same' | 'off' | undefined,
): PromptGroupDeclaration => {
  if (branch === undefined || branch === 'same' || branch === 'off') {
    throw new Error(`expected a prompt group object, got ${String(branch)}`);
  }
  return branch;
};


const TOML = `schema_version = 1
id = "clear-work"
name = "Clear work"
version = "1.0.0"

[prompts]
system = { text = "Ship the result." }
steering = { file = "steer.md" }
system_multi = [{ text = "one" }, { file = "two.md" }]

[prompts.main]
steering = { text = "main steer" }

[prompts.main.fields]
"system.language" = "Use the user's language."
"system.hidden" = false

[prompts.independent]
system = "off"
`;

describe('readDeclaration', () => {
  it('reads each declaration shape the manifest grammar allows', () => {
    const declaration = readDeclaration(parseRecipeManifest(TOML));
    expect(declaration.id).toBe('clear-work');
    expect(declaration.prompts?.system).toEqual({ kind: 'inline', text: 'Ship the result.' });
    expect(declaration.prompts?.steering).toEqual({ kind: 'file', file: 'steer.md' });
    expect(group(declaration.main).steering).toEqual({ kind: 'inline', text: 'main steer' });
  });

  it('ignores a key it does not model rather than inventing a slot for it', () => {
    const manifest = parseRecipeManifest(TOML);
    const declaration = readDeclaration(manifest);
    expect(Object.keys(declaration.prompts ?? {}).toSorted()).toEqual(['steering', 'system']);
    // `fields` is declared on the branch, not on the shared group in this file.
    expect(Object.keys(group(declaration.main).fields ?? {}).toSorted()).toEqual(['system.hidden', 'system.language']);
  });

  it('reads a segment array in order with its boundaries', () => {
    const manifest = parseRecipeManifest(`schema_version = 1
[prompts]
system = [{ text = "one" }, { file = "two.md" }]
`);
    expect(readDeclaration(manifest).prompts?.system).toEqual({
      kind: 'segments',
      parts: [{ kind: 'inline', text: 'one' }, { kind: 'file', file: 'two.md' }],
    });
  });

  it('reads an explicit off as off, and absent as absent', () => {
    const manifest = parseRecipeManifest('schema_version = 1\n[prompts]\nsystem = "off"\n');
    expect(readDeclaration(manifest).prompts?.system).toEqual({ kind: 'off' });
    expect(readDeclaration(parseRecipeManifest('schema_version = 1\n')).prompts?.system).toBeUndefined();
  });

  it('reads a false field as a real declaration, not as missing', () => {
    const declaration = readDeclaration(parseRecipeManifest(TOML));
    expect(group(declaration.main).fields?.['system.hidden']).toBe(false);
    expect(group(declaration.main).fields?.['system.language']).toBe('Use the user\'s language.');
  });

  it('reports a slot that is not a table, an array or off', () => {
    expect(() => readDeclaration(parseRecipeManifest('schema_version = 1\n[prompts]\nsystem = "text"\n')))
      .toThrow(RecipeManifestError);
  });
});

describe('parseRecipeManifest', () => {
  it('reports invalid TOML as a manifest error rather than crashing', () => {
    expect(() => parseRecipeManifest('schema_version = = 1')).toThrow(RecipeManifestError);
  });
});

describe('referencedFiles', () => {
  it('collects every referenced Markdown across all three groups', () => {
    expect(referencedFiles(readDeclaration(parseRecipeManifest(TOML)))).toEqual(['steer.md']);
  });

  it('collects file segments too', () => {
    const manifest = parseRecipeManifest('schema_version = 1\n[prompts]\nsystem = [{ file = "a.md" }, { file = "b.md" }]\n');
    expect(referencedFiles(readDeclaration(manifest))).toEqual(['a.md', 'b.md']);
  });
});

describe('slotBufferTarget', () => {
  it('opens the manifest for inline prose', () => {
    expect(slotBufferTarget({ kind: 'inline', text: 'x' })).toEqual({ file: RECIPE_MANIFEST, inline: true });
  });

  it('opens the named file for a reference', () => {
    expect(slotBufferTarget({ kind: 'file', file: 'steer.md' })).toEqual({ file: 'steer.md', inline: false });
  });

  it('opens the manifest when a segment list mixes inline and file', () => {
    expect(slotBufferTarget({ kind: 'segments', parts: [{ kind: 'file', file: 'a.md' }, { kind: 'inline', text: 'b' }] }))
      .toEqual({ file: RECIPE_MANIFEST, inline: true });
  });
});

describe('writeSlot', () => {
  it('replaces only the slot it was given', () => {
    const next = writeSlot(parseRecipeManifest(TOML), 'prompts', 'system', { kind: 'inline', text: 'New text' });
    const rendered = renderManifest(next);
    expect(rendered).toContain('New text');
    expect(rendered).toContain('steer.md');
  });

  it('preserves an explicit off elsewhere in the file', () => {
    const next = writeSlot(parseRecipeManifest(TOML), 'prompts', 'system', { kind: 'inline', text: 'x' });
    expect(group(readDeclaration(next).independent).system).toEqual({ kind: 'off' });
  });

  it('does not mutate the manifest it was given', () => {
    const original = parseRecipeManifest(TOML);
    const before = JSON.stringify(original);
    writeSlot(original, 'prompts', 'system', { kind: 'inline', text: 'x' });
    expect(JSON.stringify(original)).toBe(before);
  });

  it('preserves a false prompt field through a slot write', () => {
    const next = writeSlot(parseRecipeManifest(TOML), 'prompts', 'system', { kind: 'inline', text: 'x' });
    expect(group(readDeclaration(next).main).fields?.['system.hidden']).toBe(false);
  });

  it('round-trips an inline slot back to the same prose', () => {
    const original = parseRecipeManifest(TOML);
    const written = writeSlot(original, 'main', 'steering', { kind: 'inline', text: 'changed steer' });
    expect(group(readDeclaration(written).main).steering).toEqual({ kind: 'inline', text: 'changed steer' });
  });
});

describe('writeBranchMode', () => {
  it('writes the same/off literals the schema expects', () => {
    expect(readDeclaration(writeBranchMode(parseRecipeManifest(TOML), 'independent', 'off')).independent).toBe('off');
    expect(readDeclaration(writeBranchMode(parseRecipeManifest(TOML), 'independent', 'same')).independent).toBe('same');
  });

  it('writes a custom branch as a table', () => {
    const next = writeBranchMode(parseRecipeManifest(TOML), 'independent', 'custom', { system: { text: 'own' } });
    expect(readDeclaration(next).independent).toMatchObject({ system: { kind: 'inline', text: 'own' } });
  });
});

describe('writeCadence', () => {
  it('writes all three cadence values', () => {
    const next = writeCadence(parseRecipeManifest(TOML), 'prompts', { onTurn: true, onInput: false, intervalSteps: 3 });
    const group = readDeclaration(next).prompts;
    expect([group?.steering_on_turn, group?.steering_on_input, group?.steering_interval_steps]).toEqual([true, false, 3]);
  });

  it('keeps interval 0 rather than dropping it as falsy', () => {
    const next = writeCadence(parseRecipeManifest(TOML), 'prompts', { onTurn: true, onInput: true, intervalSteps: 0 });
    expect(readDeclaration(next).prompts?.steering_interval_steps).toBe(0);
  });
});

describe('writeField and writeModel', () => {
  it('writes a field body', () => {
    const next = writeField(parseRecipeManifest(TOML), 'main', 'system.coding', 'Ship it');
    expect(group(readDeclaration(next).main).fields?.['system.coding']).toBe('Ship it');
  });

  it('writes model off as its own literal, distinct from absent', () => {
    expect(readDeclaration(writeModel(parseRecipeManifest(TOML), 'off')).model).toBe('off');
    expect(readDeclaration(writeModel(parseRecipeManifest(TOML), undefined)).model).toBeUndefined();
  });

  it('keeps a boolean false parameter as a real value', () => {
    const next = writeModel(parseRecipeManifest(TOML), { adaptive_thinking: false, capabilities: [] });
    expect(JSON.stringify(next)).toContain('false');
    expect(JSON.stringify(next)).toContain('[]');
  });
});

describe('manifestWouldReformat', () => {
  it('reports a change when a canonical render differs from the original', () => {
    expect(manifestWouldReformat(TOML, renderManifest(parseRecipeManifest(TOML)))).toBe(true);
  });

  it('reports no change when the bytes already match', () => {
    const canonical = renderManifest(parseRecipeManifest('a = 1\n'));
    expect(manifestWouldReformat(canonical, canonical)).toBe(false);
  });

  it('detects comments the serializer drops', () => {
    expect(manifestWouldReformat('schema_version = 1 # keep me\n', 'schema_version = 1\n')).toBe(true);
  });
});
