import { call, coverage, details, join, localTime, record, rows, text, type Receipt } from './receiptFormat';

function memoryEntry(entry: Receipt): string {
  const target = record(entry['target']);
  const scope = record(entry['scope']);
  if (entry['missing'] === true) return join([
    `Memory ${text(entry['id'])}: ${text(entry['message'] ?? entry['reason'] ?? entry['code'])}`,
    text(entry['recovery']), rows(entry['visible_targets']).map(details).join('\n'),
  ]);
  const complete = entry['complete'] === true;
  const metadata = Object.fromEntries(Object.entries(entry).filter(([key]) => ![
    'id', 'title', 'body', 'scope', 'target', 'revision', 'complete', 'read', 'score', 'score_details',
    'type', 'status', 'applicability', 'basis_kind', 'created', 'updated',
  ].includes(key)));
  return join([
    `### ${text(entry['title'])} · ${text(entry['id'])} · ${text(scope['kind'])} · ${text(entry['type'])}`,
    `${text(entry['status'])} · ${text(entry['applicability'])} · ${complete ? 'complete entry' : 'reference only; read before using or editing'}`,
    complete ? text(entry['body']) : '',
    ...Object.entries(metadata).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : text(value)}`),
    entry['created'] === undefined ? '' : `Created: ${localTime(entry['created'])}`,
    entry['updated'] === undefined ? '' : `Updated: ${localTime(entry['updated'])}`,
    complete ? `Write target: ${JSON.stringify(target)}` : call('MemoryRead', record(entry['read'])),
  ]);
}

export function renderStateReceipt(name: string, value: unknown): string | undefined {
  if (name === 'MemoryRead' && Array.isArray(value)) return value.map((entry) => memoryEntry(record(entry))).join('\n\n') || 'No memory entries.';
  const data = record(value);
  if (name === 'MemorySearch' && Array.isArray(data['items'])) {
    const covered = record(data['coverage']);
    return join([
      ...rows(data['items']).map(memoryEntry),
      rows(data['items']).length === 0 ? 'No memory matches on this page.' : '',
      coverage(covered),
      Array.isArray(covered['warnings']) ? covered['warnings'].map(text).join('\n') : '',
      details({ scopes: covered['scopes'], statuses: covered['statuses'], type: covered['type'], query: data['query'] }),
      typeof data['next_cursor'] !== 'string' ? '' : `Continue: ${call(name, { cursor: data['next_cursor'] })}`,
      covered['exhausted'] === false ? 'More source entries remain; continue before treating the query as exhausted.' : '',
    ], '\n\n');
  }
  if (name === 'TodoList' && Array.isArray(data['changed'])) return join([
    data['unchanged'] === true ? 'No changes.' : join([
      Array.isArray(data['changed']) && data['changed'].length ? `Updated: ${data['changed'].map(text).join(', ')}.` : '',
      Array.isArray(data['cleared']) && data['cleared'].length ? `Cleared: ${data['cleared'].map(text).join(', ')}.` : '',
    ], ' '),
    Object.keys(record(data['todos'])).length ? `Todos: ${details(record(data['todos']))}.` : '',
    data['handoff_reviewed'] === true ? 'Handoff review recorded.' : '',
  ]);
  return undefined;
}

function plainRecord(value: string): Receipt {
  const result: Receipt = {};
  for (const line of value.split('\n')) {
    const match = /^([a-z_]+): (.*)$/.exec(line);
    if (match === null) continue;
    let parsed: unknown = match[2];
    try { parsed = JSON.parse(match[2]!); } catch {}
    result[match[1]!] = parsed;
  }
  return result;
}

function taskSummary(task: Receipt): string {
  return join([
    `${text(task['task_id'])} · ${text(task['status'])} · ${text(task['description'])}`,
    details({ kind: task['kind'], lifetime: task['lifetime'], agent: task['agent_id'], name: task['collaboration_task_name'],
      model: task['model'], effort: task['thinking_effort'], exit_code: task['exit_code'] }),
    task['stop_reason'] === undefined && task['terminal_reason'] === undefined ? '' : `Reason: ${text(task['stop_reason'] ?? task['terminal_reason'])}`,
    join([localTime(task['started_at']), localTime(task['ended_at'])], ' → '),
    task['receipt_verification'] === 'invalid' || task['receipt_verification'] === 'legacy_unverified'
      ? `Receipt: ${text(task['receipt_verification'])}; inspect TaskOutput before relying on it.` : '',
  ]);
}

export function renderTaskReceipt(name: string, output: string): string | undefined {
  if (name === 'TaskList' && /^(active_background_tasks|background_tasks): /.test(output)) {
    const chunks = output.split('\n---\n');
    const page = plainRecord(chunks.at(-1)!);
    const tasks = chunks.map(plainRecord).filter((task) => task['task_id'] !== undefined);
    return join([
      tasks.length ? tasks.map(taskSummary).join('\n\n') : 'No background tasks found.',
      page['has_more'] === true ? `Next page: ${call(name, { active_only: output.startsWith('active_'), offset: page['next_offset'] })}` : '',
    ], '\n\n');
  }
  if (name === 'TaskOutput' && output.includes('\n[output]\n')) {
    const at = output.indexOf('\n[output]\n');
    const task = plainRecord(output.slice(0, at));
    if (task['task_id'] === undefined) return undefined;
    return join([
      taskSummary(task), output.slice(at + '\n[output]\n'.length),
      task['offset'] === undefined ? '' : `Bytes ${text(task['offset'])}–${text(task['next_offset'])} of ${text(task['output_size_bytes'])} (UTF-8).`,
      task['has_more'] === true ? `Next bytes: ${call(name, { task_id: task['task_id'], offset: task['next_offset'] })}` : '',
      task['output_truncated'] === true ? task['full_output_available'] === true
        ? `Tail preview only. Full log: ${call('Read', { path: task['output_path'] })}`
        : 'Tail preview only; no persisted full log is available.' : '',
      task['output_path'] !== undefined && task['output_truncated'] !== true ? `Log: ${text(task['output_path'])}` : '',
    ], '\n\n');
  }
  if (name === 'TodoList' && output.startsWith('Current todo list:')) return output.replace(/\nNotes revision: \d+/, '');
  return undefined;
}
