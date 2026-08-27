---
"@moonshot-ai/kimi-code-sdk": major
"@moonshot-ai/kimi-code": major
---

Remove the v1 agent engine. `agent-core-v2` is now the only engine, and there is no way to select another one.

What is gone:

- The `@moonshot-ai/agent-core`, `@moonshot-ai/acp-adapter`, and `@moonshot-ai/migration-legacy` packages.
- `KIMI_CODE_LEGACY_FLAG`, which selected the v1 engine for `kimi`, `kimi -p`, `kimi doctor`, `kimi acp`, `kimi export`, and `kimi provider`, and the VS Code `kimi.useAgentCoreV1` setting.
- `KIMI_CODE_EXPERIMENTAL_AGENT_COLLABORATION` and the five-tool Codex-style adapter (`spawn_agent`, `list_agents`, `wait_agent`, `followup_task`, `interrupt_agent`), which only ever existed on v1. Use `AgentRun`, `AgentSwarm`, `AgentList`, and `AgentSend`.
- The `kimi migrate` command, its TUI screen, and the VS Code `Kimi Code: Migrate Legacy Data` command. Kiki can no longer import a kimi-cli-era `~/.kimi` home. Sessions imported before this release keep working and keep their `[imported]` badge.
- The `Agent` alias for the `AgentRun` tool.

SDK consumers: `createKimiHarnessV2` is now `createKimiHarness`, and `SDKRpcClientV2` is now `SDKRpcClient` — the v1-shaped client of those names is gone, not renamed. The SDK's protocol, config, error, and logging types are now owned by the SDK package instead of re-exported from the v1 engine; agent config carries `modelAlias` and `thinkingLevel` where it used to carry `provider` and `thinkingEffort`, and no longer carries `cwd`. Session resume replays `wire.jsonl` directly rather than through a v1 `Agent`.
