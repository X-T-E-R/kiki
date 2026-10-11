---
title: Make it yours to extend
---

# Make it yours to extend

Beyond the model, the prompt, and the tools an agent already has, Kiki has four extension seams: **plugins** that bundle capabilities, **skills** that add reusable workflows, **MCP servers** that connect external tools, and **search and retrieval** for what it knows about the web. This page covers each of the four and how they differ — because a plugin, a skill, and an MCP server sound alike and are not.

## Plugins bundle capabilities

A plugin is the packaging unit. One plugin can contribute skills, agents, MCP servers, hooks, commands, tools, and sandboxed panels, and you can browse, install, and configure plugins on the **Capabilities** page. Claude Code plugins with a `.claude-plugin/plugin.json` manifest install too, and you can point Kiki at your own marketplace JSON.

The official marketplace is maintained by Kimi and currently has three plugins: **Kimi Datasource** (query market data, macro indicators, company registrations, academic literature, and laws in natural language), **Kimi Browser Extension** (let AI drive your own browser), and **Kimi Computer Use** (let AI operate your desktop apps). Two more capabilities are separate plugins, not part of that trio: **Kiki Extract**, which converts a local PDF, Office, HTML, or text file into Markdown that `Read` and `Grep` can use, and **Kiki Notion**, a configuration and workflow for Notion's hosted MCP service. Extracting a file is a reading step — it makes an existing document searchable, and it neither creates nor edits Office documents. Installing a plugin never runs its hooks by itself — they fire only when their matching event occurs while the plugin is enabled. See [Plugins](/en/customization/plugins).

Media generation uses a media plugin's *sources* for images, video, or speech, configured under **Capabilities → Plugins → Media sources**. There is no extra experimental switch: install and enable the plugin, configure and enable a source, then request generation when you need it. Saving or listing sources does not start a job. See [Media sources](/en/customization/plugins#media-sources) for source access and authorization.

## Skills are reusable workflows

An [Agent Skill](/en/customization/skills) is a Markdown file that injects a specialized workflow or body of knowledge the agent invokes when it is relevant, and it registers as a slash command you can trigger yourself with `/name`. If you name several in one prompt after whitespace, Kiki activates them together and runs them as a single turn. A skill can also be invoked explicitly as `/skill:<name>`, and its resources (scripts, references) live beside its file.

A **custom prompt command** is the lightweight sibling: just a prompt snippet you trigger with `/name`, with no agent involvement. See [Agent Skills](/en/customization/skills) and [Custom prompt commands](/en/customization/skills#custom-prompt-commands).

## MCP servers connect external tools

[Model Context Protocol](/en/server/mcp) servers let the agent call tools exposed by external processes or services — a database, a GitHub tracker, a local filesystem. Kiki connects as an MCP client over three transports: **stdio** (Kiki starts the server as a child process), **HTTP** (an already-running endpoint), and **SSE** (a legacy streaming transport; prefer HTTP for new servers). Configure them in `mcp.json` at the user level (`~/.kiki/mcp.json`) or the project level (`.kiki/mcp.json`), and manage them interactively with `/kiki-ops help me configure MCP` or inspect status with `/mcp`. A project-level server in an untrusted folder shows its transport and launch target in the trust prompt — read it before you trust the folder.

MCP tools reach the agent exactly like built-in tools, with the same approval model. See [Model Context Protocol](/en/server/mcp).

## Search and retrieval

`WebSearch` and `FetchURL` are backed by an inspectable search and retrieval module. **Settings → Search & retrieval → Overview & source** shows which configuration source is in effect and whether the server reuses your local search configuration; `/mcp`-style status and the readiness of each named lane are visible there too. Search runs on named lanes you can inspect — some, like GitHub repository search, work without a key, and multiple keys for one provider rotate across calls. A fetch runs a chain with visible fallbacks, so you can see which extractor produced the text. The equivalent configuration lives in `config.toml` under `nb_search`. See [Search and retrieval](/en/guides/settings#search-retrieval) and [Config files: `nb_search`](/en/configuration/config-files#nb-search).

![The search lanes tab: the default lane, the pinned ones, and every other lane with where its results and credentials come from.](/shots/extend/ce-20261005-extend-search-lanes.en.png)

![The fetch chain tab, with the pipelines a web address is read through in order and what each one falls back to.](/shots/extend/ce-20261005-extend-fetch-chain.en.png)

## Next steps

- [Plugins](/en/customization/plugins) — the full plugin reference
- [Agent Skills](/en/customization/skills) — writing a skill
- [Model Context Protocol](/en/server/mcp) — connecting MCP servers
