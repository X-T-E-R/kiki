import type { ApprovalRequest } from '@kiki/protocol';

const SNIPPET_KEYS = ['command', 'cmd', 'path', 'file_path', 'url', 'pattern', 'query'] as const;
const REVIEW_KINDS: ReadonlySet<unknown> = new Set(['plan_enter', 'plan_exit', 'plan_review', 'external_permission']);

/** The kind of action an approval asks for, shown as a short verb title. */
export type ApprovalVerb = 'run' | 'edit' | 'write' | 'fetch' | 'read';

const ACTION_PREFIXES: readonly (readonly [RegExp, ApprovalVerb])[] = [
  [/^(?:running|run)\s*:?\s*/i, 'run'],
  [/^editing\s*:?\s*/i, 'edit'],
  [/^writing\s*:?\s*/i, 'write'],
  [/^fetching\s*:?\s*/i, 'fetch'],
  [/^reading\s*:?\s*/i, 'read'],
];

const TOOL_VERBS: Readonly<Record<string, ApprovalVerb>> = {
  Bash: 'run',
  bash: 'run',
  Shell: 'run',
  shell: 'run',
  Edit: 'edit',
  MultiEdit: 'edit',
  ApplyPatch: 'edit',
  apply_patch: 'edit',
  Write: 'write',
  FetchURL: 'fetch',
  WebFetch: 'fetch',
  Read: 'read',
};

export interface ApprovalSummary {
  /** Set when the action maps to a known verb; the UI titles the card with it. */
  readonly verb?: ApprovalVerb;
  readonly headline: string;
  /** The command, path or URL, shown in a monospace box. */
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

/** Verb title plus the command/path/URL for a pending approval card. */
export function summarizeApproval(request: ApprovalRequest): ApprovalSummary {
  const action = request.action.trim();
  const display = displaySnippet(request.tool_input_display)?.trim();
  const headline = action !== '' ? action : request.tool_name;
  let verb: ApprovalVerb | undefined;
  let subject = '';
  for (const [pattern, candidate] of ACTION_PREFIXES) {
    const match = pattern.exec(action);
    if (match !== null) {
      verb = candidate;
      subject = action.slice(match[0].length).trim();
      break;
    }
  }
  verb ??= TOOL_VERBS[request.tool_name];
  if (verb !== undefined) {
    const snippet = subject !== '' ? subject : display;
    return snippet !== undefined && snippet !== '' ? { verb, headline, snippet } : { verb, headline };
  }
  return display !== undefined && display !== '' && !headline.includes(display) ? { headline, snippet: display } : { headline };
}

/** Plain allow/deny approvals; plan reviews, external option sets and SSH prompts need the full view. */
export function isInlineDecidable(request: ApprovalRequest): boolean {
  if (request.ssh !== undefined) return false;
  const display = request.tool_input_display;
  const kind = typeof display === 'object' && display !== null ? (display as { kind?: unknown }).kind : undefined;
  return !REVIEW_KINDS.has(kind);
}
