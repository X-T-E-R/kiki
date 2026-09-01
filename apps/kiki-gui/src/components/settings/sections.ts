import { SETTINGS_SECTIONS } from '../../lib/settings';

const SECTIONS = SETTINGS_SECTIONS;

type SectionId = (typeof SECTIONS)[number]['id'];

export { SECTIONS, type SectionId };
