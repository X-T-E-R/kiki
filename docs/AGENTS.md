# Documentation Agent Guide

This repository uses VitePress for the documentation site. Most user-facing pages under `docs/en/` and `docs/zh/` are fully written; New or updated content should keep both locales in sync.

## Structure

- Locales live under `docs/en/` and `docs/zh/` with mirrored paths and filenames.
- Main sections (nav + sidebar) are:
  - Getting Started (`getting-started/`): installation, first-launch, desktop-app, use-cases, and Migration group (migration, model-vocabulary)
  - Guides (`guides/`): Desktop app group (interface, sessions, settings), CLI & TUI group (interaction, goals)
  - Customization (`customization/`): agents, prompt-fields, skills, plugins, hooks, themes
  - Server & Integration (`server/`): Usage group (local-server, ide, acp), Protocol & SDK group (rest-api, mcp, sdk), Internals group (architecture, cross-host-session-boundaries)
  - Configuration (`configuration/`): config-files, providers, overrides, env-vars, data-locations
  - Reference (`reference/`): command (`kiki` command), slash-commands, keyboard, tools, and Release Notes group (changelog)
- Navigation, sidebar, and URL rewrites are defined in `docs/.vitepress/config.ts`. Any new, moved, or renamed page must be wired there for both locales.

## Source of truth

- **Changelog page**: The English version (`docs/en/release-notes/changelog.md`) is the source of truth; the Chinese changelog should be translated from it. The changelog is currently generated manually by a skill that syncs from the CLI package's `CHANGELOG.md` after each release.
- **All other pages**: `docs/en/` and `docs/zh/` are mirrored pairs with the same paths, headings, and section structure. Edit whichever locale you are working in, then update the other locale through the catch-up process before the applicable boundary below.

Keep both locales in sync before release. Machine-assisted translation is fine; review the locale you changed and its mirror for accuracy, terminology, and broken links.

## Documentation lifecycle

Documentation follows implementation instead of blocking exploration and early coding:

1. Implement and test the behavior. Code and its claim-matched tests remain the source of truth for current behavior.
2. When the implementation forms a coherent candidate, classify its documentation impact:
   - **None** is exclusive and means no generated, maintainer, or user-facing contract changed.
   - Otherwise select every affected category: **Generated** for checked-in projections, **Maintainer** for owners, extension seams, recovery procedures, verification, or stable internal contracts, and **User** for supported behavior, configuration, commands, compatibility, migration, or other reader decisions.
3. Record completion separately as **Completed** or **Deferred**. `None` pairs with `Completed`; it cannot be deferred. Generated impact is never deferrable: every affected projection is regenerated and verified in the same candidate that changes its source. Each deferred maintainer or user view retains every applicable impact category and its exact path or heading, one accountable owner, and a target no later than its earliest applicable boundary:
   - Maintainer documentation is current before stable reuse by another owner or an owner handoff.
   - User documentation is current in both locales before a feature becomes default-on or is publicly released.
   A view serving both audiences uses whichever boundary arrives first. A calendar date or vague "later" is not a target boundary. When a candidate has both generated impact and deferred prose, complete the generated work now and defer only the named maintainer or user views.
4. Use `.agents/skills/kiki-docs-catchup/SKILL.md` for a coherent candidate or an explicit documentation-debt task. The skill records claims and evidence before it selects or edits views.
5. Keep release ownership distinct:
   - Release changelog curation remains a post-release task owned by `.agents/skills/sync-changelog/SKILL.md`; do not use it as the pre-release user-documentation gate.

Classification is a small, observable routing decision, not a prose-completeness gate. Preserve every affected category and view even when their deadlines differ. Structural checks can detect mirror, navigation, link, and required-resource drift, but they do not establish semantic correctness.

