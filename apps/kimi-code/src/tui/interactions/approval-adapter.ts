import type { ApprovalRequest, ToolInputDisplay } from '@kiki/node-sdk';
import { goalStartOptions } from '#/tui/components/dialogs/goal-start-permission-prompt';
import type { ApprovalPanelChoice, ApprovalPanelData, DisplayBlock } from '#/tui/interactions/types';

const DEFAULT_APPROVAL_CHOICES: ApprovalPanelChoice[] = [
  { label: 'Approve once', response: 'approved' },
  { label: 'Approve for this session', response: 'approved_for_session' },
  { label: 'Reject', response: 'rejected' },
  { label: 'Reject with feedback', response: 'rejected', requires_feedback: true },
];

const PLAN_REJECT_CHOICES: ApprovalPanelChoice[] = [
  { label: 'Reject', response: 'rejected', selected_label: 'Reject' },
  { label: 'Revise', response: 'rejected', selected_label: 'Revise', requires_feedback: true },
];

export function adaptApprovalRequest(event: ApprovalRequest): ApprovalPanelData {
  const external = externalPermissionFromDisplay(event.display);
  if (external !== undefined) {
    return {
      id: event.toolCallId,
      tool_call_id: event.toolCallId,
      tool_name: event.toolName,
      action: event.action,
      ...adaptExternalPermission(external),
    };
  }
  const resolved = resolveDisplay(event.toolName, event.display, event.action);
  return {
    id: event.toolCallId,
    tool_call_id: event.toolCallId,
    tool_name: event.toolName,
    action: event.action,
    description: resolved.description,
    display: resolved.blocks,
    choices: adaptChoices(event.toolName, event.display),
  };
}

/* ── External permission options (ACP harness, design §9) ─────────────── */

/**
 * The option set is OPEN — kinds beyond allow_once/allow_always/reject_once/
 * reject_always are legal and must all reach the panel. The exact option id
 * round-trips via `selected_option_id`; the adapter re-validates it against
 * the original request, so the UI never has to guess semantics.
 */
interface ExternalPermissionOption {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly changes?: readonly unknown[];
}

type ExternalPermissionParse =
  | { readonly ok: true; readonly summary: string; readonly detail?: unknown; readonly options: readonly ExternalPermissionOption[] }
  | { readonly ok: false };

/**
 * Undefined when the payload is some other display kind; `{ok:false}` when it
 * claims `external_permission` but fails validation — fail closed: the panel
 * then offers only Cancel.
 */
function externalPermissionFromDisplay(display: unknown): ExternalPermissionParse | undefined {
  if (!isRecord(display) || display['kind'] !== 'external_permission') return undefined;
  const summary = display['summary'];
  const rawOptions = display['options'];
  if (typeof summary !== 'string' || summary === '' || !Array.isArray(rawOptions)) {
    return { ok: false };
  }
  const options: ExternalPermissionOption[] = [];
  for (const raw of rawOptions) {
    if (!isRecord(raw)) return { ok: false };
    const { id, label, kind, changes } = raw;
    if (typeof id !== 'string' || id === '') return { ok: false };
    if (typeof label !== 'string' || label === '') return { ok: false };
    if (typeof kind !== 'string' || kind === '') return { ok: false };
    if (changes !== undefined && !Array.isArray(changes)) return { ok: false };
    options.push({ id, label, kind, changes });
  }
  if (options.length === 0) return { ok: false };
  return { ok: true, summary, detail: display['detail'], options };
}

function boundedJson(value: unknown, limit = 160): string {
  try {
    const json = JSON.stringify(value) ?? '';
    return json.length > limit ? `${json.slice(0, limit)}…` : json;
  } catch {
    return String(value);
  }
}

function externalOptionDescription(option: ExternalPermissionOption): string {
  const grants =
    option.changes !== undefined && option.changes.length > 0
      ? ` · grants: ${option.changes.map((change) => boundedJson(change)).join(', ')}`
      : '';
  return `${option.kind}${grants}`;
}

function adaptExternalPermission(
  parsed: ExternalPermissionParse,
): Pick<ApprovalPanelData, 'description' | 'display' | 'choices'> {
  const cancel: ApprovalPanelChoice = { label: 'Cancel', response: 'cancelled' };
  if (!parsed.ok) {
    return {
      description: 'Unrecognized external permission request — cancel to stay safe.',
      display: [],
      choices: [cancel],
    };
  }
  const display: DisplayBlock[] = [{ type: 'brief', text: parsed.summary }];
  if (typeof parsed.detail === 'string' && parsed.detail.length > 0) {
    display.push({ type: 'brief', text: parsed.detail });
  } else if (parsed.detail !== undefined) {
    display.push({ type: 'brief', text: boundedJson(parsed.detail, 400) });
  }
  return {
    // adaptDisplay dedupes brief blocks identical to the description; keep
    // them distinct by leaving description empty.
    description: '',
    display,
    choices: [
      ...parsed.options.map((option) => ({
        label: option.label,
        response: option.kind.toLowerCase().includes('reject')
          ? ('rejected' as const)
          : ('approved' as const),
        selected_option_id: option.id,
        description: externalOptionDescription(option),
      })),
      cancel,
    ],
  };
}

