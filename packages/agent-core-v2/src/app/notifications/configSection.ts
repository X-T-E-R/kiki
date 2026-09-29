import { z } from 'zod';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const NOTIFICATIONS_SECTION = 'notifications';

export const NotificationsConfigSchema = z.object({
  global: z.object({
    enabled: z.boolean(),
    suppress_viewing_session: z.boolean(),
    min_work_ms: z.number().int().min(0).max(86_400_000),
    work_stable_ms: z.number().int().min(100).max(60_000),
    question_delay_ms: z.number().int().min(100).max(600_000),
    quiet_hours: z.object({ start: z.string(), end: z.string(), time_zone: z.string() }).strict().optional(),
  }).strict(),
  provider_instances: z.record(z.string(), z.unknown()),
  channels: z.record(z.string(), z.unknown()),
  credential_slots: z.record(z.string(), z.unknown()),
  credential_values: z.record(z.string(), z.object({ token: z.string(), epoch_token: z.string().uuid().optional() }).strict()),
}).strict();

export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;

export const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = {
  global: {
    enabled: false,
    suppress_viewing_session: true,
    min_work_ms: 30_000,
    work_stable_ms: 3_000,
    question_delay_ms: 10_000,
  },
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
