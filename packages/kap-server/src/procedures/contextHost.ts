import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { IAgentMemorySnapshot } from '@kiki/agent-core-v2/app/memory/memorySnapshot';
import { IAgentContextMemoryService } from '@kiki/agent-core-v2/agent/contextMemory/contextMemory';
import { IAgentContextInjectorService } from '@kiki/agent-core-v2/agent/contextInjector/contextInjector';
import { externalPromptHints, externalStateHints } from '@kiki/agent-core-v2/agent/execution/externalPromptHints';
import { ISessionTodoService } from '@kiki/agent-core-v2/session/todo/sessionTodo';
import { IAgentGoalService } from '@kiki/agent-core-v2/agent/goal/goal';

import { IAgentProfileService, type Scope } from '@kiki/agent-core-v2';
import { IAgentToolRegistryService } from '@kiki/agent-core-v2/agent/toolRegistry/toolRegistry';
import { IAgentToolExecutorService } from '@kiki/agent-core-v2/agent/toolExecutor/toolExecutor';
import { IAgentStateService } from '@kiki/agent-core-v2/agent/state/agentState';
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
      const promptText = memory.get().findLast((message) => message.origin?.kind === 'user')?.content
        .flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n') ?? '';
      const parts: string[] = [];
      for (const hint of hints) {
        if (!hint.text.trim()) continue;
        const id = `${preparing ? 'prepared:' : ''}${hint.origin}:${createHash('sha256').update(hint.text).digest('hex')}`;
        if (delivered.has(id)) continue;
        if (input.harness === 'grok' && promptText.includes(`[Kiki ${hint.origin}]\n${hint.text}`)) { delivered.add(id); continue; }
        delivered.add(id);
        parts.push(`[Kiki ${hint.origin}]\n${hint.text.trim()}`);
      }
      const content = parts.join('\n\n');
      if (content.length > 0) memory.appendObservable({
        role: 'user', content: [{ type: 'text', text: preparing ? `[Handoff prepared; not injected by this hook]\n${content}` : content }], toolCalls: [],
        origin: { kind: 'hook_result', event: `kiki:${input.harness}:${input.event}`, blocked: false },
      });
      return { content: preparing ? '' : content };
    });
  }

  async catalog(seat: McpSeat): Promise<ContextCatalog> {
    return this.withAgent(seat, async (agent) => {
      const binding = agent.accessor.get(IAgentProfileService).data();
      const registry = agent.accessor.get(IAgentToolRegistryService);
      return {
        delegation: binding.allowKikiSubagents === true,
        tools: contextProcedureTable.flatMap((procedure) => {
          if (!binding.kikiContext?.includes(procedure.group)) return [];
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
      const procedure = contextProcedureTable.find((entry) => entry.name === input.name)!;
      const binding = agent.accessor.get(IAgentProfileService).data();
      if (!binding.kikiContext?.includes(procedure.group)) throw new Error('Kiki context tool group is disabled');
      const registry = agent.accessor.get(IAgentToolRegistryService);
      if (registry.resolve(procedure.nativeName) === undefined) throw new Error('Kiki context tool is disabled by the active tool policy');
      const executor = agent.accessor.get(IAgentToolExecutorService);
      const turnId = Math.max(0, agent.accessor.get(IAgentStateService).get(turnKey).nextTurnId - 1);
      for await (const executed of executor.execute([{
        id: `context:${randomUUID()}`,
        type: 'function',
        name: procedure.nativeName,
        arguments: JSON.stringify(input.arguments),
      }], { signal, turnId })) {
        return { output: executed.result.output, isError: executed.result.isError };
      }
      throw new Error('Kiki context tool returned no result');
    });
  }

  async withAgent<T>(seat: McpSeat, operation: (agent: Awaited<ReturnType<typeof ensureMainAgent>>) => Promise<T>): Promise<T> {
    if (seat.harnessAgentId !== 'main') throw new Error('Kiki context requires a harness main seat');
    return withSessionOperation(this.core, seat.sessionId, async (session) => {
      if (session === undefined) throw new Error('Session does not exist');
      const main = await ensureMainAgent(session);
      if (main.id !== seat.harnessAgentId) throw new Error('Harness agent is not admitted');
      return operation(main);
    });
  }
}
