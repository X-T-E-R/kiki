---
"@kiki/gui": minor
---

Selection annotations in the transcript: the floating selection popover now offers two actions — "Quote" (unchanged blockquote chip) and "Annotate", which opens an in-place comment input (Enter commits, Esc cancels) and chips the selection together with the comment. Annotations accumulate across many selections, render as amber pencil chips distinct from the quote chip (hover/focus reveals source + comment, individually removable), and ship in the prompt as plain-text segments — each annotation as a Markdown blockquote followed by its `Comment:` line, ahead of the quote prefix and the typed text.
