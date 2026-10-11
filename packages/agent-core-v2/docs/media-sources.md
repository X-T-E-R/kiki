# Media source management

The App-scoped `IPluginMediaService` owns installed media-source management and job persistence. `IPluginHostService` resolves each source into a runtime adapter; `IPluginSettingsService` remains the only settings write path. The public client surface is `klient.global.media`. These additions do not change the plugin SDK's media outcome or handle protocol.

## Client contract

`packages/protocol/src/media-management.ts` owns the validated management schemas. `packages/klient/src/contract/global/media.ts` exposes them through the normal service dispatcher.

- `managedSources()` returns installed source groups, including disabled and removed entries.
- `sourceSettings({ provider })` accepts any definition in a group and returns that group's settings view.
- `updateSource({ provider, values?, enabled?, removed? })` changes only that source. Setting `null` clears a value, including an inherited credential. Removal is a reversible tombstone, not package uninstall.
- `addScriptSource({ id, label, kinds, command, args?, cwd?, protocol?, format?, mime?, environment? })` adds a trusted local command to the installed `kiki-media` package. The protocol defaults to `file`; `json` supports accepted handles and subsequent actions. A saved id cannot be reused, even after removal.

A `MediaManagedSource` includes its representative `provider`, stable `sourceId`, owning `pluginId`, definitions, schema, non-secret `values`, `secretsConfigured` and `missing` fields. Provider selection uses a definition's full `${pluginId}/${definition.id}`, not a vendor label. A group can offer several definitions for image, video and speech defaults. Script metadata is returned in `values`; only its environment is an editable secret setting. Command metadata is fixed for that source id.

The existing `sources()` and `setSources()` methods still manage marketplace catalog subscriptions. They are not the installed-source roster.

## Manifest and settings

A plugin may declare `x-kiki.mediaSources` groups with `id`, `label`, `providerIds`, `settingsPrefix`, optional `legacyPluginId` and required source-local setting names. Each definition remains declared in `mediaProviders`. Groups must have distinct ids, prefixes and provider assignments; their required settings must exist in the plugin's settings schema.

A group strips its prefix when passing settings to the adapter. The unified package uses `<vendor>__` prefixes and `enabled`, `removed`, `cleared` lifecycle keys. Defaults are applied for execution, while the compatibility fingerprint covers that source's effective saved configuration rather than unrelated source settings or lifecycle keys. Changing a sibling source therefore does not invalidate an accepted handle.

`mediaScriptProvider` names one declared static runtime adapter. Its `scriptSources` string setting contains the validated descriptor array; the host expands descriptors into `script-<id>` definitions. Environment values use dynamic secret settings named `script_<id>__environment`. The host routes each dynamic definition to the static adapter with only that descriptor and environment. The descriptor array supports up to 1,000 unique source ids.

Settings and secret strings use the existing `pluginSettings` configuration storage. Inspection redacts secret values; this is not an encrypted vault. Selected Kiki connections use the existing authentication bridge and OAuth refresh owner. The migration does not copy refresh tokens or infer media entitlement from a text subscription.

## Upgrade and recovery

When an enabled grouped package replaces an installed legacy vendor package, new-provider discovery hides the duplicate legacy registration. New requests using the old default-provider id resolve to the unified definition. The host reads the legacy package's settings as source defaults until a field is overridden or explicitly cleared. A disabled legacy package's enabled intent is inherited unless the source has an explicit enabled override.

Existing jobs are not rewritten. Their original provider id, source identity, compatibility fingerprint and accepted handle stay intact. They execute against the original installed package, which must remain enabled and retain its compatible configuration. A unified source's lifecycle controls the unified adapter; it does not uninstall or disable that original package. Completed original `file_id` artifacts remain available independently of the source roster.

A unified job needs its source restored and its original compatible endpoint, credential and resume version. A changed source configuration blocks polling with `needs_provider` while preserving its handle; restoring the configuration permits polling or downloading, never a new submission. A host restart without an accepted handle or staged outcome remains `unknown` and cannot silently purchase another generation. Staging and final publication keep the existing session-owned media store and Task notification path.

## Verification and lineage

The ten vendor adapters and shared runtime in the standalone plugin repository are mechanically adapted into `kiki-media`; their existing protocol fixtures remain the donor evidence. Group management, legacy aliases and independent-script routing are Kiki-only additions. The script bridge executes a command and argument array without a shell and uses the existing installation trust decision, not a new approval or sandbox layer.

`test/app/plugin/media.test.ts` contains the claim-matched HTTP ZIP install, source lifecycle, original image publication, legacy configuration and accepted-handle upgrade/restart fixtures. Its unified-package cases use `KIKI_MEDIA_SINGLE_PLUGIN_ROOT` and optionally `KIKI_MEDIA_SINGLE_PLUGIN_ZIP`; unexpected fixture HTTP requests fail. It also covers 100 custom sources and a JSON handle blocked by an environment change, then restored without resubmission. `test/agent/pluginMedia/pluginMedia.test.ts` covers the real background Task, completion notification and original speech bytes. Klient input validation and facade routing are covered by `packages/klient/test/media-management.test.ts`; contract output parity is compiler-checked.

Documentation impact: maintainer contract completed here; plugin-generated source, manifest and catalog projections completed by the standalone plugin's sync scripts. User views `docs/en/customization/plugins.md` and `docs/zh/customization/plugins.md` require the unified-source configuration, script trust and legacy recovery sections before default-on or public release; the media release owner owns that catch-up. The standalone plugin README is the package-specific usage reference. GUI interaction and visual acceptance belong to the GUI consumer, not these backend fixtures.
