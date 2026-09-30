# S5: Windows desktop soak and recall comparison

These scripts prepare the default-enablement evidence; they do not enable desktop search or delete old indexes. The current recommendation is **keep desktop full-text search opt-in**. A short standalone run is useful diagnostics, not desktop acceptance.

## State push contract

The existing authenticated `/api/klient/events` WebSocket carries the public global event `search.indexStateChanged`. Its source is the non-durable App bus event `event.search.index_state_changed`, published by the search service from indexer IPC status/commit/lifecycle notifications. No session subscription is needed. The payload is a complete snapshot:

```json
{
  "state": "building",
  "indexed_sessions": 25,
  "total_sessions": 358,
  "documents": 5000,
  "stale": true
}
```

`state` is `building | ready | readonly | unavailable`; optional `reason` uses the same reason vocabulary as `/api/search` (`disabled`, `indexer_backoff`, `memory_budget`, `wal_stuck`, `disk_low`, `corrupt_rebuilding`, `sqlite_unavailable`, `runtime_disabled`). `degraded` is optional in the schema. Identical snapshots are suppressed. Counts advance after commits, not after each wire line; large sessions can take time between progress updates. This is latest-state delivery, not a durable/replayed event log. Older servers do not provide this event.

GUI stores pushed snapshots in the `search-index-state` query cache and cancels older in-flight status reads. It reads `/api/search/status` on first use, after subscription attachment and on reconnect, and after a manual restart/recheck; the status card has no periodic polling. The SQLite background builder is the push source; the retained MiniDb rollback does not have live progress notifications.

## Prepare safely

1. Record the exact candidate commit, Node/desktop version, Windows version and hardware, disk free space, archive counts/bytes and experimental settings. Use the same source snapshot for both recall implementations. Do not commit transcripts or captured query results.
2. Back up the **location** of `<KIKI_HOME>/search-index-v2` and the config. Keep `<KIKI_HOME>/search-index` intact. If a real-desktop cold build is needed, stop every process using the home before moving the derived v2 directory aside; never modify or delete `sessions`. The scripts do not perform this operation.
3. Install the candidate with your normal local desktop build procedure. Enable desktop search explicitly (`[search] enabled = true` or the desktop search setting), restart, and enable loopback-only debug endpoints for observation. Do not change defaults as part of a measurement.
4. Get the backend PID from the desktop process tree. Do not confuse the Tauri/WebView frontend PID with the backend or the indexer. Pass the backend URL/token through `KIKI_S5_URL` and `KIKI_S5_TOKEN` in a private shell; never put the token in a recorded command or public report.
5. Run from the repository root with Node 24.15.0+ and `pnpm install --offline --frozen-lockfile`. Output directories must be **new**; scripts refuse to overwrite reports or databases. Outputs contain session identifiers and queries and should stay private (`.tmp/` is ignored).

## Cold build and standalone diagnostic

`harness` runs the production `SqliteSearchHost` (one child writer and three query readers), enumerates source session directories read-only, and writes only a new derived DB under the output directory. It queries `session` once per sample. It does not start the desktop GUI, model traffic, watchers or the full server coordinator; session titles are not supplied by this directory-only inventory. A frozen snapshot is preferred; reading a live archive is a moving-source diagnostic, not parity evidence.

```powershell
pnpm exec tsx packages/kap-server/scripts/search-s5-soak.mts harness C:/data/sessions-snapshot .tmp/search-s5-short 240 5
# Allow cold build plus at least 24 hours after ready:
pnpm exec tsx packages/kap-server/scripts/search-s5-soak.mts harness C:/data/sessions-snapshot .tmp/search-s5-harness-full 90000 10
```

