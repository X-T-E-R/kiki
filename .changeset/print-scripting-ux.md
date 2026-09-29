---
"@kiki/cli": minor
---

Agent profile names can now use underscores as well as hyphens, and an unknown profile error lists files that were skipped and why. `kiki -p -` and `--prompt-file <path>` read multi-line prompts from stdin or a UTF-8 file, and `--include-thinking` adds thinking events to `stream-json` output.
