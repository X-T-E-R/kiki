---
"@kiki/gui": minor
"@kiki/cli": minor
---

Add Web access: open this Kiki in a browser on another device, temporarily or until you turn it off, and hand over a one-time link that signs that browser in. Settings → Spaces gains a Web access area next to the inbound list (kept separate: a remote Kiki is a different object with its own grant), `kiki web` gains `--temporary` / `--persistent` / `--status` / `--off` / `--revoke`, and the TUI gains `/web temporary|persistent|status|off|link|revoke [id]`. The link redeems for a host-only HttpOnly session cookie, so no session or root token is held in JavaScript, `localStorage`, or a URL query string. Turning it off revokes every link and browser session without stopping Kiki or cancelling running work.
