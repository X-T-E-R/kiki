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

## Desktop settings entry point

In the desktop app, **Settings → Agents → Prompt** edits this section — see [Settings pages](../guides/settings.md#agents). The card starts collapsed.

## Next steps

- [Configuration files: `prompt`](../configuration/config-files.md#prompt) — full field registry, override format, and validation rules
- [`kiki` command reference](../reference/command.md) — command-line flags for the CLI entry
- [Agents and subagents](../customization/agents.md) — agent files and `prompt_overrides` frontmatter
