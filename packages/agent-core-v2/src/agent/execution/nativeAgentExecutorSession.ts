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

  constructor(
    private readonly agent: AgentExecutorAgentContext,
    private readonly loop: IAgentLoopService,
    private readonly prompt: IAgentPromptService,
  ) {}

  async run(
    request: AgentRunRequest,
    options: RunAgentOptions,
  ): Promise<AgentRunHandle> {
    await this.hooks.onWillRun.run({ signal: options.signal });
    return runAgentTurn(this.agent, request, options);
  }

  status() {
    const status = this.loop.status();
    return status.state === 'running'
      ? { state: 'running' as const, turnId: status.activeTurnId }
      : { state: 'idle' as const };
  }

  cancel(reason?: unknown): boolean {
    let cancelled = false;
    for (const turnId of this.loop.status().pendingTurnIds) {
      cancelled = this.loop.cancel(turnId, reason) || cancelled;
    }
    return this.loop.cancel(undefined, reason) || cancelled;
  }

  settled(): Promise<void> {
    return this.loop.settled();
  }

  async shutdown(reason?: unknown): Promise<void> {
    this.cancel(reason);
    const promptReason = reason instanceof Error ? reason : new Error(String(reason ?? 'Agent executor shutdown'));
    await Promise.all([
      this.settled(),
      this.prompt.drain(promptReason),
    ]);
  }
}
