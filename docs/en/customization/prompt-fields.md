# Prompt field overrides

Prompt field overrides replace named pieces of the built-in prompt — system sections, tool descriptions, delegation notices — without forking a profile. A field value replaces; it does not append, prepend or wrap.

`kiki prompt-fields` is a read-only way to discover and check these fields. The registry, format, precedence and validation rules live in [Configuration files: `prompt`](../configuration/config-files.md#prompt); this page shows how the pieces fit together.

## What you can override

Useful built-in field ids include `system.language`, `system.reply_style`, `system.coding`, `system.shared`, `tool.web-search.description`, `tool.web-search.guidance`, `delegation.sub.notice` and `delegation.independent.notice`. System fields replace sections of the built-in prompt, except `system.shared`, which is the one shared outer addition and is appended once when non-empty. A tool `description` replaces its static description; a tool `guidance` is appended under the existing `User-configured guidance:` label.

Kiki's built-in collaboration guidance works without a Recipe. It asks agents to give one owner a complete outcome, inspect and incorporate returned work before accepting it, and send the inputs a recipient still needs for its next action. Model, route and tool requirements are applied through `AgentRun` parameters and the chosen role rather than repeated in the subagent's instructions. It does not impose a message quota on user-requested discussion. Reply language follows the user or task brief, including an explicit reply-language requirement; internal steering, reminders and quoted documents do not by themselves switch it. Customize this guidance through `system.delegation_brief_hygiene`, `delegation.sub.notice`, or the `description` and `guidance` fields for `tool.agent-run`, `tool.agent-send` and `tool.thread-send`.

These defaults keep existing profile and Recipe overrides, delegation-notice off choices, and role and tool limits intact. A custom replacement profile still controls its own body. External executors receive the text through their selected profile or configured `executor_prompt` composition; [direct external execution](./agents-and-subagents.md#direct-external-execution) without those additions stays bare.

## Where overrides live

Every override surface uses the same format — optional `files` (strict TOML files relative to the Kiki home) and inline `fields`:

| Surface | Where |
| --- | --- |
| Global | `[prompt.overrides]` in `config.toml` |
| Per model | `[models."<alias>".prompt_overrides]` in `config.toml` |
| Model Recipe | `prompts.fields` in the model's selected Recipe |
| Profile Recipe | `prompts.fields` in the profile's selected Recipe |
| Agent or `SYSTEM.md` frontmatter | `prompt_overrides:` in the frontmatter |
| Model profile entry | `model_profiles[].prompt_overrides` in an agent file |

Precedence from low to high follows the table order; a missing key inherits the lower value. The complete format, `${name}` variable substitution rules, and validation failures are documented in [`prompt`](../configuration/config-files.md#prompt).

An existing agent keeps its bound prompt fields, custom variables and cognition text when it resumes, even if their source files have changed or been deleted. Edits apply to new bindings; choose [Rebuild context](./agents-and-subagents.md#rebuilding-a-session-context) to adopt them in an existing session. An explicit model change selects the target model's prompt inputs; `new_window` alone does not reload prompt sources. Current tool permissions and hard model constraints still apply.

Older records reuse their saved system prompt and recover inline fields from the saved profile where possible. If a record never saved a required shared field, tool override, steering cue or anchor and its original inputs cannot be reconstructed, recovery names the missing inputs. Rebuild the context to use current sources rather than rolling back your installed prompts.

## Discover and validate with `kiki prompt-fields`

`kiki prompt-fields` is read-only; it does not modify `config.toml`, `SYSTEM.md`, agent profiles, or override files.

```sh
kiki prompt-fields list                       # every registered field with owner, consumers, override policy
kiki prompt-fields show system.language       # default template, empty-value policy, allowed variables
kiki prompt-fields validate --config ./candidate.toml --home ~/.kiki   # validate overrides in a config
kiki prompt-fields explain delegation.sub.notice --agent reviewer --model fast --delegation-position sub
```

`explain` prints a field's `effective`, `shadowed` or `inactive` status, its effective value, and the whole source chain for the context you select with `--agent`, `--model`, `--executor` and `--delegation-position <main|sub|independent>`. `--config <path>` inspects another config file, and `--home <dir>` picks the Kiki home used for `SYSTEM.md`, agent discovery and relative override files.

If your config still carries the old `prompt.shared` and `prompt.tools` keys, move those entries into fields under `[prompt.overrides]` rather than restoring the keys — see [prompt field precedence](../configuration/overrides.md#prompt-field-precedence).

## Recipe model presets

A Recipe packages reusable model tuning and selectable prompt text: prompt fields, system/steering/anchor text, and model settings. Recipes are enabled by default. Use the [model editor](../guides/settings.md#models-and-recipes) or `global.recipes` in the [client SDK](../server/sdk.md). An explicit `KIKI_EXPERIMENTAL_RECIPES=false` or `[experimental] recipes = false` on the server keeps them disabled; remove that override to use the default.

Create an absolute-path package directory containing `recipe.toml`. Prompt files must be Markdown paths inside that directory:

```toml
schema_version = 1
id = "example"
name = "Example"
version = "1.0.0"

[options.research]
name = "Research guidance"
description = "Include source-checking guidance"
default = true

[model.parameters]
temperature = 0.35

[prompts]
system = { text = "Cite sources when making factual claims.", when = "research" }
steering = { text = "Keep the current goal in focus." }
steering_on_turn = true
steering_on_input = true
steering_interval_steps = 0

[prompts.fields]
"system.reply_style" = "Answer concisely and directly."
```

An `[options.<id>]` table requires `name` and boolean `default`; `description` is optional. Option ids use the same regular expression as Recipe ids: `^[a-z0-9][a-z0-9._-]*$`.

A source in `system`, `steering`, `anchor.content`, or the `custom.steering` source under `steering_sources.<source>` may be one `{ text = "..." }` or `{ file = "..." }`, or an array of those sources. Each source may use either `when = "<option-id>"` or `unless = "<option-id>"`, but not both. A gate that names an undeclared option is an error, and `off` cannot be gated. Filtering every source leaves the declared slot empty; an `extends` child does not fall back to the parent for that slot.

`prompts.fields` accepts every registered, writable prompt field and uses its normal variable and empty-value validation. Options affect prompt text only; they do not affect model settings, hooks, permissions or fields. `model` uses the existing [per-model configuration](../configuration/config-files.md#models) syntax and validation for tuning settings, including parameters, usage budgets and behavior. It cannot change provider routing, credentials, request identity or permissions. Parameters and behavior remain shared across agent positions; existing main/independent usage budgets retain their separate meanings.

A package may also carry [script hooks](./hooks.md#recipe-script-hooks). Inspect `preview.hooks` and obtain the user's explicit installation consent before sending `consent: true` for a script-bearing package; never set it automatically from `consent_required`. The hook-free example below needs no script confirmation.

To install and select a local package with an already connected client:

```ts
const preview = await klient.global.recipes.preview({ source: { locator: "/absolute/path/to/example" } });
const installed = await klient.global.recipes.install({ preview_id: preview.preview_id });
const model = await klient.global.kosong.readModel("example-model");
await klient.global.kosong.updateModel("example-model", {
  recipe: installed.installation_id,
  base_revision: model.revision,
});
```

A model's `recipe` can also reference a local file or package directory, such as `./focus/recipe.toml`. Relative paths resolve from the configuration that declares the reference: an inherited reference stays relative to the base home's configuration, while a local override resolves from the current configuration directory. Absolute paths keep their original meaning.

A profile can reference the same installed package, or a local Recipe file, without changing the global model. Add `recipe: installation:<installed-id>` (or just the installation id) to its Markdown frontmatter; the id is returned by `install`. A local file or package directory also works: `recipe: ./focus/recipe.toml`, or an absolute path. A profile's relative path resolves from the profile file and is read at bind time.

Select text options with `recipe_options = { research = true }` for the model's Recipe, or with `recipe_options:` in profile frontmatter for the profile's Recipe. Each layer applies its selections only to that layer's Recipe package. An omitted selection uses the option's `default`; an unknown selected id leaves text unchanged and reports a configuration diagnostic. In the GUI, the existing model editor and the existing profile editor for a profile with a declared Recipe show these options as checkboxes.

Inspect effective option values without changing a binding with `GET /api/recipes/{id}?recipe_options=<URL-encoded JSON boolean map>` in REST or `klient.global.recipes.get(id, values)` in the klient API.

The file is not installed, and binding does not download a URL. Save through the existing profile Markdown editor or edit the profile file. Script hooks in a directly referenced file still require the existing installation consent; `hooks = "off"` contributes no scripts.

```markdown
---
name: reviewer
description: Review changes
model_alias: example-model
recipe: installation:YOUR_INSTALLED_ID
recipe_options:
  research: true
request_params:
  temperature: 0.2
---
Review the changes and report actionable findings.
```

A child space reads installed Recipes from its base home by default; a local entry takes precedence when the installation IDs match. Inherited packages are read-only: use **Copy** or **Extend** before editing them in the child space. Disabling configuration inheritance with `inherit.config = false` does not remove access to those packages, so an inherited profile can still resolve its installed Recipe. Package updates and removals in the child space write only to that space.

Recipes contribute only their declared values. Model settings resolve from the saved model, then the model Recipe, local model `overrides`, the profile Recipe, explicit profile parameters, and matching `model_profiles` parameters. Context and output caps still take the smallest applicable limit. Prompt fields resolve from global, saved model fields, model Recipe fields, profile Recipe fields, profile fields, then matching profile-model or caller-lease fields. Uncovered cognition slots and ordinary model-profile prompt text continue to apply; the role, persona, workspace instructions, host context and permissions keep their existing authority.

Set `recipe: off` on a model or profile to disable that layer's Recipe, including an inherited model selection. For model API updates, pass the current `base_revision`; `recipe: null` clears the local selection instead. Saved manual values and the other layer's Recipe remain intact. New bindings freeze each referenced package revision, selected option values, expanded text and effective model settings, including inherited parameters; option values and patch content are part of the revision, so the result is reproducible.

Existing bindings and cold restores keep that snapshot. To adopt changed option values, rebuild the context or create a new binding; hot reload alone does not change an existing binding immediately.

### Inherit or customize

A package can declare one parent with `extends = { source = "https://example.com/presets/recipe.toml" }` before its tables. Missing slots inherit; each text source or source array replaces its parent atomically. Model settings merge by declared leaf, and arrays replace as a whole. Root `model = "off"` clears inherited Recipe settings and returns to saved model settings. A prompt slot such as `steering = "off"` removes that package's inherited slot; a field value of `false` removes that inherited Recipe field. Other model or profile layers can still supply a value. Before evaluating any `when` or `unless`, option definitions merge by id. A child definition with the same id replaces the parent's complete definition, including `name`, `default`, `description`, `prepend`, `append` and `patch`; parent gates are evaluated against the merged option table. Option order after `extends` is parent options first, followed by new child ids; an override keeps the parent's position.

`prompts` is the common branch used by subagents. A `[prompts.main]` or `[prompts.independent]` table selects a whole position-specific branch; it does not implicitly fill missing slots from common. Set `main = "same"` or `independent = "same"` inside `[prompts]` to explicitly use common, or use `"off"` to disable the whole branch. Text slots accept `{ text = "..." }`, `{ file = "prompt.md" }`, or an array of those sources. An anchor uses `{ content = { text = "..." }, steps = 1, scope = "session" }`; `scope` also accepts `"turn"`.

Steering cadence belongs to the selected branch; an omitted key retains the lower layer's value. The ordinary steering body and cadence apply to direct user input and, by default, verified completed subagent-task receipts. Explicit `steering_sources.task.mode = "off"` disables that inheritance; ordinary process results, failed children and other non-user sources still require their own source setting. With no declaration, `steering_on_turn` and `steering_on_input` default to `true`, while `steering_interval_steps` defaults to `0` (no periodic injection). A positive interval counts this agent's model steps driven by that source, not seconds or tool calls; off sources stay off after compaction too.

Use `steering_sources` in that same branch to enable another source: `mode = "inherit"` follows the final user body and cadence at binding, while `mode = "custom"` uses its own `custom` body and cadence. Sources and custom fields merge by declared leaf across parent, model and profile Recipe layers, then freeze with the binding; changing user settings does not rewrite existing sessions. Source keys and defaults are listed under [Model cognition](../configuration/config-files.md#model-cognition). For example:

```toml
[prompts.steering_sources.thread]
mode = "inherit"

[prompts.steering_sources.task]
mode = "custom"
custom = { steering = { file = "task-cue.md" }, steering_interval_steps = 2 }
```

A custom Recipe body accepts the normal text/file/array forms or `"off"`; the latter suppresses lower-layer custom text. Off and inherit modes keep any saved custom draft.

### Option insertions and section patches

Options can add prompt text without replacing a declared slot. The option-level `prepend` and `append` forms are whole-slot shorthands: they insert before or after the entire slot, so a prepend can appear before a heading rather than targeting a section body. For example:

```toml
[options.citations]
name = "Citations"
default = false
append.main.steering = { text = "Cite sources" }
prepend.common.system = { file = "preface.md" }
```

`prepend` and `append` use `common`, `main` or `independent` branches. Their slots are `system`, `steering`, `anchor` (the anchor's `content`) and `steering_sources.<source>` (the custom steering body). Each insertion slot accepts one `{ text = "..." }` or `{ file = "..." }`, or an array of those sources. After inheritance is merged, each insertion expands to a source gated by `when = "<option-id>"` and is inserted before or after the actual declared slot; a single declared source is treated as an array before insertion.

For section-aware edits, add patch entries to an option:

```toml
[options.cite]
name = "Citations"
default = false

[[options.cite.patch]]
slot = "main.system"
section = "Sources"
action = "append"
content = { text = "Cite sources." }
```

`slot` uses the same `branch.slot` syntax as `prepend` and `append`; `section` is optional. Without `section`, only `action = "prepend"` or `action = "append"` is allowed, and the entry becomes a `when = "<option-id>"` source. With `section`, Kiki first gates and concatenates the complete slot text, then applies enabled options' patches in option declaration order and each option's patch-array order. Only enabled options apply.

A section matches heading text exactly at any heading level and runs from that heading to before the next heading at the same or a higher level. Lines beginning with `#` inside a fenced code block are not headings. Section-level `prepend` and `append` add content at the section body head or tail; `before` and `after` insert content before or after the whole section; `replace` replaces the whole section and requires content with its own heading; `remove` deletes the whole section and cannot have content. Every action except `remove` requires `content`, and inserted blocks are separated by a blank line. Unedited text is preserved byte-for-byte, including the trailing newline when the final section is untouched.

After `extends` is merged, the target slot must be declared and must not be `off`; an invalid slot key, missing or disabled target, or `content` carrying `when` or `unless` is an error. If an enabled patch cannot find its section or finds it more than once, evaluation fails with the option id and section in the diagnostic. Insertions cannot use `when` or `unless` themselves.

`global.recipes.fork` creates either an independent `copy` or an `extend` child; `saveLocal` edits the resulting local package with an `expected_revision` guard. Installed packages lock the complete dependency chain and work offline. `follow` checks updates daily; `pinned` keeps the accepted revision. Invalid updates leave the whole last accepted revision active. HTTPS ZIP sources require `sha256`; an inherited ZIP source can supply it in `extends`. Preview and install accept the same inspected snapshot, with no second source download at install time.

To share a local customization, save any draft first, then call `global.recipes.export(installation_id)`. It returns `{ name, revision, files }`: a suggested ZIP filename, the accepted source revision, and a relative file map. ZIP the files client-side; inherited text, model settings and cadence are materialized without a parent installation reference, so another Kiki home can preview and install the package independently. Export does not create an installation, change a model, modify source files or upload anything. Importing the package creates its own revision; the export's `revision` identifies what was accepted in the sender's home.

## Desktop settings entry point

In the desktop app, **Settings → Agents → Prompt fields** edits this section — see [Settings pages](../guides/settings.md#agents). The card starts collapsed.

## Next steps

- [Configuration files: `prompt`](../configuration/config-files.md#prompt) — full field registry, override format, and validation rules
- [`kiki` command reference](../reference/command.md) — command-line flags for the CLI entry
- [Agents and subagents](../customization/agents-and-subagents.md) — agent files and `prompt_overrides` frontmatter
