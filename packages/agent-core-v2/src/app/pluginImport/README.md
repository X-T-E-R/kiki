# History import ownership

`builtinHistory.ts` validates the first-party descriptor in `builtin/definition.json` against the existing source and settings schemas. `kiki-history` is a source namespace, not an installed plugin. The six source ids are `claude-code`, `codex`, `pi`, `grok`, `opencode` and `custom`; third-party installed and enabled sources still use the same contract.

## Execution and configuration

`PluginImportService` supplies source discovery, previews and durable jobs. `PluginHostService.requestSource` executes the built-in entry through the existing `PluginHost`, tracked requests and reload gates. It does not write installation records or scan input folders at startup. History import is a shipped capability with no experimental master switch. Discovery, previews and committing an import remain explicit user actions.

`PluginSettingsService` reads the built-in settings descriptor without looking up an installed manifest. Values stay in the existing on-disk `plugin_settings` section under `kiki-history`; the internal config domain is `pluginSettings`. This dictionary section has identity TOML codecs so plugin ids, setting keys and secret storage keys are not case-converted. Existing credential separation still puts secret values in `credentials/credentials.toml`. The sole setting is `customScript`, an absolute path to a trusted ES module exporting `discover`, `probe` and `parse`; empty uses `builtin/examples/custom-json.mjs`. The existing REST consumer is `client.rest.plugins.settings(id)` / `setSettings(id, { values })`. Custom scripts run with account permissions, not in a sandbox; their bytes and settings join the source revision so editing either requires a new preview.

## Resources and source lineage

`builtin/` is the only runtime rule tree. Core and bundled Node SDK builds copy it and `plugin/hostRunner.mjs` beside their bundled entry. The CLI's existing asset copy path and SEA collector include the same tree, notices and standalone custom example. SEA bootstrap supplies the extracted entry through the internal `KIKI_HISTORY_IMPORT_ENTRY` hook; source execution and ordinary copied bundles resolve it relative to their module. No alternative native parser or auto-install framework exists.

Claude Code and Codex adapt the MIT `session-migrate` production converters; Pi and Grok adapt the same project's v0.11.0 / `c23b1dbd21404f78be3b69d42ff4fb158ff52105` production units. The Python units are maintained here as JavaScript ports without a Python runtime dependency. OpenCode adapts the MIT production `transformShareData` grouping unit at `e00890c67261a435cee6409366a68999a93393fd`. It accepts official JSON exports and saved flat share arrays, not native SQLite databases. Licenses, authors and exact dispositions are in `builtin/THIRD_PARTY_NOTICES.md` and the Claude/Codex rule notices. These are converters, not a claim of upstream full-version compatibility.

The Pi/Grok/OpenCode transport limits each file to 64 MiB, validates required source relationships, splits long text on safe UTF-16 boundaries and bounds its normalized snapshot cache. The standalone custom JSON reader has the same file limit. Claude/Codex retain their streaming reader and 128 MiB per-line limit. Unsupported content is reported as counted losses; required relationship failures are rejected, not silently skipped. User-facing supported formats and limits live in `docs/en/customization/plugins.md` and its Chinese mirror.

## Commit and verification boundary

`nativeSession.ts` uses the existing ephemeral creation, context append, event flush and `saveEphemeral` publication path. Native identity includes canonical source home, revision and working directory: a duplicate reuses the committed session without rewriting Kiki continuation, while a changed revision or directory creates a separate session. Tool history is non-executable assistant text; foreign system state, usage, approvals and tasks are not installed. Existing archives and persisted source identities are not rewritten.

Claim-matched coverage lives in the existing tests:

- `test/app/plugin/pluginImport.test.ts`: built-in sources without installation, third-party sources, native conversation selection and Pi/Grok/OpenCode relationship validation.
- `packages/kap-server/test/pluginImport.integration.ts`: clean-home availability, existing REST settings, custom script revision changes, canonical native context, provider-backed continuation and archive compatibility; earlier native tests cover reopen and publication failure ownership.
- `apps/kimi-code/test/native/native-assets.test.ts`: copy and SEA extraction of the complete rule tree followed by loading all six registrations in a fresh Node process.

These checks do not substitute for a complete desktop/SEA build or a cross-platform/source-version matrix.
