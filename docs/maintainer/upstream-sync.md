# Upstream Synchronization (`kimi-code` → `kiki`)

Selected changes from upstream `kimi-code` enter this repository only through controlled reviews and isolated ports:

- Never merge upstream directly into `apps/*` or `packages/*`; accept selected upstream changes only through isolated cherry-picks or semantic ports.
- Review upstream at every release tag or every four weeks, whichever comes first. Filter candidates by commit title and touched paths before reading full diffs.
- Review security/CVE fixes, provider protocol mismatches, and wire or persistence data-corruption fixes as soon as they appear rather than waiting for the regular cadence.
- Exclude UI changes, cloud features, secondary-model work, and runtime-to-DI/actor migrations in the first filter unless a separate Kiki decision explicitly reopens that area.
- Record every accepted, adapted, deferred, rejected, or already-covered upstream commit in [`upstream-merge-log.md`](./upstream-merge-log.md) using its `Date | Upstream commit | Disposition | Local HEAD | Notes` table format.
