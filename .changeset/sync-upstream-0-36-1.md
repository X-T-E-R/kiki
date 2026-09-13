---
"@kiki/cli": minor
---

Merge upstream 0.36.1: adopt the App-scope `ISessionManager` facade and the declarative subagent model pool, re-expressing kiki's inherited-vs-explicit subagent binding as a persisted `inherit | fixed` mode (inherited bindings follow mid-session `/model` switches; explicit and pool-pinned bindings stay frozen). Thread wire error codes move to 40421/40927–40932 to clear upstream's newly occupied ranges; GUI and server ship together from this repo.
