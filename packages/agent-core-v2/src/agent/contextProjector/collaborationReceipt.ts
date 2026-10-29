import { call, coverage, details, join, localTime, record, rows, text, type Receipt } from './receiptFormat';

function threadRef(value: unknown): Receipt {
  const ref = record(value);
  return { host_id: ref['hostId'], workspace_id: ref['workspaceId'], session_id: ref['sessionId'],
    bridge_id: ref['bridgeId'], connection_id: ref['connectionId'] };
}

function readThread(thread: unknown, extra: Receipt = {}): string {
  return call('ThreadRead', { thread: threadRef(thread), ...extra });
}

function contentRefs(refs: unknown, thread: unknown): string {
  return rows(refs).map((ref) => `More ${Array.isArray(ref['path']) ? ref['path'].join('.') : 'content'} (${text(ref['offset'])}/${text(ref['total'])} ${ref['kind'] === 'text' ? 'UTF-16 characters' : 'items'}): ${readThread(thread, { content_ref: ref })}`).join('\n');
}

function transcriptValue(value: unknown, thread: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((entry) => transcriptValue(entry, thread)).join('\n\n');
  const item = record(value);
  if (item['kind'] === 'turn') return join([
    `### Turn ${text(item['ordinal'])} · ${text(item['state'])} · ${localTime(item['endedAt'] ?? item['startedAt'])}`,
    item['prompt'] === undefined ? '' : `Prompt (${text(record(item['origin'])['kind']) || 'unknown origin'}): ${text(item['prompt'])}`,
    item['origin'] === undefined || record(item['origin'])['kind'] === 'user' ? '' : `Origin: ${details(record(item['origin']))}`,
    transcriptValue(item['steps'], thread), text(item['error']), contentRefs(item['contentRefs'], thread),
  ]);
  if (item['kind'] === 'step') return join([transcriptValue(item['frames'], thread), contentRefs(item['contentRefs'], thread)]);
  if (item['kind'] === 'text' || item['kind'] === 'thinking') return join([
    `${text(item['role'] ?? item['kind'])}: ${text(item['text'])}`,
    item['origin'] === undefined ? '' : `Origin: ${details(record(item['origin']))}`,
    contentRefs(item['contentRefs'], thread),
  ]);
  if (item['kind'] === 'tool') return join([
    `${text(item['name'])} · ${text(item['state'])}`, item['input'] === undefined ? '' : `Input: ${JSON.stringify(item['input'])}`,
    item['output'] === undefined ? '' : `Output: ${typeof item['output'] === 'string' ? item['output'] : JSON.stringify(item['output'])}`,
    text(item['error']), contentRefs(item['contentRefs'], thread),
  ]);
  if (item['kind'] === 'notice') return join([`${text(item['level'])}: ${text(item['message'])}`, details(record(item['detail'])), contentRefs(item['contentRefs'], thread)]);
  return Object.keys(item).length > 0 ? details(item) : '';
}

