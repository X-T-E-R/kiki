import type { ApprovalRequest } from '@kiki/protocol';

const SNIPPET_KEYS = ['command', 'cmd', 'path', 'file_path', 'url', 'pattern', 'query'] as const;
const REVIEW_KINDS: ReadonlySet<unknown> = new Set(['plan_enter', 'plan_exit', 'plan_review', 'external_permission']);

export interface ApprovalSummary {
  readonly headline: string;
  readonly snippet?: string;
}

function displaySnippet(display: unknown): string | undefined {
  if (typeof display === 'string') return display;
  if (typeof display !== 'object' || display === null) return undefined;
  const record = display as Record<string, unknown>;
  for (const key of SNIPPET_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/** Headline and optional command/path snippet for a pending approval card. */
export function summarizeApproval(request: ApprovalRequest): ApprovalSummary {
  const action = request.action.replace(/^Run:\s*/, '').trim();
  const headline = action !== '' ? action : request.tool_name;
  const snippet = displaySnippet(request.tool_input_display)?.trim();
  return snippet !== undefined && snippet !== '' && !headline.includes(snippet) ? { headline, snippet } : { headline };
}

/** Plain allow/deny approvals; plan reviews, external option sets and SSH prompts need the full view. */
export function isInlineDecidable(request: ApprovalRequest): boolean {
  if (request.ssh !== undefined) return false;
  const display = request.tool_input_display;
  const kind = typeof display === 'object' && display !== null ? (display as { kind?: unknown }).kind : undefined;
  return !REVIEW_KINDS.has(kind);
}