Canonical knowledge may live in this monorepo. Keep one fact home for each contract and link audience-specific views back to it instead of copying package facts into a portal or several guides. [`MAINTAINERS.md`](../MAINTAINERS.md) routes maintainers to the current owners, generated contracts, skills, and catch-up process; it is outside the VitePress source tree and is not a public docs page.

## Authoring workflow

- Each page should keep the section ordering established by surrounding pages. Changelog is the exception because it is generated from release history.
- For other pages: edit either locale, then update its mirror before the applicable default-on or public-release boundary. A coherent early implementation candidate may defer named user views under the lifecycle above without losing their `user` impact classification.

Before rewriting a page, always: (1) understand why the original is structured the way it is, (2) identify what the reader genuinely needs to know, (3) sketch the section structure, then (4) fill in the content. Skip step 1–3 and you will lose content while rearranging format.

## Readers

Kiki documentation serves two overlapping audiences. Write for both simultaneously.

**Technical users** — familiar with the terminal, config files, API keys, and environment variables. Give them commands and paths directly; do not explain basics.

**Non-technical AI users** — product managers, designers, operators — who use AI tools but are unfamiliar with terms like "stdin", "exit code", or "regex". They primarily interact through VS Code or config files rather than writing scripts.

Both groups share the same behavior: they arrive with a specific goal, scan headings and first sentences before reading further, execute steps in order, and copy-paste code blocks directly. They abandon pages when they hit unexplained jargon.

**Writing targets:**
- Technical users: complete a task in under 5 minutes, no filler.
- Non-technical users: copy-paste their way to a working setup and roughly understand what it does, without needing to understand the underlying mechanics.

**Jargon rule:** On first use, add a plain-English gloss in parentheses. Use the term normally afterwards.

> Example: `stdin` (the channel a program reads input from), `exit code` (the status number a program returns when it finishes; 0 means success).

## Naming conventions

- Filenames are kebab-case and mirror across locales (same slug in `docs/en/` and `docs/zh/`).
- Use consistent section labels that match the sidebar titles.
- Use backticks for flags, commands, subcommands, command arguments, file paths, code identifiers, type names, field names, field values, and keyboard shortcuts.

## Wording conventions

- Do not change H1 titles or nav/sidebar labels.
- English H2+ headings use sentence case (only the first word capitalized unless it is a proper noun). Treat "Wire", "Plan mode", "YOLO mode", and "Thinking mode" as proper nouns; do not treat "agent" as a proper noun.
- Chinese H2+ headings keep English words in sentence case; preserve proper nouns listed in the term table below.
- Use `API key` in English and `API 密钥` in Chinese; keep `JSON`, `JSONL`, `OAuth`, `macOS`, `Node.js`, `npm`, `pnpm`, and `TypeScript` as-is.
- Use straight double quotes with spaces for quoted content: `"被引内容"` (not curly quotes). Add a space before and after the quoted text when adjacent to CJK characters. Use corner brackets `「」` for special terms (e.g., `「工具」`, `「会话」`).
- Prefer "终端" over "命令行" in Chinese when both are applicable (e.g., "运行在终端中", "终端界面", "终端操作").
- Use "工具调用" / "tool call", not "工具使用" / "tool use".
- Use inline code for tool names (e.g., `Read`, `Grep`, `Bash`).

Term mapping (Chinese <-> English, and proper noun handling):