export function renderCollaborationReceipt(name: string, value: Receipt, input: Receipt): string | undefined {
  if (name === 'ThreadList' && Array.isArray(value['threads'])) return join([
    'Threads (newest first)',
    ...rows(value['threads']).map((thread) => join([
      `### ${text(thread['title']) || text(record(thread['ref'])['sessionId'])} · ${text(thread['state'])} · ${localTime(thread['updatedAt'])}`,
      readThread(thread['ref']),
    ])),
    rows(value['threads']).length === 0 ? 'No matching threads.' : '',
    value['nextCursor'] === undefined ? '' : `Next page: ${call(name, { workspace_id: input['workspace_id'], bridge_id: input['bridge_id'], connection_id: input['connection_id'], cursor: value['nextCursor'] })}`,
  ], '\n\n');
  if (name === 'ThreadRead' && Array.isArray(value['turns'])) {
    const thread = value['thread'];
    const view = record(value['view']);
    const segment = record(view['segment']);
    const transcript = record(view['transcript']);
    return join([
      `Thread ${text(record(thread)['name']) || text(record(thread)['sessionId'])}`,
      ...rows(value['turns']).map((turn) => join([
        `### Turn ${text(turn['turnId'])} · ${text(turn['reason'])} · ${text(turn['origin'])} · ${localTime(turn['endedAt'])}`,
        `User: ${text(turn['input'])}`, `Assistant: ${text(turn['output'])}`,
        turn['peer'] === undefined ? '' : `Peer source: ${details(record(turn['peer']))}`,
        turn['bridgedPeer'] === undefined ? '' : `Bridged peer source: ${details(record(turn['bridgedPeer']))}`,
        contentRefs(turn['contentRefs'], thread),
      ])),
      segment['value'] === undefined ? '' : transcriptValue(segment['value'], thread),
      segment['next'] === undefined ? '' : `Continue segment: ${readThread(thread, { content_ref: segment['next'] })}`,
      contentRefs(segment['contentRefs'], thread),
      transcriptValue(transcript['items'], thread),
      ...['tasks', 'interactions', 'attachments', 'todos', 'prompts'].map((key) => rows(transcript[key]).length ? `${key}:\n${rows(transcript[key]).map(details).join('\n')}` : ''),
      coverage(transcript['coverage']),
      value['incomplete'] === 'history_preparing' ? 'History is preparing; continue below to read the original turns.' : '',
      value['nextCursor'] === undefined ? '' : `Next page: ${readThread(thread, { cursor: value['nextCursor'] })}`,
      rows(value['turns']).length === 0 && Object.keys(view).length === 0 && value['incomplete'] === undefined ? 'No finished turns on this page.' : '',
    ], '\n\n');
  }
  if (name === 'ThreadSend' && value['delivery'] !== undefined) return join([
    `Message ${text(value['delivery'])}${value['deduplicated'] === true ? ' (existing receipt)' : ''}.`,
    details({ message_id: value['messageId'], room: value['roomId'] }),
    localTime(value['acceptedAt']),
    value['delivery'] === 'pending' ? 'Accepted for delivery; use ThreadWait for activity.' : '',
  ]);
  if (name === 'ThreadWait' && Array.isArray(value['threads'])) return join([
    value['timedOut'] === true ? 'No new activity before timeout.' : 'Thread activity',
    ...rows(value['threads']).map((thread) => join([
      `### Thread ${text(record(thread['thread'])['sessionId'])}`,
      ...rows(thread['activities']).map((activity) => join([localTime(activity['at']), text(activity['kind']), text(activity['reason']),
        activity['turnId'] === undefined ? '' : `turn ${text(activity['turnId'])}`,
        activity['messageId'] === undefined ? '' : `message ${text(activity['messageId'])}`], ' · ')),
      call('ThreadWait', { threads: [{ thread: threadRef(thread['thread']), cursor: thread['cursor'] }] }),
    ])),
  ], '\n\n');
  if (name === 'RoomRead' && Array.isArray(value['entries'])) return join([
    `Room ${text(value['name'])} · ${text(value['roomId'])}${value['archived'] === true ? ' · archived' : value['paused'] === true ? ` · paused (${text(value['pauseReason'])})` : ''}`,
    ...rows(value['entries']).map((entry) => join([
      `### ${text(entry['username']) || text(entry['from'])} · ${localTime(entry['at'])}`,
      text(entry['text']), entry['replyTo'] === undefined ? '' : `Reply to: ${text(entry['replyTo'])}`,
      Array.isArray(entry['mentions']) && entry['mentions'].length ? `Mentions: ${entry['mentions'].map(text).join(', ')}` : '',
      rows(entry['attachments']).map(details).join('\n'),
    ])),
    rows(value['entries']).length === 0 ? 'No new saved messages.' : '',
    `Host: ${text(value['host'])}\nMembers (mention ids):\n${rows(value['members']).map((member) => `- ${text(member['id'])}${member['muted'] === true ? ' · muted' : ''}`).join('\n')}`,
    value['nextCursor'] === undefined ? '' : `Next page: ${call(name, { room: value['roomId'], after_id: value['nextCursor'] })}`,
  ], '\n\n');
  if (name === 'AgentList' && Array.isArray(value['agents'])) return join([
    'Direct child agents',
    ...rows(value['agents']).map((agent) => join([
      `- ${text(agent['name']) || text(agent['agent_id'])} · ${text(agent['status'])} · ${details({ agent_id: agent['agent_id'], profile: agent['profile'] })}`,
      agent['persistence_failure'] === undefined ? '' : `  Save failed: ${details(record(agent['persistence_failure']))}`,
    ])),
    rows(value['agents']).length === 0 ? 'No matching children.' : '',
    Number(value['omitted']) > 0 ? `${text(value['omitted'])} further children omitted (roster limit); use a known child name or id with AgentRun/AgentSend.` : '',
  ]);
  return undefined;
}
