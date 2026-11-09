import { randomUUID } from 'node:crypto';

import type { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { Error2, ErrorCodes } from '#/errors';
import { literalRulePattern } from '#/tool/rule-match';
import type { DispatchSelectorCall } from '#/session/dispatch/dispatch';

export function autoModelApprovalContext(
  selector: unknown,
  workDir: string,
  signal: AbortSignal,
  call?: DispatchSelectorCall,
): ResolvedToolExecutionHookContext {
  const args = { purpose: 'AgentRun model selection', receives: ['description', 'prompt', 'candidates'], workDir, selector };
  const toolCall = { type: 'function' as const, id: call?.toolCallId ?? `model-selector:${randomUUID()}`,
    name: 'AgentRunSelector', arguments: JSON.stringify(args) };
  const summary = 'Allow this model selector to receive dispatch text and choose a model';
  return { permissionAuthority: 'owner', turnId: call?.turnId ?? 0, signal, toolCall, toolCalls: [toolCall], args,
    execution: {
      description: summary, display: { kind: 'generic', summary, detail: args },
      approvalRule: literalRulePattern(toolCall.name, JSON.stringify(args)),
      execute: async () => ({ output: '' }),
    } };
}

export async function authorizeAutoModelSelector(
  gate: IAgentPermissionGate,
  context: ResolvedToolExecutionHookContext,
): Promise<void> {
  const result = await gate.authorize(context);
  if (result?.veto !== undefined || result?.permissionDecision === 'rejected' || result?.permissionDecision === 'cancelled') {
    throw new Error2(ErrorCodes.REQUEST_INVALID, typeof result.veto?.output === 'string'
      ? result.veto.output : 'The model selector was not authorized.');
  }
  context.signal.throwIfAborted();
}
