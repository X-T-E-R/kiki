import type { AgentExecutorAgentContext, AgentExecutorSession } from '#/app/agentExecutor/agentExecutor';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { createHooks } from '#/hooks';
import type {
  AgentRunHandle,
  AgentRunRequest,
  RunAgentOptions,
} from '#/session/subagent/subagent';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';

class AgentMessageStepRequest extends MessageStepRequest {
  readonly delivered: Promise<boolean>;
  private resolveDelivered!: (delivered: boolean) => void;

  constructor(message: ContextMessage) {
    super(message, {
      kind: 'steer',
      mergeable: true,
      turnScoped: false,
      admission: 'activeTurnOnly',
    });
    this.delivered = new Promise((resolve) => {
      this.resolveDelivered = resolve;
    });
  }

  protected override onSettled(): void {
    this.resolveDelivered(this.state === 'materialized');
  }
}

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

  async steer(message: ContextMessage): Promise<boolean> {
    if (this.loop.status().state !== 'running') return false;
    const request = new AgentMessageStepRequest(message);
    try {
      this.loop.enqueue(request);
    } catch (error) {
      request.abort();
      if (this.loop.status().state !== 'running') return false;
      throw error;
    }
    return request.delivered;
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
    const promptReason = reason instanceof Error
      ? reason
      : new Error(
        reason === undefined
          ? 'Agent executor shutdown'
          : typeof reason === 'string'
            ? reason
            : JSON.stringify(reason) ?? Object.prototype.toString.call(reason),
      );
    await Promise.all([
      this.settled(),
      this.prompt.drain(promptReason),
    ]);
  }
}
