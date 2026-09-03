---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kap-server": patch
---

Make the plugin marketplace catalog URL configurable (`[plugins] marketplace_url`, env, or server option). An empty value means the REST marketplace route reports unconfigured and does not fetch a remote catalog.
