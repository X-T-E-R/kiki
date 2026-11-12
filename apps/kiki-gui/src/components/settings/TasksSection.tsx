import { BackgroundWorkCard, TaskPolicyCard } from './TaskRuntimeSettings';

/**
 * The retired background-task leaf: both halves of the `task` domain, the
 * everyday one (Sessions › Background work) and the engine one (Developer ›
 * Engine parameters). Plan defaults live on Sessions; cron diagnostics on Developer.
 */
export function TasksSection() {
  return <><BackgroundWorkCard /><TaskPolicyCard /></>;
}
