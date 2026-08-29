---
"@moonshot-ai/agent-core-v2": patch
"@kiki/gui": patch
---

Make provider retries visible and bounded. The GUI status line now names an in-flight retry (cause, attempt counter, backoff delay) instead of showing minutes of unexplained silence that read as a stuck tool, and the engine clamps provider-supplied retry-after hints to 60 seconds so an overloaded relay advertising 120-second waits no longer turns one flaky step into minutes of dead air.
