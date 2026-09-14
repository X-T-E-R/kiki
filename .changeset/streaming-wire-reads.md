---
"@kiki/cli": patch
---

Cold transcript reads now stream wire files in bounded chunks instead of holding the whole file, its lines, and the parsed records in memory at once, and concurrent cold opens of the same agent share one scan that is cancelled when the last reader disconnects.
