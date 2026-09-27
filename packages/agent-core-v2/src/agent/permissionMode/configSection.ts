import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const DEFAULT_PERMISSION_MODE_SECTION = 'defaultPermissionMode';

export const DefaultPermissionModeSchema = z.enum(['manual', 'auto', 'review', 'yolo']);

registerConfigSection(DEFAULT_PERMISSION_MODE_SECTION, DefaultPermissionModeSchema);
