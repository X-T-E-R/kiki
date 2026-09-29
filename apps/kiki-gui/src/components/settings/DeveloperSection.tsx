import { AdvancedSection } from './AdvancedSection';
import { TokenCountingCard } from './CommunicationSection';
import { ResourceLimitsCard } from './EngineLimitSettings';
import { CronRuntimeCard } from './TaskRuntimeSettings';

/**
 * Developer: engine knobs a person tunes on purpose, then the raw JSON escape
 * hatch, then read-only diagnostics. Ordered from "typed field" to "read
 * only" so the most dangerous editor is never the first thing on the page.
 */
export function DeveloperSection() {
  return (
    <>
      <ResourceLimitsCard />
      <TokenCountingCard />
      <AdvancedSection />
      <CronRuntimeCard />
    </>
  );
}