interface ResolvedDisplay {
  blocks: DisplayBlock[];
  description: string;
}

function resolveDisplay(
  toolName: string,
  display: ToolInputDisplay,
  action: string,
): ResolvedDisplay {
  if (display.kind === 'generic' && isRecord(display.detail)) {
    const extracted = extractFromArgs(toolName, display.detail);
    if (extracted !== null) return extracted;
  }
  return {
    blocks: adaptDisplay(display),
    description: describeApproval(display, action),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(detail: Record<string, unknown>, key: string): string | undefined {
  const value = detail[key];
  return typeof value === 'string' ? value : undefined;
}

function extractFromArgs(
  toolName: string,
  detail: Record<string, unknown>,
): ResolvedDisplay | null {
  const command = stringField(detail, 'command');
  if (command !== undefined) {
    const cwd = stringField(detail, 'cwd');
    const toolDescription = stringField(detail, 'description');
    const danger = detectDanger(command);
    const language = stringField(detail, 'language') ?? 'bash';
    return {
      blocks: [
        {
          type: 'shell',
          language,
          command,
          cwd,
          description: toolDescription,
          danger,
        },
      ],
      description: toolDescription ?? '',
    };
  }

  const oldString = stringField(detail, 'old_string');
  const newString = stringField(detail, 'new_string');
  if (oldString !== undefined && newString !== undefined) {
    const path = stringField(detail, 'file_path') ?? stringField(detail, 'path') ?? '';
    // Diff block carries its own `+N -M path` header — no separate
    // file_op title row needed.
    return {
      blocks: [{ type: 'diff', path, old_text: oldString, new_text: newString }],
      description: '',
    };
  }

  const filePath = stringField(detail, 'file_path') ?? stringField(detail, 'path');
  const content = stringField(detail, 'content');
  if (filePath !== undefined && content !== undefined) {
    // Write is a brand-new file: render the content as a syntax-
    // highlighted code block, not a diff full of `+` markers.
    return {
      blocks: [{ type: 'file_content', path: filePath, content }],
      description: '',
    };
  }

  const url = stringField(detail, 'url');
  if (url !== undefined) {
    const method = stringField(detail, 'method');
    return {
      blocks: [{ type: 'url_fetch', url, method }],
      description: '',
    };
  }

  const query = stringField(detail, 'query');
  if (query !== undefined) {
    return {
      blocks: [{ type: 'search', query }],
      description: '',
    };
  }

  const pattern = stringField(detail, 'pattern');
  if (pattern !== undefined) {
    const scope = stringField(detail, 'path');
    return {
      blocks: [{ type: 'search', query: pattern, scope }],
      description: '',
    };
  }

  if (filePath !== undefined) {
    const operation = inferFileOp(toolName);
    return {
      blocks: [{ type: 'file_op', operation, path: filePath }],
      description: '',
    };
  }

  return null;
}

function inferFileOp(toolName: string): 'read' | 'write' | 'edit' | 'glob' | 'grep' {
  const lower = toolName.toLowerCase();
  if (lower.includes('glob')) return 'glob';
  if (lower.includes('grep')) return 'grep';
  if (lower.includes('edit')) return 'edit';
  if (lower.includes('write')) return 'write';
  return 'read';
}

function describeApproval(display: ToolInputDisplay, action: string): string {
  switch (display.kind) {
    case 'plan_review':
      return '';
    case 'plan_enter':
    case 'external_permission':
      return action;
    case 'goal_start':
      return 'Start a goal?';
    case 'generic':
      if (typeof display.detail === 'string' && display.detail.length > 0) {
        return display.detail;
      }
      return display.summary ?? action;
    case 'command':
      return display.description ?? display.command ?? action;
    case 'diff':
      return `edit ${display.path ?? ''}`.trim();
    case 'file_io':
      return `${display.operation ?? 'file'} ${display.path ?? ''}`.trim();
    case 'task_stop':
      return `stop task: ${display.task_description ?? display.task_id ?? ''}`.trim();
    case 'agent_call':
      return `spawn ${display.agent_name ?? 'agent'}`;
    case 'skill_call':
      return `invoke skill ${display.skill_name ?? ''}`.trim();
    case 'url_fetch':
      return `fetch ${display.url ?? ''}`.trim();
    case 'search':
      return `search: ${display.query ?? ''}`.trim();
    case 'todo_list':
      return `update todo list (${String(display.items?.length ?? 0)} items)`;
    case 'task':
      return `${display.status ?? 'background'} task ${display.task_id ?? ''}: ${
        display.description ?? ''
      }`.trim();
    default:
      return action;
  }
}

const DANGER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*|--recursive|--force)/i, label: 'recursive delete' },
  { pattern: /\bsudo\b/i, label: 'sudo' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/i, label: 'pipe to shell' },
  { pattern: /\bdd\b[^|]*\bof=/i, label: 'dd write' },
  { pattern: /\bmkfs\b/i, label: 'mkfs' },
  { pattern: />\s*\/dev\/(sd|nvme|disk|hd)/i, label: 'write to raw device' },
  { pattern: /\bchmod\s+-R?\s*777\b/i, label: 'chmod 777' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}/i, label: 'fork bomb' },
];

