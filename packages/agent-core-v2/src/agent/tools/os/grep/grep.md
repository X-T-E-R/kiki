Search file contents using regular expressions (powered by ripgrep).

Do not use shell `grep` or `rg` directly; this tool applies workspace path, output-limit, and sensitive-file policies.

Write patterns in ripgrep regex syntax, which differs from POSIX `grep` syntax. For example, braces are special, so escape them as `\{` to match a literal `{`.

Hidden files (dotfiles such as `.gitlab-ci.yml` or `.eslintrc.json`) are searched by default. To also search files excluded by `.gitignore` (such as `node_modules` or build outputs), set `include_ignored` to `true`. Sensitive files (such as `.env`) are always skipped for safety, even when `include_ignored` is `true`.
