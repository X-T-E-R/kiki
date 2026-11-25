import type { CallOptions } from '../../core/channel.js';

export interface SessionCommandRouteSpec {
  readonly method: 'GET' | 'POST';
  readonly suffix: string;
  readonly okCodes: readonly number[];
  readonly timeoutMs?: number;
}

export const sessionCommandRoutes = {
  read: { method: 'GET', suffix: '', okCodes: [0] },
  submit: { method: 'POST', suffix: '/prompts', okCodes: [0], timeoutMs: 0 },
  edit: { method: 'POST', suffix: '/messages/{target}:edit', okCodes: [0] },
  regenerate: { method: 'POST', suffix: '/messages/{target}:regenerate', okCodes: [0] },
  fork: { method: 'POST', suffix: ':fork', okCodes: [0] },
  btw: { method: 'POST', suffix: ':btw', okCodes: [0] },
  branch: { method: 'POST', suffix: ':branch', okCodes: [0] },
  foldBranch: { method: 'POST', suffix: ':fold', okCodes: [0] },
  discardBranch: { method: 'POST', suffix: ':discard', okCodes: [0] },
  setBranchToolsLock: { method: 'POST', suffix: ':tools-lock', okCodes: [0] },
  promoteAgent: { method: 'POST', suffix: '/agents/{target}:promote', okCodes: [0] },
  abort: { method: 'POST', suffix: '/prompts/{target}:abort', okCodes: [0, 40903] },
  abortTurn: { method: 'POST', suffix: '/turns/{target}:abort', okCodes: [0] },
  move: { method: 'POST', suffix: '/prompts/{target}:move', okCodes: [0] },
  replace: { method: 'POST', suffix: '/prompts/{target}:replace', okCodes: [0] },
  timing: { method: 'POST', suffix: '/prompts/{target}:timing', okCodes: [0] },
  hold: { method: 'POST', suffix: '/prompts/{target}:hold', okCodes: [0] },
  steer: { method: 'POST', suffix: '/prompts/{target}:steer', okCodes: [0] },
  approve: { method: 'POST', suffix: '/approvals/{target}', okCodes: [0] },
  answer: { method: 'POST', suffix: '/questions/{target}', okCodes: [0] },
  dismiss: { method: 'POST', suffix: '/questions/{target}:dismiss', okCodes: [0, 40909] },
  cancelTask: { method: 'POST', suffix: '/tasks/{target}:cancel', okCodes: [0, 40904] },
} as const satisfies Record<string, SessionCommandRouteSpec>;

export type SessionCommandName = keyof typeof sessionCommandRoutes;

export interface SessionCommandChannel {
  execute(sessionId: string, command: SessionCommandName, input: unknown, options?: CallOptions): Promise<unknown>;
}
