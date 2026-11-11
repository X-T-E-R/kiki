# `@kiki/acp-client` and External Harness Third-Party Notices

This package and its companion external harness modules (`packages/agent-core-v2/src/app/agentExecutor/`, `packages/agent-core-v2/src/os/backends/node-local/antigravityRuntime.ts`, and `scripts/external-harness/`) include TypeScript and JavaScript adaptations derived from the following permissively licensed open-source projects.

---

## T3 Code (`d2c25950b4d9`)

- **Upstream**: <https://github.com/pingdotgg/t3code> (commit `d2c25950b4d9`)
- **Adapted components**:
  - `packages/acp-client/src/antigravity.ts`, `packages/acp-client/src/flavors.ts`, `packages/acp-client/src/client.ts`, `packages/acp-client/src/events.ts`, `packages/acp-client/src/login.ts` (adapted from `apps/server/src/provider/acp/AntigravityAcpSupport.ts`, `AntigravityProtocol.ts`, `packages/provider-acp/src/server/AcpSessionRuntime.ts`, `packages/provider-grok/src/server/acpSupport.ts`, and `packages/provider-acp-registry/src/server/{copilotAcp,droidAcp,devinAcp,claudeAcp}.ts`)
  - `packages/agent-core-v2/src/app/agentExecutor/{antigravityDistribution,antigravityProcess,acpRegistryCatalog,builtinDescriptorData}.ts` and `packages/agent-core-v2/src/os/backends/node-local/antigravityRuntime.ts` (adapted from `apps/server/src/provider/{antigravityRelease,antigravityAuthSupport}.ts`, `apps/server/src/provider/acp/AntigravityTurnOutcome.ts`, `packages/provider-kiro/src/server/acpSupport.ts`, and `packages/provider-acp-registry/src/server/AcpRegistrySupport.ts`)
- **Modifications by Kiki**: Ported from Effect services/schemas to Kiki's native TypeScript, Zod, and Node.js runtime interfaces.

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

---

## Paseo (`b920243c74e2`)

- **Upstream**: <https://github.com/getpaseo/paseo> (commit `b920243c74e2`)
- **Adapted components**:
  - `scripts/external-harness/agy-cli-acp.mjs` (`takeNewDenials`, `accumulateStepUsage`, and `subagent` step projection adapted from `plugins/antigravity-provider/server/internal/session.ts` and `timeline.ts`)
- **Modifications by Kiki**: Adapted to Kiki's ACP NDJSON bridge and per-session child process lifecycle.

- **Copyright**: Copyright (c) 2025-present Mohamed Boudra
- **Full license text**: [Apache License, Version 2.0 in the Kiki desktop notice](../../apps/kiki-gui/THIRD_PARTY_NOTICES.md#paseo-apache-license-20)
