import { AdvancedSection } from './AdvancedSection';
import { LabsSection } from './LabsSection';
import { CronRuntimeCard } from './TaskRuntimeSettings';

/**
 * Developer & labs, first tab: the cron readout (env-driven, never a form),
 * the raw JSON escape hatch, the experimental-features index, and
 * developer-owned flags. Engine internals moved off the everyday pages
 * (residency, resource ceilings, task caps, handoff notices, title moments)
 * are the Engine parameters tab; retry and token counting stay on Models ›
 * Defaults, and advisor tuning inside the Memory advisor card.
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
