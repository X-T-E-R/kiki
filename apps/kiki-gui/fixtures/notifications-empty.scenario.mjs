/** notifications-empty — nb-IM on, no channels yet: the empty state and the add form. */

import { GLOBAL, notificationsBase } from './notifications.scenario.mjs';

export default {
  ...notificationsBase,
  notifications: {
    settings: { global: { ...GLOBAL, quiet_hours: undefined }, provider_instances: {}, channels: {}, credential_slots: {} },
  },
};