function detectDanger(command: string): string | undefined {
  for (const { pattern, label } of DANGER_PATTERNS) {
    if (pattern.test(command)) return label;
  }
  return undefined;
}

function adaptDisplay(display: ToolInputDisplay): DisplayBlock[] {
  switch (display.kind) {
    case 'command': {
      const command = display.command ?? '';
      const danger = detectDanger(command);
      return [
        {
          type: 'shell',
          language: display.language ?? 'bash',
          command,
          cwd: display.cwd,
          description: display.description,
          danger,
        },
      ];
    }
    case 'diff':
      return [
        {
          type: 'diff',
          path: display.path ?? '',
          old_text: display.before ?? '',
          new_text: display.after ?? '',
        },
      ];
    case 'file_io': {
      const path = display.path ?? '';
      // Write attaches the full file content — render it as a syntax-
      // highlighted code block so the approval panel can preview (and
      // ctrl+e expand) what is about to land on disk.
      if (display.operation === 'write' && typeof display.content === 'string') {
        return [{ type: 'file_content', path, content: display.content }];
      }
      // Edit attaches the old_string/new_string hunk as before/after — render
      // it as a diff block so ctrl+e expansion works on the change.
      if (
        display.operation === 'edit' &&
        typeof display.before === 'string' &&
        typeof display.after === 'string'
      ) {
        return [{ type: 'diff', path, old_text: display.before, new_text: display.after }];
      }
      return [
        {
          type: 'file_op',
          operation: display.operation,
          path,
          detail: display.detail,
        },
      ];
    }
    case 'url_fetch':
      return [
        {
          type: 'url_fetch',
          url: display.url ?? '',
          method: display.method,
        },
      ];
    case 'search':
      return [
        {
          type: 'search',
          query: display.query ?? '',
          scope: display.scope,
        },
      ];
    case 'agent_call':
      return [
        {
          type: 'invocation',
          kind: 'agent',
          name: display.agent_name ?? '',
          description: display.prompt,
        },
      ];
    case 'skill_call':
      return [
        {
          type: 'invocation',
          kind: 'skill',
          name: display.skill_name ?? '',
          description: display.args,
        },
      ];
    case 'task_stop':
      return [
        {
          type: 'brief',
          text: `Stop task ${display.task_id ?? ''}: ${display.task_description ?? ''}`,
        },
      ];
    case 'plan_review':
    case 'plan_enter':
    case 'external_permission':
      return [];
    case 'goal_start': {
      const lines = [`Start goal: ${display.objective}`];
      if (
        typeof display.completionCriterion === 'string' &&
        display.completionCriterion.length > 0
      ) {
        lines.push(`Done when: ${display.completionCriterion}`);
      }
      return [{ type: 'brief', text: lines.join('\n') }];
    }
    case 'generic':
      return [];
    case 'todo_list':
      return [];
    case 'task':
      return [];
    default:
      return [];
  }
}

function adaptChoices(toolName: string, display: ToolInputDisplay): ApprovalPanelChoice[] {
  if (toolName === 'ExitPlanMode' || display.kind === 'plan_review') {
    return adaptPlanReviewChoices(display);
  }
  if (display.kind === 'goal_start') {
    return adaptGoalStartChoices(display);
  }

  return DEFAULT_APPROVAL_CHOICES.map((choice) => cloneChoice(choice));
}

function adaptGoalStartChoices(
  display: Extract<ToolInputDisplay, { kind: 'goal_start' }>,
): ApprovalPanelChoice[] {
  // Reuse the exact options the /goal start menu shows. Each mode option starts
  // the goal under that permission mode (the policy reads selected_label); "Do
  // not start" declines so no goal is created.
  return goalStartOptions(display.mode).map((option) =>
    option.value === 'cancel'
      ? {
          label: option.label,
          response: 'cancelled',
          selected_label: 'cancel',
          description: option.description,
        }
      : {
          label: option.label,
          response: 'approved',
          selected_label: option.value,
          description: option.description,
        },
  );
}

function adaptPlanReviewChoices(display: ToolInputDisplay): ApprovalPanelChoice[] {
  const optionChoices =
    display.kind === 'plan_review' && display.options !== undefined && display.options.length >= 2
      ? display.options.map((option) => ({
          label: option.label,
          response: 'approved' as const,
          selected_label: option.label,
        }))
      : [{ label: 'Approve', response: 'approved' as const, selected_label: 'Approve' }];
  return [...optionChoices, ...PLAN_REJECT_CHOICES].map((choice) => cloneChoice(choice));
}

function cloneChoice(choice: ApprovalPanelChoice): ApprovalPanelChoice {
  return { ...choice };
}
