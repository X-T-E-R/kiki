import { AdvancedSection } from './AdvancedSection';
import { TokenCountingCard } from './CommunicationSection';
import { ResourceLimitsCard } from './EngineLimitSettings';
import { LabsSection } from './LabsSection';
import { RetryPolicyCard } from './RetryPolicyCard';
import { SessionResidencyCard } from './SessionResidencyCard';

/**
 * Developer & labs: engine knobs a person tunes on purpose, then the raw JSON
 * escape hatch, then the experimental-features index and developer-owned flags.
 */
export function DeveloperSection() {
  return (
    <>
      <ResourceLimitsCard />
      <RetryPolicyCard />
      <SessionResidencyCard />
      <TokenCountingCard />
      <AdvancedSection />
      <LabsSection />
    </>
  );
}
