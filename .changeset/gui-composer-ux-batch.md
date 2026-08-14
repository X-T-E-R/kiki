---
"@kiki/gui": patch
---

Fix GUI session/composer interaction issues: confirm unknown or disabled slash commands before sending them as plain prompts, persist per-session attachments and pill overrides across session switches, avoid image-paste races with read-in-progress placeholders that block sending, send effort/thinking only when explicitly chosen so the server default wins, prefer the server default model over the local mirror, confirm server restarts before killing running sessions, explain ambiguous y/n approval shortcuts, validate the /new working directory as an absolute path, and localize the remaining hard-coded connection/settings strings.
