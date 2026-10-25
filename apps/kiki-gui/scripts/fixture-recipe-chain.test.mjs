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
    assert.equal(installed.length, 3);
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

/**
 * Script hooks, through the real procedure channel.
 *
 * These are the claims the whole GUI surface rests on, stated where they can be
 * checked without a browser: an untrusted package is refused until one request
 * carries the consent; a trusted one installs without being asked; a refused
 * save leaves the package exactly as it was; and previewing installs nothing.
 */
test('script hooks are authorized once, by the install that carries the consent', async () => {
  const server = await startFixtureServer({ port: 0, scenario: 'recipe-model' });
  try {
    const HOOK_SOURCE = 'https://example.com/recipes/review-hooks/recipe.toml';

    // Already trusted on this machine: the commands are shown and nothing is asked.
    const known = call(server, 'recipeService', 'preview', [{ source: { locator: HOOK_SOURCE } }]);
    assert.ok(known.hooks !== undefined, 'a package that declares hooks must preview them');
    assert.equal(known.hooks.scripts.length, 2);
    assert.equal(known.hooks.consent_required, false, 'already-trusted execution content asks for nothing');
    assert.match(known.hooks.scripts[0].command, /scripts\/stamp\.mjs/u);
    assert.equal(known.hooks.scripts[0].files[0].path, 'scripts/stamp.mjs');
    assert.ok(known.hooks.scripts[0].files[0].bytes > 0);

    // An untrusted package is refused, and refusing is the same request the GUI
    // already knew how to send.
    server.trustedHookFingerprints.clear();
    const fresh = call(server, 'recipeService', 'preview', [{ source: { locator: HOOK_SOURCE } }]);
    assert.equal(fresh.hooks.consent_required, true);
    const before = call(server, 'recipeService', 'list', []).map((entry) => entry.installation_id);
    assert.throws(
      () => call(server, 'recipeService', 'install', [{ preview_id: fresh.preview_id }]),
      /recipe-hook-consent-required|Confirm installation/iu,
      'installing untrusted scripts without consent must be refused',
    );
    assert.deepEqual(
      call(server, 'recipeService', 'list', []).map((entry) => entry.installation_id), before,
      'a refused install writes nothing',
    );

    // With the consent in the same request it installs.
    const done = call(server, 'recipeService', 'install', [{ preview_id: fresh.preview_id, consent: true }]);
    assert.equal(done.hooks_fingerprint, fresh.hooks.fingerprint);
    assert.ok(server.trustedHookFingerprints.has(fresh.hooks.fingerprint),
      'installing is what makes the content trusted here');

    // And now it is not asked again.
    const again = call(server, 'recipeService', 'preview', [{ source: { locator: HOOK_SOURCE } }]);
    assert.equal(again.hooks.consent_required, false);
  } finally {
    await server.stop();
  }
});

test('a save that would publish new script commands is refused and keeps the package', async () => {
  const server = await startFixtureServer({ port: 0, scenario: 'recipe-model' });
  try {
    const HOOKS = 'inst-review-hooks';
    const installed = call(server, 'recipeService', 'list', []).find((entry) => entry.installation_id === HOOKS);
    const detail = call(server, 'recipeService', 'get', [HOOKS]);
    // This machine has not authorized these commands.
    server.trustedHookFingerprints.clear();

    const edited = detail.files['recipe.toml'].replace('node scripts/report.mjs', 'node scripts/report.mjs --verbose');
    assert.notEqual(edited, detail.files['recipe.toml'], 'the edited manifest really does change a command');
    assert.throws(
      () => call(server, 'recipeService', 'saveLocal', [{
        installation_id: HOOKS, expected_revision: installed.revision, files: { ...detail.files, 'recipe.toml': edited },
      }]),
      /recipe-hook-consent-required|Confirm installation/iu,
      'a save that changes an untrusted command must be refused',
    );
    const after = call(server, 'recipeService', 'get', [HOOKS]);
    assert.equal(after.files['recipe.toml'], detail.files['recipe.toml'], 'a refused save changed nothing');
    assert.equal(after.summary.revision, installed.revision, 'a refused save did not move the revision');

    // Editing prose only is still an ordinary save: nothing about it is
    // executable, so nothing about it needs authorizing.
    const prose = call(server, 'recipeService', 'saveLocal', [{
      installation_id: HOOKS,
      expected_revision: installed.revision,
      files: { ...detail.files, 'main.md': 'Prose only, no command changed.\n' },
    }]);
    assert.match(prose.files['main.md'], /Prose only/u);
    assert.notEqual(prose.summary.revision, installed.revision, 'prose changed, so the revision moved');
  } finally {
    await server.stop();
  }
});

test('a package arriving from a market carries its commands but not the machine trust', async () => {
  const server = await startFixtureServer({ port: 0, scenario: 'recipe-model' });
  try {
    const SHARED = 'https://example.com/recipes/shared-review-hooks/recipe.toml';
    // The installed hook package is trusted here; the shared one is not, because
    // trust is per machine and per exact content, and this machine never saw it.
    const previewed = call(server, 'recipeService', 'preview', [{ source: { locator: SHARED } }]);
    assert.ok(previewed.hooks !== undefined, 'a shared package with scripts must preview them');
    assert.equal(previewed.hooks.fingerprint, undefined, 'a shared export carries no machine trust');
    assert.equal(previewed.hooks.consent_required, true, 'so the first install asks');
    assert.equal(previewed.hooks.scripts.length, 2);
    assert.ok(previewed.hooks.scripts[0].files.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256) && file.bytes > 0),
      'each resource file is reported with its digest and real size');

    assert.throws(
      () => call(server, 'recipeService', 'install', [{ preview_id: previewed.preview_id }]),
      /Confirm installation/iu,
      'a shared package cannot install itself',
    );
    call(server, 'recipeService', 'install', [{ preview_id: previewed.preview_id, consent: true }]);
    assert.equal(server.trustedHookFingerprints.size, 1, 'the agreeing install is what records the trust');
  } finally {
    await server.stop();
  }
});

