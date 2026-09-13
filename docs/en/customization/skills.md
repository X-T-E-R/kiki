# Agent Skills

Agent Skills are a lightweight mechanism for extending model capabilities in Kiki. A Skill is a Markdown document with YAML frontmatter that describes a specialized area of knowledge or a workflow — for example, a project's code style guidelines, a PR review process, or a commit message format.

Compared to pasting the same instructions into a prompt every time, Skills offer the advantage of keeping content in a file, enabling reuse across projects and teams, allowing instant loading via a slash command, and letting the model invoke them automatically when needed.

## Custom prompt commands

Use a Markdown command when you want `/name arguments` to load your own prompt only after you explicitly send it. Commands reuse the Skill catalog and parameter expansion, but their descriptions are not offered to the model for automatic Skill invocation.

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

In the GUI or terminal, type `/`, select `brainstorm`, add a topic, then send `/brainstorm a simpler settings menu`. Selecting the entry only fills the draft; sending loads the body once with your arguments and attachments. This is an example, not an installed or mandatory brainstorming workflow.

The YAML frontmatter is optional. Without it, the filename supplies the name and the first non-empty body line supplies the menu description. Optional `name`, `description`, and `argument-hint` customize those fields; names cannot contain whitespace, `/`, `\\`, or `:`. The [body placeholders](#body-placeholders) also work in commands. If there is no argument placeholder, arguments are appended to the body. Values inserted as arguments are not expanded again.

Command locations are the active application data directory's `commands/*.md` for user-wide commands and `.kiki/commands/*.md` at the project root. Only direct Markdown children are commands. Project commands take precedence over user commands of the same name. The legacy `.kimi-code/commands/` tree is a migration source only; run `kiki migrate-config --workspace <directory>` to copy it into `.kiki/`. Explicit Skill-directory overrides retain their existing replacement behavior. Edits are watched; reopen the GUI slash menu or run `/reload` in the terminal to refresh the menu.

Built-in shortcuts keep their bare names: `/plan` still controls Plan mode. A colliding catalog entry is shown as `/skill:plan`; a command colliding with an existing Skill is shown as `/command:name`. Use the name shown in the menu. Commands are user prompts, not system prompts or executable scripts: they do not grant permissions, switch modes, or turn a flowchart into a workflow engine. Review command files from unfamiliar repositories before sending them.

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
- `${KIMI_SKILL_DIR}`: The directory containing the current Skill file

Positional arguments support single and double quoting, so in `/skill:commit "fix login" patch`, `$0` expands to `fix login`. If the body contains no argument placeholders, text passed at invocation is appended to the end of the body as `\n\nARGUMENTS: <text>`.

## Skill Locations

Kiki scans four tiers by scope; more specific scopes take higher priority: **Project > User > Extra > Built-in**

**User level** (applies to all projects):
- `$KIKI_HOME/skills/` (default: `~/.kiki/skills/`)
- `~/.agents/skills/`

The Kiki-specific user Skill directory moves with `KIKI_HOME`, so isolated data roots also get isolated Kiki-specific Skills. The generic `~/.agents/skills/` directory stays under the real OS home so it can be shared across tools.

**Project level** (project root = the nearest directory containing `.git`, searching upward from the working directory):
- `.kiki/skills/`
- `.agents/skills/`

**Extra directories**: Declared via `extra_skill_dirs` at the top level of `config.toml`:

```toml
extra_skill_dirs = ["~/team-skills", ".agents/team-skills"]
```

**Built-in Skills** are distributed with the CLI and have the lowest priority. They provide out-of-the-box workflows for common tasks — for example, configuring MCP servers, customizing the TUI theme, and editing config files. See [Built-in skill commands](../reference/slash-commands.md#built-in-skill-commands) for the full list. Those describing Kiki Code itself can be turned off with the top-level [`builtin_product_skills`](../configuration/config-files.md#top-level-fields) field.

## Invoking a Skill

Users can invoke a Skill manually with a slash command:

```
/skill:code-style
/skill:git-commits fix concurrency issue in login endpoint
```

The model can also invoke a Skill automatically based on `description` and `whenToUse` (unless `disableModelInvocation` is `true` or `type` is `flow`). Skill invocations allow up to 3 levels of nesting; beyond that they are terminated.

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

Save this as `$KIKI_HOME/skills/review-pr/SKILL.md` (or `~/.kiki/skills/review-pr/SKILL.md` when `KIKI_HOME` is unset), place the checklist at `references/checklist.md` in the same directory, and after starting a new session you can invoke it with `/skill:review-pr #1234`, where `#1234` is expanded into `$pr_ref`.

## Next steps

- [Plugins](./plugins.md) — Package Skills into installable units to share with your team
- [Agents and sub-agents](./agents.md) — How Skills influence sub-agent behavior
