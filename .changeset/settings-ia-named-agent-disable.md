---
"@kiki/gui": minor
---

Rework the settings page information architecture and subagent management:

- The capabilities section now renders as collapsible groups (Skills, MCP servers open by default; Runtime & tools, Experimental, Advanced JSON folded) instead of five flat cards, with a link to the read-only `/capabilities` browser; settings-search hits force their group open before the scroll flash lands.
- Settings section order puts everyday surfaces first and moves the low-frequency Connection section next to About.
- Named agent profiles render as a merged view: duplicate name+source+file rows across workspaces collapse into one row with compact workspace chips, and every profile (not just built-ins) can now be enabled/disabled — named profiles write `disabled_named_profiles`, built-ins keep `disabled_builtin_profiles`, with a dimmed disabled state.
