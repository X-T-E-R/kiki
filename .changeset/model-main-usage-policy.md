---
"@kiki/cli": patch
---

Add a Main agent section to the model editor where you can set only the settings the main agent uses differently, leaving everything else shared.

Token counts in that section now read the way the compaction point does: `160k`, `0.2M` and `160000` are all accepted and the field settles on `160k`, while the saved value stays a whole number of tokens. The effort chips above it are now labelled as the levels the model supports, so they no longer read as the same setting as the default effort below. "Use shared again" now sits in the same place on every row and at every window width.
