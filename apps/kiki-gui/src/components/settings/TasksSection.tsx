import { useConnection } from '../../state/connection';
import { AgentTaskSettings } from './AgentTaskSettings';
import { BoardStorageSettings } from './BoardStorageSettings';
import { ExperimentalSection } from './ExperimentalSection';
import { PlanSettings } from './PlanSettings';
import { CronRuntimeCard, TaskPolicyCard } from './TaskRuntimeSettings';

/** Task board storage and the agent-local Todo explanation share one capability leaf. */
export function TasksSection() {
  const { klient } = useConnection();
  return (
    <div className="space-y-4">
      <PlanSettings />
      <TaskPolicyCard />
      <CronRuntimeCard />
      <AgentTaskSettings
        boardContent={
          <>
            <BoardStorageSettings board={klient.global.board} />
            <ExperimentalSection
              featureIds={['task_board']}
              cardId="st-card-task-board"
              titleKey="st.experimental.taskBoard"
            />
          </>
        }
      />
    </div>
  );
}
