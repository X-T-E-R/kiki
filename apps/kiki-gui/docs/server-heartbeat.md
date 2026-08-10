# Server heartbeat needed (handoff to the kap-server owner)

`packages/kap-server/src/transport/ws/v1/wsConnectionV1.ts` documents that the
WS transport has **no ping/pong heartbeat**. Consequence for this GUI: a
half-open socket (laptop sleep, network flap, proxy idle-drop) is undetectable
from `readyState` — the browser reports `OPEN` while the stream is dead, and no
frames ever arrive to prove otherwise.

## Client-side mitigation in place

`src/lib/ws.ts` tracks `lastInboundAt` per socket. `KikiSocket.nudge()` — wired
in `src/state/connection.tsx` to `focus`, `online`, `pageshow`, and
`visibilitychange` — refuses to trust an `OPEN` socket whose inbound stream has
been silent for more than `STALE_INBOUND_MS` (45s) and forces it through the
normal close/reconnect path instead. The `ping` → `pong` reply handler in
`ws.ts` is forward-compatible: it answers an application-level ping the moment
the server grows one.

## What the server should add

An application-level heartbeat on `wsConnectionV1`: server sends
`{type: 'ping', payload: {nonce}}` on an interval (e.g. 20–30s), expects a
matching `pong`, and drops the connection after a missed reply. That gives
every client a cheap, prompt half-open detector and bounded reconnect latency,
instead of each client inventing its own staleness heuristic. TCP keepalive
does not cover this: intermediaries silently black-hole idle sockets while
keeping both endpoints' TCP state machines happy.
