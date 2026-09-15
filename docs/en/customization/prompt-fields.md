# Prompt field overrides

Prompt field overrides replace named text units in the built-in prompt — the system sections, tool descriptions, and delegation notices — without forking an agent profile. Field values replace; they do not append, prepend, or wrap.

Kiki ships a read-only surface for discovering and validating these fields: `kiki prompt-fields`. The full field registry, override format, precedence, and validation rules are owned by the [Configuration files: `prompt`](../configuration/config-files.md#prompt) reference — this page shows how the pieces fit together.

## What you can override

Useful built-in field ids include `system.language`, `system.reply_style`, `system.coding`, `system.shared`, `tool.web-search.description`, `tool.web-search.guidance`, `delegation.sub.notice`, and `delegation.independent.notice`. System fields replace sections of the built-in prompt; `system.shared` is the only shared outer addition and is appended once when non-empty. A tool `description` replaces its static description; a tool `guidance` is appended under the existing `User-configured guidance:` label.

## Where overrides live

Every override surface uses the same format — optional `files` (strict TOML files relative to the Kiki home) and inline `fields`:

| Surface | Where |
| --- | --- |
| Global | `[prompt.overrides]` in `config.toml` |
| Per model | `[models."<alias>".prompt_overrides]` in `config.toml` |
| Agent or `SYSTEM.md` frontmatter | `prompt_overrides:` in the frontmatter |
| Model profile entry | `model_profiles[].prompt_overrides` in an agent file |

Precedence from low to high follows the table order; a missing key inherits the lower value. The complete format, `${name}` variable substitution rules, and validation failures are documented in [`prompt`](../configuration/config-files.md#prompt).

## Discover and validate with `kiki prompt-fields`

`kiki prompt-fields` is read-only; it does not modify `config.toml`, `SYSTEM.md`, agent profiles, or override files.

```sh
kiki prompt-fields list                       # every registered field with owner, consumers, override policy
kiki prompt-fields show system.language       # default template, empty-value policy, allowed variables
kiki prompt-fields validate --config ./candidate.toml --home ~/.kiki   # validate overrides in a config
kiki prompt-fields explain delegation.sub.notice --agent reviewer --model fast --delegation-position sub
```

`explain` prints a field's `effective`, `shadowed`, or `inactive` status, its effective value, and the complete source chain for the selected context. Select the context with `--agent`, `--model`, `--executor`, and `--delegation-position <main|sub|independent>`; `--config <path>` inspects another config file and `--home <dir>` selects the Kiki home used for `SYSTEM.md`, agent discovery, and relative override files.

The removed `prompt.shared` and `prompt.tools` keys have moved into fields under `[prompt.overrides]`; migrate old entries instead of restoring those keys — see [prompt field precedence](../configuration/overrides.md#prompt-field-precedence).

## Desktop settings entry point

In the desktop GUI, open **Settings → Agents → Prompt** to edit this section — see [Settings pages](../desktop/settings.md#agents). The card is collapsed by default.

## Next steps

- [Configuration files: `prompt`](../configuration/config-files.md#prompt) — full field registry, override format, and validation rules
- [`kiki` command reference](../cli/command.md) — command-line flags for the CLI entry
- [Agents and subagents](../customization/agents.md) — agent files and `prompt_overrides` frontmatter
