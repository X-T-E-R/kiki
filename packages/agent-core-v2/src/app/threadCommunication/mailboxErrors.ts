/**
 * `threadCommunication` domain — backend-neutral mailbox operation failures.
 */

export class ThreadMailboxBacklogError extends Error {
  constructor(readonly limit: number) {
    super(`Thread mailbox has reached its pending-message limit (${limit}).`);
    this.name = 'ThreadMailboxBacklogError';
  }
}

export class ThreadActivityCursorExpiredError extends Error {
  constructor(
    readonly epoch: string,
    readonly minSeq: number,
    readonly latestSeq: number,
  ) {
    super('Thread activity cursor is older than retained activity.');
    this.name = 'ThreadActivityCursorExpiredError';
  }
}
