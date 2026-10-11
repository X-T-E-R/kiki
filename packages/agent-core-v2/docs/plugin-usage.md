# Workspace plugin usage

Plugin installation, consent and the home master switch remain App-owned. One installed package supplies a global default, workspace overrides and explicit session activation. `plugin_workspace_usage` is available by default; an explicit config `false` or `KIKI_EXPERIMENTAL_PLUGIN_WORKSPACE_USAGE=0` still disables this selection surface. Feature availability never grants installation consent.

## Identity and effective state

`installed.enabled` is the master authorization switch. `defaultEnabled` records global default use; records without that field preserve their former `enabled` behavior. A newly consented installation sets master authorization on and chooses its default independently. Updates and rollback preserve both values. Explicit global disable sets both off, so a workspace or session cannot override that denial.

Atomic `plugin-usage` documents use canonical registered workspace ids. Atomic `session-plugin-usage` documents use session ids and are written by `ISessionPluginUsageService`. `inherit` deletes the corresponding override; `on` and `off` persist booleans. Effective admission requires a valid, master-authorized plugin, then resolves session override → workspace override → global default. Profiles retain their existing tool and deny constraints.

REST `workspace_id` changes workspace defaults; `session_id` changes only that session. A cold read resolves the workspace through `ISessionIndex` without resuming or registering anything. Session writes acquire the existing session operation lease and release it after application. Cwd-only draft profile previews reuse the canonical workspace id or computed root key without registration. Management candidate reads use the internal `*` workspace selector to retain authorized descriptors; execution still checks effective scope admission.

## Change and application contract

A write first persists its revision and updates admission policy, then fires `onDidChange`. Workspace events omit `sessionId`; session events carry it. Workspace-owned loaders ignore session-only events, and session consumers ignore events for another session. Consumers attach actual asynchronous application work with `waitUntil`.

Workspace writes return `pending` while attached work is outstanding. Session writes await attached work. A failed application restores the previous selection at a new revision, reapplies it and reports the failure. An older completion cannot replace a newer workspace revision. MCP runtime consumers report failures through the existing change's `reportFailure` callback rather than relying on `AsyncEmitter` rejection propagation.

Native tools and skills check effective workspace/session admission at execution/activation, not only registration. MCP resolved tools capture entry identity, acquire an admitted call lease, and release it in `finally`. Removal/replacement rejects new admission immediately and drains admitted calls before closing that entry. A real winning file configuration is independent of plugin usage even if its name begins with `plugin-`; file presence wins, including disabled file entries.

Kap-server publishes `event.plugin.changed` on home reload, workspace usage change and application completion. Klient exposes it as the typed global `plugins.changed` bus event; `plugins.reloaded` remains a distinct reload-only emitter. GUI subscribers share the mutation path's query invalidation and re-read after subscription attachment/reconnection, so another window does not need a local save to refresh.

Workspace skill/profile/MCP loaders refresh workspace defaults. Session consumers filter the authorized home descriptors against both workspace and session selection. Session MCP overlays reuse the existing ephemeral configuration channel; winning file entries remain independent. Hooks preserve user rules and filter plugin-owned rules for the target session. Prompt, session-start and command lookups carry both ids. Panel listing, document reads and bridge calls enforce the requested scope for workspace and sidebar placement alike.

## Prompt safety and snapshots

Plugin usage does not rebind a running profile or adopt authored profile changes. Profile and session-start consumers mark their contributions dirty, and the existing context injector reconciles at a safe step boundary. They do not hold a usage event waiter until a later model step. `applied` describes completion of attached catalog/runtime work, not retroactive replacement of an already sent model request. Historical messages remain intact.

System-prompt snapshots retain per-plugin frozen blocks in `SystemPromptContext.pluginBlocks`. Cold snapshots without that metadata recover blocks from the existing host-owned plugin section markers. Turning a plugin off hides its block; turning it on restores the frozen content. An explicit affected plugin reload adopts only that plugin's new block, preserving unrelated frozen inputs.

## Home resident lifecycle

Workspace and session usage emit neither `IPluginService.onWillChange` nor home mutations. A later installation has master authorization but no global default, so it does not start an App resident service. First explicit use of an App-activated plugin starts its existing home-owned resident. That shared process does not admit contributions in another scope where the plugin is off.

Local off removes only the target scope's admission and does not stop a resident or another scope's in-flight work. Uninstall, explicit global disable and daemon shutdown retain the existing home-owned drain/disposal path. No all-workspace/session scan or reference-counted host platform is introduced. Usage cannot revoke consent or change credentials, and it is not process isolation for trusted plugin code.

## Focused evidence

`test/app/pluginUsage/pluginUsageService.test.ts` covers independent workspace/session persistence, master denial, cold reads, pending/failure and recovery. `test/app/plugin/pluginService.test.ts` covers A/B contribution filtering and reload. `test/app/plugin/appLifecycle.test.ts` uses a real temporary-home resident to cover later installation, explicit first use, local off with an in-flight request, and explicit global disposal.

Session skill, command and MCP tests cover session isolation, explicit local activation and file-winner preservation. Media tests distinguish new admission from accepted-job continuation. Kap-server's `pluginUsageRoutes.test.ts` covers cold targeting, session operation leases and scoped panels/commands. GUI tests and the reusable `capture-plugin-scopes.mjs` fixture workflow cover the selection surfaces; fixture screenshots do not establish real-backend behavior.
