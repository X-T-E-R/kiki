export type MailboxWrite<V> =
  | { readonly op: 'set'; readonly key: string; readonly value: V; readonly ttl?: number; readonly expireAt?: number; readonly onlyIfMissing?: boolean }
  | { readonly op: 'del'; readonly key: string };

export interface MailboxRow<V = Record<string, unknown>> {
  readonly key: string;
  readonly value: V;
  readonly expireAt: number;
}

export interface MailboxOwner {
  readonly epoch: number;
  readonly hostId: string;
}

export interface LegacyDeliveryCursor {
  readonly target: string;
  readonly seq: number;
  readonly key: string;
}

export interface LegacyDeliveryPage {
  readonly rows: readonly LegacyDeliveryCursor[];
}

export type MailboxOperation =
  | { readonly type: 'owner'; readonly owner: MailboxOwner }
  | { readonly type: 'get'; readonly keys: readonly string[] }
  | { readonly type: 'find_identity'; readonly partition: string; readonly field: 'messageId' | 'legacyIdentity'; readonly value: string }
  | { readonly type: 'batch'; readonly ops: readonly MailboxWrite<unknown>[]; readonly owner?: MailboxOwner; readonly archive?: { readonly source: string; readonly rows: readonly MailboxRow[] }; readonly importCheckpoint?: { readonly source: string; readonly after: string; readonly items: number; readonly bytes: number } }
  | { readonly type: 'scan'; readonly prefix: string; readonly after?: string; readonly limit: number; readonly kind?: string }
  | { readonly type: 'peer'; readonly group: string; readonly before?: string; readonly limit: number }
  | { readonly type: 'checkpoint'; readonly source: string }
  | { readonly type: 'legacy_deliveries'; readonly source: string; readonly after?: LegacyDeliveryCursor; readonly limit: number }
  | { readonly type: 'discard_archive'; readonly completedMigrationId?: string }
  | { readonly type: 'verify' }
  | { readonly type: 'backup'; readonly destination: string }
  | { readonly type: 'metadata'; readonly key: string; readonly value?: unknown }
  | { readonly type: 'close' };

export interface MailboxRequest {
  readonly id: number;
  readonly operation: MailboxOperation;
  readonly cancellation?: SharedArrayBuffer;
}

export type MailboxResponse =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: { readonly message: string; readonly code?: string; readonly committed?: boolean } };

/** Error code for a mailbox request rejected before dispatch because the worker queue is full. */
export const MAILBOX_QUEUE_FULL = 'mailbox.queue_full';

let entry: string | undefined;
export function configureMailboxWorkerRuntime(path: string): void { entry = path; }
export function mailboxWorkerEntry(): string | undefined { return entry; }
