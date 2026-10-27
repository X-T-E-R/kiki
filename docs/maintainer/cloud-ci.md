# Run tests on the cloud runners

Use **Kiki Cloud CI** from the Actions page on the `kiki` branch, or dispatch it with GitHub CLI:

```sh
gh workflow run kiki-cloud-ci.yml --repo X-T-E-R/kiki --ref kiki \
  -f target=both -f suite=smoke -f shard=1/5
gh run list --repo X-T-E-R/kiki --workflow kiki-cloud-ci.yml --limit 5
gh run watch RUN_ID --repo X-T-E-R/kiki --exit-status
```

Both runners must be online for `target=both` to finish. Each job records its runner, commit, suite, shard and outcome in the run summary. A failure remains a failed job.

## Choose a test selection

| Selection | What runs | Target |
| --- | --- | --- |
| `smoke` | CI partition and desktop updater contract tests | `baidu`, `tencent`, or `both` |
| `transcript` | The transcript package test suite | `baidu`, `tencent`, or `both` |
| `ordinary-shard` | One of the existing five ordinary CI shards, excluding GUI and media-preview lanes | `tencent` |

For example, run the third ordinary shard with `-f target=tencent -f suite=ordinary-shard -f shard=3/5`. Run all five shard selections to cover the ordinary lane. GUI, real media preview, lint, typecheck and packaging remain in the existing GitHub-hosted CI workflow.

The workflow installs the locked dependencies and uses `.nvmrc` and the repository's pnpm version. Ordinary shards build the same native auth and PTY dependencies as hosted CI. Vitest uses one worker; the workflow does not increase the Node heap limit.

## Runner contract

The workflow selects Linux x64 machines with the common `kiki-ci` label and a provider label:

| Runner | Provider label | Capacity label | Planned service limit |
| --- | --- | --- | --- |
| `kiki-baidu-01` | `baidu` | `kiki-small` | 150% CPU, 3 GiB memory |
| `kiki-tencent-01` | `tencent` | `kiki-medium` | 300% CPU, 5 GiB memory |

Each runner processes one job at a time. The cloud host configuration owns service limits, the dedicated non-root account and runner installation. The repository workflow owns test selection. Keep deployment credentials, Docker access and sudo privileges out of the runner account.

Only manual dispatch on `X-T-E-R/kiki` at `refs/heads/kiki` is accepted by this workflow. The host must also enforce those repository, event and ref values in a root-owned job-start hook before accepting jobs; labels alone do not stop another public-PR workflow from targeting a registered runner. Preserve this check when updating the runner service.

## Recover an unavailable runner

Check the registered runners before dispatching:

```sh
gh api repos/X-T-E-R/kiki/actions/runners \
  --jq '.runners[] | {name,status,busy,labels:[.labels[].name]}'
```

If a runner is offline, inspect its service and runner diagnostic logs on that host. These machines need outbound HTTPS on port 443, not a domain or a new public listener. Check access to GitHub, Actions, release assets and the package registry separately; successful access to `api.github.com` does not establish access to `github.com`. The [GitHub runner network reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#requirements-for-communication-with-github) lists the endpoints by function.

After restoring the service, run `smoke` on that provider and check its actual job result before using a heavier suite.
