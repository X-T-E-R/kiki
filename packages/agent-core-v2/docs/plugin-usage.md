# Workspace plugin usage

Plugin installation, consent and the home master switch remain App-owned. `IPluginUsageService` adds a default-off workspace use policy; it does not create another DI scope, an installation identity or a per-session switch. Enable `plugin_workspace_usage` through `IFlagService` (`KIKI_EXPERIMENTAL_PLUGIN_WORKSPACE_USAGE=1`).

## Identity and effective state

An atomic `plugin-usage` document is keyed by the canonical registered workspace id. `inherit` deletes an override; `on` and `off` persist booleans. Consumers require both the home's enabled, valid contribution and a workspace policy that is not off. Workspace-on never enables a home-disabled plugin. Profiles retain their existing tool and deny constraints.

REST reads and writes accept either `workspace_id` or `session_id`; a cold session is resolved through `ISessionIndex` without resume or registration. Cwd-only draft profile previews reuse an existing canonical workspace id by root identity, or use the existing computed root key without registering a workspace. Unscoped management catalogs stay home-wide.

## Change and application contract

A write first persists its revision and updates admission policy, then fires `onDidChange`. Consumers synchronously attach their actual asynchronous application work with `waitUntil`. The write returns saved state with `applyState=pending` when that work is outstanding; `onDidApply` publishes applied/failed for the latest revision only. A failed consumer does not undo the saved choice. Repeating a later revision cannot be overwritten by completion of an older one. MCP runtime consumers report application errors through the change's `reportFailure` callback; the config owner rejects its usage waiter after all consumers finish, rather than relying on shared `AsyncEmitter` rejection propagation.

Native tools and skills check workspace admission at execution/activation, not only registration. MCP resolved tools capture entry identity, acquire an admitted call lease, and release it in `finally`. Removal/replacement rejects new admission immediately and drains admitted calls before closing that entry. A real winning file configuration is independent of plugin usage even if its name begins with `plugin-`; file presence wins, including disabled file entries.

Kap-server publishes `event.plugin.changed` on home reload, workspace usage change and application completion. Klient exposes it as the typed global `plugins.changed` bus event; `plugins.reloaded` remains a distinct reload-only emitter. GUI subscribers share the mutation path's query invalidation and re-read after subscription attachment/reconnection, so another window does not need a local save to refresh.

Workspace skill/profile/MCP loaders refresh the scoped catalogs. Hook registries retain home descriptors and filter plugin-owned rules for each session workspace; user rules remain. Session source reloads pass the same workspace id to plugin system-prompt and session-start lookups. Workspace panels require a target for listing/document access and a real session target for bridge calls; sidebar panels remain home services. Command listings use the explicit target.

## Prompt safety and snapshots

Plugin usage does not rebind a running profile or adopt authored profile changes. The existing context injector reconciles plugin prompt sections, skills and session-start guidance at a step boundary or an acquired idle quiescence. An active, initialized consumer keeps the write pending until that boundary. Already sent model requests and historical messages remain intact.

System-prompt snapshots retain per-plugin frozen blocks in `SystemPromptContext.pluginBlocks`. Cold snapshots without that metadata recover blocks from the existing host-owned plugin section markers. Turning a plugin off hides its block; turning it on restores the frozen content. An explicit affected plugin reload adopts only that plugin's new block, preserving unrelated frozen inputs. State and wire manifest generators project the new optional metadata.

## Host integration boundary

Workspace usage emits neither `IPluginService.onWillChange` nor home mutations. It cannot uninstall a plugin, revoke installation consent, change credentials or stop an App resident service. The separate App Host candidate consumes home enablement/activation only. This candidate's native-host fixtures prove that workspace-off does not enter the home mutation path; real resident continuation is an integration check when that Host is combined, not a claim established by `app_service=false` in an older manifest schema.

## Focused evidence

`test/app/pluginUsage/pluginUsageService.test.ts` covers persistence, flag-off, revisions and pending/failure. `test/app/plugin/pluginService.test.ts` covers A/B contribution filtering and reload. Native-host, MCP manager, skill, hook, prompt warm/cold and session-start tests cover delayed admission and safe refresh. Kap-server's `pluginUsageRoutes.test.ts` covers cold targeting and A/B panel document/late bridge/commands; `agentProfiles.integration.ts` checks canonical cold cwd targeting without a Program. The right-rail GUI owner owns the single real GUI chain and screenshots; source/type checks do not substitute for that evidence.
