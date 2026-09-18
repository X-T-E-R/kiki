---
name: kiki-ops.docs
description: Answer Kiki product questions from the local documentation installed with Kiki — CLI and GUI usage, configuration, slash commands, features, and error behavior. Use when the user asks how Kiki works, how to configure it, or what Kiki reports mean.
---

# Check Kiki docs (kiki-ops.docs)

Answer Kiki product questions from the documentation installed with the running Kiki version, not from memory or an upstream product website. This skill covers Kiki CLI, Kiki for VS Code, configuration, slash commands, tools, sessions, features, and error behavior; it is not for developing the Kiki repository itself.

## Local source of truth

The installed documentation root is `<KIKI_HOME>/docs/`. `KIKI_HOME` is the configured Kiki home directory and defaults to `~/.kiki`. It contains mirrored `en/` and `zh/` Markdown trees.

Choose the locale that matches the user's configured or interface language. If that locale or page is absent, fall back to `en/`. Use `Glob` to locate candidate Markdown files and `Read` to read the relevant pages before answering. Do not use `FetchURL` for Kiki product behavior.

## Page map

| Topic | Local section |
| --- | --- |
| Product overview and entry points | `{locale}/index.md` |
| Installation, migration, use cases, interaction, sessions, goals, IDE and desktop usage, server/runtime behavior | `{locale}/guides/` |
| MCP, skills, plugins, data sources, agents, hooks, and themes | `{locale}/customization/` |
| `config.toml`, providers, overrides, environment variables, and data locations | `{locale}/configuration/` |
| `kiki` and CLI commands, tools, slash commands, keyboard shortcuts, ACP, server API, and error responses | `{locale}/reference/` |
| Version history | `{locale}/release-notes/changelog.md` |

Start with the most specific mapped page. When a question spans features, read the relevant pages from each section rather than inferring missing details.

## Provider boundary

Kiki supports multiple providers. Provider-platform account facts such as memberships, quota, billing, plan eligibility, and API key console behavior belong to that provider's own documentation or console and are not covered by the Kiki product docs. State that boundary and direct the user to the selected provider's official account surface when needed.

Never fetch `kimi.com` or other upstream Kimi Code product documentation to explain Kiki behavior. Kiki is an independent fork, and upstream behavior may differ. Provider-specific endpoints or authentication facts may be taken from Kiki's local provider configuration pages when those pages explicitly document them.

## How to answer

1. Resolve the local docs root and locale, falling back to `en/` when necessary.
2. Read the relevant local Markdown page or pages before answering.
3. Answer only what those installed pages establish and cite the local relative paths used.
4. If the installed documentation does not cover a claim, say plainly that the local Kiki docs do not specify it. Never invent configuration keys, command names, model IDs, error meanings, or product behavior.