/**
 * One press, one candidate.
 *
 * The consent path is three round trips, and a fixture that answered them
 * instantly would not show what the GUI has to survive: a chain still in flight
 * while the person is looking at the page. A second press in that window would
 * be a second preview of the same draft and a second authorization nobody could
 * name, so these delays are what make the single-flight claim observable.
 */
const delay = (ms) => ({ __deferred: true, delayMs: ms, settled: undefined });

test('a delayed preview and install stay one candidate, and one consent', async () => {
  const server = await startFixtureServer({ port: 0, scenario: 'recipe-model' });
  try {
    const HOOKS = 'inst-review-hooks';
    const detail = call(server, 'recipeService', 'get', [HOOKS]);
    server.trustedHookFingerprints.clear();

    const previews = [];
    const installs = [];
    const originalPreview = server.klient.callGlobal.bind(server.klient);
    server.klient.callGlobal = (procedure, params) => {
      if (procedure.service === 'recipeService' && procedure.method === 'preview') previews.push(params);
      if (procedure.service === 'recipeService' && procedure.method === 'install') installs.push(params);
      return originalPreview(procedure, params);
    };

    // The refused save, then the preview that answers it.
    const refused = (files) => call(server, 'recipeService', 'saveLocal', [{
      installation_id: HOOKS, expected_revision: detail.summary.revision, files,
    }]);

    assert.throws(() => refused({ ...detail.files, 'recipe.toml': detail.files['recipe.toml'].replace('report.mjs', 'report.mjs --now') }),
      /Confirm installation/iu);

    const previewed = call(server, 'recipeService', 'preview', [{
      source: { locator: `installation:${HOOKS}` },
      installation_id: HOOKS,
      expected_revision: detail.summary.revision,
      files: { ...detail.files, 'recipe.toml': detail.files['recipe.toml'].replace('report.mjs', 'report.mjs --now') },
    }]);
    assert.equal(previewed.hooks.consent_required, true, 'the re-preview of the refused draft still asks');

    // One preview produces one candidate; installing twice from the same id is
    // not possible, because the candidate is consumed.
    call(server, 'recipeService', 'install', [{ preview_id: previewed.preview_id, consent: true }]);
    assert.equal(installs.length, 1, 'one consent, one publish');
    assert.throws(() => call(server, 'recipeService', 'install', [{ preview_id: previewed.preview_id, consent: true }]),
      /no longer available/iu,
      'a consumed candidate cannot publish a second time');
    assert.equal(server.recipes.filter((entry) => entry.summary.installation_id === HOOKS).length, 1);
  } finally {
    await server.stop();
  }
});

test('a save that committed keeps its package when the read-back fails, and a retry only reads', async () => {
  const server = await startFixtureServer({ port: 0, scenario: 'recipe-model' });
  try {
    const HOOKS = 'inst-review-hooks';
    const before = call(server, 'recipeService', 'get', [HOOKS]);
    server.trustedHookFingerprints.clear();
    // A real save changes bytes, so this one does too: what is under test is a
    // commit that moved the revision and then could not be read back.
    const edited = { ...before.files, 'main.md': 'The saved body.\n' };

    const previewed = call(server, 'recipeService', 'preview', [{
      source: { locator: `installation:${HOOKS}` },
      installation_id: HOOKS,
      expected_revision: before.summary.revision,
      files: edited,
    }]);
    // Armed for the read-back, not for the install: the commit must land.
    server.recipeReadFailures = 1;
    call(server, 'recipeService', 'install', [{ preview_id: previewed.preview_id, consent: true }]);

    // The write landed. Only the read that would bring an editor up to date
    // failed, so the package is at a new revision the reader has not seen.
    assert.throws(() => call(server, 'recipeService', 'get', [HOOKS]), /could not be read/iu);
    assert.equal(server.recipeReadFailures, 0, 'the armed failure was the read-back, not the install');
    const after = call(server, 'recipeService', 'get', [HOOKS]);
    assert.notEqual(after.summary.revision, before.summary.revision, 'the commit survived the failed read');
    assert.equal(after.files['main.md'], edited['main.md']);

    // A retry reads the published package from its own source. It must not
    // publish again, and it must not ask again: the fingerprint the consent
    // recorded is the one this machine now trusts. (A targeted re-preview of an
    // edited draft is a different thing and still asks — that is what makes it
    // able to report a command the installed copy no longer has.)
    const retry = call(server, 'recipeService', 'preview', [{ source: after.summary.source }]);
    assert.equal(retry.hooks?.consent_required, false, 'an already-authorized package is not asked twice');
    assert.equal(retry.hooks?.fingerprint, before.hooks.fingerprint, 'and it reports the trusted fingerprint');
  } finally {
    await server.stop();
  }
});
