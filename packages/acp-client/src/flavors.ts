const TOOL_TEXT_LIMIT = 8_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export interface DroidElicitationQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly value: string }[];
}

export interface DroidElicitationForm {
  readonly questions: readonly DroidElicitationQuestion[];
  readonly respond: (answers: Readonly<Record<string, unknown>>) =>
    | { readonly action: 'accept'; readonly content: Record<string, string> }
    | { readonly action: 'cancel' };
}

export function extractDroidElicitationForm(request: {
  readonly mode?: unknown;
  readonly requestedSchema?: unknown;
}): DroidElicitationForm | undefined {
  if (request.mode !== 'form') return undefined;
  const schema = record(request.requestedSchema);
  const properties = record(schema?.['properties']);
  const required = Array.isArray(schema?.['required']) ? schema['required'] : undefined;
  if (properties === undefined || required === undefined || required.some((entry) => typeof entry !== 'string')) {
    return undefined;
  }
  const questions: DroidElicitationQuestion[] = [];
  for (const [id, rawField] of Object.entries(properties)) {
    if (!/^question_[1-9]\d*$/.test(id)) continue;
    const field = record(rawField);
    const companion = record(properties[`${id}_other`]);
    const title = typeof field?.['title'] === 'string' ? field['title'].trim() : '';
    const description = typeof field?.['description'] === 'string' ? field['description'].trim() : '';
    const oneOf = Array.isArray(field?.['oneOf']) ? field['oneOf'] : undefined;
    if (field?.['type'] !== 'string' || !title || !description || oneOf === undefined || companion?.['type'] !== 'string') {
      return undefined;
    }
    const parsedChoices: Array<{ readonly label: string; readonly value: string }> = [];
    let hasOther = false;
    for (const rawOption of oneOf) {
      const option = record(rawOption);
      const optionConst = typeof option?.['const'] === 'string' ? option['const'] : '';
      const optionTitle = typeof option?.['title'] === 'string' ? option['title'].trim() : '';
      if (!/^(?:option_\d+|other)$/.test(optionConst) || !optionTitle) return undefined;
      if (optionConst === 'other') hasOther = true;
      else parsedChoices.push({ label: optionTitle, value: optionConst });
    }
    if (parsedChoices.length === 0 || !hasOther) return undefined;
    questions.push({ id, header: title, question: description, options: parsedChoices });
  }
  const requiredIds = new Set(required as string[]);
  if (
    questions.length === 0 ||
    Object.keys(properties).length !== questions.length * 2 ||
    requiredIds.size !== questions.length ||
    questions.some((question) => !requiredIds.has(question.id))
  ) {
    return undefined;
  }
  return {
    questions,
    respond: (answers) => {
      const entries: Array<readonly [string, string]> = [];
      for (const question of questions) {
        const raw = Object.hasOwn(answers, question.id)
          ? answers[question.id]
          : Object.hasOwn(answers, question.question)
            ? answers[question.question]
            : answers[question.header];
        if (typeof raw !== 'string' || raw.trim().length === 0) return { action: 'cancel' };
        const matched = question.options.find((option) => option.value === raw || option.label === raw);
        if (matched !== undefined) {
          entries.push([question.id, matched.value]);
        } else {
          entries.push([question.id, 'other'], [`${question.id}_other`, raw.slice(0, TOOL_TEXT_LIMIT)]);
        }
      }
      return { action: 'accept', content: Object.fromEntries(entries) };
    },
  };
}

