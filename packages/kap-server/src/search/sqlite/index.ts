import { createHash, randomUUID } from 'node:crypto';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { matchSingleMediaPathTag } from '@kiki/agent-core-v2/agent/media/mediaRef';
import { normalizeLiteral, tokenize } from '@kiki/minidb';

import type { GlobalSearchIncomplete } from '../contract';
import { MAX_DOC_TEXT_CHARS, type MessageDoc, type StepTrackerState, type TitleDoc } from '../docs';
import { decodePageToken, encodePageToken, boundaryOf, matchDocs, paginateRows, type MatchedRow, type NormalizedQuery, type SearchBudgets } from '../match';
import { analyzeWireLine, type ExtractedWireMessage } from '../wireExtract';
import { openSearchDatabase } from './schema';

const CHUNK = 1 << 20;
const MAX_LINE = 8 << 20;
const MAX_BATCH_DOCS = 500;
const MAX_BATCH_CHARS = 4 << 20;
const BINARY = /data:[^;\s]+;base64,|[A-Za-z0-9+/]{256,}={0,2}/gi;
const EMPTY_STEP: StepTrackerState = { byUuid: {}, byToolCall: {}, begins: 0 };

function subagentPrompt(line: string): ExtractedWireMessage | undefined {
  let record: unknown;
  try { record = JSON.parse(line); } catch { return undefined; }
  if (record === null || typeof record !== 'object' || !('message' in record)) return undefined;
  const message = record.message;
  if (message === null || typeof message !== 'object' || !('origin' in message) ||
    !('content' in message) || !('role' in message) || message.role !== 'user') return undefined;
  const origin = message.origin;
  if (origin === null || typeof origin !== 'object' || !('kind' in origin) ||
    !('name' in origin) || origin.kind !== 'system_trigger' || origin.name !== 'subagent') return undefined;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content.filter((part: unknown): part is { type: 'text'; text: string } =>
    part !== null && typeof part === 'object' && 'type' in part && part.type === 'text' &&
    'text' in part && typeof part.text === 'string' && matchSingleMediaPathTag(part.text) === undefined)
    .map((part: { text: string }) => part.text).join('').trim();
  if (!text) return undefined;
  const timestamp = 'time' in record ? record.time : undefined;
  const time = typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0
    ? timestamp > 1e12 ? Math.floor(timestamp) : Math.floor(timestamp * 1000) : undefined;
  return { role: 'user', text, time };
}

export interface SqliteSessionInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly dir: string;
  readonly updatedAt: number;
  readonly title?: string;
}

export interface SqliteSearchResult {
  readonly rows: MatchedRow[];
  readonly hasMore: boolean;
  readonly pageToken?: string;
  readonly incomplete?: GlobalSearchIncomplete;
}

interface FileRow {
  id: number; ino: string | null; size: number; mtime_ms: number; offset: number;
  tail_hash: string | null; turn_next: number; turn_has: number; step_state: string; policy: string;
}

function quoteTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

async function identity(dir: string): Promise<string | undefined> {
  try {
    const st = await stat(dir, { bigint: true });
    return st.isDirectory() && st.ino > 0n && st.birthtimeNs > 0n
      ? `${st.dev}:${st.ino}:${st.birthtimeNs}` : undefined;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

async function titleAt(dir: string): Promise<string> {
  for (const path of [join(dir, 'state.json'), join(dir, 'session-meta', 'state.json')]) {
    try {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      return typeof value === 'object' && value !== null && 'title' in value && typeof value.title === 'string'
        ? value.title : '';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return '';
    }
  }
  return '';
}

async function wireFiles(dir: string): Promise<{ path: string; agentId: string }[]> {
  const files: { path: string; agentId: string }[] = [];
  try { if ((await stat(join(dir, 'wire.jsonl'))).isFile()) files.push({ path: join(dir, 'wire.jsonl'), agentId: 'main' }); } catch {}
  async function visit(path: string): Promise<void> {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name === 'wire.jsonl') {
        files.push({ path: child, agentId: child.slice(join(dir, 'agents').length + 1).split(/[\\/]/)[0]! });
      }
    }
  }
  await visit(join(dir, 'agents'));
  return files;
}

export class SqliteSearchIndex {
  private readonly bootSalt = randomUUID();
  private constructor(readonly db: DatabaseSync, readonly indexSubagentToolOutput: boolean) {}

