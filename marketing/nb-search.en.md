# Spotlight: nb-search — web access with real key management

*A Kiki feature spotlight.*

Every coding agent can "search the web". Most stop at a single API key pasted into an env var, and fall over the moment that key rate-limits. Kiki's web access runs on **nb-search**, a standalone search and fetch library developed alongside Kiki and integrated directly into its `WebSearch` / `FetchURL` tools.

## Lanes, not a single endpoint

nb-search organizes web access into named **lanes** — `tavily.search`, `exa.search`, `duckduckgo.search`, `github.repositories`, `context7.docs`, and more — each with its own provider, cost, and latency profile. The agent picks a lane per query, or combines several and gets deduplicated, provenance-tracked results back. Fetching works the same way: extraction chains (e.g. `tavily.extract → jina.reader → direct.fetch`) fall through automatically when one extractor fails or returns junk.

![Search lanes in Settings: ready keyless lanes, the current default, and an unavailable lane with the exact reasons.](shots/d06-search-lanes.en.light.png)

## Keyless out of the box

Two lanes need no credentials at all: **GitHub repository search** and **Context7 library documentation**. A fresh Kiki install can already answer "what's the current API of X" and "find me a repo that does Y" before you configure anything.

## Multiple keys, with a scheduler

When you do configure providers, nb-search takes them seriously:

- **Multiple keys per provider** — comma-separated in a local credentials file, not a single env var.
- **Scheduling strategies** — round-robin or priority ordering across keys, with cooldowns when a key errors or rate-limits.
- **Retries and failover** — a failed key doesn't fail the query; the scheduler moves on.
- **Balance awareness** — for providers that expose usage, nb-search can query balances on a cached rhythm, so scheduling can prefer keys with headroom without paying a quota-check before every call.

![A fetch extraction chain with visible fallbacks: each step's status is inspectable.](shots/d07-fetch-chain.en.light.png)

## Why it matters

Search is the tool agents call most and notice least — until it breaks a long-running session at 2 a.m. because one free-tier key ran dry. nb-search turns web access from a single point of failure into managed infrastructure: lanes you can inspect, keys that rotate, failures that route around themselves.
