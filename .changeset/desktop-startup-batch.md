---
"@kiki/gui": patch
---

Desktop shell: fail fast when the backend exits during startup (with exit code, stderr tail, and a persistent backend log), show a dedicated boot/failure card with retry, cancel, and copy-diagnostics instead of the unusable URL/token form, and allow remote server and provider endpoints through the desktop CSP (user-configured URLs cannot be whitelisted).
