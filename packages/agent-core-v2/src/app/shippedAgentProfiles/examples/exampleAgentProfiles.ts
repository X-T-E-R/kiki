import IMPLEMENTER_PROFILE_TEXT from './implementer.md?raw';
import REVIEWER_PROFILE_TEXT from './reviewer.md?raw';

export const EXAMPLE_AGENT_PROFILE_TEMPLATES = [
  { id: 'implementer', fileName: 'implementer.md', text: IMPLEMENTER_PROFILE_TEXT },
  { id: 'reviewer', fileName: 'reviewer.md', text: REVIEWER_PROFILE_TEXT },
] as const;
