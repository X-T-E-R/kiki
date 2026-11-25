import { useSyncExternalStore } from 'react';

import { sessionSeenSnapshot, subscribeSessionSeen } from '@kiki/session-core/settings';

export function useSessionSeen() {
  return useSyncExternalStore(subscribeSessionSeen, sessionSeenSnapshot, sessionSeenSnapshot);
}
