export type CodexClientErrorCode =
  | 'aborted'
  | 'closed'
  | 'protocol'
  | 'remote'
  | 'spawn'
  | 'stdio'
  | 'timeout';

export class CodexClientError extends Error {
  constructor(
    readonly code: CodexClientErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'CodexClientError';
  }
}

export class CodexRemoteError extends CodexClientError {
  constructor(
    readonly requestId: string,
    readonly remoteCode: number,
    message: string,
    data?: unknown,
  ) {
    super('remote', message, data);
    this.name = 'CodexRemoteError';
  }
}
