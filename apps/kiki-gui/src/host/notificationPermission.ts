/** The system's own answer: allowed, refused, or never asked ('default'). */
export type SystemNotificationPermission = 'granted' | 'denied' | 'default';

/**
 * What a host's `notify` reports when the system has not been asked for
 * notification permission yet.
 *
 * Asking is never a side effect of a notification: a permission prompt that
 * appears out of nowhere, while the person is somewhere else, cannot be
 * understood. So a host that would have to ask first sends nothing and rejects
 * with this, carrying the one call that asks. The app then asks the person in
 * words (`components/firstRun/NotifyAskBanner`) and runs `request` from inside
 * the click on its "notify me" button, which browsers also require. Any kind of
 * notification can report this: a waiting approval matters most.
 */
export class NotificationPermissionNotAsked extends Error {
  constructor(
    /** Ask the system; resolves to whether notifications are now allowed. Call it from a user gesture. */
    readonly request: () => Promise<boolean>,
  ) {
    super('System notifications have not been allowed or blocked yet.');
    this.name = 'NotificationPermissionNotAsked';
  }
}
