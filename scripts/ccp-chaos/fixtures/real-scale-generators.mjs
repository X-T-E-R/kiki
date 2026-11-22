import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { tokenize } from '../../../packages/lexical/src/index.ts';

const SEARCH_APP_ID = 0x4b534958;
const SEARCH_SCHEMA_VERSION = 2;
const HISTORY_NAV_APP_ID = 0x4b484e31;
const HISTORY_NAV_SCHEMA_VERSION = 4;
const USAGE_APP_ID = 0x4b555332;
const USAGE_SCHEMA_VERSION = 2;

const CONVERSATION_SEARCH_PARTS = "('prompt','text','output')";

function roundMs(val) {
  return Number(Number(val ?? 0).toFixed(2));
}

function encodeSearchTerm(term) {
  const hex = Buffer.from(term, 'utf8').toString('hex');
  return ['b', ...hex.match(/.{1,128}/gu).map((chunk) => `x${chunk}`), 'e'].join(' ');
}

export function encodeFts5Terms(text) {
  return tokenize(String(text ?? '')).map(encodeSearchTerm).join(' ');
}

/**
 * Generates a deterministic real-directory + real-file tree (ZERO symlinks,
 * respecting `workspacePathInventory.ts:174` which skips symlink descent).
 * Supports both sub-overflow Git repos (210k-240k tracked files in full/cliff)
 * and >250k unignored non-Git umbrella trees (280k-300k files in full/cliff).
 */
export async function generateRealDirectoryTree({
  rootDir,
  fileCount,
  isGitRepo = true,
  needlePrefix = 'CLIFF_NEEDLE',
  concurrency = 64,
}) {
  const startedAt = performance.now();
  const absRoot = path.resolve(rootDir);
  fs.rmSync(absRoot, { recursive: true, force: true });
  fs.mkdirSync(absRoot, { recursive: true });

  let directoryCount = 0;
  if (isGitRepo) {
    fs.mkdirSync(path.join(absRoot, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(absRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    fs.writeFileSync(path.join(absRoot, '.git', 'info', 'exclude'), '*.ignored-by-git\n', 'utf8');
    fs.writeFileSync(path.join(absRoot, '.gitignore'), 'ignored-cache/\n*.tmp-ignored\n', 'utf8');
  }

  const topBuckets = fileCount >= 10_000 ? 64 : 8;
  const subBuckets = fileCount >= 10_000 ? 64 : 4;
  const leafDirs = [];
  for (let a = 0; a < topBuckets; a += 1) {
    const topName = `pkg_${String(a).padStart(2, '0')}`;
    const topAbs = path.join(absRoot, topName);
    fs.mkdirSync(topAbs, { recursive: true });
    directoryCount += 1;
    for (let b = 0; b < subBuckets; b += 1) {
      const subName = `mod_${String(b).padStart(2, '0')}`;
      const subAbs = path.join(topAbs, subName);
      fs.mkdirSync(subAbs, { recursive: true });
      directoryCount += 1;
      leafDirs.push({ relDir: `${topName}/${subName}`, absDir: subAbs });
    }
  }

  const needleIndices = new Set([
    0,
    1,
    2,
    3,
    Math.floor(fileCount / 2),
    Math.max(0, fileCount - 1),
  ]);
  const sampleNeedles = [];

  const createOne = async (idx) => {
    const leaf = leafDirs[idx % leafDirs.length];
    const fileName = `f_${String(idx).padStart(6, '0')}.ts`;
    const absPath = path.join(leaf.absDir, fileName);
    const relPath = `${leaf.relDir}/${fileName}`;
    let content;
    if (needleIndices.has(idx)) {
      const needle = `${needlePrefix}_${String(idx).padStart(6, '0')}`;
      sampleNeedles.push({ idx, needle, relPath });
      content = `export const ${needle} = "${needle}";\nexport const IDX = ${idx};\n`;
    } else {
      content = `export const N_${idx} = ${idx};\n`;
    }
    if (fileCount <= 2_500) {
      fs.writeFileSync(absPath, content, 'utf8');
    } else {
      await fs.promises.writeFile(absPath, content, 'utf8');
    }
  };

  if (fileCount <= 2_500) {
    for (let i = 0; i < fileCount; i += 1) {
      await createOne(i);
    }
  } else {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, fileCount) }, async () => {
      while (cursor < fileCount) {
        const idx = cursor;
        cursor += 1;
        await createOne(idx);
      }
    });
    await Promise.all(workers);
  }

  sampleNeedles.sort((a, b) => a.idx - b.idx);
  const totalFiles = fileCount + (isGitRepo ? 1 : 0);
  return {
    rootDir: absRoot,
    fileCount: totalFiles,
    sourceFileCount: fileCount,
    directoryCount,
    totalEntries: totalFiles + directoryCount,
    isGitRepo,
    symlinksUsed: 0,
    sampleNeedles,
    elapsedMs: roundMs(performance.now() - startedAt),
  };
}

