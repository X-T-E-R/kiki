# Prompt field overrides

Prompt field overrides replace named pieces of the built-in prompt — system sections, tool descriptions, delegation notices — without forking a profile. A field value replaces; it does not append, prepend or wrap.

`kiki prompt-fields` is a read-only way to discover and check these fields. The registry, format, precedence and validation rules live in [Configuration files: `prompt`](../configuration/config-files.md#prompt); this page shows how the pieces fit together.

## What you can override

Useful built-in field ids include `system.language`, `system.reply_style`, `system.coding`, `system.shared`, `tool.web-search.description`, `tool.web-search.guidance`, `delegation.sub.notice` and `delegation.independent.notice`. System fields replace sections of the built-in prompt, except `system.shared`, which is the one shared outer addition and is appended once when non-empty. A tool `description` replaces its static description; a tool `guidance` is appended under the existing `User-configured guidance:` label.

## Where overrides live

Every override surface uses the same format — optional `files` (strict TOML files relative to the Kiki home) and inline `fields`:

| Surface | Where |
| --- | --- |
| Global | `[prompt.overrides]` in `config.toml` |
| Per model | `[models."<alias>".prompt_overrides]` in `config.toml` |
| Agent or `SYSTEM.md` frontmatter | `prompt_overrides:` in the frontmatter |
| Model profile entry | `model_profiles[].prompt_overrides` in an agent file |

Precedence from low to high follows the table order; a missing key inherits the lower value. The complete format, `${name}` variable substitution rules, and validation failures are documented in [`prompt`](../configuration/config-files.md#prompt).

An existing agent keeps its bound prompt fields, custom variables and cognition text when it resumes, even if their source files have changed or been deleted. Edits apply to new bindings; choose [Rebuild context](./agents.md#rebuilding-a-session-context) to adopt them in an existing session. An explicit model change selects the target model's prompt inputs; `new_window` alone does not reload prompt sources. Current tool permissions and hard model constraints still apply.

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

A Recipe packages model tuning into one reusable preset: prompt fields, system/steering/anchor text, and model settings. Recipes are experimental and default off; enable `KIKI_EXPERIMENTAL_RECIPES=true` in the server environment before using `global.recipes` in the [client SDK](../server/sdk.md).

Create an absolute-path package directory containing `recipe.toml`. Prompt files must be Markdown paths inside that directory:

```toml
schema_version = 1
id = "example"
name = "Example"
version = "1.0.0"

[model.parameters]
temperature = 0.35

[prompts]
steering = { text = "Keep the current goal in focus." }
steering_on_turn = true
steering_on_input = true
steering_interval_steps = 0

[prompts.fields]
"system.reply_style" = "Answer concisely and directly."
```

`prompts.fields` accepts every registered, writable prompt field and uses its normal variable and empty-value validation. `model` uses the existing [per-model configuration](../configuration/config-files.md#models) syntax and validation for tuning settings, including parameters, usage budgets and behavior. It cannot change provider routing, credentials, request identity or permissions. Parameters and behavior remain shared across agent positions; existing main/independent usage budgets retain their separate meanings.

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

Selecting a Recipe replaces the model prompt-tuning surface, not the agent's role, persona, workspace instructions or host context. Previously saved model prompts are retained but ignored while the Recipe is selected. Declared model setting leaves override saved tuning values; undeclared settings retain ordinary resolution. Set `recipe: null` with the current `base_revision` to stop using it and restore saved manual settings. New bindings adopt the selection; existing sessions keep their frozen Recipe revision until a context rebuild or explicit model change.

### Inherit or customize

A package can declare one parent with `extends = { source = "https://example.com/presets/recipe.toml" }` before its tables. Missing slots inherit; each text source or source array replaces its parent atomically. Model settings merge by declared leaf, and arrays replace as a whole. Root `model = "off"` clears inherited Recipe settings and returns to saved model settings. A prompt slot such as `steering = "off"` disables it without restoring the old manual model prompt; a field value of `false` removes that inherited Recipe field.

`prompts` is the common branch used by subagents. A `[prompts.main]` or `[prompts.independent]` table selects a whole position-specific branch; it does not implicitly fill missing slots from common. Set `main = "same"` or `independent = "same"` inside `[prompts]` to explicitly use common, or use `"off"` to disable the whole branch. Text slots accept `{ text = "..." }`, `{ file = "prompt.md" }`, or an array of those sources. An anchor uses `{ content = { text = "..." }, steps = 1, scope = "session" }`; `scope` also accepts `"turn"`.

Steering cadence belongs to the selected branch: `steering_on_turn` defaults to `true` for new turns and rearming after compaction, `steering_on_input` defaults to `true` for materialized human input, and `steering_interval_steps` defaults to `0` (no additional periodic injection). A positive interval counts this agent's actual model loop steps since the last injection, not seconds or tool calls.

`global.recipes.fork` creates either an independent `copy` or an `extend` child; `saveLocal` edits the resulting local package with an `expected_revision` guard. Installed packages lock the complete dependency chain and work offline. `follow` checks updates daily; `pinned` keeps the accepted revision. Invalid updates leave the whole last accepted revision active. HTTPS ZIP sources require `sha256`; an inherited ZIP source can supply it in `extends`. Preview and install accept the same inspected snapshot, with no second source download at install time.

## Desktop settings entry point

In the desktop app, **Settings → Agents → Prompt** edits this section — see [Settings pages](../guides/settings.md#agents). The card starts collapsed.

## Next steps

- [Configuration files: `prompt`](../configuration/config-files.md#prompt) — full field registry, override format, and validation rules
- [`kiki` command reference](../reference/command.md) — command-line flags for the CLI entry
- [Agents and subagents](../customization/agents.md) — agent files and `prompt_overrides` frontmatter