export function normalizeDevinSessionUpdate<T>(notification: T): T {
  const root = record(notification);
  const update = record(root?.['update']);
  if (root === undefined || update === undefined) return notification;
  const meta = record(update['_meta']);
  const parentAgentId = record(meta?.['cognition.ai/subagent_context'])?.['parentAgentId'];
  const routed = typeof parentAgentId === 'string' && parentAgentId !== 'root'
    ? { ...root, sessionId: parentAgentId }
    : root;
  const messageId = meta?.['cognition.ai/streamingMessageId'];
  const sessionUpdate = update['sessionUpdate'];
  const nextUpdate: Record<string, unknown> = { ...update };
  if ((sessionUpdate === 'agent_message_chunk' || sessionUpdate === 'agent_thought_chunk') && typeof messageId === 'string') {
    nextUpdate['messageId'] = messageId;
  }
  if (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') {
    const inferredName = meta?.['cognition.ai/inferenceToolName'];
    if (typeof inferredName === 'string' && (!nextUpdate['title'] || nextUpdate['title'] === 'Tool')) {
      nextUpdate['title'] = inferredName;
    }
  }
  return { ...routed, update: nextUpdate } as T;
}

export interface AcpSubagentProjection {
  readonly nativeTaskId: string;
  readonly childSessionId: string | null;
  readonly prompt: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly result: string | null;
}

export function extractClaudeSubagentUpdate(tool: {
  readonly toolCallId: string;
  readonly name?: string;
  readonly status?: string;
  readonly rawInput?: unknown;
  readonly meta?: unknown;
}): AcpSubagentProjection | undefined {
  if (tool.name !== 'Agent' && tool.name !== 'Task') return undefined;
  const input = record(tool.rawInput);
  if (typeof input?.['prompt'] !== 'string') return undefined;
  const asyncResponse = record(record(record(tool.meta)?.['claudeCode'])?.['toolResponse'])?.['isAsync'] === true;
  const background = input['run_in_background'] === true || asyncResponse;
  return {
    nativeTaskId: tool.toolCallId,
    childSessionId: null,
    prompt: input['prompt'],
    title: typeof input['description'] === 'string' ? input['description'] : null,
    model: typeof input['model'] === 'string' ? input['model'] : null,
    status: tool.status === 'failed'
      ? 'failed'
      : tool.status === 'completed' && !background
        ? 'completed'
        : 'running',
    result: null,
  };
}

export function extractClaudeSubagentSessionEvent(notification: unknown): {
  readonly type: 'state' | 'delegation';
  readonly childSessionId: string;
  readonly parentSessionId: string | null;
  readonly status?: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly result?: string | null;
  readonly delegationId?: string;
  readonly prompt?: string;
} | undefined {
  const root = record(notification);
  const sessionId = typeof root?.['sessionId'] === 'string' ? root['sessionId'] : undefined;
  const update = record(root?.['update']);
  if (sessionId === undefined || update === undefined) return undefined;
  if (update['sessionUpdate'] === 'subagent_update') {
    const childSessionId = typeof update['sessionId'] === 'string' ? update['sessionId'] : undefined;
    const state = record(update['state']);
    if (childSessionId === undefined || typeof state?.['state'] !== 'string') return undefined;
    const error = record(state['error']);
    return {
      type: 'state',
      childSessionId,
      parentSessionId: sessionId,
      status: state['state'] === 'running' || state['state'] === 'requires_action'
        ? 'running'
        : state['stopReason'] === 'error'
          ? 'failed'
          : state['stopReason'] === 'cancelled' || state['state'] === 'unknown'
            ? 'cancelled'
            : 'completed',
      result: typeof error?.['message'] === 'string' ? error['message'] : null,
    };
  }
  if (update['sessionUpdate'] === 'session_message') {
    const messageId = typeof update['messageId'] === 'string' ? update['messageId'] : undefined;
    const content = Array.isArray(update['content']) ? update['content'] : undefined;
    if (messageId === undefined || content === undefined) return undefined;
    return {
      type: 'delegation',
      childSessionId: sessionId,
      parentSessionId: typeof update['senderSessionId'] === 'string' ? update['senderSessionId'] : null,
      delegationId: messageId,
      prompt: content
        .flatMap((block) => {
          const item = record(block);
          return item?.['type'] === 'text' && typeof item['text'] === 'string' ? [item['text']] : [];
        })
        .join('\n'),
    };
  }
  return undefined;
}