`report.json` records the idle harness baseline, whole-run sampled peaks, post-ready RSS regression, query latency/errors, final progress, WAL and `quick_check`. `samples.jsonl` retains cold-build samples too. Main RSS comes from `process.memoryUsage()` (includes the query worker threads); child RSS comes from Windows `Get-Process.WorkingSet64`. Debug/self-reported child RSS is also retained. Sampling is not an instantaneous peak measurement; increase sampling frequency if needed. Indexer status counters are periodically reported and can lag a sample.

## Real desktop: cold phase, then 24 hours warm

Start a short observer during the cold build to retain the baseline, OS RSS, availability and WAL samples. Keep the GUI open, use an agent normally, and separately record whether it reconnects, becomes unresponsive, or logs a heap-watchdog trigger. The observer cannot prove GUI usability or detect watchdog lines by itself.

```powershell
# Example backend PID only; replace with the actual candidate's backend PID.
pnpm exec tsx packages/kap-server/scripts/search-s5-soak.mts desktop 12345 .tmp/search-s5-desktop-cold 1800 1
# Once the index is ready, start the actual warm soak and use the agent normally:
pnpm exec tsx packages/kap-server/scripts/search-s5-soak.mts desktop 12345 .tmp/search-s5-desktop-24h 86400 10
```

`desktop` only observes a loopback backend and its indexer; it does not submit prompts, alter config, or query transcripts. A PID change, fetch failure, closed backend, or missing debug status is a sample error, not a zero-memory sample. The report counts such errors; investigate every one. Preserve backend logs separately and search for `memory_budget`, indexer exits, watchdog and reconnection errors. A state sampled between failures is not a substitute for the log history. Regression covers the whole desktop observation window, so start the warm run **after** ready. `full24h` only means the duration requirement was observed; it is not an acceptance flag.

Accept only with all evidence: no GUI reconnects during cold build, no heap-watchdog triggers, backend peak at most idle baseline + 350 MiB, indexer peak at most 768 MiB, at least 24 warm hours, backend and indexer RSS slope at most 5 MiB/hour, WAL at most 64 MiB, no `memory_budget` log entries and no unexplained sample errors. Include the log review and GUI observation in the report. A short-window slope extrapolation is not a leak diagnosis and cannot satisfy the 24-hour gate.

## Recall: old implementation versus candidate

Copy `search-s5-queries.json` to a private file and adapt its queries to actual remembered content before measuring. Keep exactly 20 queries: 10 Chinese, 10 English/code, with two-character literal queries. Do not replace a failing broad query solely to improve the metric. The checked-in set is a repeatable diagnostic example, not a claim that these are representative user queries.

Run the old implementation on a separate development server/home/index backed by the same frozen source corpus; do not run the old MiniDb memory-heavy index in the production desktop. Record its commit/backend selection. Verify both endpoints are index-ready; do not mix live-session scans into this comparison (queries here have no session container). Export all pages, not just the first page:

```powershell
# KIKI_S5_TOKEN must match each endpoint; set it privately before each capture.
pnpm exec tsx packages/kap-server/scripts/search-s5-recall.mts api http://127.0.0.1:58627 .tmp/queries.json .tmp/old-results.json
pnpm exec tsx packages/kap-server/scripts/search-s5-recall.mts api http://127.0.0.1:58628 .tmp/queries.json .tmp/new-results.json
pnpm exec tsx packages/kap-server/scripts/search-s5-recall.mts compare .tmp/old-results.json .tmp/new-results.json .tmp/recall-report.json .tmp/policy-exclusions.json
```

Use `[]` for no exclusions. For each old hit removed by the new extraction policy, provide an explicit `{ "queryId": "zh01", "key": "<exact key string from old-results.json>", "reason": "subagent content excluded by default" }` record. Verify this against the original transcript. Allowed policy explanations include default-excluded subagents, tool content beyond 4,096 characters, binary removal and oversized records; do not classify unexplained misses or deadline/candidate-cap omissions as policy exclusions. Explain every remaining difference in the report. Never paste private identifiers into public docs.

