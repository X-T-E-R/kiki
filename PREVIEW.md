# Kiki preview status

Kiki is an independently developed fork of Kimi Code. This page describes the current repository preview, not a promise that every downloadable release contains the latest changes. Check `kiki --version` and the matching release notes when reporting a problem.

## What is available

The CLI/TUI, browser UI and desktop UI share the local server and session storage. Kiki supports conversation history, subagents, configurable models and tools, plugins, and external agent engines. See [README.md](README.md) for installation and the [documentation](https://x-t-e-r.github.io/kiki/en/) for configuration.

Global content search uses a disk-backed SQLite index by default in the CLI server. Indexing runs in a separate process; queries can return partial results while the background build is in progress. Settings → Search & retrieval shows index progress and availability, and offers a restart when an indexer failure is retryable. Progress is delivered over the shared WebSocket connection; opening the settings page or reconnecting refreshes the current status.

In the bundled desktop app, full-text indexing is **off by default**. Enable the experimental desktop search setting in Search & retrieval, or set `[search] enabled = true` in your config, then restart the backend. The indexer checks SQLite/FTS support and free disk space before building. Title search remains available with full-text indexing off.

## Known limitations

- Desktop content search has not passed the full 24-hour real-desktop soak and old-implementation recall comparison required for default enablement. A short standalone indexing run is not evidence that the desktop GUI stays connected during a full build.
- The default index covers session titles and main-agent user/assistant text (up to 20,000 characters per message), plus the first 4,096 characters of main-agent tool results. Subagent content is excluded by default. `[search] index_subagents = true` enables truncated subagent content after restart. Binary payloads, reasoning and oversized wire records are not indexed. Use `HistoryRead` to read complete turns rather than interpreting a search miss as proof that content never existed.
- Queries have work and time limits. Broad queries and two-character ASCII literal queries can return incomplete results; this is reported in the search response. Narrow the query or scope it to a session/workspace. Results during a build may cover only part of the archive, and stale results may lag recent changes.
- A first build needs additional disk space and time. The new index is stored under `<KIKI_HOME>/search-index-v2`; the old `search-index` directory is not automatically removed. Do not delete session data to repair a search index. Disable search and restart if indexing interferes with your work.
- External engines require their own installed executables, authentication and supported protocols. The settings checks are not a guarantee that an external provider or engine will accept every request.
- Standalone npm development requires Node.js 24.15.0 or later. Windows requires Git Bash. The macOS desktop download is unsigned and not notarized; follow the verification and first-open instructions in the README.

Keep backups of workspaces and session data before trying experimental settings. Local session storage does not mean requests are offline: model, search and integration providers receive the data required by the calls you configure. Review tool permissions and provider settings before running an agent on sensitive material.

## Give useful feedback

Report reproducible bugs at [GitHub Issues](https://github.com/X-T-E-R/kiki/issues). Include:

1. Kiki version, operating system, install method, and whether you used desktop, browser or terminal UI.
2. Steps to reproduce, the expected outcome, and what actually happened.
3. Relevant settings or experimental flags, without credentials.
4. For search issues: the visible index state, a sanitized query and scope, whether results were marked incomplete or stale, approximate archive size, and whether the problem happened during a build or after it completed.
5. A small sanitized log excerpt or screenshot, if useful. Remove bearer tokens, API keys, private paths, prompts and third-party personal data. Do not upload your entire home/session directory to a public issue.

For suspected security vulnerabilities, **do not open a public issue**. Follow [SECURITY.md](SECURITY.md) and report privately through GitHub Security Advisories.

Third-party attribution is recorded in [NOTICE](NOTICE). Maintainers can reproduce the search soak and recall checks with [the S5 procedure](packages/kap-server/scripts/search-s5.md); those checks do not change desktop defaults.
