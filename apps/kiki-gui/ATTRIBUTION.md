# Attribution

kiki-gui is an original work within the kiki project (MIT). Selected
presentation and interaction patterns were ported or adapted from the
following reference projects, with license terms retained:

| Donor | Upstream | License | What was adapted |
| --- | --- | --- | --- |
| codeg | https://github.com/xintaofei/codeg (pinned checkout: `references/codeg`) | Apache-2.0 | Lazy streamdown engine loading (`src/components/markdown/streamdown-plugins.ts`); stick-to-bottom + jump-to-latest thread pattern (`src/components/Transcript.tsx`) |
| AionUi | https://github.com/iOfficeAI/AionUi (pinned checkout: `references/aionui`) | Apache-2.0 | Code-block chrome — language label, copy, long-block collapse (`src/components/markdown/KikiCodeBlock.tsx`); approval intent classification and submit guards (`src/components/Interactions.tsx`); honest capability degradation in the model/effort selector (`src/components/Composer.tsx`) |
| grok-build | https://github.com/xai-org/grok-build (pinned checkout: `references/grok-build`) | Apache-2.0 | Unified-diff hunk recipe — 3-line context, blank-edge trim, unchanged-line separators, diffstat header (`src/lib/diff.ts`, `src/components/DiffCard.tsx`) |
| liveagent | https://github.com/Stack-Cairn/LiveAgent (pinned checkout: `references/liveagent`) | MIT | Wake-nudge reconnect policy and wake-signal wiring (`src/lib/ws.ts`, `src/state/connection.tsx`) |

Adapted files carry a header comment naming their donor and license.
Runtime dependencies (`streamdown`, `shiki`, `use-stick-to-bottom`,
`diff`, and the React/Vite/Tailwind stack) are MIT-licensed npm
packages governed by their own licenses.

Donor revisions and mapping records are tracked in the EasyAgent Assay
workspace (`DONORS.md`, adoption ids `codeg-kiki-gui-presentation-ports`,
`aionui-kiki-gui-interaction-ports`, `grok-build-kiki-gui-diff-recipe`,
`liveagent-kiki-gui-reconnect-policies`).
