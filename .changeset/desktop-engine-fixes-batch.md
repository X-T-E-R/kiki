---
"@kiki/gui": patch
---

Harden desktop backend startup and local development discovery: verify the packaged sidecar manifest and reported server version before connecting, reject stale PID registrations through the server-id handshake, and never return the local bearer token from a non-loopback Vite listener.
