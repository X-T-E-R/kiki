# Spotlight: nb-search — web access with real key management

*A Kiki feature spotlight.*

`WebSearch` and `FetchURL` are backed by **nb-search**, a standalone search and fetch library developed alongside Kiki. What it changes is what happens when a provider is slow, rate-limits, or runs out of keys.

## Lanes, not a single endpoint

nb-search organizes web access into named **lanes** — `tavily.search`, `exa.search`, `duckduckgo.search`, `github.repositories`, `context7.docs`, and more — each with its own provider, cost, and latency profile. The agent picks a lane per query, or combines several and gets deduplicated, provenance-tracked results back. Fetching works the same way: extraction chains such as `tavily.extract → jina.reader → direct.fetch` fall through automatically when one extractor fails or returns junk.

![Search lanes in Settings: ready keyless lanes, the current default, and an unavailable lane with the exact reasons.](shots/d06-search-lanes.en.light.png)

## Keyless out of the box

Two lanes need no credentials at all: **GitHub repository search** and **Context7 library documentation**. A fresh install can already answer "what's the current API of X" and "find me a repo that does Y" before you configure anything.

## Multiple keys, with a scheduler

When you do configure providers:

- **Multiple keys per provider** — comma-separated in a local credentials file, not a single env var.
- **Scheduling strategies** — round-robin or priority ordering across keys, with cooldowns when a key errors or rate-limits.
- **Retries and failover** — a failed key doesn't fail the query; the scheduler moves on.
- **Balance awareness** — for providers that expose usage, nb-search can query balances on a cached rhythm, so scheduling prefers keys with headroom without a quota-check before every call.

![A fetch extraction chain with visible fallbacks: each step's status is inspectable.](shots/d07-fetch-chain.en.light.png)

Configure it under **Settings → Search & retrieval**; `kiki web` and the CLI both report lane readiness before you rely on it.
