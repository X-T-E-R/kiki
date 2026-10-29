import { AdvancedSection } from './AdvancedSection';
import { TokenCountingCard } from './CommunicationSection';
import { ResourceLimitsCard } from './EngineLimitSettings';
import { LabsSection } from './LabsSection';
import { MemoryAdvisorTuningCard } from './MemoryAdvisorTuning';
import { RetryPolicyCard } from './RetryPolicyCard';
import { SessionResidencyCard } from './SessionResidencyCard';
import { CronRuntimeCard } from './TaskRuntimeSettings';

/**
 * Developer & labs: engine knobs a person tunes on purpose, then the raw JSON
 * escape hatch, then the experimental-features index and developer-owned flags.
 * The cron readout (env-driven, never a form) sits with the engine reads.
 */
export function DeveloperSection() {
  return (
    <>
      <ResourceLimitsCard />
      <RetryPolicyCard />
      <SessionResidencyCard />
      <TokenCountingCard />
      <MemoryAdvisorTuningCard />
      <CronRuntimeCard />
      <AdvancedSection />
      <LabsSection />
    </>
  );
}