The comparison deduplicates public hit identities `(session, agent, role, time, turn, step)`; it is **logical-hit recall**, not raw document recall (multiple same-identity wire records merge). Inspect collisions and duplicates when reviewing differences. `comparisonThresholdMet` requires the 20-query mix, complete responses and at least 95% micro-averaged recall over retained baseline identities. It is not S5 acceptance: endpoint provenance, content-policy annotations, same-corpus identity and desktop stability still require independent review. No-baseline-hit queries are reported with null recall; count them and choose genuinely useful queries for the acceptance run. Any `incomplete` makes the completeness gate fail.

For a diagnostic independent of FTS candidate generation, compare SQLite queries against a streaming SQL scan of **the retained derived text**, not against the old implementation:

```powershell
pnpm exec tsx packages/kap-server/scripts/search-s5-recall.mts sqlite .tmp/search-s5-short/index.sqlite packages/kap-server/scripts/search-s5-queries.json .tmp/candidate.json
pnpm exec tsx packages/kap-server/scripts/search-s5-recall.mts sql-truth .tmp/search-s5-short/index.sqlite packages/kap-server/scripts/search-s5-queries.json .tmp/truth.json
pnpm exec tsx packages/kap-server/scripts/search-s5-recall.mts compare .tmp/truth.json .tmp/candidate.json .tmp/derived-recall.json
```

The SQL scan reuses the lexical normalization/tokenizer but bypasses FTS, deadlines and candidate caps. It can detect bounded-query omissions, not extractor omissions. Both SQLite modes open the DB read-only. Capture after the writer has stopped; do not copy a live WAL database without SQLite-consistent backup.

## Short-run evidence (2026-09-30)

Windows, Node v24.19.0; directory-only harness reading a real, live archive without writing it. This is not a frozen L1 snapshot or a bundled desktop run. Requested 240 seconds at 5-second sampling; actual 245.278 seconds including close/check. Raw private artifacts remain under `.tmp/search-s5-short-valid/`; no transcript contents are checked in.

| Measurement | Result |
| --- | ---: |
| Sessions / documents / main wire files read | 358 / 113,549 / 350 |
| Wire bytes read / DB bytes | 1,880,908,257 / 614,010,880 |
| Cold ready time | 166.444 s |
| Baseline harness RSS | 120.039 MiB |
| Whole-run sampled main / indexer peak | 320.875 / 304.199 MiB |
| Warm main / indexer peak (15 samples, roughly 75 s) | 241.961 / 303.289 MiB |
| Warm main / indexer slope | 54.832 / 0 MiB/h |
| Peak WAL / final WAL | 27,064,312 / 0 B |
| Queries / P95 / query errors | 48 / 31.936 ms / 0 |
| Sample errors / memory-budget samples / watchdog timeouts | 0 / 0 / 0 |
| quick_check | ok |

The whole-run peaks were calculated from the retained 48 raw samples; the initial report's `main`/`indexer` metrics describe the post-ready window. No desktop baseline or GUI continuity claim follows from these numbers. The main short-window slope exceeds the 5 MiB/h target and needs a real warm soak, not extrapolation or an assumption that GC will fix it.

On that derived corpus, the 20-query SQL-scan comparison retained 15,527 logical identities and found 5,398: **34.765% overall recall**. The 18 complete queries recovered all 2,794 identities. `权限` was marked `deadline` (1,580 of 1,701), and the broad ASCII literal `WS` was marked `candidate_cap` (1,024 of 11,032). These are bounded-query omissions, not policy exclusions; the complete-response/95% gate did not pass. This was **not an old-implementation comparison**. Earlier exploratory runs with non-integer inventory timestamps or missing literal normalization were repaired and are not accepted measurement evidence.

**Decision recommendation:** do not change the desktop default yet. Complete the real GUI cold-build observation, 24-hour normal-use soak and same-snapshot old-implementation comparison; review broad/short-query omissions before default enablement. Do not remove the old index as part of this task. Deleting it requires a separately approved cleanup after all gates pass.
