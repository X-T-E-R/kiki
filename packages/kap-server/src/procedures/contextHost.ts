import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { IAgentMemorySnapshot } from '@kiki/agent-core-v2/app/memory/memorySnapshot';
import { IAgentContextMemoryService } from '@kiki/agent-core-v2/agent/contextMemory/contextMemory';
import { IAgentContextInjectorService } from '@kiki/agent-core-v2/agent/contextInjector/contextInjector';
import { externalBoundaryHookEvent, externalHintAlreadyRecorded, externalPromptHints, externalStateHints, externalTurnHasModelContent } from '@kiki/agent-core-v2/agent/execution/externalPromptHints';
import { IAgentExecutionService } from '@kiki/agent-core-v2/agent/execution/execution';
import { newDeliveryId } from '@kiki/agent-core-v2/agent/contextMemory/messageDelivery';
import { newMessageId } from '@kiki/agent-core-v2/agent/contextMemory/messageId';
import { ISessionTodoService } from '@kiki/agent-core-v2/session/todo/sessionTodo';
import { IAgentGoalService } from '@kiki/agent-core-v2/agent/goal/goal';

import { IAgentProfileService, type Scope } from '@kiki/agent-core-v2';
import { IAgentLifecycleService } from '@kiki/agent-core-v2/session/agentLifecycle/agentLifecycle';
import type { IAgentScopeHandle } from '@kiki/agent-core-v2/_base/di/scope';
import { IAgentToolRegistryService } from '@kiki/agent-core-v2/agent/toolRegistry/toolRegistry';
import { IAgentToolPolicyService } from '@kiki/agent-core-v2/agent/toolPolicy/toolPolicy';
import { IAgentToolExecutorService } from '@kiki/agent-core-v2/agent/toolExecutor/toolExecutor';
import { IAgentStateService } from '@kiki/agent-core-v2/agent/state/agentState';
import { IAgentScopeContext } from '@kiki/agent-core-v2/agent/scopeContext/scopeContext';
import { nativeHarnessToolAllowed } from '@kiki/agent-core-v2/app/agentExecutor/harnessMcp';
import { turnKey } from '@kiki/agent-core-v2/agent/loop/turnOps';
import { contextCallSchema, contextProcedureTable, type ContextCatalog } from '@kiki/klient/procedures';

import { withSessionOperation } from '../lib/sessionOperationLease';
import { ensureMainAgent } from '../transport/mainAgent';
import type { McpSeat } from '../mcp/seatResolver';

export class ContextProcedureHost {
  private readonly delivered = new WeakMap<McpSeat, Set<string>>();
  constructor(private readonly core: Scope) {}

  async hook(seat: McpSeat, rawInput: unknown) {
    const input = z.object({
      harness: z.enum(['claude', 'codex', 'antigravity', 'grok']),
      event: z.enum(['SessionStart', 'UserPromptSubmit', 'PreCompact', 'PreInvocation', 'PostCompact', 'PreToolUse', 'Stop']),
      compact: z.boolean().optional(),
    }).strict().parse(rawInput);
    return this.withAgent(seat, async (agent) => {
      if (!agent.accessor.get(IAgentProfileService).data().kikiContext?.includes('hooks')) throw new Error('Kiki context hooks are disabled');
      await agent.accessor.get(IAgentContextInjectorService).reconcileAllAtSafeBoundary();
      const memory = agent.accessor.get(IAgentContextMemoryService);
      const todos = agent.accessor.get(ISessionTodoService);
      const hints = [
        { origin: 'memory', text: await agent.accessor.get(IAgentMemorySnapshot).get() },
        ...externalPromptHints(memory.get(), new Set()),
        ...externalStateHints({ todos: todos.getTodos(agent.id), notes: todos.getNotes(agent.id).notes,
          goal: agent.accessor.get(IAgentGoalService).getGoal().goal }),
      ];
      if (input.event === 'PreCompact' || input.event === 'PostCompact') {
        hints.push({ origin: 'handoff', text: 'Preserve the current goal, working notes, constraints, decisions, and next action in the compaction handoff. Kiki memory, board, cron, threads, and history remain in Kiki; do not recreate persisted work.' });
      }
      let delivered = this.delivered.get(seat);
      if (delivered === undefined) this.delivered.set(seat, delivered = new Set());
      const preparing = input.event === 'PreCompact';
      const recovering = input.compact === true || (input.harness === 'codex' && input.event === 'UserPromptSubmit');
      if (recovering && delivered.delete('compaction_pending')) {
        for (const id of delivered) if (/^(memory|goal_state|todo_state):/.test(id)) delivered.delete(id);
      }
      if (preparing) delivered.add('compaction_pending');
      const execution = agent.accessor.get(IAgentExecutionService).status();
      const runningTurnId = execution.state === 'running' || execution.state === 'cancelling' ? execution.turnId : undefined;
      const boundary = externalBoundaryHookEvent(input.event);
      const history = memory.get();
      const parts: string[] = [];
      for (const hint of hints) {
        if (!hint.text.trim()) continue;
        const id = `${preparing ? 'prepared:' : ''}${hint.origin}:${createHash('sha256').update(hint.text).digest('hex')}`;
        if (delivered.has(id)) continue;
        const formatted = `[Kiki ${hint.origin}]\n${hint.text.trim()}`;
        if (!recovering && (externalHintAlreadyRecorded(history, hint.text, runningTurnId) || externalHintAlreadyRecorded(history, formatted, runningTurnId))) {
          delivered.add(id);
          continue;
        }
        delivered.add(id);
        parts.push(formatted);
      }
      const content = parts.join('\n\n');
      if (content.length > 0) {
        const text = preparing ? `[Handoff prepared; not injected by this hook]\n${content}` : content;
        const origin = { kind: 'hook_result' as const, event: `kiki:${input.harness}:${input.event}`, blocked: false };
        const beforeModel = runningTurnId !== undefined && !externalTurnHasModelContent(history, runningTurnId);
        if (!preparing && boundary && runningTurnId !== undefined) {
          const messageId = newMessageId();
          memory.appendManaged({
            role: 'user', content: [{ type: 'text', text }], toolCalls: [], id: messageId, origin,
          }, {
            deliveryId: newDeliveryId(),
            messageId,
            turnId: runningTurnId,
            deliveredAt: new Date().toISOString(),
            origin: 'queue',
            placement: beforeModel ? 'safety_boundary' : undefined,
          });
        } else {
          memory.appendObservable({ role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin });
        }
      }
      return { content: preparing ? '' : content };
    });
  }

