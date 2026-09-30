import { readFile, writeFile } from 'node:fs/promises';
import { SqliteSearchIndex } from '../src/search/sqlite/index';
import { normalizeLiteral, tokenize } from '@kiki/minidb';

interface Query { id: string; query: string; mode: 'terms' | 'literal'; language: 'zh' | 'other' }
interface Run { source: string; queries: Array<Query & { keys: string[]; incomplete: string[] }> }
const [mode, source, queriesPath, output, exclusionsPath] = process.argv.slice(2);
if (!mode || !source || !queriesPath || !output) throw new Error('usage: search-s5-recall.mts <api|sqlite|sql-truth> <url|db> <queries.json> <output.json>\n       search-s5-recall.mts compare <baseline.json> <candidate.json> <report.json> [exclusions.json]');
if (mode === 'compare') {
  const baseline = JSON.parse(await readFile(source, 'utf8')) as Run;
  const candidate = JSON.parse(await readFile(queriesPath, 'utf8')) as Run;
  const exclusions = exclusionsPath ? JSON.parse(await readFile(exclusionsPath, 'utf8')) as Array<{ queryId: string; key: string; reason: string }> : [];
  if (exclusions.some((e) => !e.reason.trim())) throw new Error('every policy exclusion needs a reason');
  if (exclusions.some((e) => !baseline.queries.find((q) => q.id === e.queryId)?.keys.includes(e.key))) throw new Error('exclusion is not a baseline hit');
  const details = baseline.queries.map((old) => {
    const current = candidate.queries.find((q) => q.id === old.id);
    if (!current || current.query !== old.query || current.mode !== old.mode) throw new Error(`mismatched query ${old.id}`);
    const excluded = exclusions.filter((e) => e.queryId === old.id);
    const retained = old.keys.filter((key) => !excluded.some((e) => e.key === key));
    const missing = retained.filter((key) => !current.keys.includes(key));
    return { id: old.id, query: old.query, retained: retained.length, missing, excluded,
      recall: retained.length > 0 ? (retained.length - missing.length) / retained.length : null,
      incomplete: [...old.incomplete, ...current.incomplete] };
  });
  const retained = details.reduce((n, q) => n + q.retained, 0);
  const missed = details.reduce((n, q) => n + q.missing.length, 0);
  const queryMix = baseline.queries.length === 20 && baseline.queries.filter((q) => q.language === 'zh').length === 10 &&
    baseline.queries.filter((q) => q.language === 'other').length === 10 && baseline.queries.some((q) => q.mode === 'literal' && q.query.length === 2);
  const complete = details.every((q) => q.incomplete.length === 0);
  const report = { baseline: baseline.source, candidate: candidate.source, queryMix, complete, retained, missed,
    recall: retained > 0 ? (retained - missed) / retained : null,
    comparisonThresholdMet: queryMix && complete && retained > 0 && (retained - missed) / retained >= 0.95,
    note: 'API baseline must be an independently verified OLD implementation on the same corpus; api: alone is not proof. SQL truth only checks the retained SQLite corpus, not old-implementation parity.', details };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ retained, missed, recall: report.recall, comparisonThresholdMet: report.comparisonThresholdMet }) + '\n');
} else {
  const queries = JSON.parse(await readFile(queriesPath, 'utf8')) as Query[];
  if (new Set(queries.map((q) => q.id)).size !== queries.length || queries.some((q) => !q.query || !['terms', 'literal'].includes(q.mode))) throw new Error('invalid queries');
  if (!['api', 'sqlite', 'sql-truth'].includes(mode)) throw new Error('unknown capture mode');
  if (mode === 'api' && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(source).hostname)) throw new Error('loopback API URL required');
  const run: Run = { source: `${mode}:${mode === 'api' ? new URL(source).origin : 'read-only-derived-index'}`, queries: [] };
  const index = mode === 'api' ? undefined : SqliteSearchIndex.openReader(source);
  const keyOf = (hit: { session_id: string; agent_id: string; role: string; time: number; turn?: number; step_id?: string }) =>
    JSON.stringify([hit.session_id, hit.agent_id, hit.role, hit.time, hit.turn ?? null, hit.step_id ?? null]);
  try {
    for (const query of queries) {
      const keys = new Set<string>();
      const incomplete = new Set<string>();
      if (mode === 'sql-truth') {
        const rows = index!.db.prepare("SELECT s.id session_id, f.agent_id, d.role, d.time, d.turn, d.step_id, d.text FROM docs d JOIN files f ON f.id=d.file_id JOIN sessions s ON s.id=f.session_id UNION ALL SELECT id, '', 'title', updated_at, NULL, NULL, title FROM sessions").iterate() as unknown as Iterable<Parameters<typeof keyOf>[0] & { text: string }>;
        const terms = [...new Set(tokenize(query.query))];
        for (const hit of rows) {
          const match = query.mode === 'literal' ? normalizeLiteral(hit.text).includes(normalizeLiteral(query.query)) : terms.every((t) => tokenize(hit.text).includes(t));
          if (match) keys.add(keyOf(hit));
        }
      } else {
        let token: string | undefined;
        let pages = 0;
        do {
          if (++pages > 10_000) throw new Error('pagination exceeded safety bound');
          if (mode === 'api') {
            const response = await fetch(new URL('/api/search', source), { method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env['KIKI_S5_TOKEN'] ?? ''}` },
              body: JSON.stringify({ query: query.query, mode: query.mode, sort: 'time_desc', page_size: 50, page_token: token }), signal: AbortSignal.timeout(30_000) });
            const body = await response.json() as { code: number; data: { items: Parameters<typeof keyOf>[0][]; has_more: boolean; page_token?: string; incomplete?: string; index_state: { state: string } } };
            if (!response.ok || body.code !== 0 || !['ready', 'readonly'].includes(body.data.index_state.state)) throw new Error(`query ${query.id}: endpoint not ready`);
            for (const hit of body.data.items) keys.add(keyOf(hit));
            if (body.data.incomplete) incomplete.add(body.data.incomplete);
            token = body.data.page_token;
            if (body.data.has_more && !token) throw new Error('missing page token');
          } else {
            const page = await index!.search({ query: query.query, mode: query.mode, op: 'AND', sort: 'time_desc', pageSize: 50,
              literalQuery: query.mode === 'literal' ? normalizeLiteral(query.query) : undefined,
              termsQuery: query.mode === 'terms' ? [...new Set(tokenize(query.query))] : undefined }, token);
            for (const row of page.rows) {
              const hit = row.value;
              keys.add(keyOf({ session_id: hit.sessionId, agent_id: hit.agentId, role: hit.role, time: hit.time, turn: hit.kind === 'message' ? hit.turn : undefined, step_id: hit.kind === 'message' ? hit.stepId : undefined }));
            }
            if (page.incomplete) incomplete.add(page.incomplete);
            token = page.pageToken;
          }
        } while (token);
      }
      run.queries.push({ ...query, keys: [...keys].toSorted(), incomplete: [...incomplete] });
      process.stdout.write(JSON.stringify({ id: query.id, hits: keys.size, incomplete: [...incomplete] }) + '\n');
    }
  } finally { index?.close(); }
  await writeFile(output, JSON.stringify(run, null, 2) + '\n', { flag: 'wx' });
}
