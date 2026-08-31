import type { AgentExecutorAgentContext, AgentExecutorSession } from '#/app/agentExecutor/agentExecutor';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { createHooks } from '#/hooks';
import type {
  AgentRunHandle,
  AgentRunRequest,
  RunAgentOptions,
} from '#/session/subagent/subagent';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';

export class NativeAgentExecutorSession implements AgentExecutorSession {
  readonly hooks = createHooks<{ onWillRun: { signal: AbortSignal } }, 'onWillRun'>([
    'onWillRun',
  ]);

  constructor(private readonly agent: AgentExecutorAgentContext) {}

  async run(
    request: AgentRunRequest,
    options: RunAgentOptions,
  ): Promise<AgentRunHandle> {
    await this.hooks.onWillRun.run({ signal: options.signal });
    return runAgentTurn(this.agent, request, options);
  }

  status() {
    const status = this.agent.accessor.get(IAgentLoopService).status();
    return status.state === 'running'
      ? { state: 'running' as const, turnId: status.activeTurnId }
      : { state: 'idle' as const };
  }

  cancel(reason?: unknown): boolean {
    const loop = this.agent.accessor.get(IAgentLoopService);
    let cancelled = false;
    for (const turnId of loop.status().pendingTurnIds) {
      cancelled = loop.cancel(turnId, reason) || cancelled;
    }
    return loop.cancel(undefined, reason) || cancelled;
  }

  settled(): Promise<void> {
    return this.agent.accessor.get(IAgentLoopService).settled();
  }

  async shutdown(reason?: unknown): Promise<void> {
    this.cancel(reason);
    const promptReason = reason instanceof Error ? reason : new Error(String(reason ?? 'Agent executor shutdown'));
    await Promise.all([
      this.settled(),
      this.agent.accessor.get(IAgentPromptService).drain(promptReason),
    ]);
  }
}
