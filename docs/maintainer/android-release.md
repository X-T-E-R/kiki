# Build and verify Android APKs

Android packaging lives in `apps/kiki-gui/mobile`. Ordinary CI produces debug APKs; the product tag workflow adds a persistently signed APK to the existing desktop/CLI Release. Use the manual signing check to validate credentials and download a signed build without creating a tag or publishing assets.

## Choose a build

| Workflow | Trigger | Download |
| --- | --- | --- |
| `kiki-android-ci.yml` | Relevant branch push or PR; manual dispatch | `kiki-android-debug-<run-id>-<producer-attempt>`, retained 14 days |
| `kiki-android-signing-check.yml` | Manual dispatch on the chosen branch, protected by environment `release` | `kiki-android-signing-check-<run-id>-<producer-attempt>`, retained 7 days |
| `kiki-desktop-release.yml` | A new immutable `kiki-v<version>` or `kiki-v<version>-beta.<n>` tag; dispatch with an existing tag | `kiki-release-android-<run-id>-<producer-attempt>`, retained 7 days, then exact APK/checksum/receipt on the product Release |

Each artifact contains one APK, its adjacent `.sha256`, and `android-receipt.json`. Names end in `android-debug.apk`, `android-release-check.apk`, or `android-release.apk` respectively. The receipt records package ID `ai.easyagent.kiki`, GUI version, source commit, repository, run/producer attempt, APK digest, signing certificate fingerprint, and build-tools version. Only product candidates carry a tag and frozen prepare identity; signing-check artifacts cannot be consumed as product candidates.

`versionName` comes from `apps/kiki-gui/package.json`, not the private mobile npm package. `scripts/android-version.mjs` preserves the shell's existing `major * 1000000 + minor * 1000 + patch` code mapping, rejects components outside its range, and keeps the full beta suffix in `versionName`. A beta and stable version with the same three numeric components share a versionCode. The product prepare step also checks the unified CLI/GUI/Tauri/Cargo/system versions against the tag.

## Configure persistent signing

Keep one backed-up PKCS12 release keystore for upgrades. Configure these four **environment secrets** in GitHub's `release` environment; do not put credentials in repository files, command arguments, or build artifacts.

| Secret | Value |
| --- | --- |
| `KIKI_ANDROID_KEYSTORE_BASE64` | Base64 encoding of the persistent PKCS12 keystore |
| `KIKI_ANDROID_STORE_PASSWORD` | Keystore password |
| `KIKI_ANDROID_KEY_ALIAS` | The actual private-key entry alias, including a numeric alias if applicable |
| `KIKI_ANDROID_KEY_PASSWORD` | That entry's password |

Set the **repository variable** `KIKI_ANDROID_SIGNING_CERT_SHA256` to the corresponding public certificate's SHA-256 fingerprint (64 hex digits; colons are accepted). Protect the `release` environment's branch access and approvals. Recover the existing keystore and credentials from their secure backups when needed; generating a replacement identity breaks upgrades for existing installations.

The signing step materializes the keystore only under `RUNNER_TEMP`. Gradle reads its path and the other three values from the environment, uses `storeType 'PKCS12'`, and rejects release tasks when inputs are missing. The verifier requires the expected certificate, a non-debuggable package, the exact version and application ID, API 24 minimum/API 36 target, and the packaged launcher/icon/shortcut resources. The keystore is removed by an `always()` step. A missing input, wrong certificate, version mismatch, invalid APK signature, or build failure stops artifact upload; there is no debug-signing substitute.

## Verify on GitHub Actions without publishing

After the implementation is on the repository's default branch, dispatch the debug build and the signing check on the branch you want to verify. These workflows have only `contents: read` and do not create tags or Releases.

```sh
branch="$(gh repo view X-T-E-R/kiki --json defaultBranchRef --jq .defaultBranchRef.name)"
gh workflow run kiki-android-ci.yml --repo X-T-E-R/kiki --ref "$branch"
gh workflow run kiki-android-signing-check.yml --repo X-T-E-R/kiki --ref "$branch"
gh run list --repo X-T-E-R/kiki --workflow kiki-android-ci.yml --branch "$branch" --limit 3
gh run list --repo X-T-E-R/kiki --workflow kiki-android-signing-check.yml --branch "$branch" --limit 3
```