| Chinese | English | Proper noun (zh) | Proper noun (en) |
| --- | --- | --- | --- |
| Agent | agent | yes | no |
| main agent | main agent | no | no |
| subagent | subagent | no | no |
| Shell | shell | yes | no |
| Plan 模式 | Plan mode | yes | yes (Plan mode) |
| YOLO 模式 | YOLO mode | yes | yes (YOLO mode) |
| Thinking 模式 | Thinking mode | yes | yes (Thinking mode) |
| MCP | MCP | yes | yes |
| Kiki CLI | Kiki CLI | yes | yes |
| Agent Skills | Agent Skills | yes | yes |
| Skill | skill | yes | no |
| 系统提示词 | system prompt | no | no |
| 提示词 | prompt | no | no |
| 会话 | session | no | no |
| 上下文 | context | no | no |
| API 密钥 | API key | yes | no |
| JSON | JSON | yes | yes |
| JSONL | JSONL | yes | yes |
| OAuth | OAuth | yes | yes |
| macOS | macOS | yes | yes |
| TypeScript | TypeScript | yes | yes |
| Node.js | Node.js | yes | yes |
| npm | npm | yes | yes |
| pnpm | pnpm | yes | yes |
| kiki | kiki | yes | yes |
| 审批请求 | approval request | no | no |
| 斜杠命令 | slash command | no | no |
| 工具调用 | tool call | no | no |
| Frontmatter | frontmatter | yes | no |
| User 消息 | user message | yes (User) | no |
| Assistant 消息 | assistant message | yes (Assistant) | no |
| Tool 消息 | tool message | yes (Tool) | no |
| 轮次 | turn | no | no |
| 供应商 | provider | no | no |
| Prompt Flow | Prompt Flow | yes | yes |
| Diff | diff | yes | no |

### Kimi platform rules

Two distinct platforms exist and must never be mixed:

