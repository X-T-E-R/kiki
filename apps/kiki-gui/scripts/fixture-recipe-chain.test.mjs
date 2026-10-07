/**
 * The Recipe chains, end to end through the real procedure channel.
 *
 * These are the assertions a green component test cannot make: that browsing a
 * package writes nothing, that forking does not bind, that a failed update keeps
 * the accepted copy usable, and — the one that keeps getting broken — that
 * binding or detaching a Recipe leaves everything the Recipe does not declare
 * exactly as the person saved it.
 *
 * Every request goes through `callGlobal`, so a schema the GUI relies on but the
 * fixture does not answer fails here rather than in a screenshot.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { tsImport } from 'tsx/esm/api';

import { startFixtureServer } from './fixture-server.mjs';

// The production wire validators, so a rule this proof asserts is the rule the
// real facade enforces rather than one the fixture happens to implement.
const { patchModelRequestSchema } = await tsImport('../../../packages/protocol/src/modelCatalog.ts', import.meta.url);

const MODEL = 'example/kimi-k2';
const CLEAR_WORK = 'inst-clear-work';

const call = (server, service, method, params) => server.klient.callGlobal({ scope: 'core', service, method }, params);
const readModel = (server) => call(server, 'modelCatalogMutation', 'readModel', [MODEL]);
const updateModel = (server, patch) => call(server, 'modelCatalogMutation', 'updateModel', [MODEL, patch]);

/** `cognition` is a whole-object write point, so the caller spreads the stored object. */
const saveSlot = (model, slot, text) => ({
  cognition: text === undefined
    ? Object.fromEntries(Object.entries(model.cognition).filter(([key]) => key !== slot))
    : { ...model.cognition, [slot]: { text } },
});

test('a Recipe package is browsed, forked and exported without touching the model', async () => {
  const server = await startFixtureServer({ port: 0, scenario: 'recipe-model' });
  try {
    const installed = call(server, 'recipeService', 'list', []);
    assert.equal(installed.length, 2);
    // A package that cannot be updated stays selectable and says why, instead of
    // disappearing or being presented as broken.
    const stale = installed.find((entry) => entry.installation_id === 'inst-review-only');
    assert.equal(stale.update_mode, 'pinned');
    assert.ok(stale.last_error !== undefined, 'a failed update must report its reason');
    assert.equal(stale.health, 'ready', 'a failed update keeps the accepted copy usable');

    const detail = call(server, 'recipeService', 'get', [CLEAR_WORK]);
    assert.deepEqual(detail.used_by, [MODEL]);
    assert.equal(detail.resolved.model.temperature, 0.2);
    assert.equal(detail.resolved.branches.main.steering_on_turn, true);
    // `off` is this layer contributing nothing, not inheriting the text above it.
    assert.equal(detail.resolved.branches.independent.system, undefined);

    const before = call(server, 'recipeService', 'list', []).map((entry) => entry.installation_id);
    call(server, 'recipeService', 'preview', [{ source: { locator: 'https://example.com/recipes/clear-work/recipe.toml' } }]);
    assert.deepEqual(
      call(server, 'recipeService', 'list', []).map((entry) => entry.installation_id), before,
      'browsing a package installed nothing',
    );

    const forked = call(server, 'recipeService', 'fork', [{
      installation_id: CLEAR_WORK, mode: 'extend', id: 'clear-work-local', name: 'Clear work (extended)',
    }]);
    assert.notEqual(forked.summary.installation_id, CLEAR_WORK);
    assert.equal(forked.resolved.dependencies.length, 1, 'an extend keeps the parent chain visible');
    assert.equal(readModel(server).recipe, CLEAR_WORK, 'forking must not bind the model');

    const copied = call(server, 'recipeService', 'fork', [{
      installation_id: CLEAR_WORK, mode: 'copy', id: 'clear-work-copy', name: 'Clear work (copy)',
    }]);
    assert.equal(copied.resolved.dependencies.length, 0, 'a copy is self-contained');

    const saved = call(server, 'recipeService', 'saveLocal', [{
      installation_id: forked.summary.installation_id,
      expected_revision: forked.summary.revision,
      files: { 'recipe.toml': 'schema_version = 1\n', 'main.md': 'Edited body.\n' },
    }]);
    assert.notEqual(saved.summary.revision, forked.summary.revision);
    assert.equal(saved.editable, true);
    assert.equal(readModel(server).recipe, CLEAR_WORK, 'saving a package must not bind the model');

    const exported = call(server, 'recipeService', 'export', [forked.summary.installation_id]);
    assert.equal(exported.name, 'clear-work-local-1.2.0');
    assert.match(exported.files['main.md'], /Edited body/);

    call(server, 'recipeService', 'remove', [{ installation_id: copied.summary.installation_id }]);
    assert.ok(!call(server, 'recipeService', 'list', []).some((entry) => entry.installation_id === copied.summary.installation_id));
  } finally {
    await server.stop();
  }
});

