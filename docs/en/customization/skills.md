# Agent Skills

A Skill is a Markdown document with YAML frontmatter that describes a piece of knowledge or a workflow — a project's code style, a PR review process, a commit message format. Keeping it in a file rather than pasting it into every prompt means it can be shared across projects and teams, loaded with a slash command, or picked up by the model automatically when it is relevant.

## Custom prompt commands

A command is the same kind of file, loaded only when you explicitly send `/name arguments`. Commands reuse the Skill catalog and parameter expansion, but the model is never offered their descriptions for automatic invocation.

Create `.kiki/commands/brainstorm.md` in your project root:

```markdown
---
description: Discuss possible approaches before choosing one
argument-hint: "<topic>"
---
Discuss several approaches to $ARGUMENTS and explain their trade-offs.
Ask about important missing requirements. Keep this a discussion; do not
create documents or modify files unless I ask you to.
```

In the GUI or terminal, type `/`, pick `brainstorm`, add a topic and send `/brainstorm a simpler settings menu`. Picking the entry only fills the draft; sending loads the body once with your arguments and attachments.

The frontmatter is optional. Without it, the filename supplies the name and the first non-empty body line becomes the menu description. Optional `name`, `description` and `argument-hint` override those; a name cannot contain whitespace, `/`, `\` or `:`. The [body placeholders](#body-placeholders) work here too, and if the body has no argument placeholder the arguments are appended to it. Values inserted as arguments are not expanded again.

Commands live in `commands/*.md` under the active application data directory (user-wide) and `.kiki/commands/*.md` at the project root. Only direct Markdown children count, and a project command wins over a user command of the same name. The legacy `.kimi-code/commands/` tree is not read. Edits are watched — reopen the GUI slash menu or run `/reload` in the terminal to see them.

Built-in shortcuts keep their bare names, so `/plan` still controls Plan mode. A Skill that collides with one is shown as `/skill:plan`, and a command that collides with a Skill as `/command:name`; use the name the menu shows. A command is a user prompt, not a system prompt or a script: it grants no permissions, switches no modes, and cannot run anything. Review command files from an unfamiliar repository before sending them.

## Creating a Skill

Skill files must be placed in a [known scan directory](#skill-locations). Two file structures are supported:

- **Directory form (recommended)**: Create a subdirectory under the Skills directory, name the main file `SKILL.md`, and place scripts, reference materials, and other supporting files in the same directory. When both `<name>/SKILL.md` and a same-named `<name>.md` exist in the same directory, the subdirectory takes precedence.
- **Flat form**: Use a single `.md` file directly; the Skill name is taken from the filename (minus `.md`).

### File Format

`SKILL.md` consists of two parts: YAML frontmatter and a Markdown body:

```markdown
---
name: code-style
description: Project code style guidelines defining naming, indentation, comments, and file organization
type: prompt
whenToUse: When the user asks me to write, modify, or review project source code
disableModelInvocation: false
arguments:
  - target
  - mode
---

Please handle code according to the following guidelines:

- Use 2-space indentation
- Variable names use `camelCase`, type names use `PascalCase`
- Public functions must have TSDoc comments
- Lines must not exceed 100 characters
```

### Frontmatter Fields

| Field | Description |
| --- | --- |
| `name` | Skill name. Required in a directory-form `SKILL.md`; when omitted in a flat `.md` file, the filename is used. Names are case-insensitive |
| `description` | A one-line summary; the model uses this to decide when to use the Skill. Required in a directory-form `SKILL.md`; when omitted in a flat `.md` file, falls back to the first non-empty line of the body (up to 240 characters) |
| `type` | Skill type: `prompt` (default), `inline` (same semantics as `prompt`), `flow` (manual invocation only; not available for automatic model invocation). Other values are skipped |
| `whenToUse` | Description of when the Skill should be triggered. Also accepts `when-to-use` and `when_to_use` |
| `disableModelInvocation` | When set to `true`, prevents the model from invoking this Skill automatically. Also accepts `disable-model-invocation` and `disable_model_invocation` |
| `arguments` | List of named parameters; can be written as a string array or a whitespace-separated string (e.g., `arguments: target mode`). Once declared, parameters can be read in the body with `$<name>` |

::: warning Note
In a directory-form `SKILL.md`, both `name` and `description` **must** be explicitly provided. Omitting either one will cause parsing to fail.
:::

### Body Placeholders

Before the body is sent to the model, a small set of placeholders are expanded:

- `$ARGUMENTS`: The full raw argument string passed at invocation
- `$ARGUMENTS[0]`, `$ARGUMENTS[1]` and shorthand `$0`, `$1`: Positional arguments after whitespace tokenization (zero-indexed)
- `$<name>`: Named parameters declared in `arguments`
- `${KIKI_SKILL_DIR}`: The directory containing the current Skill file

Positional arguments support single and double quoting, so in `/skill:commit "fix login" patch`, `$0` expands to `fix login`. If the body contains no argument placeholders, text passed at invocation is appended to the end of the body as `\n\nARGUMENTS: <text>`.

## Skill Locations

Kiki scans four tiers by scope; more specific scopes take higher priority: **Project > User > Extra > Built-in**

**User level** (applies to all projects):
- `$KIKI_HOME/skills/` (default: `~/.kiki/skills/`)
- `~/.agents/skills/`

The Kiki-specific user Skill directory moves with `KIKI_HOME`, so a relocated data root gets its own copy; the generic `~/.agents/skills/` stays under the real OS home so other tools can share it.

**Project level** (project root = the nearest directory containing `.git`, searching upward from the working directory):
- `.kiki/skills/`
- `.agents/skills/`

**Extra directories**: Declared via `extra_skill_dirs` at the top level of `config.toml`:

```toml
extra_skill_dirs = ["~/team-skills", ".agents/team-skills"]
```

**Built-in Skills** ship with the CLI and have the lowest priority. They cover common setup tasks — configuring MCP servers, customizing the TUI theme, editing config files; [Built-in skill commands](../reference/slash-commands.md#built-in-skill-commands) lists them. Every Skill Kiki ships describes Kiki itself, so the top-level [`builtin_product_skills`](../configuration/config-files.md#top-level-fields) field turns all of them off at once, including `/kiki-ops`. Set it back to `true` to restore them.

## Invoking a Skill

Users can invoke a Skill manually with a slash command:

```text
/skill:code-style
/skill:git-commits fix concurrency issue in login endpoint
```

The model can also invoke a Skill on its own from `description` and `whenToUse`, unless `disableModelInvocation` is `true` or `type` is `flow`. A Skill can invoke another Skill, up to three levels deep.

## Complete Example

```markdown
---
name: review-pr
description: Review a Pull Request according to team standards and produce a structured review report
type: prompt
whenToUse: When the user asks me to review a PR, inspect code changes, or evaluate commit quality
arguments:
  - pr_ref
---

Please review the PR the user specified: $pr_ref

1. Fetch and read the full diff for `$pr_ref`.
2. Check each of the following items:
   - Whether corresponding test cases are included
   - Whether public API documentation has been updated
   - Whether new dependencies have been introduced; if so, state the reason
   - Whether error handling covers edge cases
3. Refer to the checklist in the same directory: `references/checklist.md`
4. Produce a review report containing:
   - Overall conclusion (approve / request changes / comment)
   - Required changes (blocking)
   - Suggested improvements (non-blocking)
   - Noteworthy positives
```

Save this as `$KIKI_HOME/skills/review-pr/SKILL.md` (`~/.kiki/skills/review-pr/SKILL.md` when `KIKI_HOME` is unset), put the checklist at `references/checklist.md` in the same directory, and start a new session. `/skill:review-pr #1234` then expands `#1234` into `$pr_ref`.

## Next steps

- [Plugins](./plugins.md) — Package Skills into installable units to share with your team
- [Agents and sub-agents](./agents.md) — How Skills influence sub-agent behavior
