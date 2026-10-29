import { call, coverage, details, join, localTime, nextCall, record, rows, text, type Receipt } from './receiptFormat';

function locator(item: Receipt, target: Receipt): string {
  if (typeof item['ref'] === 'string') return call('HistoryRead', { ref: item['ref'] });
  const selector = item['step_id'] === undefined ? { turn: item['turn'] } : { step_id: item['step_id'] };
  if (selector.turn === undefined && selector.step_id === undefined) return '';
  return call('HistoryRead', { session_id: item['session_id'] ?? target['session_id'],
    agent_id: item['agent_id'] ?? target['agent_id'], ...selector });
}

export function renderHistoryReceipt(name: string, value: Receipt): string | undefined {
  const target = record(value['target']);
  let entries: string[];
  if (Array.isArray(value['blocks'])) {
    entries = rows(value['blocks']).map((block) => {
      const range = record(block['range']);
      return join([
        `### ${join([text(block['role']), text(block['tool_name']), text(block['part'])], ' · ') || 'Source'}`,
        text(block['text']),
        range['total'] === undefined ? '' : `Characters ${text(range['start'])}–${text(range['end'])} of ${text(range['total'])} (UTF-16)${Number(range['end']) < Number(range['total']) ? '; excerpt continues' : ''}${Number(range['start']) > 0 ? '; earlier text available with start_char:0' : ''}.`,
        locator(block, target),
      ]);
    });
  } else if (Array.isArray(value['hits'])) {
    entries = rows(value['hits']).map((hit) => {
      const communication = record(hit['communication']);
      return join([
        `### ${join([text(hit['role']), localTime(hit['time']), text(hit['session_id']), text(hit['agent_id'])], ' · ')}`,
        text(hit['snippet']),
        locator(hit, target),
        Object.keys(communication).length > 0 ? `Peer message: ${details(communication)}` : '',
      ]);
    });
  } else if (Array.isArray(value['turns'])) {
    entries = rows(value['turns']).map((turn) => join([
      `### Turn ${text(turn['turn'])}${turn['started_at'] === undefined ? '' : ` · ${localTime(turn['started_at'])}`}`,
      turn['prompt_excerpt'] === undefined ? '' : `User: ${text(turn['prompt_excerpt'])}`,
      turn['answer_excerpt'] === undefined ? '' : `Assistant: ${text(turn['answer_excerpt'])}`,
      locator(turn, target),
    ]));
  } else if (Array.isArray(value['agents'])) {
    entries = rows(value['agents']).map((agent) => join([
      `- ${text(agent['name']) || text(agent['agent_id'])} · ${details({ agent_id: agent['agent_id'], parent: agent['parent_agent_id'], turns: agent['turn_count'] })}`,
      join([localTime(agent['first_time']), localTime(agent['last_time'])], ' → '),
      call('HistoryList', { kind: 'turns', session_id: target['session_id'], agent_id: agent['agent_id'] }),
    ]));
  } else if (typeof value['text'] === 'string') {
    entries = [value['text']];
    if (value['truncated'] === true) entries.push(`Excerpt starts at character ${text(value['offset'])} of ${text(value['total_chars'])} (UTF-16); more text remains.`);
  } else return undefined;
  const cursor = value['next_cursor'];
  const partial = coverage(value['coverage'], value['incomplete']);
  const preparation = value['continuation'] === 'scan';
  const summary = entries.length > 0 ? entries.join('\n\n') : preparation
    ? 'History navigation is preparing; no source text has been returned yet.'
    : value['status'] === 'no_match' ? 'No matches in the covered history.' : 'No entries on this page.';
  return join([
    join([name, details({ workspace: target['workspace_id'], session: target['session_id'], agent: target['agent_id'],
      scope: value['scope_used'], mode: value['mode_used'] })], ' · '),
    summary,
    partial ? `${partial} ${cursor == null ? 'Use HistoryList to inspect another source or retry after the writer settles.' : 'Continue below to scan the remaining history.'}` : '',
    value['warning'] === 'page_local_relevance' ? 'Relevance is ranked within each page; later pages may contain stronger matches.' : text(value['warning']),
    cursor === undefined ? nextCall(value['next_call']) : `${preparation ? 'Continue scan' : 'Next page'}: ${call(name, { cursor })}`,
    cursor === undefined && name === 'HistorySearch' ? nextCall(record(value['expand_hint'])['next_call']) : '',
  ], '\n\n');
}
