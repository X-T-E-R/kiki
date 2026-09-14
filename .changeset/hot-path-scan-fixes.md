---
"@kiki/cli": patch
---

Reduce background rescanning across the server: message history paginates from a projection checkpoint with real wire timestamps, workspace skill lists reuse the watched catalog, search indexing only revisits changed sessions, the embedded store compacts its WAL by size ratio as well as absolute size, and the todo reminder tracks a per-agent cursor instead of rescanning the whole history every step.
