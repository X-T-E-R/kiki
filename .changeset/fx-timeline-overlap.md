---
"@kiki/gui": patch
---

Fix the conversation timeline losing its end anchor mid-turn: during a
streaming turn the last row grows from the 120px estimate to its real height,
the virtualizer's re-measure rule skipped the scrollTop compensation for a row
that spans the fold, and its virtual wasAtEnd gate read the stale estimate —
so the viewport stopped following the first time it rested below a growing
block. Every later append (the next user bubble included) then drew below the
fold, with stale position-fix paints floating the user bubble over the
assistant content above it. Transcript now re-asserts "truly at end" from the
actual DOM distance (scrollHeight − clientHeight − scrollTop) through the
virtualizer's shouldAdjustScrollPositionOnItemSizeChange, so the compensation
runs while the viewport is still anchored and follow survives the estimate→
actual delta. Default above-fold and backward-scroll rules are untouched.
