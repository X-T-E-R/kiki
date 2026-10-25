import { CronRuntimeCard, TaskPolicyCard } from './TaskRuntimeSettings';

/** Background-task limits and cron diagnostics. Plan defaults live on Sessions. */
export function TasksSection() {
  return (
    <>
      <TaskPolicyCard />
      <CronRuntimeCard />
    </>
  );
}
