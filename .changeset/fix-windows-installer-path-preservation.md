---
"@kiki/cli": patch
---

Fix the Windows NSIS installer and uninstaller so updating the user `PATH` preserves existing entries longer than 1,024 characters and keeps unexpanded `REG_EXPAND_SZ` tokens intact.
