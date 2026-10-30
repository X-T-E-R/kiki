import { MemoryAdvisorSettingsCard } from './MemoryAdvisorSettings';
import { MemorySettingsCard, MemoryWorkspaceSettingsCard } from './MemorySettings';

export function MemorySection() {
  // The tuning card id is kept as an alias on the advisor card's wrapper, so
  // old links to the developer page's tuning card land on the advisor card,
  // whose 高级 fold holds the numbers now.
  return (
    <div className="space-y-4">
      <MemorySettingsCard />
      <div id="st-card-memory-advisor-tuning" className="scroll-mt-4"><MemoryAdvisorSettingsCard /></div>
      <MemoryWorkspaceSettingsCard />
    </div>
  );
}
