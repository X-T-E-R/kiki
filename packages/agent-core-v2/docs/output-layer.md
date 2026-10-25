# Output-layer generation

The output layer transforms supplied Assistant-visible text without opening an agent, restoring a session, or reading conversation history. `IOutputLayerService` is an App-scope service. Its input contract and stream events live in `packages/protocol/src/outputLayer.ts`; the HTTP-only client capability is `klient.rest.outputLayer`.

## Installed package and settings

The installed package's effective plugin usage controls availability. For `configuration(sessionId)` and every generation, the host resolves the session's workspace through `ISessionIndex` and `IWorkspaceService`, rejects an unknown session, and calls `IPluginUsageService.allows(workspaceId, 'kiki-output-layer', sessionId)`. Session selection overrides workspace selection, which overrides global usage; the existing `plugin_workspace_usage` rollback flag preserves its global-only behavior when explicitly disabled. Cold reads use the session index and persisted usage without restoring an agent. A configuration read without a session returns global availability.

The host reads the installed `kiki-output-layer` package through `IPluginHostService.requestPanel('kiki-output-layer', 'settings', 'configuration', {})`. The package owns six default presets and instructions: `translate`, `translate-en`, `plain`, `catgirl`, `tsundere` and `custom`. Saved `presets` replace the defaults as a complete list and retain the user's edits; a separate optional `templates` array offers the current built-in definitions for explicit additions. The host validates the returned configuration on every configuration read and before each generation. It does not substitute host preset defaults when the package is unavailable.

`configure` validates the supplied presets/settings and writes them through `IPluginSettingsService.update`; credentials are not part of this contract. Installation, enabling, settings changes and package replacement use the existing plugin host lifecycle. A running request keeps its parsed input snapshot. Later reads and requests see the current package and settings.

Plugin engine `0.4.1` adds the `settings` panel slot. A sandboxed settings panel can use the authenticated panel bridge's `plugin.settings.get`, `plugin.settings.patch`, `plugin.models.list` and `plugin.call` methods. Settings access is bound to the panel's own package, model choices contain no credentials, and settings panels cannot call `session.summary` or `session.sendMessage`.

## Generation and transport

`GET` and `PUT /api/output-layer/configuration` read and update the plugin configuration using the ordinary KAP envelope. `GET` accepts an optional `session_id` query; the client exposes it as `configuration({ sessionId })`. `PUT` edits global plugin settings. `POST /api/output-layer/stream` requires a valid `sessionId` in the strict display-input schema and returns NDJSON events. The normal bearer-auth gate applies; closing the stream aborts only its native model request.

A preset starts with no model selected. An absent, empty or whitespace-only `modelId` without a complete custom-model binding returns `failed` before resolving any requester; the host never uses the main/default model. A selected catalog model uses `IModelCatalog.getRequester`. A custom model uses `getConnectionRequester(connectionId, customModelId, contextWindow)`, building a transient model through the same provider, OAuth and governance path without inserting it into the model registry. Neither path passes tools to the model. Only supplied original/output history pairs and the current display group are sent. `maxOutputTokens` is optional: when absent the output layer supplies no completion cap, while an explicit positive cap is preserved within the model's output limit. The native requester still applies model and remaining-context limits.

`started` returns the effective `cycleId`, `historyReset`, model window and estimated input tokens. `delta` appends text, `reset` discards a failed attempt's partial text, and `completed`, `failed` or `cancelled` ends the request. Thinking and tool parts are not projected into reading output.

## History and derived results

`apps/kiki-gui/src/lib/outputLayerClient.ts` serializes generation and appends only completed original/output pairs. A cycle has a fixed instruction prefix. At the configured history budget or model input-window limit, the host clears the whole history and generates a new cycle ID before the reset group's request. The client adopts that ID from `started`, so the reset request and subsequent append requests share one provider cache key. The default budget is 16,384 tokens; `0` disables history. The current group must fit within the input window after reserving an explicitly configured output cap, if any, or generation fails with an actionable message.

Derived reading results are separate from model-visible history. `clearHistory` retains them; `clearResults` cancels affected work and removes them. The GUI supplies a storage adapter bound to its connection/home namespace. Source identity includes session, source ID, revision and text; preset changes and history-budget changes produce new result identities. Each result records the history sources actually used, so source invalidation removes dependent results and cancels pending requests for that session.

## Focused checks

- `test/app/outputLayer/outputLayer.test.ts`: persisted session/workspace/global usage, unknown-session rejection, empty-model rejection and explicit catalog/custom model selection, optional output cap, templates and saved edits, text-only input, whole-cycle reset and continued cache key/prefix, failure and cancellation.
- `test/app/plugin/liveReload.test.ts`, case `hot-enables and updates a display-only panel backend beside the same live conversation`: an installed panel backend is enabled and replaced beside an already-live agent, with no tools added.
- `packages/kap-server/test/outputLayer.test.ts`: authenticated HTTP configuration and NDJSON generation with a mock provider, strict input rejection, provider failure and disconnect cancellation.
- `packages/kap-server/test/plugins.integration.ts`, case `supports sessionless settings panels`: settings ownership, secret redaction, model choices and denied conversation actions.
- `apps/kiki-gui/src/lib/outputLayerClient.test.ts`: serialized history, returned cycle IDs, derived-cache reopen, configuration snapshots, invalidation and Unicode grouping.
