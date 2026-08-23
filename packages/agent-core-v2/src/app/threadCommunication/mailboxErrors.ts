import { HomeRuntimeError } from '#/app/runtimeHost/errors';

import { ThreadCommunicationErrors } from './errors';

export class ThreadMailboxLegacyWriterActiveError extends HomeRuntimeError {
  constructor() {
    super(
      ThreadCommunicationErrors.codes.MAILBOX_LEGACY_WRITER_ACTIVE,
      'A previous version is still using the legacy thread mailbox. Close the older process and retry.',
    );
    this.name = 'ThreadMailboxLegacyWriterActiveError';
  }
}

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
