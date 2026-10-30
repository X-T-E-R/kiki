import { AdvancedSection } from './AdvancedSection';
import { LabsSection } from './LabsSection';
import { CronRuntimeCard } from './TaskRuntimeSettings';

/**
 * Developer & labs: the cron readout (env-driven, never a form), the raw JSON
 * escape hatch, the experimental-features index, and developer-owned flags.
 * Everything with a user-facing home lives there instead: residency and
 * resource ceilings on Sessions › Background work, retry and token counting
 * on Models › Defaults, and advisor tuning inside the Memory advisor card.
 */
export function DeveloperSection() {
  return (
    <>
      <CronRuntimeCard />
      <AdvancedSection />
      <LabsSection />
    </>
  );
}