Select each run by its source commit, wait for success (and approve environment `release` if required), then inspect and download it. For example, replace the example run ID below with the selected debug run:

```sh
run=123456789
attempt="$(gh api "repos/X-T-E-R/kiki/actions/runs/$run" --jq .run_attempt)"
gh run view "$run" --repo X-T-E-R/kiki --json headSha,conclusion,url
gh run download "$run" --repo X-T-E-R/kiki \
  --name "kiki-android-debug-$run-$attempt" --dir android-debug
(cd android-debug && sha256sum -c ./*.apk.sha256)
```

For the signing check, download `kiki-android-signing-check-$run-$attempt` into a separate empty directory. Inspect `android-receipt.json`: expect `variant: release-check`, `debuggable: false`, the selected source SHA, and the repository's public signing fingerprint. With a checkout of that exact source, Java 21, and `ANDROID_HOME` containing build-tools 36.1.0, verify the downloaded APK directly:

```sh
GITHUB_REPOSITORY=X-T-E-R/kiki KIKI_SOURCE_SHA="$(git rev-parse HEAD)" \
  GITHUB_RUN_ID="$run" GITHUB_RUN_ATTEMPT="$attempt" \
  KIKI_ANDROID_SIGNING_CERT_SHA256="$(gh variable get KIKI_ANDROID_SIGNING_CERT_SHA256 --repo X-T-E-R/kiki)" \
  node apps/kiki-gui/mobile/scripts/android-artifact.mjs verify \
    --variant release-check --directory android-signing-check
```

Use `--variant debug` and the debug run's coordinates/directory to verify a debug download; no certificate variable is needed. Save the run URL, artifact ID, receipt and checksum result as the build evidence. [Installation instructions](../en/getting-started/installation.md#install-the-android-app) explain certificate changes and data retained during upgrades.

## Product tag consumption and recovery

Use a new tag containing the Android packaging implementation and the matching unified version. Do not re-tag or add Android assets to an already-public release that lacks them.

The prepare job adds `android-release-input.json` to the existing immutable release-input artifact. It binds the public Android certificate, mobile npm lock, source/tag/version and the native prepare receipt identity. The protected Android job checks out that exact source and consumes that artifact ID before signing. No catalog, desktop/CLI frozen input, native platform matrix, or updater key is replaced.

The publisher selects the latest successful Android producer attempt within the same workflow run, downloads it by artifact ID, verifies its receipt against the same prepare input, and runs the APK verifier again. It uploads the exact three files through the existing no-replacement asset loop, downloads them back, and byte-compares them before publishing. Existing draft assets must match exactly. Published assets are reused only if identical; a missing or different public asset fails instead of being replaced.

If a job fails, fix the named input or build error and use **Re-run failed jobs** while the immutable artifacts remain available. A publisher-only retry can reuse a successful prior Android producer attempt. If prepare is rerun, rerun every consumer against the new prepare artifact; receipts reject mixed inputs. If an APK was already uploaded to a draft and rebuilding changes its bytes, keep the earlier exact candidate for recovery rather than overwriting the asset. After artifact expiry, use a new authorized release attempt with a coherent candidate set; never bypass byte or certificate checks.

## Local checks

The mobile npm package is intentionally outside the root pnpm workspace and has its own committed npm lock. Use Node from `.nvmrc`, Java 21, Android SDK platform 36 and build-tools 36.1.0; no local prior `build/` directory is needed.

```sh
cd apps/kiki-gui/mobile
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run android:version
npm run android:debug
```

`npm run android:release` requires `KIKI_ANDROID_KEYSTORE_FILE`, `KIKI_ANDROID_STORE_PASSWORD`, `KIKI_ANDROID_KEY_ALIAS`, and `KIKI_ANDROID_KEY_PASSWORD` already provided through an authorized secret mechanism. Prefer the protected Actions signing check for credential verification. iOS source is retained, but there is no signed iOS distribution or App Store publishing workflow.