test('a Recipe reference on a model is bound and detached through one model commit', async () => {
  const server = await startFixtureServer({ port: 0, scenario: 'recipe-model' });
  try {
    const seeded = readModel(server);
    const bound = updateModel(server, { base_revision: seeded.revision, recipe: CLEAR_WORK });
    assert.equal(bound.recipe, CLEAR_WORK);
    // The binding carries the resolved snapshot, so the page can show what the
    // package contributes and where each value came from.
    assert.equal(bound.recipe_model_binding.model.temperature, 0.2);
    assert.equal(bound.recipe_model_binding.model_origins.temperature.manifest_id, 'clear-work');
    assert.deepEqual(
      bound.recipe_model_binding.references.map((reference) => reference.surface), ['model'],
    );

    const detached = updateModel(server, { base_revision: bound.revision, recipe: null });
    assert.equal(detached.recipe, undefined);
    assert.equal(detached.recipe_model_binding, undefined, 'the snapshot goes with the reference');
    assert.equal(detached.display_name, 'Kimi K2', 'detaching a package is not a reset of the model');

    assert.throws(
      () => updateModel(server, { base_revision: detached.revision, recipe: 'inst-does-not-exist' }),
      /not_installed|invalid/u,
      'binding a package that is not installed must be refused',
    );
    assert.equal(readModel(server).recipe, undefined);
  } finally {
    await server.stop();
  }
});

test('a manual prompt body is read from its file and only converted when saved', async () => {
  const server = await startFixtureServer({ port: 0, scenario: 'recipe-model' });
  try {
    const seeded = readModel(server);
    const common = seeded.cognition_bodies.branches.common;
    // The shared level still points at author files: the editor shows the whole
    // source and never pretends it can write those files.
    assert.equal(common.slots.overlay.source, 'files');
    assert.match(common.slots.overlay.files[0].text, /Legacy overlay file/);
    assert.equal(common.slots.overlay.source_read_only, true);
    // `writable` means "can be edited into a body stored on the model".
    assert.equal(common.slots.overlay.writable, true);
    // An identity with no declaration of its own says so rather than guessing.
    assert.equal(seeded.cognition_bodies.branches.independent.selection, 'off');
    assert.equal(seeded.cognition_bodies.branches.main.source_scope, 'main');

    assert.equal(readModel(server).cognition_bodies.branches.common.slots.overlay.source, 'files',
      'reading is not a conversion');

    const saved = updateModel(server, { base_revision: seeded.revision, ...saveSlot(seeded, 'anchor', 'An anchor body.') });
    assert.equal(saved.cognition_bodies.branches.common.slots.anchor.source, 'inline');
    assert.equal(saved.cognition_bodies.branches.common.slots.anchor.text, 'An anchor body.');
    assert.equal(saved.cognition_bodies.branches.common.slots.overlay.source, 'files',
      'saving one slot must not rewrite an unrelated author reference');

    // An explicit empty body is a declaration, not an absence.
    const emptied = updateModel(server, { base_revision: saved.revision, cognition: { ...saved.cognition, anchor: { text: '' } } });
    assert.equal(emptied.cognition_bodies.branches.common.slots.anchor.source, 'inline');
    assert.equal(emptied.cognition_bodies.branches.common.slots.anchor.text, '');

    // The revision requirement is a wire rule, so it is asserted against the
    // schema the real facade validates with rather than against the fixture.
    const withoutRevision = patchModelRequestSchema.safeParse(saveSlot(seeded, 'anchor', 'No revision.'));
    assert.equal(withoutRevision.success, false, 'a prompt write must carry the revision the read reported');
    assert.match(
      withoutRevision.error.issues.map((issue) => issue.message).join(' '), /base_revision/u,
    );
    assert.equal(readModel(server).cognition_bodies.branches.common.slots.anchor.text, '');

    assert.throws(
      () => updateModel(server, { base_revision: seeded.revision, display_name: 'Stale write' }),
      /revision_conflict/iu,
      'a stale revision must conflict rather than overwrite',
    );
    assert.equal(readModel(server).display_name, 'Kimi K2');
  } finally {
    await server.stop();
  }
});

test('binding or detaching a Recipe never touches a body the package does not declare', async () => {
  const server = await startFixtureServer({ port: 0, scenario: 'recipe-model' });
  try {
    const seeded = readModel(server);
    const withBody = updateModel(server, { base_revision: seeded.revision, ...saveSlot(seeded, 'anchor', 'Mine, saved on the model.') });

    const bound = updateModel(server, { base_revision: withBody.revision, recipe: CLEAR_WORK });
    assert.equal(bound.cognition_bodies.branches.common.slots.anchor.text, 'Mine, saved on the model.');

    const detached = updateModel(server, { base_revision: bound.revision, recipe: null });
    assert.equal(detached.cognition_bodies.branches.common.slots.anchor.text, 'Mine, saved on the model.',
      'detaching a package must not clear what the person saved');
    assert.equal(detached.cognition_bodies.branches.common.slots.overlay.source, 'files',
      'detaching a package must not convert an author reference');
  } finally {
    await server.stop();
  }
});