  async catalog(seat: McpSeat): Promise<ContextCatalog> {
    return this.withAgent(seat, async (agent) => {
      const binding = agent.accessor.get(IAgentProfileService).data();
      const policy = agent.accessor.get(IAgentToolPolicyService);
      const registry = agent.accessor.get(IAgentToolRegistryService);
      if (seat.nativeTools === true) return {
        delegation: false,
        nativeTools: true,
        tools: registry.list().filter((tool) =>
          nativeHarnessToolAllowed(binding, agent.accessor.get(IAgentScopeContext).parentAgentId, tool.name, tool.source) &&
          policy.isToolActive(tool.name, tool.source)).map((tool) => ({
          name: tool.name,
          toolName: `kiki_${tool.name}`,
          description: tool.description,
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        })),
      };
      return {
        delegation: binding.allowKikiSubagents === true,
        tools: contextProcedureTable.flatMap((procedure) => {
          if (!binding.kikiContext?.includes(procedure.group) || !policy.isToolActive(procedure.nativeName)) return [];
          const tool = registry.resolve(procedure.nativeName);
          return tool === undefined ? [] : [{
            name: procedure.name,
            toolName: procedure.toolName,
            description: tool.description,
            parameters: tool.parameters ?? { type: 'object', properties: {} },
          }];
        }),
      };
    });
  }

  async call(seat: McpSeat, rawInput: unknown, signal: AbortSignal) {
    const input = contextCallSchema.parse(rawInput);
    return this.withAgent(seat, async (agent) => {
      const procedure = contextProcedureTable.find((entry) => entry.name === input.name);
      const binding = agent.accessor.get(IAgentProfileService).data();
      if (seat.nativeTools !== true && (procedure === undefined || !binding.kikiContext?.includes(procedure.group))) {
        throw new Error('Kiki context tool group is disabled');
      }
      const name = seat.nativeTools === true ? input.name : procedure!.nativeName;
      const registry = agent.accessor.get(IAgentToolRegistryService);
      const tool = registry.list().find((entry) => entry.name === name);
      if (tool === undefined) throw new Error('Kiki context tool is unavailable');
      if (seat.nativeTools === true &&
        !nativeHarnessToolAllowed(binding, agent.accessor.get(IAgentScopeContext).parentAgentId, name, tool.source)) {
        return { output: `Tool "${name}" is disabled by the harness capability binding`, isError: true };
      }
      if (!agent.accessor.get(IAgentToolPolicyService).isToolActive(name, tool.source)) {
        return { output: `Tool "${name}" is disabled by the active tool policy`, isError: true };
      }
      const executor = agent.accessor.get(IAgentToolExecutorService);
      const turnId = Math.max(0, agent.accessor.get(IAgentStateService).get(turnKey).nextTurnId - 1);
      for await (const executed of executor.execute([{
        id: `context:${randomUUID()}`,
        type: 'function',
        name,
        arguments: JSON.stringify(input.arguments),
      }], { signal, turnId })) {
        return { output: executed.result.output, isError: executed.result.isError };
      }
      throw new Error('Kiki context tool returned no result');
    });
  }

  async withAgent<T>(seat: McpSeat, operation: (agent: IAgentScopeHandle) => Promise<T>): Promise<T> {
    if (seat.harnessAgentId === undefined) throw new Error('Kiki context requires a harness agent seat');
    return withSessionOperation(this.core, seat.sessionId, async (session) => {
      if (session === undefined) throw new Error('Session does not exist');
      const agent = seat.harnessAgentId === 'main' && seat.nativeTools !== true ? await ensureMainAgent(session)
        : session.accessor.get(IAgentLifecycleService).get(seat.harnessAgentId!);
      if (agent === undefined || seat.nativeTools === true && agent !== seat.harnessAgentInstance) {
        throw new Error('Harness agent is not available');
      }
      return operation(agent);
    });
  }
}
