# Imported format rules

Claude/Codex rules retain their original notices under `rules/claude/THIRD_PARTY_NOTICES.md` and `rules/codex/THIRD_PARTY_NOTICES.md`.

## session-migrate

`rules/pi.mjs` semantically ports the v3 header/tree indexing, active-parent-path selection and message/content/tool-result/compaction projection from `_active_path`, `parse`, `_entry_events`, `_content_events` and `_portable_pi_result_blocks` in `src/session_migrate/formats/pi.py` (upstream pinned Pi 0.80.6). `rules/grok.mjs` adapts native summary/update linkage and count checks, ACP message/tool dispatch and tool-output projection from `parse_session`, `_decode_updates`, `_parse_update` and `_tool_update_blocks` in `formats/grok.py` (upstream pinned Grok 1.0.5). These are source readers, not the upstream target writers; Kiki serializes through its existing session services. Images, private thinking and internal runtime state are omitted with loss reports.

Source: https://github.com/xhluca/session-migrate/tree/c23b1dbd21404f78be3b69d42ff4fb158ff52105/src/session_migrate/formats (0.11.0). The JavaScript adapters use bounded local exports and the existing sessionSources paging contract rather than the Python runtime.

MIT License

Copyright (c) 2026 xhluca

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## OpenCode

`rules/opencode.mjs:transformShareData` adapts the complete production share-data hierarchy grouping unit from `packages/opencode/src/cli/cmd/import.ts:60–90`, revision `e00890c67261a435cee6409366a68999a93393fd` in https://github.com/anomalyco/opencode. Kiki adds orphan-part/linkage validation and projects the official JSON export's message/parts into its existing import records. No SQLite storage writer, account access or share-URL fetch is copied.

MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
