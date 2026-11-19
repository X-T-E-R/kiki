---
"@kiki/cli": patch
---

Fix plugin, credential, recipe hook, and runtime host files that could be left empty or broken after a crash or power loss, which blocked startup until they were deleted by hand.
