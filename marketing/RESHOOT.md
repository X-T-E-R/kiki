# Marketing Screenshot Guide & Ledger

All public screenshots live in `docs/public/shots/**` and serve `README.md`, `README.zh-CN.md`, `marketing/*.md`, and the VitePress site under `docs/`. Each image is a fixture render of the real GUI against an example project (`sample-app` with neutral hosts such as `example.com` and `example.test`, and placeholder credentials such as `YOUR_API_KEY`). Keep the "rendered example" caption wherever these frames appear. The flagship video demo is a separate real recording; see [./launch/demo-storyboard.md](./launch/demo-storyboard.md).

## Prerequisites

1. Use **Node.js 24 LTS** (`.nvmrc`: `24.22.1`) and **pnpm 10.33.0**.
2. Build `@kiki/session-core` before launching GUI capture scripts when workspace sources changed:
   ```sh
   pnpm --filter @kiki/session-core build
   ```
3. Build or reuse the static GUI bundle in the disposable repo-level `.tmp/kiki-public-visuals/dist` directory:
   ```sh
   cd apps/kiki-gui
   npx vite build --outDir ../../.tmp/kiki-public-visuals/dist --emptyOutDir --logLevel warn
   ```
4. Set `KIKI_FIXTURE_EPOCH` to the current UTC timestamp before running any script so relative timestamps ("1m ago", "14m ago") never age into hundreds of days or hours:
   ```sh
   export KIKI_FIXTURE_EPOCH="$(node -e 'console.log(new Date().toISOString())')"
   ```
5. Never point a runner's `--out` or output environment variable directly at `docs/public/shots`—runners wipe or overwrite their working directory. Always render into `.tmp/marketing-out/...` and copy into `docs/public/shots/**` with `scripts/marketing-collect.mjs`.

## Runners & Collection Workflow

Run all commands from `apps/kiki-gui` with `KIKI_FIXTURE_EPOCH` set:

- **P1 core frames** (`h01-fleet-workbench`, `r01-reviewer-profile`, `r02-goal-queue`, `r05-multi-model-fleet`):
  ```sh
  node scripts/marketing-shots.mjs --out=../../.tmp/marketing-out/p1 --only=h01,r01,r02
  node scripts/marketing-shots.mjs --out=../../.tmp/marketing-out/r05 --only=r05 --rail-width=440
  ```
  Run `r05` with `--rail-width=440` and collect it after `p1` so all four per-role subagent model chips (`gpt-6-astra`, `Claude Fable`, `DeepSeek V4 Flash`, `GLM 5.3 Flash`) remain simultaneously visible in `workbench/workbench-per-role-models.{en,zh}.png`.
- **P2 deep-dive frames** (`d01`–`d08`):
  ```sh
  node scripts/marketing-p2-shots.mjs --out=../../.tmp/marketing-out/p2
  ```
- **People & Spaces base frames** (`ps-20261005-people-{memory,execution,room-threads,room-paused}`, `ps-20261005-spaces-{list,remote,inbound,web-access,session-ssh}`):
  ```sh
  KIKI_MARKETING_CAMPAIGN_REUSE_BUILD=1 \
  KIKI_PEOPLE_SPACES_VISUAL_DIR=../../.tmp/marketing-out/ps \
  node scripts/visual-people-spaces-20261005.mjs
  ```
- **Control, Extend & Ecosystem base frames** (`ce-20261005-freedom-{oauth-device,permission-modes}`, `ce-20261005-extend-{skills,mcp}`):
  ```sh
  KIKI_MARKETING_CAMPAIGN_REUSE_BUILD=1 \
  KIKI_CONTROL_ECOSYSTEM_DIR=../../.tmp/marketing-out/ce \
  node scripts/control-ecosystem-shots.mjs --only=ce-freedom-oauth-device,ce-freedom-permission-modes,ce-extend-skills,ce-extend-mcp
  ```
- **Main Campaign + Workbench/Long-Work + Usage + Companion Frames**:
  ```sh
  KIKI_MARKETING_CAMPAIGN_REUSE_BUILD=1 \
  KIKI_MARKETING_CAMPAIGN_DIR=../../.tmp/marketing-out/campaign \
  node scripts/marketing-campaign.mjs
  ```
  `marketing-campaign.mjs` renders the primary `marketing-campaign` set (`hero-workbench` light/dark, `workbench-background-tasks`, `long-work-*`, `people-*`, `spaces-*`, `freedom-*`, `agents-*`, `daily-usage`, `ecosystem-history-import`, `look-skins`), companion frames (`ps-people-execution-detail`, desktop `ps-spaces-{list,remote,inbound,credentials,detail}`, `ce-freedom-{oauth-reuse,prompt-overrides}`, `ce-extend-{plugins,search-source,search-lanes,fetch-chain}`, `ce-ecosystem-{engines,import-sources}`), plus the spread suites from `marketing-workbench-longwork-shots.mjs` (`wl-*`) and `marketing-usage-shots.mjs` (`ux-usage-*`).
