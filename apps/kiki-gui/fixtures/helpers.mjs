/**
 * Shared builders for fixture scenarios. Everything here produces wire shapes
 * matching @kiki/protocol (plus the broadcaster-synthesized approval
 * and question frames documented in src/lib/types.ts).
 */

let counter = 0;
export function fid(prefix) {
  counter += 1;
  return `${prefix}_fx_${String(counter).padStart(4, '0')}`;
}

export function ts(minutesAgo = 0) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

export function textOf(text) {
  return [{ type: 'text', text }];
}

export function userMsg(sessionId, text, minutesAgo = 0) {
  return {
    id: fid('msg'),
    session_id: sessionId,
    role: 'user',
    content: textOf(text),
    created_at: ts(minutesAgo),
  };
}

/** User-role message carrying an engine prompt origin (`metadata.origin`). */
export function originMsg(sessionId, text, origin, minutesAgo = 0) {
  return { ...userMsg(sessionId, text, minutesAgo), metadata: { origin } };
}

/** Assistant message; parts: string (text) | {thinking} | {toolUse:{id,name,input}} */
export function assistantMsg(sessionId, parts, minutesAgo = 0) {
  const content = parts.map((part) => {
    if (typeof part === 'string') return { type: 'text', text: part };
    if (part.thinking !== undefined) return { type: 'thinking', thinking: part.thinking };
    return {
      type: 'tool_use',
      tool_call_id: part.toolUse.id,
      tool_name: part.toolUse.name,
      input: part.toolUse.input,
    };
  });
  return { id: fid('msg'), session_id: sessionId, role: 'assistant', content, created_at: ts(minutesAgo) };
}

export function toolResultMsg(sessionId, toolCallId, output, minutesAgo = 0, isError) {
  return {
    id: fid('msg'),
    session_id: sessionId,
    role: 'tool',
    content: [{ type: 'tool_result', tool_call_id: toolCallId, output, is_error: isError }],
    created_at: ts(minutesAgo),
  };
}

export function sessionRecord(id, overrides = {}) {
  return {
    id,
    workspace_id: 'wd_fixture_000000000000',
    title: overrides.title ?? 'Fixture session',
    created_at: ts(120),
    updated_at: ts(2),
    busy: false,
    pending_interaction: 'none',
    archived: false,
    metadata: { cwd: 'C:/fixture/workshop' },
    agent_config: { model: '' },
    usage: {
      input_tokens: 12_400,
      output_tokens: 2_100,
      cache_read_tokens: 8_000,
      cache_creation_tokens: 0,
      total_cost_usd: 0.0432,
      context_tokens: 25_900,
      context_limit: 262_144,
      turn_count: 4,
    },
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
    ...overrides,
  };
}

/**
 * Expand a text into a sequence of delta steps with correct cumulative
 * offsets: `{ type, turnId, text, per, delay }` → step list.
 */
export function streamSteps(type, turnId, text, { per = 24, delay = 30 } = {}) {
  const steps = [];
  for (let offset = 0; offset < text.length; offset += per) {
    const delta = text.slice(offset, offset + per);
    steps.push({
      delay,
      frame: { type, offset, payload: { turnId, delta } },
    });
  }
  return steps;
}

export function approvalFrame({ toolName, action, display, toolCallId }) {
  return {
    type: 'event.approval.requested',
    payload: {
      approval_id: fid('approval'),
      session_id: '$SID',
      turn_id: 1,
      tool_call_id: toolCallId ?? fid('call'),
      tool_name: toolName,
      action,
      tool_input_display: display,
      created_at: ts(),
      expires_at: new Date(Date.now() + 23 * 3600_000).toISOString(),
    },
  };
}

export function turnStart(turnId = 1, prompt) {
  return { frame: { type: 'turn.started', payload: { turnId, origin: { kind: 'user' }, prompt } } };
}

export function turnEnd(turnId = 1, reason = 'completed') {
  return { frame: { type: 'turn.ended', payload: { turnId, reason, durationMs: 4200 } } };
}

export function promptDone(promptId = '$PROMPT') {
  return { frame: { type: 'prompt.completed', payload: { promptId, finishedAt: ts() } } };
}

export function workChanged(busy, pending = 'none') {
  return {
    frame: { type: 'event.session.work_changed', payload: { busy, pending_interaction: pending } },
  };
}

/** A commit step: journal the assistant's completed message so a post-resync
 * snapshot contains it (the fixture server's answer to the real journal). */
export function commitAssistant(sessionIdPlaceholder, text) {
  return {
    commit: {
      id: 'placeholder',
      session_id: sessionIdPlaceholder,
      role: 'assistant',
      content: textOf(text),
      created_at: ts(),
    },
  };
}
