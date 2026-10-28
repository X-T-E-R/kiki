import { MemoryAdvisorSettingsCard } from './MemoryAdvisorSettings';
import { MemorySettingsCard, MemoryWorkspaceSettingsCard } from './MemorySettings';

export function MemorySection() {
  return <div className="space-y-4"><MemorySettingsCard /><MemoryAdvisorSettingsCard /><MemoryWorkspaceSettingsCard /></div>;
}
