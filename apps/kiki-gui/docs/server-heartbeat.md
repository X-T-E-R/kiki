# Server heartbeat needed (handoff to the kap-server owner)

`packages/kap-server/src/transport/ws/v1/wsConnectionV1.ts` documents that the
WS transport has **no ping/pong heartbeat**. Consequence for this GUI: a
half-open socket (laptop sleep, network flap, proxy idle-drop) is undetectable
from `readyState` — the browser reports `OPEN` while the stream is dead, and no
frames ever arrive to prove otherwise.

## Client-side mitigation in place

`src/lib/ws.ts` tracks `lastInboundAt` per socket. `KikiSocket.nudge()` — wired
in `src/state/connection.tsx` to `focus`, `online`, `pageshow`, and
`visibilitychange` — reconnects a down socket immediately, and only distrusts
an `OPEN` socket when the server **advertised a heartbeat** in `server_hello`
(`payload.heartbeat_interval_ms`): with a heartbeat contract, inbound silence
past `max(45s, 3× interval)` means the transport is half-open, so the nudge
forces the close/reconnect path. kap-server's wsConnectionV1 currently
advertises no heartbeat, so the stale-silence branch stays disarmed (no
false-positive reconnects on alt-tab for idle sessions) and reconnects remain
close-driven. The `ping` → `pong` reply handler in `ws.ts` is
forward-compatible: it answers an application-level ping the moment the server
grows one.

## What the server should add

An application-level heartbeat on `wsConnectionV1`: advertise
`heartbeat_interval_ms` in `server_hello`, send `{type: 'ping', payload:
{nonce}}` on that interval, expect a matching `pong`, and drop the connection
after a missed reply. That gives every client a cheap, prompt half-open
detector and bounded reconnect latency, instead of each client inventing its
own staleness heuristic — and it lets this GUI arm its stale-silence check
automatically. TCP keepalive does not cover this: intermediaries silently
black-hole idle sockets while keeping both endpoints' TCP state machines
happy.
