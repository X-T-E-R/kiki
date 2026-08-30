export interface ExternalPermissionOption {
  readonly id: string;
  readonly label: string;
  readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | (string & {});
  readonly changes?: readonly unknown[];
}

export interface ExternalPermissionDisplay {
  readonly kind: 'external_permission';
  readonly summary: string;
  readonly detail?: unknown;
  readonly options: readonly ExternalPermissionOption[];
}

/**
 * `ToolInputDisplay` — structured UI hint describing a tool call's input, so
 * approval panels and tool renderers can present it without re-deriving it
 * from raw arguments.
 */
export type ToolInputDisplay =
  | {
      kind: 'command';
      command: string;
      cwd?: string | undefined;
      description?: string | undefined;
      language?: 'bash' | undefined;
    }
  | {
      kind: 'file_io';
      operation: 'read' | 'write' | 'edit' | 'glob' | 'grep';
      path: string;
      detail?: string | undefined;
      content?: string | undefined;
      before?: string | undefined;
      after?: string | undefined;
    }
  | {
      kind: 'diff';
      path: string;
      before: string;
      after: string;
      hunks?: number | undefined;
    }
  | {
      kind: 'search';
      query: string;
      scope?: string | undefined;
    }
  | {
      kind: 'url_fetch';
      url: string;
      method?: string | undefined;
    }
  | {
      kind: 'agent_call';
      agent_name: string;
      prompt: string;
      background?: boolean | undefined;
    }
  | {
      kind: 'skill_call';
      skill_name: string;
      args?: string | undefined;
    }
  | {
      kind: 'todo_list';
      items: { title: string; status: string }[];
    }
  | {
      kind: 'task';
      task_id: string;
      status: string;
      description: string;
      task_kind?: string | undefined;
    }
  | {
      kind: 'task_stop';
      task_id: string;
      task_description: string;
    }
  | {
      kind: 'plan_review';
      plan: string;
      path?: string | undefined;
      options?: readonly { label: string; description: string }[] | undefined;
    }
  | {
      kind: 'goal_start';
      objective: string;
      completionCriterion?: string | undefined;
      mode: 'manual' | 'yolo';
    }
  | ExternalPermissionDisplay
  | {
      kind: 'generic';
      summary: string;
      detail?: unknown;
    };