  static async open(path: string, options: { indexSubagentToolOutput?: boolean } = {}): Promise<SqliteSearchIndex> {
    return new SqliteSearchIndex(await openSearchDatabase(path), options.indexSubagentToolOutput ?? false);
  }

  close(): void { this.db.close(); }

  private get generation(): string {
    return `${this.bootSalt}:${(this.db.prepare("SELECT v FROM meta WHERE k='generation'").get() as { v: string }).v}`;
  }

  private bumpGeneration(): void {
    this.db.prepare("UPDATE meta SET v=CAST(v AS INTEGER)+1 WHERE k='generation'").run();
  }

  private insertDoc(fileId: number | null, sessionId: string, lineOffset: number, ord: number,
    role: string, time: number, turn: number | undefined, stepId: string | undefined, text: string): void {
    const db = this.db;
    const info = db.prepare('INSERT INTO docs(file_id,session_id,line_offset,ord,role,time,turn,step_id,text) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(fileId, sessionId, lineOffset, ord, role, time, turn ?? null, stepId ?? null, text);
    const id = Number(info.lastInsertRowid);
    db.prepare('INSERT INTO docs_terms(rowid,terms) VALUES(?,?)').run(id, tokenize(text).join(' '));
    db.prepare('INSERT INTO docs_tri(rowid,text) VALUES(?,?)').run(id, normalizeLiteral(text));
  }

  private deleteDocs(where: 'id' | 'file_id' | 'session_id', key: string | number): void {
    const db = this.db;
    const rows = db.prepare(`SELECT id,text FROM docs WHERE ${where}=?`).iterate(key) as Iterable<{ id: number; text: string }>;
    for (const row of rows) {
      db.prepare("INSERT INTO docs_terms(docs_terms,rowid,terms) VALUES('delete',?,?)")
        .run(row.id, tokenize(row.text).join(' '));
      db.prepare("INSERT INTO docs_tri(docs_tri,rowid,text) VALUES('delete',?,?)")
        .run(row.id, normalizeLiteral(row.text));
      db.prepare('DELETE FROM docs WHERE id=?').run(row.id);
    }
  }

  private async tailHash(path: string, offset: number): Promise<string> {
    const fd = await open(path, 'r');
    try {
      const length = Math.min(4096, offset);
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await fd.read(buf, 0, length, offset - length);
      return createHash('sha1').update(buf.subarray(0, bytesRead)).digest('hex');
    } finally { await fd.close(); }
  }

  async syncSession(session: SqliteSessionInput): Promise<void> {
    const id = await identity(session.dir);
    if (id === undefined) return;
    const db = this.db;
    const title = await titleAt(session.dir);
    const existing = db.prepare('SELECT title,identity,dir FROM sessions WHERE id=?').get(session.id) as
      { title: string; identity: string; dir: string } | undefined;
    if (existing !== undefined && (existing.identity !== id || existing.dir !== session.dir)) {
      db.exec('BEGIN');
      try {
        this.deleteDocs('session_id', session.id);
        db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
        this.bumpGeneration();
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO sessions(id,workspace_id,title,dir,identity,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,title=excluded.title,dir=excluded.dir,identity=excluded.identity,updated_at=excluded.updated_at')
        .run(session.id, session.workspaceId, title, session.dir, id, session.updatedAt);
      if (existing === undefined || existing.title !== title || existing.identity !== id) {
        if (existing !== undefined && existing.identity === id) {
          const oldTitle = db.prepare("SELECT id FROM docs WHERE session_id=? AND role='title'")
            .get(session.id) as { id: number } | undefined;
          if (oldTitle) this.deleteDocs('id', oldTitle.id);
          this.bumpGeneration();
        }
        if (title) this.insertDoc(null, session.id, -1, 0, 'title', session.updatedAt, undefined, undefined, title);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const files = await wireFiles(session.dir);
    for (const file of files) await this.syncFile(session, file.path, file.agentId);
    const paths = new Set(files.map((file) => file.path));
    const stored = db.prepare('SELECT id,path FROM files WHERE session_id=?').all(session.id) as { id: number; path: string }[];
    for (const file of stored) if (!paths.has(file.path)) this.removeFile(file.id);
  }

  private removeFile(fileId: number): void {
    const db = this.db;
    db.exec('BEGIN');
    try {
      this.deleteDocs('file_id', fileId);
      db.prepare('DELETE FROM files WHERE id=?').run(fileId);
      this.bumpGeneration();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  private async syncFile(session: SqliteSessionInput, path: string, agentId: string): Promise<void> {
    const db = this.db;
    const st = await stat(path);
    let file = db.prepare('SELECT * FROM files WHERE path=?').get(path) as FileRow | undefined;
    const policy = agentId === 'main' || this.indexSubagentToolOutput ? 'full' : 'meta-only';
    if (file && (st.size < file.offset || (file.offset > 0 &&
      (file.ino !== String(st.ino) || file.tail_hash !== await this.tailHash(path, file.offset))) || file.policy !== policy)) {
      this.removeFile(file.id);
      file = undefined;
    }
    if (!file) {
      db.prepare("INSERT INTO files(session_id,agent_id,path,ino,size,mtime_ms,offset,tail_hash,turn_next,turn_has,step_state,policy) VALUES(?,?,?,?,?,?,0,NULL,0,0,?,?)")
        .run(session.id, agentId, path, String(st.ino), st.size, st.mtimeMs, JSON.stringify(EMPTY_STEP), policy);
      file = db.prepare('SELECT * FROM files WHERE path=?').get(path) as unknown as FileRow;
    }
    if (file.offset === st.size) return;
    const fd = await open(path, 'r');
    let offset = file.offset;
    let position = offset;
    let pending = Buffer.alloc(0);
    let dropping = false;
    let next = file.turn_next;
    let hasTurn = !!file.turn_has;
    let step: StepTrackerState = JSON.parse(file.step_state) as StepTrackerState;
    let docs = 0;
    let textBytes = 0;
    let skipped = 0;
    const commit = async (): Promise<void> => {
      if (offset === file!.offset) return;
      const hash = await this.tailHash(path, offset);
      db.prepare('UPDATE files SET ino=?,size=?,mtime_ms=?,offset=?,tail_hash=?,turn_next=?,turn_has=?,step_state=? WHERE id=?')
        .run(String(st.ino), st.size, st.mtimeMs, offset, hash, next, Number(hasTurn), JSON.stringify(step), file!.id);
      db.exec('COMMIT');
      file!.offset = offset;
      docs = 0;
      textBytes = 0;
      db.exec('BEGIN');
    };
    db.exec('BEGIN');
    try {
      const chunk = Buffer.allocUnsafe(CHUNK);
      while (position < st.size) {
        const { bytesRead } = await fd.read(chunk, 0, Math.min(CHUNK, st.size - position), position);
        if (!bytesRead) break;
        position += bytesRead;
        let start = 0;
        while (start < bytesRead) {
          const nl = chunk.indexOf(0x0a, start);
          const end = nl < 0 || nl >= bytesRead ? bytesRead : nl;
          const piece = chunk.subarray(start, end);
          if (!dropping && pending.length + piece.length > MAX_LINE) {
            dropping = true;
            pending = Buffer.alloc(0);
            skipped++;
          }
          if (!dropping) pending = Buffer.concat([pending, piece]);
          if (nl < 0 || nl >= bytesRead) break;
          const lineOffset = offset;
          offset = position - bytesRead + nl + 1;
          if (pending.length && !dropping) {
            const line = pending.toString('utf8');
            if (line.includes('"type":"context.append_') || line.includes('"type":"context.undo"')) {
              const analysis = analyzeWireLine(line);
              if (analysis.turn.kind === 'open' || (analysis.turn.kind === 'ensure' && !hasTurn) || analysis.turn.kind === 'undo') {
                step = EMPTY_STEP;
              }
              if (analysis.turn.kind === 'open') {
                db.prepare('INSERT INTO turn_openers(file_id,idx,turn,anchor) VALUES(?,?,?,?)')
                  .run(file!.id, next, next, Number(analysis.turn.anchor));
                next++;
                hasTurn = true;
              } else if (analysis.turn.kind === 'ensure' && !hasTurn) {
                next++;
                hasTurn = true;
              } else if (analysis.turn.kind === 'undo') {
                const opener = db.prepare('SELECT idx,turn FROM turn_openers WHERE file_id=? AND anchor=1 ORDER BY idx DESC LIMIT 1 OFFSET ?')
                  .get(file!.id, analysis.turn.count - 1) as { idx: number; turn: number } | undefined;
                if (opener) {
                  db.prepare('DELETE FROM turn_openers WHERE file_id=? AND idx>=?').run(file!.id, opener.idx);
                  next = opener.turn;
                  hasTurn = !!(db.prepare('SELECT 1 FROM turn_openers WHERE file_id=? LIMIT 1').get(file!.id));
                }
              }
              if (analysis.step.kind === 'begin') {
                const begins = step.begins + 1;
                step = { ...step, begins, byUuid: { ...step.byUuid, [analysis.step.uuid]: analysis.step.ordinal ?? begins } };
              } else if (analysis.step.kind === 'call') {
                const ordinal = step.byUuid[analysis.step.uuid];
                if (ordinal !== undefined) step = { ...step, byToolCall: { ...step.byToolCall, [analysis.step.toolCallId]: ordinal } };
              }
              const prompt = agentId === 'main' || analysis.messages.length ? undefined : subagentPrompt(line);
              const messages = prompt === undefined ? analysis.messages : [prompt];
              for (let i = 0; i < messages.length; i++) {
                const message = messages[i]!;
                if (message.role === 'tool' && policy === 'meta-only') continue;
                const text = message.text.replace(BINARY, '[binary]').slice(0,
                  agentId !== 'main' || message.role === 'tool' ? 4096 : MAX_DOC_TEXT_CHARS);
                if (!text) continue;
                const ordinal = message.stepUuid !== undefined ? step.byUuid[message.stepUuid] :
                  message.toolCallId !== undefined ? step.byToolCall[message.toolCallId] : undefined;
                const turn = hasTurn ? next - 1 : undefined;
                this.insertDoc(file!.id, session.id, lineOffset, i, message.role, message.time ?? session.updatedAt,
                  turn, turn !== undefined && ordinal !== undefined ? `t${turn}.${ordinal}` : undefined, text);
                docs++;
                textBytes += Buffer.byteLength(text);
              }
            }
          }
          pending = Buffer.alloc(0);
          dropping = false;
          start = nl + 1;
          if (docs >= MAX_BATCH_DOCS || textBytes >= MAX_BATCH_CHARS) await commit();
        }
        if (pending.length > MAX_LINE) { dropping = true; pending = Buffer.alloc(0); skipped++; }
      }
      if (skipped) db.prepare("INSERT INTO meta(k,v) VALUES('skipped_lines',?) ON CONFLICT(k) DO UPDATE SET v=CAST(v AS INTEGER)+excluded.v")
        .run(String(skipped));
      await commit();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { await fd.close(); }
  }

  async search(q: NormalizedQuery, pageToken?: string, budgets: SearchBudgets = {
    literalCandidateCap: 10_000, maxTextHits: 100_000, postingsVisitBudget: 250_000,
    queryDeadlineMs: 500, queryTextBudgetChars: 16_000_000,
  }): Promise<SqliteSearchResult> {
    const db = this.db;
    const generation = this.generation;
    const page = decodePageToken(q, 'index', pageToken, generation);
    const deadlineAt = Date.now() + budgets.queryDeadlineMs;
    let incomplete: GlobalSearchIncomplete | undefined;
    const terms = q.termsQuery ?? [...new Set(tokenize(q.query))];
    const literal = q.literalQuery ?? normalizeLiteral(q.query);
    let matchedIds: { rowid: number }[];
    if (q.mode === 'terms') {
      if (!terms.length) matchedIds = [];
      else {
        const expression = terms.map(quoteTerm).join(q.op === 'OR' ? ' OR ' : ' AND ');
        matchedIds = db.prepare('SELECT rowid FROM docs_terms WHERE docs_terms MATCH ? LIMIT ?')
          .all(expression, budgets.maxTextHits + 1) as { rowid: number }[];
      }
    } else if (Array.from(literal).length >= 3) {
      matchedIds = db.prepare('SELECT rowid FROM docs_tri WHERE docs_tri MATCH ? LIMIT ?')
        .all(quoteTerm(literal), budgets.literalCandidateCap + 1) as { rowid: number }[];
    } else {
      const cjk = /^[\u3400-\u9fff\u3040-\u30ff\uff00-\uffef]{2}$/.test(literal);
      matchedIds = cjk
        ? db.prepare('SELECT rowid FROM docs_terms WHERE docs_terms MATCH ? LIMIT ?')
          .all(quoteTerm(literal), budgets.literalCandidateCap + 1) as { rowid: number }[]
        : db.prepare('SELECT id AS rowid FROM docs LIMIT ?')
          .all(budgets.literalCandidateCap + 1) as { rowid: number }[];
      if (!cjk) incomplete = 'deadline';
    }
    const cap = q.mode === 'terms' ? budgets.maxTextHits : budgets.literalCandidateCap;
    if (matchedIds.length > cap) { matchedIds.length = cap; incomplete = 'candidate_cap'; }
    const rows: { key: string; value: MessageDoc | TitleDoc; score: number }[] = [];
    const N = q.mode === 'terms' ? (db.prepare('SELECT count(*) AS n FROM docs').get() as { n: number }).n : 0;
    const dfs = new Map<string, number>();
    if (q.mode === 'terms') for (const term of terms) {
      dfs.set(term, (db.prepare('SELECT count(*) AS n FROM docs_terms WHERE docs_terms MATCH ?')
        .get(quoteTerm(term)) as { n: number }).n);
    }
    for (const { rowid } of matchedIds) {
      if (Date.now() > deadlineAt) { incomplete ??= 'deadline'; break; }
      const hit = db.prepare('SELECT d.*,s.workspace_id,s.title,s.identity,s.dir,f.agent_id,f.path FROM docs d JOIN sessions s ON s.id=d.session_id LEFT JOIN files f ON f.id=d.file_id WHERE d.id=?')
        .get(rowid) as { id: number; file_id: number | null; session_id: string; line_offset: number; ord: number;
          role: MessageDoc['role'] | 'title'; time: number; turn: number | null; step_id: string | null;
          text: string; workspace_id: string; title: string; identity: string; dir: string;
          agent_id: string | null; path: string | null } | undefined;
      if (!hit) continue;
      const value: MessageDoc | TitleDoc = hit.role === 'title'
        ? { kind: 'title', sessionId: hit.session_id, workspaceId: hit.workspace_id, sessionTitle: hit.title,
          sessionIdentity: hit.identity, agentId: '', role: 'title', text: hit.text, time: hit.time }
        : { kind: 'message', sessionId: hit.session_id, workspaceId: hit.workspace_id,
          sessionTitle: hit.title, sessionIdentity: hit.identity, agentId: hit.agent_id!, role: hit.role,
          text: hit.text, time: hit.time, turn: hit.turn ?? undefined, stepId: hit.step_id ?? undefined };
      const tokens = q.mode === 'terms' ? tokenize(hit.text) : [];
      let score = 0;
      if (tokens.length) for (const term of terms) {
        const frequency = tokens.filter((token) => token === term).length;
        if (frequency) score += (frequency / tokens.length) * Math.log(1 + N / (dfs.get(term) || 1));
      }
      rows.push({ key: hit.role === 'title' ? `\0title\\${hit.session_id}` :
        `${hit.session_id}/${hit.agent_id}/${hit.path === join(hit.dir, 'wire.jsonl') ? 'root' : 'agents'}:${hit.line_offset}:${hit.ord}`,
      value, score });
    }
    const budget = { deadlineAt, textCharsLeft: budgets.queryTextBudgetChars };
    const matched = matchDocs(q, rows, page.kind === 'keyset' ? page.boundary : undefined, budget);
    incomplete ??= matched.incomplete;
    const valid: MatchedRow[] = [];
    const identities = new Map<string, string | undefined>();
    for (const row of matched.rows) {
      const source = db.prepare('SELECT dir,identity FROM sessions WHERE id=?').get(row.value.sessionId) as
        { dir: string; identity: string } | undefined;
      if (!source || source.identity !== row.value.sessionIdentity) continue;
      if (!identities.has(source.dir)) identities.set(source.dir, await identity(source.dir));
      if (identities.get(source.dir) === source.identity) valid.push(row);
      if (Date.now() > deadlineAt) { incomplete ??= 'deadline'; break; }
    }
    const { pageRows, hasMore } = paginateRows(q, page, valid);
    return { rows: pageRows, hasMore, incomplete,
      pageToken: hasMore ? encodePageToken(q, 'index', boundaryOf(q, pageRows[pageRows.length - 1]!), generation) : undefined };
  }
}
