/**
 * external-clients — the 0.3.3 external client surface, end to end.
 *
 * The reverse of the external engines card: here a client outside Kiki drives
 * this machine. The scenario seeds the two halves a reader actually meets.
 *
 * - Settings › External clients: two connections (an authorized ChatGPT over
 *   a local stdio config, a paused desktop client that holds a host-command
 *   grant), one authorization waiting for a decision, and a listener that is
 *   bound but unchecked — deliberately not "reachable", because nothing has
 *   proved a client could get in.
 * - The externally driven session in the ordinary list: tool activity from the
 *   client, one saved note, one user excerpt, and a running sub agent, so the
 *   page has to keep the real facts and refuse to invent a model.
 *
 * Every connection/session shape mirrors
 * packages/klient/src/core/facade/external-clients.ts; the values are mock
 * data, and the timestamps are epoch milliseconds as the facade reports them.
 */

import base from './profile-editor.scenario.mjs';
import { sessionRecord } from './helpers.mjs';

const WSID = 'wd_fixture_000000000000';
const WORKSPACE = 'C:/fixture/workshop';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const now = Date.now();

const SID = 'session_fixture_external_client';

const connections = [
  {
    id: 'conn_chatgpt',
    name: 'ChatGPT',
    workspace: WORKSPACE,
    mode: 'auto',
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'ReadMedia', 'AgentRun', 'TaskList', 'TaskOutput', 'TaskStop',
      'HistoryList', 'HistoryRead', 'HistorySearch', 'kiki_save_text'],
    allowCommands: false,
    memoryScopes: ['workspace'],
    historyScope: 'current',
    status: 'active',
    createdAt: now - 6 * HOUR,
    updatedAt: now - 12 * MINUTE,
  },
  {
    id: 'conn_desktop',
    name: 'Desktop MCP',
    workspace: WORKSPACE,
    // A hand-picked tool list, so the panel opens the picker rather than
    // reading as the template.
    tools: ['Read', 'Glob', 'Grep'],
    mode: 'review',
    allowCommands: true,
    memoryScopes: ['workspace', 'global'],
    historyScope: 'connection',
    status: 'paused',
    createdAt: now - 3 * HOUR,
    updatedAt: now - 48 * MINUTE,
  },
  {
    id: 'conn_old',
    name: 'Old client',
    workspace: WORKSPACE,
    mode: 'manual',
    tools: ['Read'],
    allowCommands: false,
    memoryScopes: ['workspace'],
    historyScope: 'current',
    status: 'revoked',
    createdAt: now - 40 * HOUR,
    updatedAt: now - 39 * HOUR,
  },
];

const sessionsByConnection = {
  conn_chatgpt: [
    {
      sessionId: SID, sessionRef: 'extref_01J8ZC', connectionId: 'conn_chatgpt', clientName: 'ChatGPT',
      workspace: WORKSPACE, status: 'open', createdAt: now - 25 * MINUTE, updatedAt: now - 2 * MINUTE,
    },
  ],
  conn_desktop: [],
};

/**
 * What a local branch would carry, in the v3 preview shape. `partial` with a
 * known total is the honest case: Kiki read a bounded slice, and the UI has to
 * say so rather than present twelve rows as everything.
 */
const materialSource = { connectionId: 'conn_chatgpt', clientName: 'ChatGPT', sessionRef: 'extref_01J8ZC', driver: 'external' };
const materials = {
  [SID]: {
    state: 'partial',
    sessionId: SID,
    knownTotal: 9,
    coverage: { complete: false, bytesRead: 184320, recordsRead: 12, reason: 'bounded read' },
    items: [
      {
        id: 'rec_budget', kind: 'saved_text', title: 'Retry budget', excerpt: 'The retry budget was raised to 3 attempts in this branch; keep the old value for the public endpoint.',
        recordKind: 'note', source: materialSource, history: { sessionId: SID, agentId: 'main', turn: 1 },
      },
      {
        id: 'rec_user', kind: 'saved_text', title: '', excerpt: 'The user asked for a rollback, not a fix-forward.',
        recordKind: 'user_excerpt', source: materialSource, history: { sessionId: SID, agentId: 'main', turn: 1 },
      },
      {
        id: 'rec_tool', kind: 'tool_record', title: 'Edit src/limits.ts', excerpt: 'Applied patch to src/limits.ts: parseLimit now rejects values below 1.',
        toolName: 'Edit', source: materialSource, history: { sessionId: SID, agentId: 'main', turn: 2 },
      },
    ],
  },
};

const authorizations = [
  {
    id: 'auth_01',
    clientId: 'conn_chatgpt',
    clientName: 'ChatGPT',
    redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    scopes: ['tools:read', 'tools:write', 'history:read'],
    createdAt: now - 40_000,
  },
];

/**
 * The listener is bound and unchecked. This is the state that must never read
 * as "a remote client can connect", so the walk can look at it.
 */
const listener = {
  enabled: true,
  state: 'listening',
  origin: '127.0.0.1:59412',
  publicUrl: 'https://kiki-mcp.example.test',
  mcpUrl: 'https://kiki-mcp.example.test/mcp',
  discovery: 'unchecked',
};

const t0 = now - 22 * MINUTE;
const at = (seconds) => new Date(t0 + seconds * 1000).toISOString();

