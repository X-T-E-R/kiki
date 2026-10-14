# Source-owned adapters

Managed executor adapters change only when a caller posts `POST /api/executors/{id}/install` or `POST /api/executors/{id}/rollback`. The request and response a caller can rely on are in [Executor catalog and checks](../en/server/rest-api.md#executor-catalog-and-checks) and [执行器目录与检查](../zh/server/rest-api.md#执行器目录与检查). This page records which installer runs, where the bytes come from, and what a failed write or a failed installation record leaves on disk.

## Pinned npm releases

`MANAGED_ADAPTER_RELEASES` in `packages/agent-core-v2/src/app/agentExecutor/managedAdapterRegistry.ts` pins `claude-acp` (`@agentclientprotocol/claude-agent-acp` 0.84.0, entry `dist/index.js`) and `codex-acp` (`@agentclientprotocol/codex-acp` 2.0.0, entry `dist/index.js`). `ManagedAdapterService.install` packs the pinned tarball URL with `npm pack` into `<home>/.tmp/managed-executors/<id>/<installId>`. It rejects a filename that is not one `.tgz` segment, an empty archive, an archive larger than 32 MiB, and a sha512 mismatch. It then runs `npm install --prefix <home>/tools/managed-executors/<id>/<version>-<installId> --ignore-scripts --no-audit --no-fund --save-exact` on that archive. The installation record is written only after the entry file exists and `package.json` name and version match the pin. A failure before that write leaves the previous active record in place and sets `phase` to `failed`. Rollback of these releases swaps `active` and `previous` in the record. They have no `targetDir`, so rollback does not copy files. `GET /api/executors/installations` lists the pins at `phase: idle` with no `active` when nothing is installed, and does not install them.

## Bundle root

The source-owned set is `SOURCE_OWNED_ADAPTER_FILES`: `agy-cli-acp.mjs`, `agy-hook-registration.mjs`, and `agy-permission-hook.mjs`. `scripts/external-harness/production-manifest.mjs` is the same list. Package, version `0.4.1`, and source `bundled:external-harness` live on that manifest as `SOURCE_OWNED_ADAPTER_PACKAGE`, `SOURCE_OWNED_ADAPTER_VERSION`, and `SOURCE_OWNED_ADAPTER_SOURCE`. Files under `scripts/external-harness` that are not in the list are not installed.

`getSourceOwnedAdapterRoot` in `apps/kimi-code/src/native/native-assets.ts` returns a directory only when all three files are present. It prefers the SEA asset `external-harness/agy-cli-acp.mjs`. When the caller did not pass an asset source or manifest, it then tries `./external-harness`, `../external-harness`, and `../../dist/external-harness` beside the module. `apps/kimi-code/src/main.ts` publishes a found root as `KIKI_SOURCE_OWNED_ADAPTER_ROOT`. npm `lite` and `full` both stage the three files at `dist/external-harness`. The SEA manifest carries the same three under `runtime/external-harness/`. `apps/kimi-code/scripts/native/external-harness-assets.mjs` collects and copies them.

`ManagedAdapterService` uses `KIKI_SOURCE_OWNED_ADAPTER_ROOT` when that variable is set. A set path that does not contain every file fails with `Source-owned adapter resources are unavailable` and does not fall through. An unset variable walks up at most eight parents for `scripts/external-harness`, then tries `external-harness` beside the compiled module.

## Selection, install, and rollback

`sourceOwnedAdapterScript` selects an executor only when the selected source is one `node-script` whose basename is `agy-cli-acp.mjs`. A path lookup, ambiguous selection, or unknown id returns not found without changing files. A selected script whose path is relative after `~` and `${KIKI_HOME}` expand instead fails validation with envelope code `40001`. The id is the executor the caller selected.

Install replaces only the three names in the script's parent directory. Env, model, permissions, and `supports_mcp` are not rewritten: an existing false stays false, and an existing true stays true. Other files in that directory stay. Snapshots live under `<home>/tools/managed-executors/<id>/<version>-<installId>`. When the current three files differ from the bundle, the pre-write snapshot uses version `0.0.0` and source `snapshot:local-adapter`. The new bundle is snapshotted before production is replaced. A production copy that already matches the bundle, with the same stored version and integrity, returns without writing.

HTTP status comes from `projectManagedStatus` in `packages/kap-server/src/routes/agentProfiles.ts`. It has `id`, `release` (`package_name`, `version`, `integrity`, `source`, `entry`), `active`, `previous`, `phase`, and `error`. It omits `supportsMcp` and `targetDir`. Source-owned `active.version` is `0.4.1`, `release.source` is `bundled:external-harness`, and `release.entry` is `agy-cli-acp.mjs`.

Rollback of a source-owned install writes the previous snapshot over the three names, then swaps `active` and `previous`. A second rollback swaps those two copies again. Custom files stay where they are.

## Failed writes and failed records

A production read that fails for a reason other than a missing file stops before any write. The three files and the installation record stay as they were. A missing name is absent. If a later write fails, that name is deleted instead of being restored from bytes that were never read.

`replaceProduction` remembers each name it attempts. If a write throws, it writes the original bytes back for names that existed and deletes names that did not. The call then fails with the write error. If saving the installation record throws and the files were not already the bundle, install runs that same restore for all three names from the bytes read before the write, then fails with the record error. If the files already matched, a failed record update does not rewrite them. If saving the rollback record throws, rollback writes the active snapshot back over the three names, then fails with the record error. The stored record is the one from before that failed update. When install had not stored a record yet, it stays absent.

If the restore write itself throws, the call rejects with `Error2` code `CONFIG_INVALID`; HTTP maps it to envelope `40001`. Install also records `phase: failed` and the diagnosis in `error`. Rollback propagates the request error without updating those progress fields, so its later status must not be treated as proof that the rollback succeeded. The request diagnoses are:

- Restoring production bytes, including when the install-record update fails and putting the earlier bytes back also fails: `Source-owned adapter restore failed after a partial write: <cause>`.
- Putting the active snapshot back fails with `Source-owned adapter restore failed after the installation record update failed: <cause>`. That restore runs when the rollback record update fails, and also when the previous snapshot could not be applied and the active copy cannot be written back either. In the second case the record update has not run; the stored record is still the pre-rollback record.

A rollback that cannot read its previous snapshot, for a reason other than not-found, leaves the installed files and the active record in place and rejects with that read error. Pinned npm installs do not use this byte restore. Their record moves only after the pack and metadata checks above.

## Next spawn

`status().supportsMcp` is true only when the bundle can be read and the three production files match it. That value is not written into the executor document, so it stays independent of the preserved `supports_mcp` field. The installed entry contains `registerMcpAgent`. The next spawn of that executor reads the replaced files; a process that is already running is not restarted. After a rollback to bytes that do not match the bundle, `status().supportsMcp` is false again. The HTTP status still omits the field.

## Verification

- `packages/agent-core-v2/test/app/agentExecutor/managedAdapterService.test.ts`, `managed ACP adapter installation`: immutable version root, atomic pointer swap, mismatched archive, metadata before activation, failed upgrade, and the cross-process install lock.
- Same file, `source-owned adapter installation`: selected install, truncated write, failed restore, record-update failure, rollback record failure, a production read that is not not-found, an unreadable previous snapshot, and the production manifest.
- `packages/kap-server/test/agentProfiles.integration.ts`: `lists managed adapter releases without installing and rejects unknown adapter IDs`; `installs and rolls back the selected source-owned adapter without changing executor config`.
- `apps/kimi-code/test/native/external-harness-assets.test.ts`: the three production scripts through the SEA manifest, npm dist, and extraction.
