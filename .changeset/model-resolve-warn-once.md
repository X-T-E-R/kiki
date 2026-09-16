---
"@kiki/cli": patch
---

Fixed a crash-loop where an ambiguous model id (one name matching several configured models) re-logged its resolution warning on every lookup — over a million lines could flood the backend log, build native write-back pressure, and trip the memory watchdog into restarting the server. Resolutions are now memoized per model catalog generation and the warning logs once per id.
