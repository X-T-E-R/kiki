import { MemorySettingsCard, MemoryWorkspaceSettingsCard } from './MemorySettings';

export function MemorySection() {
  return <div className="space-y-4"><MemorySettingsCard /><MemoryWorkspaceSettingsCard /></div>;
}
