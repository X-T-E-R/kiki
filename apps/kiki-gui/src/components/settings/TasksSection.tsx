import { useConnection } from '../../state/connection';
import { AgentTaskSettings } from './AgentTaskSettings';
import { BoardStorageSettings } from './BoardStorageSettings';
import { TaskPolicyCard } from './TaskRuntimeSettings';

/**
 * Tasks: background-task limits and where task cards live. Plan defaults
 * moved to Sessions (they decide how a session starts, not how tasks run);
 * the task-board feature flag moved to Labs with every other flag.
 */
export function TasksSection() {
  const { klient } = useConnection();
  return (
    <>
      <TaskPolicyCard />
      <AgentTaskSettings boardContent={<BoardStorageSettings board={klient.global.board} />} />
    </>
  );
}