/**
 * The session's own activity. An external turn is a tool activity, not a
 * prompt: nothing here invents a user message or an assistant reply, and the
 * saved records are marked as the client's own submissions.
 */
const turn = (ordinal, frames, startSeconds, endSeconds) => ({
  kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed',
  origin: { kind: 'external', payload: { turnId: ordinal, toolName: 'Read' } },
  prompt: '', startedAt: at(startSeconds), endedAt: at(endSeconds), durationMs: (endSeconds - startSeconds) * 1000,
  steps: [{ kind: 'step', stepId: `t${ordinal}.1`, turnId: `t${ordinal}`, ordinal: 1, state: 'completed', frames }],
});

const LIMIT_BEFORE = [
  'export function parseLimit(raw: string): number {',
  '  return Number(raw);',
  '}',
].join('\n');

/** A saved body long enough that the transport hands over a prefix, not all of it. */
const LONG_BODY = [
  '## Change log',
  '',
  'The client pasted its own summary of every step it took in the chat. It is',
  'long on purpose: the transport cuts a body this size into a readable prefix',
  'plus a content ref, so the row has to offer reading the rest rather than',
  'pretending the prefix is the whole record.',
  '',
  '1. Raised the retry budget from 1 to 3 attempts.',
  '2. Kept the public endpoint on the old value so callers are unaffected.',
  '3. Added `Math.max(1, …)` to the parse so a missing value cannot become 0.',
  '4. Left `src/limits.ts` as the only changed file on purpose.',
].join('\n');

const items = [
  // A saved record is its own item, exactly as the engine records it: an
  // `external.text` marker whose payload is the durable `ExternalTextPayload`.
  // It is not a text frame — a frame with a role would be a message, and this
  // is the client handing over what it saved.
  {
    kind: 'marker',
    markerId: 'external-text:xc-saved-2',
    marker: 'external.text',
    at: at(40),
    payload: {
      recordId: 'xc-saved-2',
      turnId: 1,
      // Past the transport's body budget, so the server hands over a prefix
      // plus a content ref and the row has to offer to read the rest.
      text: LONG_BODY,
      kind: 'note',
      title: 'Full change log',
      source: {
        driver: 'external',
        connectionId: 'conn_chatgpt',
        clientName: 'ChatGPT',
        sessionRef: 'extref_01J8ZC',
      },
    },
  },
  {
    kind: 'marker',
    markerId: 'external-text:xc-saved-1',
    marker: 'external.text',
    at: at(60),
    payload: {
      recordId: 'xc-saved-1',
      turnId: 1,
      text: 'The retry budget was raised to 3 attempts in this branch, and `src/limits.ts` is the only file that changed.',
      kind: 'handoff',
      title: 'Retry budget handoff',
      source: {
        driver: 'external',
        connectionId: 'conn_chatgpt',
        clientName: 'ChatGPT',
        sessionRef: 'extref_01J8ZC',
      },
    },
  },
  turn(1, [
    { kind: 'tool', frameId: 'xc-t1-read', toolCallId: 'ext:call_read', name: 'Read src/limits.ts', state: 'done',
      input: { path: 'src/limits.ts' }, display: { kind: 'file_io', operation: 'read', path: 'src/limits.ts' }, output: LIMIT_BEFORE },
    { kind: 'tool', frameId: 'xc-t1-write', toolCallId: 'ext:call_write', name: 'Edit src/limits.ts', state: 'done',
      input: { path: 'src/limits.ts' },
      display: { kind: 'diff', path: 'src/limits.ts', before: LIMIT_BEFORE, after: LIMIT_BEFORE.replace('return Number(raw);', 'return Math.max(1, Number(raw));') },
      output: 'Applied patch to src/limits.ts' },
  ], 0, 96),
  turn(2, [
    { kind: 'tool', frameId: 'xc-t2-test', toolCallId: 'ext:call_test', name: 'pnpm vitest run src/limits.test.ts', state: 'done',
      input: { command: 'pnpm vitest run src/limits.test.ts' },
      display: { kind: 'command', command: 'pnpm vitest run src/limits.test.ts' },
      output: ' ✓ src/limits.test.ts (2 tests) 5ms\n\n Test Files  1 passed (1)' },
    { kind: 'tool', frameId: 'xc-t2-agent', toolCallId: 'ext:call_agent', name: 'AgentRun', state: 'done',
      input: { profile: 'reviewer', prompt: 'Review the limit parsing change.' },
      display: { kind: 'agent', profile: 'reviewer' },
      output: 'Started background task task_xc_01' },
  ], 120, 210),
];

export default {
  ...base,
  externalClients: {
    connections,
    listener,
    authorizations,
    materials,
    sessions: sessionsByConnection,
    nextConnectionNumber: 4,
  },
  sessions: [
    sessionRecord(SID, {
      title: 'ChatGPT: harden the limit parser',
      // Wire shape, not the engine's stored `custom`: kap-server projects
      // `Session.metadata` by spreading custom flat.
      metadata: {
        cwd: WORKSPACE,
        externalClient: {
          driver: 'external',
          connectionId: 'conn_chatgpt',
          clientName: 'ChatGPT',
          sessionRef: 'extref_01J8ZC',
        },
      },
      // No Kiki model runs this session, so the main agent is not bound to one.
      agent_config: { model: '' },
    }),
  ],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      agent_transcripts: { main: { agent_id: 'main', has_more: false, items } },
    },
  },
};
