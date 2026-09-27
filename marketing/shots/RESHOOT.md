# Reshoot plan (after the GUI redesign lands)

The current shots predate the redesign. Re-render them once the new shell, settings, and composer have merged. After that, update the README, gallery, features pages, and launch drafts only where a filename changes.

Runners (run from `apps/kiki-gui`). Each runner wipes its output directory, so never point one at `marketing/shots`:

- `node scripts/marketing-shots.mjs [--only=h01] [--collect]` renders h01, r01, r02, r04, and r05. Builders: `fixtures/marketing-builders.mjs` + `fixtures/marketing-scene.mjs`.
- `node scripts/marketing-p2-shots.mjs [--only=d01] [--collect]` renders d01–d08 and board-task-detail. Builders: `fixtures/marketing-p2-builders.mjs` + `fixtures/marketing-p2-scene.mjs`.

All of these are **fixture** scenes: the real UI rendering an example project. Keep the "rendered example" caption wherever they are used. The flagship demo is a **real** recording instead; see [../launch/demo-storyboard.md](../launch/demo-storyboard.md).

## Re-render (existing scenarios)

| Shot | Scenario(s) | Used by / what to check after the redesign |
| --- | --- | --- |
| `h01-fleet-workbench` (en light, en dark, zh light) | `marketing-h01-en`, `marketing-h01-zh` | README hero until the real recording replaces it. New shell, sidebar, and Mode chip (Normal/Plan/Goal). |
| `d02-prompt-fields` | `marketing-d02-{en,zh}` | README **Freedom** image. Show a tool-description override for one model alias in the preview. |
| `r05-multi-model-fleet` | `marketing-r05-{en,zh}` | README **Power** image. Model chips in the new dispatch tree. |
| `r02-goal-queue` | `marketing-r02-{en,zh}` | Features page. Make the per-message timing labels ("when idle / after subagents / after tasks") legible. |
| `r01-reviewer-profile` | `marketing-r01-{en,zh}` | Features page and gallery. Settings → Agents is now list → detail, and the ZH term is 「智能体」. |
| `d01-agent-preview` | `marketing-d01-{en,zh}` | Gallery. Subagent transcript in the new inspector. |
| `r04-task-board`, `board-task-detail` | `marketing-r04-{en,zh}` | The board is becoming a first-class page. Reshoot it as the page, not the panel. |
| `d05-cron-panel` | `marketing-d05-{en,zh}` | Cron is becoming a first-class page. Same as above. |
| `d06-search-lanes`, `d07-fetch-chain` | `marketing-d06/d07-{en,zh}` | Settings restyle only. |
| `d03-tasks-page`, `d04-tool-steps-notification`, `d08-video-attachment` | `marketing-d03/d04/d08-{en,zh}` | Transcript/tool-card restyle. |

## New shots (new scenarios needed)

Each one needs `marketing-<id>-{en,zh}.scenario.mjs` entry points plus a builder, following the existing pattern: identical structure, translated copy. They are **features-page** shots only, not heroes. Shoot a01–a04 only after the UI has merged; until then the features page keeps a text placeholder.

| Proposed name | Scenario to add | Features card | Scene |
| --- | --- | --- | --- |
| `a01-approve-for-me` | `marketing-a01-{en,zh}` | Permission modes | Permission picker with all four modes and "Approve for me" selected, next to a transcript record of a reviewer-approved action with reviewer attribution. Not a README or demo hero. |
| `a02-needs-you-tray` | `marketing-a02-{en,zh}` | Permission modes (secondary) | Needs-you tray above the composer: one approval expanded, and a non-blocking question collapsed as "1 more". |
| `a03-session-search` | `marketing-a03-{en,zh}` | Session search | Two-layer session search / Ctrl+K switcher with title hits and content hits. |
| `a04-new-agent-templates` | `marketing-a04-{en,zh}` | Agent files | "New agent" with templates (Blank / Implementer / Reviewer / Duplicate current). |
| `a05-providers-models` | `marketing-a05-{en,zh}` | Providers and models | Settings → AI: several providers (Kimi, an OpenAI-compatible DeepSeek endpoint, GLM, Anthropic) with model aliases. Use placeholder keys only. |
| `a06-plugins-mcp-skills` | `marketing-a06-{en,zh}` | Plugins, MCP, skills | Plugins list with one installed plugin expanded, showing the skills, agents, and MCP servers it contributes, plus an MCP server's status. |
| `a07-hooks` | `marketing-a07-{en,zh}` | Hooks | A hook blocking a dangerous shell command: the transcript record of the block with the hook's reason, and the `[[hooks]]` config beside it. |
| `a08-acp-editor` | `marketing-a08-{en,zh}` | Editors over ACP | Kiki running as the agent inside Zed's agent panel. This is an editor screenshot, not a fixture render, so capture it by hand with a sample project. |
