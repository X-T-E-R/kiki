import { memo } from 'react';
import type {
  AgentIdentity,
  AgentTokenUsage,
  AgentTreeMetrics,
  AgentPanelTodo,
  AgentToolCapability,
  AgentSkillCapability,
  AgentSubagentTarget,
  AgentActiveWorkItem,
  AgentBoardSummary,
} from './types';
import { AgentIdentitySection } from './AgentIdentitySection';
import { AgentTodoSection } from './AgentTodoSection';
import { AgentCapabilitiesSection } from './AgentCapabilitiesSection';
import { AgentActiveWorkSection, AgentPinnedBoardFooter } from './AgentActiveWorkSection';

export interface AgentPanelProps {
  readonly identity: AgentIdentity;
  readonly usage?: AgentTokenUsage;
  readonly treeMetrics?: AgentTreeMetrics;
  readonly todos: readonly AgentPanelTodo[];
  readonly tools: readonly AgentToolCapability[];
  readonly skills: readonly AgentSkillCapability[];
  readonly subagentTargets: readonly AgentSubagentTarget[];
  readonly activeWork: readonly AgentActiveWorkItem[];
  readonly boardSummary?: AgentBoardSummary;
  readonly onOpenTreeSelect?: () => void;
  readonly onOpenUsageDetail?: () => void;
  readonly onToggleTodo?: (id: string) => void;
  readonly onNewTodo?: () => void;
  readonly onOpenActiveItem?: (item: AgentActiveWorkItem) => void;
  readonly onOpenBoard: () => void;
  readonly onNewBoardTask?: () => void;
  readonly className?: string;
  readonly prototypeMode?: boolean;
}

export const AgentPanel = memo(function AgentPanel({
  identity,
  usage,
  treeMetrics,
  todos,
  tools,
  skills,
  subagentTargets,
  activeWork,
  boardSummary,
  onOpenTreeSelect,
  onOpenUsageDetail,
  onToggleTodo,
  onNewTodo,
  onOpenActiveItem,
  onOpenBoard,
  onNewBoardTask,
  className = '',
}: AgentPanelProps) {
  return (
    <div
      data-agent-panel
      className={`flex flex-col h-full min-h-0 bg-paper font-sans text-ink border-l border-hairline relative ${className}`}
    >
      {/* Scrollable Center Content Area (Takes remaining height, scrolls smoothly) */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 pb-2">
        {/* 1. Agent Identity Area (includes compact metrics + context meter + profile details drawer) */}
        <AgentIdentitySection
          identity={identity}
          usage={usage}
          treeMetrics={treeMetrics}
          onOpenTreeSelect={onOpenTreeSelect}
          onOpenUsageDetail={onOpenUsageDetail}
        />

        {/* 2. Current Todo (Directly following identity, mid-top position) */}
        <AgentTodoSection
          todos={todos}
          onToggleTodo={onToggleTodo}
          onNewTodo={onNewTodo}
        />

        {/* 3. Active Work Execution (This Agent's Todo + Running Children) */}
        <AgentActiveWorkSection
          activeItems={activeWork}
          onOpenItem={onOpenActiveItem}
        />

        {/* 4. Capabilities & Dispatch (Tools, Skills, Subagents) */}
        <AgentCapabilitiesSection
          tools={tools}
          skills={skills}
          subagentTargets={subagentTargets}
        />
      </div>

      {/* Pinned Board Entry / Active Task Summary at Bottom (Always pinned, never scrolled away) */}
      <div className="shrink-0">
        <AgentPinnedBoardFooter
          summary={boardSummary}
          onOpenBoard={onOpenBoard}
          onNewBoardTask={onNewBoardTask}
        />
      </div>
    </div>
  );
});
