# Recipes

A Recipe packages reusable prompt text, model settings and optional script hooks. Install it once, then select it on a model or [agent profile](./prompt-fields.md#recipe-model-presets). Each binding keeps its own option choices.

## Install and select

In **Settings → Models & agents → [Models → Connections](../guides/settings.md#connections)**, open a model's editor and choose **Choose a Recipe**. You can select an installed package, browse a configured Recipe market, or import a source.

1. Preview the source URL or an absolute path on the server. A local source can be a directory or `recipe.toml` file; an HTTPS ZIP accepts an optional SHA-256 checksum and verifies it when provided.
2. Review the expanded prompts, model settings and any script files. A package with new scripts requires explicit consent to install them.
3. Choose **Install only** to keep the package without changing the model, or **Install and apply** to also save the model binding and its current drafts.
4. For an already installed package, select its options and choose **Apply to model**. Merely reading or selecting a package leaves the saved binding unchanged.

If installation succeeds but applying to the model fails, keep the installation and retry **Apply to model** after correcting the reported problem. **Restore manual settings** removes the model's Recipe reference while retaining its saved manual values and any separate profile Recipe.

## Choose options and inspect the result

An option has an id, a name, an optional description and a boolean default. Options can include or remove text, insert text into a prompt slot, or patch a named Markdown section. The full [option and patch syntax](./prompt-fields.md#option-insertions-and-section-patches) belongs to the package manifest.

Select options on the model or profile that uses the package; `model_profiles[].recipe_options` in an agent file can also override options for that binding when the selected model matches the entry. Omitted choices use the package defaults; two models or two roles can use the same installation with different choices. An option removed by an update produces a diagnostic and is ignored; review the binding's choices before saving again.

To inspect a choice without saving it, use `klient.global.recipes.get(id, values)` or `GET /api/recipes/{id}?recipe_options=<URL-encoded JSON boolean map>`. The response's `resolved.option_values` contains the effective choices, and `resolved.branches` contains the expanded prompt text.

For example, with an already connected [Klient](../server/sdk.md), apply a previewed package to one model:

```ts
const recipes = klient.global.recipes;
const preview = await recipes.preview({ source: { locator: "/path/to/recipe" } });
const installed = await recipes.install({ preview_id: preview.preview_id });
const values = { research: true };
const effective = await recipes.get(installed.installation_id, values);
const model = await klient.global.kosong.readModel("example-model");
await klient.global.kosong.updateModel(model.id, {
  recipe: installed.installation_id,
  recipe_options: values,
  base_revision: model.revision,
});
```

Review `preview.hooks` before installing a package with scripts; pass `consent: true` only after that approval. For several models, read and update each alias with its own `base_revision`. If a model changed in between, refresh that model and retry its save; already successful model saves remain in place.

New bindings freeze the package revision, selected options, expanded text and model settings. An existing or restored conversation keeps that snapshot. Start a new binding or [rebuild the context while idle](./agents-and-subagents.md#rebuilding-a-session-context) to adopt changed options or package content.

## Browse installed packages

**Settings → Models & agents → Recipes** (`/settings/recipes`) manages packages without opening a model. The list shows each package's version, update rule, any failed update, and the models that use it. Open a package to read it (`?recipe=<installation id>`), then choose **Edit this Recipe** (`&view=edit`); a package installed from a source offers **Customize this Recipe**, which copies or extends it first. Nothing on this page binds a model. **Remove** names the models that still use the package and switches them back to their own saved settings. The page also installs from a link or path and manages Recipe markets. In a model's Recipe tab, **Open in the Recipe library** jumps to the bound package.

If a save is refused because the package was saved elsewhere first, the editor keeps your edits and offers **Load the newer version**. Your changed files keep your words, untouched files take the newer copy, and the next save uses the newer revision.

The [Recipe API](../server/rest-api.md#recipes-and-markets) exposes `global.recipes.list()` and `GET /api/recipes`. Each entry includes its installation id, display name, version, accepted revision, source locator, update mode and health. `copied_from` records a fork's source; market entries associate a package with their source URL.

The optional directory fields support model pickers and management lists:

| Field | Meaning |
| --- | --- |
| `used_by` | Current effective model aliases using this installation, including inherited model references; omitted when none use it |
| `options` | Option definitions and defaults from the accepted revision; omitted when none are declared or that revision is unavailable |
| `update_available` | A successful update check found another revision |
| `last_error` | The update or revision-read failure to resolve |

`GET /api/models` and `klient.global.kosong.listModels()` also return each model's `recipe` and explicit `recipe_options`. A `recipe` reference may start with `installation:`; remove that prefix when joining it to the directory's `installation_id`. For a selected-options summary, combine the model's choices with each option's default. An unbound model or a model set to `off` omits both fields.

Directory reads use accepted local snapshots and do not fetch package sources. If a revision cannot be read or validated, its entry remains visible with `health: "unavailable"` and a diagnostic. Repair its installation or remove it; other packages remain usable.

## Update, customize and share

An installed package locks its dependency chain and remains usable offline. **Follow** (`follow`) checks for updates daily and adopts a valid revision when no new script consent is needed. **Pinned** (`pinned`) keeps the accepted revision and is skipped by update checks. An explicit check reports availability without replacing the current revision. Invalid updates retain the complete last accepted package.

Use **Copy and edit** for an independent local package, or **Extend from this** to retain a parent reference. Edit **Prompt words** or **Source files**, then choose **Save Recipe**. Saving the package does not select it on another model. API edits use `expected_revision`; on a conflict, reload before editing again. Inherited installations are read-only in a child space, so copy or extend them there before saving.

Save author drafts before **Download as ZIP**. The export includes accepted inherited content so another home can import it independently. The API returns `{ name, revision, files }`; the caller creates the ZIP from that relative file map. Export does not upload the package.

## Markets and removal

Recipe markets are HTTPS catalogs configured under `recipes.markets`. Each market has an `id`, `name`, `url` and `enabled` choice. Disabling a market keeps installed packages. A failed catalog fetch can return its cached entries with `offline: true`; the diagnostic names the source to repair. Plugin markets and Recipe markets have separate catalogs and installation operations.

Before removing an installation, inspect its `used_by` model aliases. Removal is rejected while those models still reference it, unless you explicitly pass `disable_models: true`; this writes `recipe: "off"` on the affected models and preserves their other settings. Profile references are separate and are not included in `used_by`; switch or remove those references before deleting a package they need. Existing frozen bindings retain their accepted snapshot.
