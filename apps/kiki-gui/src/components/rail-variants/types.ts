/**
 * The right rail's public contract, shared by both modes and every caller
 * (the session view and the routed agent page).
 */

import type { ReactNode } from 'react';

import type {
  AgentForest,
  ApprovalBlock,
  QuestionBlock,
  SessionViewState,
  SubagentBlock,
} from '@kiki/session-core/session';

/** Additional context for the selected subagent in the shared rail. */
export interface SubagentRailContext {
  readonly agentId: string;
  /** The subagent's own timeline card data from the parent transcript. */
  readonly block: SubagentBlock | undefined;
  /** Pending approvals + questions waiting on this subagent. */
  readonly pendingInteractionCount: number;
  /** Jump back to the parent timeline and locate the spawning card. */
  readonly onJumpToSpawn: (() => void) | undefined;
}

/**
 * Reserved inspector chapter for session memory (entries this session read or
 * wrote). The rail renders whatever the caller passes; with nothing passed
 * the slot stays empty and takes no space.
 */
export interface InspectorMemorySlot {
  readonly title: string;
  readonly count?: number;
  readonly content: ReactNode;
}

export interface RailProps {
  state: SessionViewState;
  forest: AgentForest;
  selectedAgentId?: string;
  subagent?: SubagentRailContext;
  taskOwnerAgentId?: string;
  onClose?: () => void;
  onCancelTask: (taskId: string, ownerAgentId?: string) => void;
  /**
   * Stops one running subagent task through its owning agent's scope
   * (`ownerAgentId` = the agent the task is registered under). When absent
   * the bulk-terminate affordance stays hidden.
   */
  onStopAgentTask?: (ownerAgentId: string, taskId: string) => Promise<void>;
  onOpenSubagent: (agentId: string) => void;
  /** Heading's "← Main agent" — hand the inspector back to main. */
  onInspectMain?: () => void;
  /** Needs-you Review: focus the item where it is answered. */
  onReviewPending?: (kind: 'approval' | 'question', id: string) => void;
  /**
   * Every pending approval / question in the session, from any agent depth.
   * With it the rail leads with one Needs you block in every focus; without
   * it (the routed agent page) Now lists the focused agent's own items.
   */
  sessionPending?: readonly (ApprovalBlock | QuestionBlock)[];
  /** In-place yes/no for a bubbled approval (session-scoped resolve). */
  onResolveApproval?: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
  /** Recent-activity file rows open the file in the preview workspace. */
  onOpenFile?: (path: string) => void;
  /** Reserved memory chapter (see InspectorMemorySlot). */
  memory?: InspectorMemorySlot;
  className?: string;
}
