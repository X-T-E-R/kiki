import { SETTINGS_SECTIONS } from '@kiki/session-core/settings';

const SECTIONS = SETTINGS_SECTIONS;

type SectionId = (typeof SECTIONS)[number]['id'];

export { SECTIONS, type SectionId };