- **Collect into `docs/public/shots/`**:
  ```sh
  node scripts/marketing-collect.mjs --from=../../.tmp/marketing-out/p1
  node scripts/marketing-collect.mjs --from=../../.tmp/marketing-out/p2
  node scripts/marketing-collect.mjs --from=../../.tmp/marketing-out/ps/<run-dir>
  node scripts/marketing-collect.mjs --from=../../.tmp/marketing-out/ce/<run-dir>
  node scripts/marketing-collect.mjs --from=../../.tmp/marketing-out/campaign/<run-dir>
  node scripts/marketing-collect.mjs --from=../../.tmp/marketing-out/r05
  ```

## Placeholder & Visual Hygiene

- Persona names must use the personal-assistant set (`小柚`/`Yuzu`, `豆豆`/`Doudou`, `米粒`/`Mili`)—never retired placeholder names.
- Hosts, accounts, and keys must stay neutral (`example.com`, `example.test`, `you@example.test`, `team@example.test`, `C:/Users/you/...`, `C:/Projects/sample-app`, `YOUR_API_KEY`).
- `docs/AGENTS.md` and `pnpm docs:check-governance` govern public links and doc parity; verify zero broken `/shots/...` or `../docs/public/shots/...` references after every collection run.

## Current Shot Inventory (134 Active + 2 Retired)

All 136 previously tracked screenshots were audited for the post-redesign GUI: **130 active frames re-rendered**, **4 plugin-owned frames intentionally unchanged**, and **2 unreferenced frames retired**.

### Index & Dark Theme (8 frames — all re-rendered)

| File(s) | Status | Runner / Source | Notes |
| --- | --- | --- | --- |
| `index/hero-workbench.{en,zh}.png` | re-rendered | `marketing-shots.mjs` (`h01`) / `marketing-campaign.mjs` | Updated shell, sidebar spaces header, Mode chip, and live queue. |
| `theme-dark/hero-workbench.{en,zh}.dark.png` | re-rendered | `marketing-campaign.mjs` (`hero-workbench`) | Dark theme counterpart of main hero workbench. |
| `index/wl-20261005-hero-workbench.{en,zh}.png` | re-rendered | `marketing-workbench-longwork-shots.mjs` (`wl-hero-workbench`) | README & VitePress hero light theme. |
| `theme-dark/wl-20261005-hero-workbench.{en,zh}.dark.png` | re-rendered | `marketing-workbench-longwork-shots.mjs` (`wl-hero-workbench`) | README & VitePress hero dark theme (`themes: ['light', 'dark']`). |

### Workbench (16 frames — all re-rendered)