| | Kimi Code platform | Kimi Open Platform |
|---|---|---|
| Audience | Individual developers, subscription-based | Enterprise / product integration, pay-per-token |
| OpenAI-compatible base URL | `https://api.kimi.com/coding/v1` | `https://api.moonshot.cn/v1` |
| Anthropic-compatible base URL | `https://api.kimi.com/coding/` | Not supported |
| API key entry | [Kimi Code console](https://www.kimi.com/code/console) | [platform.kimi.com](https://platform.kimi.com) |

Rules:
- Kiki supports multiple providers. For Kimi Code subscription examples, use `api.kimi.com/coding/…`; for Kimi Open Platform examples, use `api.moonshot.cn/v1`.
- Keep the provider platform explicit; Kiki's product name does not change provider endpoints, model IDs, or OAuth identities.
- Product names are **Kiki CLI** and **Kiki for VS Code**. Use **Kimi Code** only for the upstream product or its provider platform.

## Typography

- **Spacing around mixed content**: Add a space between Chinese characters and English words, numbers, inline code, or links. Exception: no space before full-width punctuation.
  - ✓ 在 TypeScript 中使用 `class` 关键字
  - ✗ 在TypeScript中使用`class`关键字
  - ✓ 详见 [配置文件](./config.md)。
  - ✗ 详见[配置文件](./config.md)。
- **Full-width punctuation**: Use full-width punctuation in Chinese text: `，。；：？！（）` not `, . ; : ? ! ( )`.
- **Keyboard shortcuts**: Use hyphen between modifier and key (`Ctrl-C`, `Ctrl-D`, `Shift-Tab`, `Alt-V`), not plus sign. Exception: literal application output (e.g., the `Press Ctrl+C again to exit` hint produced by the product itself) keeps its exact rendering.
- **Code block language**: Always specify language for fenced code blocks (e.g., ` ```sh `, ` ```toml `, ` ```json `, ` ```ts `). Exception: natural language examples (user prompts) may omit the language.
- **Callout titles**: Use short category titles for callout blocks (`::: tip`, `::: warning`, `::: info`, `::: danger`). Put the detailed description in the block content, not the title.
  - Chinese: use `提示` for tip, `注意` for warning, `说明` for info, `警告` for danger.
  - English: use no title or short words like `Note` for warning.
  - ✓ `::: tip 提示` + content starting with the key point
  - ✓ `::: warning 注意` + content `部分 \`.agents\` 资源不受 \`KIKI_HOME\` 影响。...`
  - ✗ `::: warning 不影响 .agents` (title too long, should be in content)
  - ✗ `::: tip .agents 路径独立于 KIKI_HOME` (title too long)
- **Version info blocks**: For version change callouts, use `::: info` with a category title (Added/Changed/Removed in English; 新增/变更/移除 in Chinese). The content should be a complete sentence.
  - ✓ `::: info 新增` + content `新增于 0.2.0。`
  - ✗ `::: info 新增于 0.2.0` (title too long)
  - ✓ `::: info Changed` + content `Renamed in 0.2.0. ...`
  - ✗ `::: info Renamed in 0.2.0` (title too long)
- **Callout syntax**: Use `:::` for standalone callouts. `::::` is valid only as the outer fence of a nested container and must be correctly closed; an unclosed or mismatched `::::` breaks page rendering. When nesting is not needed, use a `>` blockquote inside a callout for secondary notes instead.

## Writing style

- **Natural narrative**: Organize content like writing an article, guiding readers smoothly through the material.
- **Avoid fragmentation**: Don't turn every point into a subheading; use paragraph transitions instead. This applies to narrative content — explanations, motivations, and sequential reasoning that flow as connected prose.
- **Global perspective**: "Getting Started" introduces core concepts only; detailed usage belongs in later pages.
- **Progressive depth**: Guides → Customization → Configuration → Reference, information deepens gradually.
- **No nav tip blocks**: VitePress provides automatic prev/next navigation; don't add `::: tip 接下来` blocks at page end. A `## Next steps` section is appropriate when there are closely related follow-on pages — see [Page structure](#page-structure).
- **One idea per paragraph**: Each paragraph makes one point. 3–4 sentences is the target; split when a paragraph exceeds 5 sentences.
- **Map before detail**: Every page and every major section should open with one "map" sentence — what this section covers and how it relates to what came before — before expanding into details. Readers should know where they are before they dive in.

  > ❌ Jump straight to detail: "Credential resolution has three steps: first read `api_key`…"
  >
  > ✓ Map then detail: "Provider credentials follow a separate resolution path from ordinary runtime parameters — the CLI reads only from `config.toml` and never falls back to shell environment variables. The priority order is:…"

- **Parallel content needs formatting**: This is the counterpart to "avoid fragmentation" — the distinction is what kind of content you have. Multiple items of the same kind (file descriptions, config field explanations, caveats) written as separate paragraphs with no visual distinction force readers to parse shape instead of meaning. Fix:
  - Each item is "name + one sentence": use an unordered list: `- **Name**: description`
  - Multiple dimensions (name + type + description): use a table
  - Each item is longer than two sentences: use a `###` subheading

### Example: good vs bad

Outline prompt:

```
* Install and upgrade
  * System requirements: Node.js 24.15.0+, recommend pnpm
  * Install, upgrade, uninstall steps
```

**Bad** (mechanical conversion to headings):

```markdown
## Install and upgrade

### System requirements

- Node.js 24.15.0+
- Recommend pnpm

### Install

...

### Upgrade

...
```

**Good** (natural narrative):

```markdown
## Install and upgrade

Kiki CLI requires Node.js 24.15.0 or later. We recommend using pnpm for installation and management.

If you haven't installed pnpm yet, please refer to the pnpm installation docs first. Install Kiki CLI:

(code block)

Verify the installation:

(code block)

Upgrade to the latest version:

(code block)
```

## Format decisions

Choose the format that matches the content's structure, not the one that looks most thorough.

**Ordered list** — steps that must happen in sequence (installation, configuration, migration). Do not nest sub-lists inside steps.

**Unordered list** — parallel items with no ordering dependency. Format: `- **Name**: one-sentence description`.

**Table** — reference content with multiple dimensions to compare or look up (config fields with name + type + required + description; keyboard shortcuts; platform comparison). Avoid tables when cell content would need to wrap to be readable.

**Prose** — explanations, motivations, caveats, anything that flows naturally as connected sentences. Do not convert prose into bullets just to add visual structure.

## Cross-references

Readers never read just one page. A complete understanding is usually spread across several pages. Add links wherever they help.

**Always link when:**
1. A concept mentioned on this page has a full explanation on another page — link to it on first mention, not the second or third. Prefer anchors (`#section`) over page-top links when the relevant content is in a specific section.
2. This page gives a brief summary while another page has the full field reference or example — link the summary to the detail.
3. A later section on this page depends on a concept defined earlier on this page — back-link with `[term](#anchor)` so readers don't have to scroll.

**Do not write:**
- "See related documentation" — which one? Readers skip this.
- Link only in a "Next steps" list at the bottom — readers who hit a blocker mid-page won't scroll to the end to find the link.
- First mention without a link, linked on second or third mention — the first mention is when the reader most wants to click.

**Inline links vs "Next steps":** Inline links serve readers who need supplemental information mid-page. A closing "Next steps" section serves readers who finished the page and want natural follow-on reading. Both have a place; neither replaces the other.

## Page structure

```
# Title (noun phrase, no period)

Opening sentence or two + plain-English summary (only when the concept has a learning curve)

> blockquote (optional: Beta notice, prerequisites)

Supplementary context / use-case list (optional)

Diagram (optional)

::: warning Banner (deprecation, breaking change, security notice — after opening content, before first ##)

## First section

Body…

## Next steps (optional, only when related pages exist)
- [Page name](/path) — one sentence describing what the reader can do there
```

**Banner placement rule:** Banners must appear after all opening content (opening sentences, blockquote, diagram) and before the first `##`. A banner must never be the first thing on the page.

## Content completeness

**Default position: keep everything.** When editing a page, every block of original content needs an explicit destination — either retained or consciously removed with a stated reason.

**Valid reasons to omit content:**
- Too low-level / pure implementation detail that users never need to act on
- Already covered more completely on another page that is linked from here
- Content is ambiguous or suspected outdated — flag it rather than silently dropping it

**Not valid reasons:**
- "Seems unimportant" — that is a guess, not a reason
- "I'm not sure about this" — research it rather than omitting it
- "The page is getting long" — restructure, do not cut

If content is omitted, note it explicitly in the PR description or commit message. Do not write omission notices inside the document itself.

## Checklist

Run through this before marking any doc change ready for review.

### Format

| Problem | Fix |
|---|---|
| `::::` unclosed or mismatched | Close the fence or replace with `:::` if nesting is not needed |
| Nested callout containers | Change inner one to `>` blockquote |
| Banner before first `##` but also before opening content | Move to after opening sentences / blockquote / diagram |
| Steps written as unordered list | Change to ordered list |
| Multi-dimension comparison written as prose | Convert to table |
| Technical term used without explanation on first occurrence | Add plain-English gloss in parentheses |
| Cross-reference written as "see …" with no link | Add inline link; prefer anchor to section, not just page top |
| Concept depends on earlier definition but no back-link | Add `[term](#anchor)` |
| Changed zh without changing en (or vice versa) | Update both locales |
| Code block has no language tag | Add language (e.g., `sh`, `toml`, `json`); exception: natural-language prompt examples may omit the tag |

### Product and provider consistency

Before shipping, verify these values match the rest of the docs:

- **Provider URLs**: for Kimi examples, follow the [Kimi platform rules](#kimi-platform-rules); other providers keep their own endpoints.
- **Upgrade command**: matches `guides/getting-started.md`.
- **Kimi model ID**: use `kimi-for-coding`, not a versioned model name, in Kimi Code subscription examples.
- **Login command**: `/login`, not `/setup`.
- **Product names**: **Kiki CLI** and **Kiki for VS Code**; preserve **Kimi Code** when referring to the upstream product or provider.

## Build and preview

- Docs are built with VitePress from `docs/`.
- Common commands (run inside `docs/`):
  - `npm install`
  - `npm run dev`
  - `npm run build`
  - `npm run preview`
- The build output is `docs/.vitepress/dist`.

## Changelog syncing

See `sync-changelog` skill for the changelog generation workflow.
