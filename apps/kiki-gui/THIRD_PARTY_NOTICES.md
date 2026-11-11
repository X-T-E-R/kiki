# Kiki desktop third-party notices

Kiki desktop is built from open-source components. The exact JavaScript and Rust dependency versions shipped by a release are recorded in the repository's `pnpm-lock.yaml` and `apps/kiki-gui/src-tauri/Cargo.lock` at the matching `kiki-v<version>` tag. License identifiers below link to the applicable project license or standard license text.

This static notice covers the bundled sidecar and embedded mobile runtime bundle, major direct client runtime dependencies, and source adapted from recorded donors. Separate mobile host shells (for example Android APKs packaging Termux Bionic Node.js LTS, PRoot subprocess sandboxes, or scrcpy-derived device inspection helpers) carry their own native binary and license notices alongside the embedded Kiki bundle. Release owners must review this notice when either lockfile, a bundled runtime, or adapted source changes.

## Bundled runtime and major direct dependencies

| Component | Use in Kiki desktop | License |
| --- | --- | --- |
| [Kimi Code](https://github.com/MoonshotAI/kimi-code) | Bundled `kiki-server.exe` sidecar | MIT |
| [agent-browser 0.38.2](https://github.com/vercel-labs/agent-browser/tree/39a74c70d7759d5a6de7a22c04570bb626bbd081), Kiki `kiki-no-replay-r1` / `kiki-stdio-r1` derivative | Managed browser MCP execution resource embedded in the Windows sidecar; modified transport does not replay indeterminate operations, and Windows MCP output capture follows the CLI's exit rather than inherited background writers. LICENSE, NOTICE, build metadata and patch accompany the extracted resource. | Apache-2.0 |
| [Tauri](https://github.com/tauri-apps/tauri), updater, dialog, filesystem, notification, and window-state plugins | Windows desktop runtime, NSIS packaging, native integration, and signed updates | Apache-2.0 OR MIT |
| [React](https://github.com/facebook/react) and React DOM | Desktop user interface runtime | MIT |
| [React Router](https://github.com/remix-run/react-router) | Desktop client routing | MIT |
| [CodeMirror](https://github.com/codemirror) packages | Text and code editing | MIT |
| [`@moonshot-ai/protocol`](https://github.com/MoonshotAI/kimi-code) | Workspace protocol library used by the desktop client | MIT |
| [TanStack Query](https://github.com/TanStack/query) | Client-side server-state management | MIT |
| [Streamdown](https://github.com/vercel/streamdown) and `@streamdown/code`, `@streamdown/cjk`, `@streamdown/math`, `@streamdown/mermaid` | Streaming Markdown, code, CJK text, math, and diagram rendering | Apache-2.0 |
| [KaTeX](https://github.com/KaTeX/KaTeX) and [Mermaid](https://github.com/mermaid-js/mermaid) | Math typesetting and diagram rendering | MIT |
| [xterm.js](https://github.com/xtermjs/xterm.js), addon-fit, and addon-web-links | Terminal rendering and integration | MIT |
| [diff](https://github.com/kpdecker/jsdiff) | Unified diff processing | BSD-3-Clause |
| [use-stick-to-bottom](https://github.com/stackblitz-labs/use-stick-to-bottom) | Conversation scroll behavior | MIT |
| Fraunces, JetBrains Mono, and Space Grotesk Fontsource packages | Fonts bundled with the desktop UI | OFL-1.1 |

## Adapted source and interaction donors

| Donor and pinned revision | Recorded use in Kiki desktop | License |
| --- | --- | --- |
| [codeg `fa230248`](https://github.com/xintaofei/codeg/commit/fa230248d285c3f4fa541a737fc93f209820512e) | Streamdown loading, thread scrolling, and Tauri sidecar staging | Apache-2.0 |
| [AionUi `28a2a9f`](https://github.com/iOfficeAI/AionUi/commit/28a2a9f57f1bf4f9111b9c33e0cfc1eb918effc8) | Code-block controls, approval guards, and capability degradation | Apache-2.0 |
| [grok-build `a5589e9`](https://github.com/xai-org/grok-build/commit/a5589e958437d79e13db026eedcb1720bffd4063) | Unified-diff presentation | Apache-2.0 |
| [LiveAgent `00a2c6f`](https://github.com/Stack-Cairn/LiveAgent/commit/00a2c6fc43754f40022b0703459824559bee73ea) | Reconnect policy and managed-child shutdown behavior | MIT |
| [deepseek-harness `47f9438`](https://github.com/deepseek-ai/deepseek-harness/commit/47f943859bef60e4160492346772ded9b24f765a) | Conversation-shell, composer, status, tool, queue, and reference-chip interaction patterns | MIT |
| [dsh-web-ui `6265187`](https://github.com/zhu1090093659/dsh-web-ui/commit/62651870dd18ad3d9bf54a9cb934b75d0fbaf639) | Grouped collapsible capability cards | Apache-2.0 |
| [Letta Code `c0956ed`](https://github.com/letta-ai/letta-code/commit/c0956ed3263da7f781a958ce35ff3042ef97adfa) | Partial JSON string-field scanner for streaming SendMessage drafts (`src/lib/partialJson.ts`) | Apache-2.0 |
| [OpenCode `e00890c`](https://github.com/anomalyco/opencode/commit/e00890c67261a435cee6409366a68999a93393fd) | Account sign-in behaviour behind the device-code flows the Connections page runs: the xAI/Grok device-grant adapter attributed in full at `packages/oauth/THIRD_PARTY_NOTICES.md`, which ships with the desktop build | MIT |
| [Mika `1473f143`](https://github.com/wangzan101/Mika/commit/1473f143285950f1266378f4c1ad613efb182ee9) | Mobile runtime host control protocol (`apps/kimi-code/src/mobile-entry.ts`), platform-aware capability defaults, secret-broker handoff, and companion device-bridge patterns for accessibility inspection, virtual display gestures, and sandboxed shell execution (Copyright 2026 wangzan101) | Apache-2.0 |
| [T3 Code `d2c25950b4d9`](https://github.com/pingdotgg/t3code/commit/d2c25950b4d9) | External ACP session runtime (`session/resume` priority, load replay gate, config option readiness), Antigravity ACP 1.4.5 / `agy acp` 1.5.1+ release and dual-source adapter, per-instance `GEMINI_HOME` / skills junction isolation, Codex account Shadow Home junction overlay (`codexHomeOverlay.ts`), Claude 5h/7d/spend usage-window parser (`claudeUsageWindowParser.ts`), protocol payload sanitizer, `client_view_file` read repair, `interaction_*` user-question bridge, read-only SQLite turn-outcome quota reset parser, ACP Registry catalog validator, and Grok / Kiro / Copilot / Droid / Devin / Claude ACP flavors (`packages/acp-client/THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_NOTICES.md`) | MIT |
| [Paseo `b920243c74e2`](https://github.com/getpaseo/paseo/commit/b920243c74e2) | Codex `app-server` 128 MiB oversized JSONL frame isolation (`packages/codex-client`), non-destructive `thread/fork` conversation undo (`codexUndoParticipant.ts`), streaming `partial-json` external tool preview parser (`packages/transcript/src/facts/partialJson.ts`), multi-file turn diff projection, and Antigravity CLI permission-denial / subagent / step-usage accounting (`packages/acp-client/THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_NOTICES.md`) | Apache-2.0 |

The Kiki repository itself is distributed under the MIT License in the repository root. Copyright and license notices supplied by third-party projects remain the property of their respective authors.

## Full license texts for adapted source

The following full license texts apply to adapted source identified above.

### T3 Code MIT License

```text
MIT License

Copyright (c) 2026 T3 Tools Inc.

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
```

### Paseo Apache License 2.0

Copyright (c) 2025-present Mohamed Boudra

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
