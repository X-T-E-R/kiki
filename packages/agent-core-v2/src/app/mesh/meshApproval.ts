import type { ISessionApprovalService, ApprovalDecision } from '#/session/approval/approval';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

export type MeshPermissionMode = 'manual' | 'review' | 'auto' | 'yolo';

export type MeshOperationKind =
  | 'remote_command'
  | 'out_of_workspace'
  | 'cow_apply'
  | 'file_sync'
  | 'port_tunnel'
  | 'interactive_login';

export interface MeshApprovalInput {
  readonly operation: MeshOperationKind;
  readonly permissionMode: MeshPermissionMode;
  readonly action: string;
  readonly targetLabel: string;
  readonly display?: ToolInputDisplay;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly toolCallId?: string;
  readonly approvalService?: Pick<ISessionApprovalService, 'request'>;
}

export interface MeshApprovalOutcome {
  readonly decision: ApprovalDecision;
  readonly via: 'yolo_auto_approve' | 'session_approval_service' | 'approval_required';
  readonly feedback?: string;
}

/**
 * Evaluates approval for a mesh operation without introducing a second gate above `permission_mode === 'yolo'`.
 * Interactive login flows always require human credentials; all other operations auto-approve immediately in `yolo` mode.
 */
export async function evaluateMeshApproval(input: MeshApprovalInput): Promise<MeshApprovalOutcome> {
  if (input.operation !== 'interactive_login' && input.permissionMode === 'yolo') {
    return {
      decision: 'approved',
      via: 'yolo_auto_approve',
    };
  }
  if (input.approvalService === undefined) {
    return {
      decision: 'rejected',
      via: 'approval_required',
      feedback: `Operation '${input.operation}' on '${input.targetLabel}' requires approval in '${input.permissionMode}' mode.`,
    };
  }
  const response = await input.approvalService.request({
    sessionId: input.sessionId,
    agentId: input.agentId,
    toolCallId: input.toolCallId,
    toolName: `mesh:${input.operation}`,
    action: input.action,
    display: input.display ?? {
      kind: 'generic',
      summary: `${input.operation} on ${input.targetLabel}: ${input.action}`,
    },
  });
  return {
    decision: response.decision,
    via: 'session_approval_service',
    ...(response.feedback === undefined ? {} : { feedback: response.feedback }),
  };
}
