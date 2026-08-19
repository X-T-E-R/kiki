---
"@kiki/gui": minor
---

Organize the session-and-workspace experience: filter the session list by workspace over `GET /sessions?workspace_id`, add client-local session pinning (persisted through `POST /sessions/{id}/profile` metadata) with a pinned-first sort and recency time-grouping headers, extend the sidebar empty state to point at archived sessions, paginate global search results, add a "view all" escape from the `/new` recent-session chips, keep the Tasks page refreshing through a completion grace window, and add workspace rename/unregister controls to Settings with confirmation.