# Handoff: request-level usage ledger (kap-server)

The GUI usage dashboard (`/usage`) aggregates per-session `SessionUsage`
client-side. That ceiling is visible already: deleted sessions erase
history, and "what is happening right now" can only be answered at
session granularity (`busy`, `current_prompt_id`), not at request
granularity. To lift it, the server needs a request-level ledger.

## What to record

One ledger entry per LLM call (including retries as their own entries):

- `request_id`, `session_id`, `turn` / `prompt_id`, `agent_id` (main vs
  subagent), timestamp (start/end)
- `model`, `provider`, protocol attempt index
- `input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_creation_tokens`, `cost_usd`
- `latency_ms`, outcome (`completed` / `failed` / `cancelled`), error
  class when failed

## What the GUI needs on the wire

1. **Live in-flight state** — extend the WS status surface (or a new
   `request.started` / `request.completed` frame pair) so a client can
   render "call in flight: model X, elapsed 12s, 1.2k tokens out so
   far" per session/agent. The session's existing
   `agent.status.updated` push channel is the natural carrier.
2. **Queryable history** — `GET /api/v1/usage/requests?session_id=&since=&limit=`
   returning ledger entries, plus `GET /api/v1/usage/summary?bucket=day&model=`
   for pre-aggregated rollups so the GUI stops re-deriving history from
   surviving sessions.
3. **Persistence across session deletion** — the ledger must outlive
   its session; today's per-session `usage` dies with the session.
4. (Optional) provider quota/rate-limit state when the upstream
   exposes it, surfaced as part of the summary payload.

## Non-goals / boundaries

- The GUI keeps its client-side aggregation as a fallback for servers
  without the ledger; new endpoints must be additive and versioned.
- Nothing here changes billing-critical accounting — this is
  observability, not metering.

Related open handoffs: `server-heartbeat.md` (WS heartbeat), terminal
`terminal_*` WS dispatch, SEA packaging of `conpty.node`.