| File(s) | Status | Runner / Source | Notes |
| --- | --- | --- | --- |
| `workbench/workbench-per-role-models.{en,zh}.png` | re-rendered | `marketing-shots.mjs` (`r05`, `--rail-width=440`) | All 4 subagent role model bindings visible in dispatch tree. |
| `workbench/workbench-background-tasks.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Updated `/s/:id/tasks` shell and status rows. |
| `workbench/d01-agent-preview.{en,zh}.png` | re-rendered | `marketing-p2-shots.mjs` (`d01`) | Subagent inspector drill-in via `[data-subagent-open]`. |
| `workbench/d03-tasks-page.{en,zh}.png` | re-rendered | `marketing-p2-shots.mjs` (`d03`) | Per-session background tasks view with expanded task. |
| `workbench/wl-20261005-workbench-fleet.{en,zh}.png` | re-rendered | `marketing-workbench-longwork-shots.mjs` | Multi-agent fleet overview. |
| `workbench/wl-20261005-workbench-subagent.{en,zh}.png` | re-rendered | `marketing-workbench-longwork-shots.mjs` | Subagent view alongside main session. |
| `workbench/wl-20261005-workbench-tasks.{en,zh}.png` | re-rendered | `marketing-workbench-longwork-shots.mjs` | Workbench background tasks list. |
| `workbench/wl-20261005-subagent-rail-detail.{en,zh}.png` | re-rendered | `marketing-workbench-longwork-shots.mjs` | Right-rail crop (`680x1180` @2x) showing subagent metrics and controls. |

### Long Work (18 active + 2 retired)

| File(s) | Status | Runner / Source | Notes |
| --- | --- | --- | --- |
| `long-work/long-work-goal-queue.{en,zh}.png` | re-rendered | `marketing-shots.mjs` (`r02`) | Goal strip and per-message queue timing controls. |
| `long-work/long-work-context-fresh.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Context meter popover with Fresh renewal strategy selected. |
| `long-work/long-work-memory-scopes.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Memory page scopes, entries, and change history. |
| `long-work/d05-cron-panel.{en,zh}.png` | re-rendered | `marketing-p2-shots.mjs` (`d05`) | Scheduled tasks (`/cron`) page with recurring, one-shot, and paused entries. |
| `long-work/wl-20261005-longwork-goal-queue.{en,zh}.png` | re-rendered | `marketing-workbench-longwork-shots.mjs` | Expanded queued-messages stack. |
| `long-work/wl-20261005-longwork-scheduled.{en,zh}.png` | re-rendered | `marketing-workbench-longwork-shots.mjs` | Scheduled tasks page variant. |
| `long-work/wl-20261005-longwork-context.{en,zh}.png` | re-rendered | `marketing-workbench-longwork-shots.mjs` | Context renewal strategy panel. |
| `long-work/r04-task-board.{en,zh}.png` | unchanged | `marketing-shots.mjs` (manual/plugin) | Owned by optional `kiki-task-board` plugin (`marketing/task-board.*.md`); not a core GUI route. |
| `long-work/board-task-detail.{en,zh}.png` | unchanged | `marketing-p2-shots.mjs` (manual/plugin) | Owned by optional `kiki-task-board` plugin; kept unchanged. |
| `long-work/wl-20261005-longwork-board.{en,zh}.png` | retired | Removed via `git rm` | Unreferenced across `README*`, `marketing/**`, and `docs/**`; showed removed sidebar Task board nav item. |

### Daily Driver (10 frames — all re-rendered)

| File(s) | Status | Runner / Source | Notes |
| --- | --- | --- | --- |
| `daily/d04-tool-steps-notification.{en,zh}.png` | re-rendered | `marketing-p2-shots.mjs` (`d04`) | Folded tool steps and expanded completion notice. |
| `daily/d08-video-attachment.{en,zh}.png` | re-rendered | `marketing-p2-shots.mjs` (`d08`) | Inline video attachment playback in session timeline. |
| `daily/daily-usage.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Usage History tab with token and cost breakdown. |
| `daily/ux-usage-live.{en,zh}.png` | re-rendered | `marketing-usage-shots.mjs` | Usage Live tab with active/waiting agents and governance rules summary. |
| `daily/ux-usage-export.{en,zh}.png` | re-rendered | `marketing-usage-shots.mjs` | Usage External sync tab across webhook, VibeCafe, and script destinations. |

### People & Personas (16 frames — all re-rendered)

| File(s) | Status | Runner / Source | Notes |
| --- | --- | --- | --- |
| `people/people-persona-card.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Updated persona names (`Yuzu`/`小柚`, `Doudou`/`豆豆`, `Mili`/`米粒`). |
| `people/people-daily-conversation.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Persona daily conversation and thread sidebar. |
| `people/people-room.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Multi-persona room discussion with speaker attribution. |
| `people/ps-20261005-people-memory.{en,zh}.png` | re-rendered | `visual-people-spaces-20261005.mjs` | Persona memory scope and entries. |
| `people/ps-20261005-people-execution.{en,zh}.png` | re-rendered | `visual-people-spaces-20261005.mjs` | Persona execution/home workspace settings. |
| `people/ps-people-execution-detail.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Right-pane crop of persona execution workspace bindings. |
| `people/ps-20261005-people-room-threads.{en,zh}.png` | re-rendered | `visual-people-spaces-20261005.mjs` | Room member picker showing personas and threads. |
| `people/ps-20261005-people-room-paused.{en,zh}.png` | re-rendered | `visual-people-spaces-20261005.mjs` | Paused room state after turn-budget cap. |

### Spaces & Devices (20 frames — all re-rendered)

| File(s) | Status | Runner / Source | Notes |
| --- | --- | --- | --- |
| `spaces/spaces-spaces-list.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | `/settings/spaces` list with credential scope. |
| `spaces/spaces-remote-connections.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Paired remote spaces list with `/api/thread-bridges` mock. |
| `spaces/spaces-web-access.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | `/settings/connection-services?tab=web` web access and signed-in browsers. |
| `spaces/ps-20261005-spaces-list.{en,zh}.png` | re-rendered | `visual-people-spaces-20261005.mjs` / `marketing-campaign.mjs` | Desktop-mode spaces list with hot/credential indicators. |
| `spaces/ps-20261005-spaces-detail.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Desktop-mode space detail (`/settings/spaces?space=...`). |
| `spaces/ps-20261005-spaces-credentials.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Space credentials and SSH host copy controls. |
| `spaces/ps-20261005-spaces-remote.{en,zh}.png` | re-rendered | `visual-people-spaces-20261005.mjs` / `marketing-campaign.mjs` | Remote paired spaces view. |
| `spaces/ps-20261005-spaces-inbound.{en,zh}.png` | re-rendered | `visual-people-spaces-20261005.mjs` / `marketing-campaign.mjs` | `/settings/connection-services?tab=kiki` inbound pairing gate. |
| `spaces/ps-20261005-spaces-web-access.{en,zh}.png` | re-rendered | `visual-people-spaces-20261005.mjs` | Browser access mode and device links. |
| `spaces/ps-20261005-spaces-session-ssh.{en,zh}.png` | re-rendered | `visual-people-spaces-20261005.mjs` | Session workspace attached over SSH. |

### Agents (8 frames — all re-rendered)

| File(s) | Status | Runner / Source | Notes |
| --- | --- | --- | --- |
| `agents/agents-profiles.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Unified Agent Manager (`/settings/agents`) list. |
| `agents/agents-profile-editor.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Profile editor view for `release-lead`. |
| `agents/agents-profile-picker.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Composer `#composer-profile-select` picker on `/new`. |
| `agents/r01-reviewer-profile.{en,zh}.png` | re-rendered | `marketing-shots.mjs` (`r01`) | `reviewer` raw Markdown File tab inside `/settings/agents`. |

### Freedom (14 frames — all re-rendered)

| File(s) | Status | Runner / Source | Notes |
| --- | --- | --- | --- |
| `freedom/freedom-connections.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | `/settings/ai?tab=providers` connections list with neutral `example.test` endpoints. |
| `freedom/freedom-prompt-overrides.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Prompt field overrides and preview on `/settings/agents#st-card-prompt-config`. |
| `freedom/d02-prompt-fields.{en,zh}.png` | re-rendered | `marketing-p2-shots.mjs` (`d02`) | Tool-description override preview. |
| `freedom/ce-20261005-freedom-oauth-device.{en,zh}.png` | re-rendered | `control-ecosystem-shots.mjs` | Device-code OAuth side panel flow. |
| `freedom/ce-20261005-freedom-oauth-reuse.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Desktop-mode local credential discovery and reuse panel. |
| `freedom/ce-20261005-freedom-permission-modes.{en,zh}.png` | re-rendered | `control-ecosystem-shots.mjs` | Composer permission-mode picker with "Approve for me" selected. |
| `freedom/ce-20261005-freedom-prompt-overrides.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Full-card prompt overrides capture at `1200x1000`. |

### Extend (16 frames — all re-rendered)

| File(s) | Status | Runner / Source | Notes |
| --- | --- | --- | --- |
| `extend/d06-search-lanes.{en,zh}.png` | re-rendered | `marketing-p2-shots.mjs` (`d06`) | `/settings/search?tab=search` scoped service cards. |
| `extend/d07-fetch-chain.{en,zh}.png` | re-rendered | `marketing-p2-shots.mjs` (`d07`) | `/settings/search?tab=fetch` with `kiki-common-direct 1` routing package metadata. |
| `extend/ce-20261005-extend-plugins.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | Installed plugin contribution breakdown (`kiki-office`). |
| `extend/ce-20261005-extend-skills.{en,zh}.png` | re-rendered | `control-ecosystem-shots.mjs` | Skills catalog across built-in and plugin sources. |
| `extend/ce-20261005-extend-mcp.{en,zh}.png` | re-rendered | `control-ecosystem-shots.mjs` | MCP server transports (`stdio`, `http`, `sse`) and expanded tool list. |
| `extend/ce-20261005-extend-search-source.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | `/settings/search?tab=advanced` local `nb-search` config reuse. |
| `extend/ce-20261005-extend-search-lanes.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | `/settings/search?tab=search#st-card-search-providers` service cards. |
| `extend/ce-20261005-extend-fetch-chain.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | `/settings/search?tab=fetch#st-card-search-fetch` extraction chain. |

### Ecosystem & Look (8 frames — all re-rendered)

| File(s) | Status | Runner / Source | Notes |
| --- | --- | --- | --- |
| `ecosystem/ecosystem-history-import.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | `/settings/sessions/import` showing sources and loss preview after `/settings/*` router fix. |
| `ecosystem/ce-20261005-ecosystem-engines.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | `/settings/ai?tab=providers#st-card-engines` external engine check states. |
| `ecosystem/ce-20261005-ecosystem-import-sources.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | `/capabilities?view=import` redirect into `/settings/sessions/import` with probed conversations. |
| `look/look-skins.{en,zh}.png` | re-rendered | `marketing-campaign.mjs` | `/settings/appearance` theme, built-in skins, corner radius, and motion controls. |
