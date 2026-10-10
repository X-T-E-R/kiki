# Recipe model presets

Recipes own the selected model's prompt tuning and declared model settings, while preserving the agent role and host authority. The feature is registered in `packages/agent-core-v2/src/app/recipes/configSection.ts` and defaults off. Enable `KIKI_EXPERIMENTAL_RECIPES=true` for development. The package format and SDK workflow live in [Prompt field overrides](../en/customization/prompt-fields.md#recipe-model-presets) and its [Chinese mirror](../zh/customization/prompt-fields.md#recipe-模型配方).

## Sources and validation

`RecipeSourceReader` is the Node filesystem/network adapter; business services never read package files directly. It reuses the plugin source and GitHub ref resolvers, `undici` for bounded downloads, and `yauzl` for in-memory ZIP reading. Packages are data only; no package executable runs.

A local source is an absolute directory or manifest path. Referenced Markdown paths must remain inside its real package root. HTTPS manifests keep referenced files within the same origin and directory subtree across redirects; credentials, fragments and non-public resolved addresses are rejected. HTTPS ZIP sources require a SHA-256 checksum. GitHub sources resolve a commit before downloading. Text is strict UTF-8, limited to 256 KiB per file and 4 MiB per package; archives are limited to 256 entries and reject symlinks and unsafe paths.

`recipeParser.ts` validates manifest version 1 and semantic versions, resolves text sources, and validates each registered writable field through `IPromptFieldRegistry`. Do not maintain a Recipe-specific prompt-field allowlist. Cadence validation is shared with cognition through protocol `modelSteeringCadenceSchema`.

`recipeModelSettings.ts` derives the allowed tuning schema from `ModelRecordSchema` and converts through `modelsFromToml`/`modelsToToml`. Provider, protocol, connection credentials, model identity/routing, request identity, pricing identity, beta routing, old cognition/prompt overrides and recursive Recipe/alias overrides are excluded. The actual model schema remains authoritative: parameters and behavior stay shared-only; usage keeps its existing main/independent branches. New tuning fields should enter through that schema rather than a second settings parser.

## Merge and accepted revisions

A manifest has at most one parent. Its dependency chain is bounded to 16 packages and rejects cycles. Prompt text sources and source arrays replace atomically. Fields merge by id with `false` as an inherited-field tombstone. Model objects merge by declared leaf; arrays replace atomically, while `model = "off"` removes all inherited Recipe model settings. Position-specific prompt objects are whole-branch selections: main and independent do not silently fill from common; `same` explicitly selects common and `off` disables the branch. Sub always selects common.

The App-scoped `IRecipeService` stores accepted snapshots through `IAtomicDocumentStore` and content through `IBlobStore`. Each revision hashes the complete manifest, source identity, files, merged declaration, dependency locks and resolved result. Reads verify the immutable digest before binding. Parent file content retains the parent's source, even when a child contains a same-named file.

Preview keeps a bounded in-memory candidate for 15 minutes. Install consumes that exact candidate and does not download again. Publishing a new revision is a compare-and-swap of the installation pointer after every source and dependency has passed validation. A failed update records `last_error` but leaves the entire old revision active. `follow` checks daily after startup; `pinned` does not advance automatically. Manual `checkUpdates` discovers without accepting. Explicit rollback accepts only revisions already in that installation's history.

A `copy` fork materializes the resolved text, fields, cadence and model settings into an independent local package. An `extend` fork retains a single parent source, including a supplied ZIP checksum; a pinned parent's revision locks its complete result. `saveLocal` requires the current `expected_revision`. Uninstall refuses selected model references unless `disable_models` is explicit, retains immutable snapshots, and never deletes an author's original directory.

Markets are configured in `[recipes]` as `markets`. There is no built-in official catalog URL. Catalog success is cached for 15 minutes, failure for 60 seconds; the last persisted catalog can be displayed offline. A changed market URL does not reuse another URL's persisted catalog.

## Model selection and runtime binding

The shared protocol is `packages/protocol/src/recipe.ts`; klient exposes `global.recipes`, and KAP exposes `/api/recipes` and `/api/recipe-markets`. Apply through `global.kosong.updateModel(id, { recipe: installation_id, base_revision })`, not a separate settings API. Clear with `recipe: null`. Selection validates the installation before mutating the model record, and stale model revisions fail without overwriting other edits.

Model entity `parameters` and `usage` remain the saved manual record. `effective_parameters`/`parameter_sources` and `usage_effective`/`usage_sources` report actual composition. `recipe_model_binding` carries `{ installation_id, revision, model, model_origins }`; mark a source as Recipe only if its leaf actually wins the existing model-resolution trace. An unavailable installation yields a model issue so editing can recover, while execution refuses an invalid new binding.

Profile binding resolves one accepted Recipe snapshot for prompt assembly and model settings together. The requester, media/tool selection, context budgets and question-frequency guard use the frozen settings through the existing catalog pipeline. Old model cognition and per-model prompt tuning are retained but ignored, including their missing files; role/persona/room/workspace/host context, top-level role behavior, tools and hard model/effort constraints retain their normal authority. Declared Recipe model settings supersede saved manual tuning; omitted leaves keep ordinary resolution.

Bound profile snapshots persist Recipe text, parameters, cadence and provenance. Cold resume does not reread current Recipe sources. Rebuild adopts the current accepted revision; switching models reassembles the real role and the target model inputs, and switching away restores ordinary manual tuning. Preparation restores temporary cognition and diagnostics on failure. Recipe anchors replace only the Recipe-owned model text and keep outer persona, room, delegation and shared/host additions.

Agent prompt diagnostics expose the running binding's `recipe_model_binding`, which can differ from the model editor's current installation revision. Channel sources record Recipe provenance and shadowed manual tuning. The GUI must distinguish saved values, effective values and running revision rather than infer them from the installation list.

## Verification and integration

- `test/app/recipes/recipes.test.ts` exercises complete inheritance, parent-file origins, array replacement, model-schema reuse, copy/pin/off, corrupt revisions, failed pointer commits, offline resolution and local/network boundaries.
- `test/agent/profile/cognition-binding.test.ts` exercises all positions, preserved role/persona/room, anchors, missing ignored prompt files, real requester options, cold recovery, rebuild and model switching.
- `packages/kap-server/test/recipes.integration.ts` drives the real server and HTTP klient through preview/install, model CAS, local customization, accepted updates, failed updates and disabling.

Regenerate core config/state manifests when the source schemas or bound state change. The steering provider owns injection triggers and cadence counting; Recipe only validates, merges, binds and freezes its parameters. Integrate changes to the shared cognition schema semantically rather than replacing another owner's file. GUI presentation and visual acceptance are a separate consumer of these contracts.
