import { z } from 'zod';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const NOTIFICATIONS_SECTION = 'notifications';

const DEFAULT_NOTIFICATIONS_GLOBAL = {
  enabled: true,
  suppress_viewing_session: true,
  min_work_ms: 0,
  work_stable_ms: 3_000,
  question_delay_ms: 10_000,
} as const;

export const NotificationsConfigSchema = z.object({
  global: z.object({
    enabled: z.boolean().default(DEFAULT_NOTIFICATIONS_GLOBAL.enabled),
    suppress_viewing_session: z.boolean().default(DEFAULT_NOTIFICATIONS_GLOBAL.suppress_viewing_session),
    min_work_ms: z.number().int().min(0).max(86_400_000).default(DEFAULT_NOTIFICATIONS_GLOBAL.min_work_ms),
    work_stable_ms: z.number().int().min(100).max(60_000).default(DEFAULT_NOTIFICATIONS_GLOBAL.work_stable_ms),
    question_delay_ms: z.number().int().min(100).max(600_000).default(DEFAULT_NOTIFICATIONS_GLOBAL.question_delay_ms),
    quiet_hours: z.object({ start: z.string(), end: z.string(), time_zone: z.string() }).strict().optional(),
  }).strict().default({ ...DEFAULT_NOTIFICATIONS_GLOBAL }),
  provider_instances: z.record(z.string(), z.unknown()).default({}),
  channels: z.record(z.string(), z.unknown()).default({}),
  credential_slots: z.record(z.string(), z.unknown()).default({}),
  credential_values: z.record(z.string(), z.object({ token: z.string(), epoch_token: z.string().uuid().optional() }).strict()).default({}),
}).strict();

export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;

export const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = {
  global: { ...DEFAULT_NOTIFICATIONS_GLOBAL },
  provider_instances: {},
  channels: {},
  credential_slots: {},
  credential_values: {},
};

registerConfigSection(NOTIFICATIONS_SECTION, NotificationsConfigSchema, {
  defaultValue: DEFAULT_NOTIFICATIONS_CONFIG,
  fromToml: (value) => value,
  toToml: (value) => value,
});
