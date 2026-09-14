# Hot-path unbounded-work checklist

Any new route, service method, poller, timer callback, or projection that reads session/workspace data must answer these questions before implementation. The yardstick is the real data shape: hundreds of sessions, GiB of wire files, a single session with hundreds of agent wires.

## A. Data volume

- What is the worst-case input of this read, and what does it scale with (session count, wire bytes, workspace count)?
- What is the budget (records / bytes / candidates / deadline), and does exceeding it produce an explicit `incomplete` / `stale` / `degraded` marker rather than a silent partial result?
- If you load a whole wire file, a whole history, or a whole directory tree to answer a bounded question, the design is wrong.

## B. Trigger frequency

- Who triggers this: every request, every open, a timer, startup? Estimate calls per minute at the real data shape.
- Inside a timer callback, O(N) or O(total bytes) work is a red flag; make it change-driven (mtime / fingerprint / generation / seq) so idle ticks cost nothing.
- If a client polls this endpoint, the cache/stale TTL must strictly exceed the poll interval; a TTL shorter than the poll interval is no cache at all.

## C. Caching

- TTL starts when the result becomes available, never when the request arrived.
- Concurrent same-key misses share one in-flight computation (single-flight) with refcounted cancellation; the last waiter leaving aborts the work.
- Caches have a size cap and an eviction rule, and stay usable (stale) while the source is degraded.

## D. Pagination and projections

- Pagination reads only what the page needs; never "load everything, then `slice`".
- Derived projections (transcript, usage, indexes) keep a durable checkpoint (offset / seq / generation) and apply the tail; rebuilding from zero on every read is a defect.
- Engine replay and transcript projection must not each decode the same wire file twice.

## E. Degradation

- A fallback path must be cheaper than the primary path, never a full-scan substitute (a point read that becomes a full-table scan under degradation is an incident multiplier).
- Prefer serve-stale + background refresh over blocking on repair.

## F. Observability

- Hot paths log budget hits, cache hit/miss/shared, and scan costs (files/records/bytes/duration) through `ILogService`; never user content.
- Reproducible timing scripts belong under `.tmp/` (gitignored), not in tracked test fixtures unless they are real regression tests.

Reference incident class: 2026-09-14 unbounded-scan audit (`analyses/2026-09-14-kiki-unbounded-scan-audit.md` in the EasyAgent workspace).