/**
 * Pre-populates `<homeDir>/search-index-v2/index.sqlite` using the exact v2 production
 * schema (`APPLICATION_ID = 0x4b534958`, `user_version = 2`, FTS5 `docs_terms` + `docs_tri`).
 */
export function prepopulateSearchIndexV2({
  homeDir,
  workspaceId,
  sessionIds,
  docCount = 400,
  needleToken = 'WORKSTATION_CLIFF_SEARCH_NEEDLE',
}) {
  const startedAt = performance.now();
  const dbPath = path.join(homeDir, 'search-index-v2', 'index.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-32768; PRAGMA mmap_size=0; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=67108864',
    );
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL,
        dir TEXT NOT NULL, identity TEXT NOT NULL, updated_at INTEGER NOT NULL, source_mtime_ms REAL) STRICT;
      CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL, path TEXT NOT NULL UNIQUE, ino TEXT, size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
        offset INTEGER NOT NULL, tail_hash TEXT, turn_next INTEGER NOT NULL, turn_has INTEGER NOT NULL,
        step_state TEXT NOT NULL, policy TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS turn_openers (file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL, turn INTEGER NOT NULL, anchor INTEGER NOT NULL,
        PRIMARY KEY (file_id, idx)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        line_offset INTEGER NOT NULL, ord INTEGER NOT NULL, role TEXT NOT NULL, time INTEGER NOT NULL,
        turn INTEGER, step_id TEXT, text TEXT NOT NULL,
        UNIQUE (file_id, line_offset, ord)) STRICT;
      CREATE INDEX IF NOT EXISTS docs_session ON docs(session_id, role);
      CREATE INDEX IF NOT EXISTS files_session ON files(session_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_terms USING fts5(terms, content='', tokenize='unicode61 remove_diacritics 0');
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_tri USING fts5(text, content='docs', content_rowid='id', tokenize='trigram');
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS file_failures (path TEXT PRIMARY KEY, strikes INTEGER NOT NULL,
        error TEXT NOT NULL) STRICT;
    `);
    db.exec(`PRAGMA application_id=${SEARCH_APP_ID}; PRAGMA user_version=${SEARCH_SCHEMA_VERSION}`);
    db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('generation','1')").run();
    db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('extractor_version','3')").run();
    db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('selfcheck','passed')").run();

    const validSessions = (sessionIds ?? []).filter(Boolean);
    if (validSessions.length === 0) {
      return { dbPath, seededDocs: 0, seededSessions: 0, needleToken, elapsedMs: roundMs(performance.now() - startedAt) };
    }

    const insSession = db.prepare(
      'INSERT OR REPLACE INTO sessions(id, workspace_id, title, dir, identity, updated_at, source_mtime_ms) VALUES(?, ?, ?, ?, ?, ?, ?)',
    );
    const insFile = db.prepare(
      'INSERT OR REPLACE INTO files(id, session_id, agent_id, path, ino, size, mtime_ms, offset, tail_hash, turn_next, turn_has, step_state, policy) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insDoc = db.prepare(
      'INSERT OR REPLACE INTO docs(id, file_id, session_id, line_offset, ord, role, time, turn, step_id, text) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insTerms = db.prepare('INSERT INTO docs_terms(rowid, terms) VALUES(?, ?)');
    const insTri = db.prepare('INSERT INTO docs_tri(rowid, text) VALUES(?, ?)');

    const now = Date.now();
    const fileIds = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let i = 0; i < validSessions.length; i += 1) {
        const sid = validSessions[i];
        const sessDir = path.join(homeDir, 'sessions', workspaceId, sid);
        const wirePath = path.join(sessDir, 'agents', 'main', 'wire.jsonl');
        const st = fs.existsSync(wirePath) ? fs.statSync(wirePath) : { size: 512, mtimeMs: now, ino: i + 1 };
        const dirStBig = fs.existsSync(sessDir) ? fs.statSync(sessDir, { bigint: true }) : null;
        const sessionIdentity =
          dirStBig && dirStBig.isDirectory() && dirStBig.ino > 0n && dirStBig.birthtimeNs > 0n
            ? `${dirStBig.dev}:${dirStBig.ino}:${dirStBig.birthtimeNs}`
            : `${workspaceId}:${sid}`;
        const stateStat = fs.existsSync(path.join(sessDir, 'state.json'))
          ? fs.statSync(path.join(sessDir, 'state.json'))
          : st;
        insSession.run(
          sid,
          workspaceId,
          `Indexed Cliff Session #${i + 1}`,
          sessDir,
          sessionIdentity,
          now - i * 1000,
          stateStat.mtimeMs,
        );
        const fileId = i + 1;
        insFile.run(
          fileId,
          sid,
          'main',
          wirePath,
          String(st.ino ?? i + 1),
          st.size,
          st.mtimeMs,
          st.size,
          null,
          2,
          1,
          '{}',
          'full',
        );
        fileIds.push({ fileId, sid });
      }

      const needleTerms = encodeFts5Terms(`${needleToken} workstation cliff sqlite fts5 contention`);
      const regularTerms = encodeFts5Terms('synthetic workstation scale benchmark session history query');
      for (let d = 1; d <= docCount; d += 1) {
        const target = fileIds[(d - 1) % fileIds.length];
        const isNeedle = d <= 12 || d % 40 === 0;
        const role = d % 2 === 0 ? 'assistant' : 'user';
        const text = isNeedle
          ? `${needleToken} doc=${d} workstation cliff sqlite fts5 contention verification`
          : `Synthetic workstation scale benchmark session history query entry #${d}`;
        const terms = isNeedle ? needleTerms : regularTerms;
        insDoc.run(d, target.fileId, target.sid, d * 128, 0, role, now - d * 500, d, `step-${d}`, text);
        insTerms.run(d, terms);
        insTri.run(d, text);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const dbStat = fs.existsSync(dbPath) ? fs.statSync(dbPath) : { size: 0 };
    return {
      dbPath,
      dbBytes: dbStat.size,
      seededDocs: docCount,
      seededSessions: validSessions.length,
      needleToken,
      elapsedMs: roundMs(performance.now() - startedAt),
    };
  } finally {
    db.close();
  }
}

