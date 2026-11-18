import type { ApprovalRequest } from '@kiki/protocol';

import {
  externalPermissionFromDisplay,
  planReviewFromDisplay,
  type ExternalPermissionOption,
} from '../Interactions';

export interface ConcurrencyLimiter {
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  readonly activeCount: () => number;
  readonly pendingCount: () => number;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Bounded async concurrency limiter so inline triage detail fetches never
 * crowd WebView2's 6-connection per-origin HTTP/1.1 pool.
 */
export function createConcurrencyLimiter(maxConcurrent = 2): ConcurrencyLimiter {
  const limit = Math.max(1, Math.floor(maxConcurrent));
  let active = 0;
  const queue: {
    start: () => void;
    reject: (reason: unknown) => void;
    cleanup?: () => void;
  }[] = [];

  const pump = () => {
    while (active < limit && queue.length > 0) {
      const next = queue.shift();
      if (next !== undefined) {
        next.cleanup?.();
        active += 1;
        next.start();
      }
    }
  };

  return {
    activeCount: () => active,
    pendingCount: () => queue.length,
    run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise<T>((resolve, reject) => {
        const entry = {
          cleanup: undefined as (() => void) | undefined,
          reject,
          start: () => {
            if (signal?.aborted) {
              active -= 1;
              pump();
              reject(abortError());
              return;
            }
            Promise.resolve()
              .then(task)
              .then(resolve, reject)
              .finally(() => {
                active -= 1;
                pump();
              });
          },
        };
        if (signal !== undefined) {
          const onAbort = () => {
            const idx = queue.indexOf(entry);
            if (idx !== -1) {
              queue.splice(idx, 1);
              entry.cleanup?.();
              reject(abortError());
            }
          };
          signal.addEventListener('abort', onAbort, { once: true });
          entry.cleanup = () => {
            signal.removeEventListener('abort', onAbort);
          };
        }
        queue.push(entry);
        pump();
      });
    },
  };
}

export const sharedActivityDetailLimiter = createConcurrencyLimiter(2);

export type ApprovalTriageShape =
  | { readonly kind: 'ssh'; readonly summary: string }
  | {
      readonly kind: 'external_permission';
      readonly ok: true;
      readonly summary: string;
      readonly options: readonly ExternalPermissionOption[];
    }
  | { readonly kind: 'external_permission'; readonly ok: false }
  | {
      readonly kind: 'plan_review';
      readonly excerpt: string;
      readonly path?: string;
      readonly hasOptions: boolean;
    }
  | {
      readonly kind: 'standard';
      readonly snippet?: string;
      readonly canAllowSession: boolean;
    };

function clampSnippet(raw: string, maxLines = 4, maxChars = 280): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  const lines = trimmed.split(/\r?\n/u);
  const sliced = lines.slice(0, maxLines).join('\n');
  const capped = sliced.length > maxChars ? `${sliced.slice(0, maxChars - 1)}…` : sliced;
  return lines.length > maxLines && !capped.endsWith('…') ? `${capped}\n…` : capped;
}

function extractRecordSnippet(display: unknown): string | undefined {
  if (typeof display === 'string') {
    const clean = clampSnippet(display);
    return clean === '' ? undefined : clean;
  }
  if (typeof display !== 'object' || display === null) return undefined;
  const record = display as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'path', 'file_path', 'url', 'pattern', 'query', 'summary', 'description'] as const) {
    const val = record[key];
    if (typeof val === 'string' && val.trim() !== '') {
      return clampSnippet(val);
    }
  }
  if (Array.isArray(record['query'])) {
    const joined = record['query'].filter((item): item is string => typeof item === 'string').join(' · ');
    if (joined.trim() !== '') return clampSnippet(joined);
  }
  return undefined;
}

export function extractApprovalDetail(request: ApprovalRequest): ApprovalTriageShape {
  if (request.ssh !== undefined) {
    const target = `${request.ssh.user}@${request.ssh.hostname}:${request.ssh.port}`;
    return {
      kind: 'ssh',
      summary: request.ssh.fingerprint ? `${target} · ${request.ssh.fingerprint}` : target,
    };
  }

  const external = externalPermissionFromDisplay(request.tool_input_display);
  if (external !== undefined) {
    if (!external.ok) return { kind: 'external_permission', ok: false };
    return {
      kind: 'external_permission',
      ok: true,
      summary: clampSnippet(external.display.summary, 3, 220),
      options: external.display.options,
    };
  }

  const plan = planReviewFromDisplay(request.tool_input_display);
  if (plan !== undefined) {
    return {
      kind: 'plan_review',
      excerpt: clampSnippet(plan.plan, 4, 260),
      path: plan.path,
      hasOptions: Boolean(plan.options && plan.options.length > 0),
    };
  }

  const snippet = extractRecordSnippet(request.tool_input_display) ?? request.approval_rule;
  const canAllowSession =
    request.tool_name !== 'EnterPlanMode' && request.tool_name !== 'ExitPlanMode';
  return {
    kind: 'standard',
    snippet: snippet !== undefined && snippet.trim() !== '' ? clampSnippet(snippet) : undefined,
    canAllowSession,
  };
}

/** Trim leading provider/channel prefix (`provider/model-name` -> `model-name`) for compact display. */
export function shortModelLabel(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const trimmed = model.trim();
  if (trimmed === '') return undefined;
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed;
}

/** True when a blocked item has waited 5 minutes or longer. */
export function isLongWait(isoAt: string, nowMs = Date.now()): boolean {
  const parsed = Date.parse(isoAt);
  if (Number.isNaN(parsed)) return false;
  return nowMs - parsed >= 5 * 60_000;
}