/**
 * Pre-populates `<homeDir>/server/history-navigation.sqlite` using exact schema v4
 * (`APPLICATION_ID = 0x4b484e31`, `user_version = 4`, WAL mode, `nav_terms` + `nav_trigrams`).
 */
export function prepopulateHistoryNavigationDb({
  homeDir,
  workspaceId,
  sessionIds,
  rowCount = 300,
  needleToken = 'HISTORY_NAV_WAL_NEEDLE',
}) {
  const startedAt = performance.now();
  const dbPath = path.join(homeDir, 'server', 'history-navigation.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec('PRAGMA busy_timeout=15000; PRAGMA journal_mode=WAL; PRAGMA auto_vacuum=INCREMENTAL');
    db.exec(
      'PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA wal_autocheckpoint=500; PRAGMA journal_size_limit=33554432; PRAGMA foreign_keys=ON',
    );
    db.exec(`
      CREATE TABLE IF NOT EXISTS scopes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, projection TEXT NOT NULL,
        workspace TEXT NOT NULL, session TEXT NOT NULL, agent TEXT NOT NULL,
        last_used_at INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS rows (
        scope INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE, key TEXT NOT NULL,
        kind TEXT NOT NULL, turn INTEGER NOT NULL, step TEXT, active INTEGER NOT NULL,
        position INTEGER, time INTEGER, value TEXT NOT NULL, PRIMARY KEY(scope,key)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS nav_turn ON rows(scope,kind,active,turn);
      CREATE INDEX IF NOT EXISTS nav_position ON rows(scope,turn,active,position);
      CREATE INDEX IF NOT EXISTS nav_time ON rows(scope,kind,active,time);
      CREATE INDEX IF NOT EXISTS nav_search_role_order ON rows(scope,
        coalesce(json_extract(value,'$.role'),'user'),coalesce(time,0),key)
        WHERE active=1 AND json_extract(value,'$.part') IN ${CONVERSATION_SEARCH_PARTS};
      CREATE INDEX IF NOT EXISTS nav_source ON rows(scope,active,json_extract(value,'$.anchor.start'));
      CREATE TABLE IF NOT EXISTS state (
        scope INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE, bucket TEXT NOT NULL,
        key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,bucket,key)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS canonical_spans (
        scope INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE, turn_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL, start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL,
        digest BLOB NOT NULL, PRIMARY KEY(scope,turn_id,ordinal)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS turn_sequence (
        scope INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
        id TEXT NOT NULL, start_ordinal INTEGER NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(scope,seq)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS nav_turn_sequence_id ON turn_sequence(scope,active,id);
      CREATE INDEX IF NOT EXISTS nav_turn_sequence_start ON turn_sequence(scope,active,start_ordinal);
      CREATE TABLE IF NOT EXISTS anchor_sequence (
        scope INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
        ordinal INTEGER NOT NULL, turn_id TEXT, message_id TEXT, active INTEGER NOT NULL, PRIMARY KEY(scope,seq)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS nav_anchor_ordinal ON anchor_sequence(scope,active,ordinal DESC);
      CREATE INDEX IF NOT EXISTS nav_anchor_turn ON anchor_sequence(scope,active,turn_id);
      CREATE TABLE IF NOT EXISTS manifest (
        scope INTEGER PRIMARY KEY REFERENCES scopes(id) ON DELETE CASCADE, value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS turn_boundaries (
        scope INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE, turn_id INTEGER NOT NULL,
        start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL, PRIMARY KEY(scope,turn_id)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS boundary_manifest (
        scope INTEGER PRIMARY KEY REFERENCES scopes(id) ON DELETE CASCADE, watermark INTEGER NOT NULL, proof TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS directory_views (id TEXT PRIMARY KEY, used INTEGER NOT NULL) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS search_documents (
        id INTEGER PRIMARY KEY, scope INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
        key TEXT NOT NULL, content_hash TEXT NOT NULL, UNIQUE(scope,key)
      ) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS nav_terms USING fts5(terms, content='', contentless_delete=1);
      CREATE VIRTUAL TABLE IF NOT EXISTS nav_trigrams USING fts5(body, tokenize='trigram', detail='none', content='', contentless_delete=1);
      CREATE TRIGGER IF NOT EXISTS nav_row_search_delete AFTER DELETE ON rows BEGIN
        DELETE FROM search_documents WHERE scope=old.scope AND key=old.key;
      END;
      CREATE TRIGGER IF NOT EXISTS nav_search_delete AFTER DELETE ON search_documents BEGIN
        DELETE FROM nav_terms WHERE rowid=old.id;
        DELETE FROM nav_trigrams WHERE rowid=old.id;
      END;
      CREATE INDEX IF NOT EXISTS nav_scopes_used ON scopes(projection, last_used_at);
    `);
    db.exec(`PRAGMA application_id=${HISTORY_NAV_APP_ID}; PRAGMA user_version=${HISTORY_NAV_SCHEMA_VERSION}`);

    const validSessions = (sessionIds ?? []).filter(Boolean);
    const insScope = db.prepare(
      'INSERT OR IGNORE INTO scopes(name, projection, workspace, session, agent, last_used_at) VALUES(?, ?, ?, ?, ?, ?)',
    );
    const getScope = db.prepare('SELECT id FROM scopes WHERE name = ?');
    const insRow = db.prepare(
      'INSERT OR REPLACE INTO rows(scope, key, kind, turn, step, active, position, time, value) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insSearchDoc = db.prepare(
      'INSERT OR REPLACE INTO search_documents(id, scope, key, content_hash) VALUES(?, ?, ?, ?)',
    );
    const insNavTerms = db.prepare('INSERT INTO nav_terms(rowid, terms) VALUES(?, ?)');
    const insNavTri = db.prepare('INSERT INTO nav_trigrams(rowid, body) VALUES(?, ?)');

    const now = Date.now();
    const scopeIds = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      const scopeTargets = validSessions.slice(0, Math.max(1, Math.min(validSessions.length, 32)));
      for (let i = 0; i < scopeTargets.length; i += 1) {
        const sid = scopeTargets[i];
        const scopeName = `${workspaceId}\0${sid}\0main`;
        insScope.run(scopeName, '', workspaceId, sid, 'main', now - i * 1000);
        const found = getScope.get(scopeName);
        if (found?.id) scopeIds.push(found.id);
      }

      const needleEncoded = encodeFts5Terms(`${needleToken} concurrent wal history navigation`);
      const regularEncoded = encodeFts5Terms('synthetic history navigation turn block payload');
      for (let r = 1; r <= rowCount; r += 1) {
        const scopeId = scopeIds[(r - 1) % scopeIds.length];
        const key = `text:t${r}:0`;
        const isNeedle = r <= 12 || r % 35 === 0;
        const body = isNeedle
          ? `${needleToken} row=${r} concurrent wal history navigation`
          : `Synthetic history navigation turn block payload #${r}`;
        const val = JSON.stringify({
          role: r % 2 === 0 ? 'assistant' : 'user',
          part: 'text',
          text: body,
          anchor: { start: r * 256, end: r * 256 + 180 },
        });
        insRow.run(scopeId, key, 'text', r, `t${r}.1`, 1, r, now - r * 400, val);
        const digest = createHash('sha256').update(body).digest('hex').slice(0, 16);
        insSearchDoc.run(r, scopeId, key, digest);
        insNavTerms.run(r, isNeedle ? needleEncoded : regularEncoded);
        insNavTri.run(r, body.toLowerCase());
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const dbStat = fs.existsSync(dbPath) ? fs.statSync(dbPath) : { size: 0 };
    return {
      dbPath,
      dbBytes: dbStat.size,
      seededRows: rowCount,
      seededScopes: scopeIds.length,
      needleToken,
      elapsedMs: roundMs(performance.now() - startedAt),
    };
  } finally {
    db.close();
  }
}

/**
 * Pre-populates `<homeDir>/cache/usage-read-model-v2/index.sqlite` using exact schema v2
 * (`APPLICATION_ID = 0x4b555332`, `user_version = 2`, WAL mode).
 */
export function prepopulateUsageReadModelV2({
  homeDir,
  workspaceId,
  sessionIds,
  factCount = 400,
}) {
  const startedAt = performance.now();
  const dbPath = path.join(homeDir, 'cache', 'usage-read-model-v2', 'index.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  try {
    db.exec(
      'PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA cache_size=-16384; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA journal_size_limit=67108864',
    );
    db.exec(`
      CREATE TABLE IF NOT EXISTS private_session(workspace TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(workspace,id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session(workspace TEXT NOT NULL,id TEXT NOT NULL,title TEXT,created REAL NOT NULL,updated REAL NOT NULL,archived INTEGER NOT NULL,deleted INTEGER NOT NULL,ephemeral INTEGER NOT NULL DEFAULT 0,present INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(workspace,id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS source(id TEXT PRIMARY KEY,workspace TEXT,session_id TEXT,generation TEXT NOT NULL,checkpoint TEXT,journal_offset INTEGER NOT NULL DEFAULT 0,journal_size INTEGER NOT NULL DEFAULT 0,ordinal INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,present INTEGER NOT NULL DEFAULT 1,kind TEXT NOT NULL DEFAULT 'wire',retained_meta TEXT,building_generation TEXT,building_checkpoint TEXT,building_ordinal INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS source_session ON source(workspace,session_id);
      CREATE TABLE IF NOT EXISTS fact(source TEXT NOT NULL,generation TEXT NOT NULL,ordinal INTEGER NOT NULL,time REAL NOT NULL,model TEXT NOT NULL,upstream_model TEXT,source_agent TEXT,agent TEXT,parent_agent TEXT,provider TEXT,model_alias TEXT,profile TEXT,turn REAL,input_other REAL NOT NULL,output REAL NOT NULL,cache_read REAL NOT NULL,cache_creation REAL NOT NULL,state INTEGER NOT NULL,mask INTEGER NOT NULL,known INTEGER,usage_scope TEXT,executor TEXT,PRIMARY KEY(source,generation,ordinal)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS fact_time ON fact(time,source,generation,ordinal);
      CREATE TABLE IF NOT EXISTS source_model_total(source TEXT NOT NULL,generation TEXT NOT NULL,model TEXT NOT NULL,state INTEGER NOT NULL,mask INTEGER NOT NULL,input_other REAL NOT NULL,output REAL NOT NULL,cache_read REAL NOT NULL,cache_creation REAL NOT NULL,records INTEGER NOT NULL,PRIMARY KEY(source,generation,model,state,mask)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS source_hour_total_v1(source TEXT NOT NULL,generation TEXT NOT NULL,identity TEXT NOT NULL,time REAL NOT NULL,latest_time REAL NOT NULL,model TEXT NOT NULL,source_agent TEXT,agent TEXT,parent_agent TEXT,provider TEXT,model_alias TEXT,profile TEXT,turn REAL,input_other REAL NOT NULL,output REAL NOT NULL,cache_read REAL NOT NULL,cache_creation REAL NOT NULL,state INTEGER NOT NULL,mask INTEGER NOT NULL,record_count INTEGER NOT NULL,precise INTEGER NOT NULL,PRIMARY KEY(source,generation,identity)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS source_hour_head_v1(source TEXT NOT NULL,generation TEXT NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(source,generation)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS retired_generation(source TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(source,generation)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS retained_publication(ledger TEXT NOT NULL,target TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(ledger,target)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS import(source TEXT PRIMARY KEY,progress TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS stage(source TEXT NOT NULL,ordinal INTEGER NOT NULL,time REAL NOT NULL,model TEXT NOT NULL,upstream_model TEXT,source_agent TEXT,agent TEXT,parent_agent TEXT,provider TEXT,model_alias TEXT,profile TEXT,turn REAL,input_other REAL NOT NULL,output REAL NOT NULL,cache_read REAL NOT NULL,cache_creation REAL NOT NULL,state INTEGER NOT NULL,mask INTEGER NOT NULL,known INTEGER,usage_scope TEXT,executor TEXT,PRIMARY KEY(source,ordinal)) WITHOUT ROWID;
    `);
    db.exec(`PRAGMA application_id=${USAGE_APP_ID}; PRAGMA user_version=${USAGE_SCHEMA_VERSION}`);

    const validSessions = (sessionIds ?? []).filter(Boolean);
    const now = Date.now();
    const hourMs = Math.floor(now / 3_600_000) * 3_600_000;

    const insSession = db.prepare(
      'INSERT OR REPLACE INTO session(workspace,id,title,created,updated,archived,deleted,ephemeral,present) VALUES(?,?,?,?,?,?,?,?,1)',
    );
    const insSource = db.prepare(
      "INSERT OR REPLACE INTO source(id,workspace,session_id,generation,checkpoint,journal_offset,journal_size,ordinal,revision,present,kind) VALUES(?,?,?,?,?,?,?,?,?,1,'wire')",
    );
    const insFact = db.prepare(
      'INSERT OR REPLACE INTO fact(source,generation,ordinal,time,model,upstream_model,source_agent,agent,parent_agent,provider,model_alias,profile,turn,input_other,output,cache_read,cache_creation,state,mask,known,usage_scope,executor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    const insModelTotal = db.prepare(
      'INSERT OR REPLACE INTO source_model_total(source,generation,model,state,mask,input_other,output,cache_read,cache_creation,records) VALUES(?,?,?,?,?,?,?,?,?,?)',
    );
    const insHourTotal = db.prepare(
      'INSERT OR REPLACE INTO source_hour_total_v1(source,generation,identity,time,latest_time,model,source_agent,agent,parent_agent,provider,model_alias,profile,turn,input_other,output,cache_read,cache_creation,state,mask,record_count,precise) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)',
    );
    const insHourHead = db.prepare(
      'INSERT OR REPLACE INTO source_hour_head_v1(source,generation,ordinal) VALUES(?,?,?)',
    );

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR REPLACE INTO meta(id, epoch, revision) VALUES(1, ?, 1)').run(randomUUID());
      const targets = validSessions.slice(0, Math.max(1, Math.min(validSessions.length, 64)));
      const perSourceOrd = new Map();
      const perSourceTotals = new Map();

      for (let i = 0; i < targets.length; i += 1) {
        const sid = targets[i];
        const sourceId = `sessions/${workspaceId}/${sid}/agents/main`;
        const wirePath = path.join(homeDir, 'sessions', workspaceId, sid, 'agents', 'main', 'wire.jsonl');
        const wireStat = fs.existsSync(wirePath) ? fs.statSync(wirePath) : { size: 512, mtimeMs: now };
        const gen = `gen_${i + 1}`;
        insSession.run(workspaceId, sid, `Usage Session #${i + 1}`, now - 60_000, now - i * 1000, 0, 0, 0);
        perSourceOrd.set(sourceId, {
          sid,
          gen,
          wireSize: wireStat.size,
          wireMtimeMs: wireStat.mtimeMs,
          count: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreate: 0,
        });
        perSourceTotals.set(sourceId, { sid, gen });
      }
      const sourceKeys = [...perSourceOrd.keys()];
      for (let f = 0; f < factCount; f += 1) {
        const sourceId = sourceKeys[f % sourceKeys.length];
        const rec = perSourceOrd.get(sourceId);
        const ord = rec.count;
        rec.count += 1;
        const inputOther = 800 + (f % 500);
        const output = 160 + (f % 120);
        const cacheRead = 400 + (f % 200);
        const cacheCreate = 64;
        rec.input += inputOther;
        rec.output += output;
        rec.cacheRead += cacheRead;
        rec.cacheCreate += cacheCreate;
        insFact.run(
          sourceId,
          rec.gen,
          ord,
          now - f * 250,
          'twin-anthropic',
          'twin-anthropic',
          'main',
          'main',
          null,
          'twin_anthropic',
          'twin-anthropic',
          'default',
          ord,
          inputOther,
          output,
          cacheRead,
          cacheCreate,
          0,
          15,
          1,
          'main',
          'native',
        );
      }

      for (const [sourceId, rec] of perSourceOrd.entries()) {
        const ckpt = JSON.stringify({
          valid: true,
          generation: '',
          offset: rec.wireSize,
          size: rec.wireSize,
          mtimeMs: rec.wireMtimeMs,
        });
        insSource.run(sourceId, workspaceId, rec.sid, rec.gen, ckpt, rec.wireSize, rec.wireSize, rec.count, 1);
        if (rec.count > 0) {
          insModelTotal.run(sourceId, rec.gen, 'twin-anthropic', 0, 15, rec.input, rec.output, rec.cacheRead, rec.cacheCreate, rec.count);
          insHourTotal.run(
            sourceId,
            rec.gen,
            `${hourMs}:twin-anthropic:main:0:15`,
            hourMs,
            now,
            'twin-anthropic',
            'main',
            'main',
            null,
            'twin_anthropic',
            'twin-anthropic',
            'default',
            null,
            rec.input,
            rec.output,
            rec.cacheRead,
            rec.cacheCreate,
            0,
            15,
            rec.count,
          );
          insHourHead.run(sourceId, rec.gen, rec.count);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const dbStat = fs.existsSync(dbPath) ? fs.statSync(dbPath) : { size: 0 };
    return {
      dbPath,
      dbBytes: dbStat.size,
      seededFacts: factCount,
      seededSessions: Math.min(validSessions.length, 64),
      elapsedMs: roundMs(performance.now() - startedAt),
    };
  } finally {
    db.close();
  }
}

/**
 * Runs genuine multi-threaded concurrent WAL readers (`node:worker_threads` synchronized
 * via a SharedArrayBuffer barrier) overlapping with an active WAL writer against
 * `history-navigation.sqlite` while kap-server is active.
 */
export async function runConcurrentHistoryWalReaders({ dbPath, needleToken, readerCount = 4, queriesPerReader = 6 }) {
  const startedAt = performance.now();
  const encoded = encodeFts5Terms(needleToken);
  const effectiveReaders = Math.max(1, readerCount);
  const barrier = new Int32Array(new SharedArrayBuffer(16));
  const workerScript = `
    const { workerData, parentPort } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const { performance } = require('node:perf_hooks');
    const { dbPath, encoded, queriesPerReader, readerCount, barrierBuf } = workerData;
    const barrier = new Int32Array(barrierBuf);
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
    const latencies = [];
    let succeeded = 0;
    let failed = 0;
    let matchedRows = 0;
    try {
      const stmtTerms = db.prepare('SELECT rowid FROM nav_terms WHERE nav_terms MATCH ? LIMIT 10');
      const stmtRows = db.prepare('SELECT scope, key, turn FROM rows WHERE active = 1 ORDER BY time DESC LIMIT 20');
      const arrived = Atomics.add(barrier, 0, 1) + 1;
      if (arrived >= readerCount) {
        Atomics.store(barrier, 1, 1);
        Atomics.notify(barrier, 1);
      } else {
        Atomics.wait(barrier, 1, 0, 5000);
      }
      for (let q = 0; q < queriesPerReader; q += 1) {
        const t0 = performance.now();
        try {
          const hits = stmtTerms.all(encoded);
          const recent = stmtRows.all();
          latencies.push(Number((performance.now() - t0).toFixed(2)));
          matchedRows += hits.length + recent.length;
          succeeded += 1;
        } catch {
          failed += 1;
        }
      }
    } finally {
      db.close();
    }
    parentPort.postMessage({ latencies, succeeded, failed, matchedRows });
  `;

  const walPath = `${dbPath}-wal`;
  let walBytesObserved = 0;
  let walWritesCompleted = 0;
  const writerPromise = (async () => {
    const deadline = performance.now() + 5_000;
    while (Atomics.load(barrier, 1) === 0 && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const wdb = new DatabaseSync(dbPath, { timeout: 5_000 });
    try {
      wdb.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
      const scopeRow = wdb.prepare('SELECT id FROM scopes LIMIT 1').get();
      if (scopeRow) {
        const insRow = wdb.prepare(
          'INSERT OR REPLACE INTO rows(scope, key, kind, turn, step, active, position, time, value) VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?)',
        );
        for (let w = 0; w < 4; w += 1) {
          const k = `wal_overlap_${Date.now()}_${w}`;
          const val = JSON.stringify({
            role: 'assistant',
            part: 'text',
            text: `${needleToken} concurrent WAL writer probe #${w}`,
          });
          wdb.exec('BEGIN IMMEDIATE');
          try {
            insRow.run(scopeRow.id, k, 'text', 9000 + w, `t${9000 + w}.0`, 9000 + w, Date.now(), val);
            wdb.exec('COMMIT');
            walWritesCompleted += 1;
          } catch {
            try { wdb.exec('ROLLBACK'); } catch {}
          }
          if (fs.existsSync(walPath)) {
            walBytesObserved = Math.max(walBytesObserved, fs.statSync(walPath).size);
          }
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    } finally {
      wdb.close();
    }
  })();

  const workerResults = await Promise.all(
    Array.from({ length: effectiveReaders }, () =>
      new Promise((resolve, reject) => {
        const worker = new Worker(workerScript, {
          eval: true,
          workerData: {
            dbPath,
            encoded,
            queriesPerReader,
            readerCount: effectiveReaders,
            barrierBuf: barrier.buffer,
          },
        });
        let settled = false;
        worker.once('message', (msg) => {
          settled = true;
          resolve(msg);
        });
        worker.once('error', (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
        worker.once('exit', (code) => {
          if (!settled) {
            settled = true;
            reject(new Error(`WAL reader worker exited early with code ${code}`));
          }
        });
      }),
    ),
  );
  await writerPromise;

  const latencies = [];
  let succeeded = 0;
  let failed = 0;
  let matchedRows = 0;
  for (const r of workerResults) {
    latencies.push(...(r.latencies ?? []));
    succeeded += r.succeeded ?? 0;
    failed += r.failed ?? 0;
    matchedRows += r.matchedRows ?? 0;
  }

  const sorted = [...latencies].toSorted((a, b) => a - b);
  const p95 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
  return {
    readerCount: effectiveReaders,
    workerThreadsUsed: true,
    overlappingWalWriter: walWritesCompleted > 0,
    walWritesCompleted,
    walBytesObserved,
    queriesAttempted: effectiveReaders * queriesPerReader,
    succeeded,
    failed,
    matchedRows,
    p95Ms: p95,
    maxMs: sorted.length > 0 ? sorted.at(-1) : 0,
    elapsedMs: roundMs(performance.now() - startedAt),
  };
}
