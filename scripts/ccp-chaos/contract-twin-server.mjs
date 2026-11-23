import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import http from 'node:http';
import http2 from 'node:http2';
import { performance } from 'node:perf_hooks';
import {
  checkRequiredToolSchemas,
  detectS10Directive,
  planS10ChildStep,
  REQUIRED_CHILD_CHAIN_TOOLS,
  REQUIRED_ORCHESTRATOR_TOOLS,
} from './twin/chained-workload.mjs';
import { streamPacedAnthropicResponse } from './twin/stream-writer.mjs';

const ANTHROPIC_THREADS_BETA = 'message-threads-2026-08-12';
const MAX_CACHE_CONTROL_BREAKPOINTS = 4;

const DEFAULT_FAULT_WEIGHTS = [
  ['ping_eof', 18],
  ['ping_error', 15],
  ['malformed_tool', 20],
  ['rate_limit_429', 15],
  ['mid_stream_eof', 12],
  ['soft_safety', 8],
  ['early_413', 7],
  ['slow_drip', 5],
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  let length;
  if (body.length < 128) {
    length = Buffer.from([body.length]);
  } else {
    const bytes = [];
    let n = body.length;
    while (n > 0) {
      bytes.unshift(n & 255);
      n >>>= 8;
    }
    length = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

function derSequence(...parts) {
  return der(0x30, ...parts);
}

function derOid(hex) {
  return der(0x06, Buffer.from(hex, 'hex'));
}

function derAsn1Time(date) {
  const iso = date.toISOString().replaceAll(/[-:T]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  const year = date.getUTCFullYear();
  if (year >= 1950 && year <= 2049) {
    return der(0x17, Buffer.from(iso.slice(2), 'ascii'));
  }
  return der(0x18, Buffer.from(iso, 'ascii'));
}

export function generateLoopbackTlsCert() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const now = Date.now();
  const algorithm = derSequence(derOid('2a8648ce3d040302'));
  const name = derSequence(der(0x31, derSequence(derOid('550403'), der(0x0c, Buffer.from('127.0.0.1')))));
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 1;
  const sanValue = derSequence(
    der(0x82, Buffer.from('localhost', 'ascii')),
    der(0x87, Buffer.from([127, 0, 0, 1])),
  );
  const sanExtension = derSequence(derOid('551d11'), der(0x04, sanValue));
  const extensions = der(0xa3, derSequence(sanExtension));
  const tbs = derSequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    algorithm,
    name,
    derSequence(derAsn1Time(new Date(now - 86_400_000)), derAsn1Time(new Date(now + 30 * 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const certDer = derSequence(tbs, algorithm, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  const b64 = certDer.toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  const cert = `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  return { key, cert, fingerprint };
}

function countCacheControlBreakpoints(value) {
  if (value === null || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += countCacheControlBreakpoints(item);
    return total;
  }
  let total =
    Object.hasOwn(value, 'cache_control') && value.cache_control !== null && value.cache_control !== undefined ? 1 : 0;
  for (const [k, v] of Object.entries(value)) {
    if (k === 'cache_control' || k === 'input') continue;
    if (v && typeof v === 'object') total += countCacheControlBreakpoints(v);
  }
  return total;
}

function normalizeMessageBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

function validateAnthropicToolPairing(messages) {
  const seenToolUseIds = new Set();
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== 'object' || (msg.role !== 'user' && msg.role !== 'assistant')) {
      return `Invalid message at index ${i}: expected role "user" or "assistant"`;
    }
    const blocks = normalizeMessageBlocks(msg.content);
    const toolUses = blocks.filter((b) => b && typeof b === 'object' && b.type === 'tool_use');
    const toolResults = blocks.filter((b) => b && typeof b === 'object' && b.type === 'tool_result');

    if (msg.role === 'assistant') {
      if (toolResults.length > 0) {
        return `Message ${i} (assistant) must not contain tool_result blocks`;
      }
      for (const tu of toolUses) {
        if (typeof tu.id !== 'string' || tu.id.length === 0) {
          return `Message ${i} contains tool_use without valid id`;
        }
        if (seenToolUseIds.has(tu.id)) {
          return `Duplicate tool_use id "${tu.id}" at message ${i}`;
        }
        seenToolUseIds.add(tu.id);
      }
      if (toolUses.length > 0 && i + 1 < messages.length) {
        const nextMsg = messages[i + 1];
        if (!nextMsg || nextMsg.role !== 'user') {
          return `Assistant message ${i} with tool_use must be followed by user message with tool_result`;
        }
        const nextResultIds = new Set(
          normalizeMessageBlocks(nextMsg.content)
            .filter((b) => b && typeof b === 'object' && b.type === 'tool_result')
            .map((b) => b.tool_use_id),
        );
        for (const tu of toolUses) {
          if (!nextResultIds.has(tu.id)) {
            return `Missing tool_result for tool_use id "${tu.id}" in message ${i + 1}`;
          }
        }
      }
    } else if (toolResults.length > 0) {
      if (i === 0) {
        return `Message 0 (user) contains orphan tool_result without preceding assistant tool_use`;
      }
      const prevMsg = messages[i - 1];
      if (!prevMsg || prevMsg.role !== 'assistant') {
        return `User message ${i} with tool_result must immediately follow an assistant message`;
      }
      const prevToolUseIds = new Set(
        normalizeMessageBlocks(prevMsg.content)
          .filter((b) => b && typeof b === 'object' && b.type === 'tool_use')
          .map((b) => b.id),
      );
      for (const tr of toolResults) {
        if (typeof tr.tool_use_id !== 'string' || !prevToolUseIds.has(tr.tool_use_id)) {
          return `Orphan tool_result "${String(tr.tool_use_id)}" at message ${i} has no matching tool_use in message ${i - 1}`;
        }
      }
    }
  }
  return null;
}

function isSystemReminderOnlyText(text) {
  const stripped = String(text ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, '').trim();
  return stripped.length === 0;
}

function extractLatestTurnPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { text: '', turnToolRound: 0 };
  }
  let turnToolRound = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || msg.role !== 'user') continue;
    const blocks = normalizeMessageBlocks(msg.content);
    const hasToolResult = blocks.some((b) => b && typeof b === 'object' && b.type === 'tool_result');
    const textParts = blocks
      .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .filter((t) => !isSystemReminderOnlyText(t));
    if (hasToolResult && textParts.length === 0) {
      turnToolRound += 1;
      continue;
    }
    if (textParts.length === 0) {
      continue;
    }
    return { text: textParts.join('\n'), turnToolRound };
  }
  return { text: '', turnToolRound };
}

function extractToolResultText(toolResults) {
  const parts = [];
  for (const tr of toolResults ?? []) {
    if (typeof tr?.content === 'string') parts.push(tr.content);
    else if (Array.isArray(tr?.content)) {
      for (const blk of tr.content) {
        if (typeof blk?.text === 'string') parts.push(blk.text);
      }
    }
  }
  return parts.join('\n');
}

function stripReadLinePrefixes(text) {
  return String(text ?? '')
    .split(/\r?\n/u)
    .filter((line) => !line.startsWith('<system>'))
    .map((line) => line.replace(/^\s*\d+\t/u, ''))
    .join('\n')
    .trim();
}

function detectV23ToolPlan(text) {
  const m = /\[V23_TOOL_PLAN:([A-Za-z0-9_-]+)\]/u.exec(String(text ?? ''));
  if (!m) return null;
  try {
    const raw = Buffer.from(m[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.steps)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function interpolatePlanValue(value, ctx) {
  if (typeof value === 'string') {
    return value
      .replaceAll('{{LAST_TOOL_TEXT}}', ctx.lastToolText)
      .replaceAll('{{LAST_TASK_ID}}', ctx.lastTaskId)
      .replaceAll('{{LAST_BRANCH_ID}}', ctx.lastBranchId);
  }
  if (Array.isArray(value)) return value.map((v) => interpolatePlanValue(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolatePlanValue(v, ctx);
    return out;
  }
  return value;
}

function extractAllPromptText(body) {
  const parts = [];
  if (Array.isArray(body?.messages)) {
    for (const msg of body.messages) {
      if (typeof msg?.content === 'string') {
        parts.push(msg.content);
      } else if (Array.isArray(msg?.content)) {
        for (const blk of msg.content) {
          if (typeof blk?.text === 'string') parts.push(blk.text);
          if (typeof blk?.content === 'string') parts.push(blk.content);
        }
      }
    }
  }
  if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      if (typeof item?.content === 'string') parts.push(item.content);
      else if (Array.isArray(item?.content)) {
        for (const blk of item.content) {
          if (typeof blk?.text === 'string') parts.push(blk.text);
        }
      }
    }
  }
  return parts.join('\n');
}

function extractLatestUserMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { text: '', toolResults: [] };
  const last = messages.at(-1);
  if (!last || last.role !== 'user') return { text: '', toolResults: [] };
  const blocks = normalizeMessageBlocks(last.content);
  const textParts = [];
  const toolResults = [];
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string') textParts.push(b.text);
    if (b?.type === 'tool_result') toolResults.push(b);
  }
  return { text: textParts.join('\n'), toolResults };
}

function countMediaBlocks(body) {
  let count = 0;
  let totalChars = 0;
  const inspect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) inspect(item);
      return;
    }
    if (node.type === 'image' || node.type === 'image_url' || node.type === 'input_image' || node.type === 'document') {
      count += 1;
      const raw = node?.source?.data ?? node?.image_url?.url ?? node?.image_url ?? '';
      if (typeof raw === 'string') totalChars += raw.length;
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') inspect(v);
    }
  };
  inspect(body?.messages);
  inspect(body?.input);
  return { count, totalChars };
}

function extractHeader(headers, name) {
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw.join(',');
  return typeof raw === 'string' ? raw : undefined;
}

function parseBetaTokens(headerVal, bodyBetas) {
  const tokens = new Set();
  if (typeof headerVal === 'string') {
    for (const part of headerVal.split(',')) {
      const trimmed = part.trim();
      if (trimmed) tokens.add(trimmed);
    }
  }
  if (Array.isArray(bodyBetas)) {
    for (const b of bodyBetas) {
      if (typeof b === 'string' && b.trim()) tokens.add(b.trim());
    }
  }
  return tokens;
}

const CHAOS_TAG_MAP = [
  ['[CHAOS:PING_EOF]', 'ping_eof'],
  ['[CHAOS:PING_ERROR]', 'ping_error'],
  ['[CHAOS:SOFT_SAFETY]', 'soft_safety'],
  ['[CHAOS:MALFORMED_TOOL]', 'malformed_tool'],
  ['[CHAOS:EARLY_413]', 'early_413'],
  ['[CHAOS:RATE_LIMIT_429_RETRY_AFTER]', 'rate_limit_429_retry_after'],
  ['[CHAOS:RATE_LIMIT_429_NO_RETRY]', 'rate_limit_429_no_retry'],
  ['[CHAOS:RATE_LIMIT_429]', 'rate_limit_429'],
  ['[CHAOS:GATEWAY_524]', 'gateway_524'],
  ['[CHAOS:MID_STREAM_EOF]', 'mid_stream_eof'],
  ['[CHAOS:SLOW_DRIP]', 'slow_drip'],
  ['[CHAOS:THREAD_LOST]', 'thread_lost'],
];

function detectTaggedFault(promptText) {
  let lastPos = -1;
  let matched = null;
  for (const [tag, faultKind] of CHAOS_TAG_MAP) {
    const idx = promptText.lastIndexOf(tag);
    if (idx > lastPos) {
      lastPos = idx;
      matched = faultKind;
    }
  }
  return matched;
}

function detectToolProfile(promptText) {
  const matches = [...promptText.matchAll(/\[TOOLS:([A-Z0-9_]+)(?::([^\]]+))?\]/gu)];
  if (matches.length === 0) return null;
  const last = matches.at(-1);
  return { profile: last[1], arg: last[2] ?? '' };
}

function detectCoupledTickLoop(text) {
  const m = /\[COUPLED_TICK_LOOP:id=([A-Za-z0-9_.-]+)(?:,maxSteps=(\d{1,4}))?\]/u.exec(String(text ?? ''));
  if (!m) return null;
  return {
    id: m[1],
    maxSteps: m[2] ? Math.max(1, Number.parseInt(m[2], 10)) : 250,
  };
}

function extractSystemPromptSnippet(body) {
  if (typeof body?.system === 'string') return body.system.slice(0, 24_000);
  if (Array.isArray(body?.system)) {
    return body.system
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('\n')
      .slice(0, 24_000);
  }
  return '';
}

function detectBarrierId(promptText) {
  const matches = [...promptText.matchAll(/\[CHAOS_BARRIER:([A-Za-z0-9_.-]+)\]/gu)];
  return matches.length > 0 ? matches.at(-1)[1] : null;
}

function detectStreamHoldMs(text) {
  if (typeof text !== 'string' || !text.includes('[CHAOS:STREAM_HOLD:')) return 0;
  const matches = [...text.matchAll(/\[CHAOS:STREAM_HOLD:(\d{2,5})\]/gu)];
  if (matches.length === 0) return 0;
  const raw = Number.parseInt(matches.at(-1)[1], 10);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(30_000, Math.max(50, raw));
}

function extractScopeKey(headers, body, promptText) {
  const tagMatch = /\[CHAOS_SCOPE:([A-Za-z0-9_.:-]+)\]/u.exec(promptText);
  if (tagMatch) return tagMatch[1];
  const userId = body?.metadata?.user_id;
  if (typeof userId === 'string' && userId.length > 0) return userId;
  const sessionHeader = extractHeader(headers, 'x-session-id') ?? extractHeader(headers, 'x-kiki-session-id');
  if (sessionHeader) return sessionHeader;
  const firstUserText = promptText.slice(0, 120);
  return createHash('sha256').update(firstUserText).digest('hex').slice(0, 16);
}

function pickWeightedFault(rng, weights) {
  const total = weights.reduce((acc, [, w]) => acc + w, 0);
  let r = rng() * total;
  for (const [kind, w] of weights) {
    r -= w;
    if (r <= 0) return kind;
  }
  return weights[0][0];
}

function planToolCalls({ profile, arg, declaredToolNames, workspaceDir, seq }) {
  const has = (name) => declaredToolNames.has(name);
  const calls = [];
  const push = (name, input) => {
    if (has(name)) {
      calls.push({ id: `toolu_twin_${seq}_${calls.length + 1}`, name, input });
    }
  };

  if (profile === 'WORKSPACE' || profile === 'ALL_MIX') {
    push('Glob', { pattern: 'src/**/*.ts' });
    push('Grep', { pattern: 'CHAOS_TOKEN_', output_mode: 'files_with_matches' });
    push('Read', { path: 'src/mod-001.ts', line_offset: -5, n_lines: 5 });
  }
  if (profile === 'HISTORY' || profile === 'ALL_MIX') {
    push('HistoryList', { kind: 'turns', limit: 5 });
    push('HistorySearch', { query: 'Synthetic', include_tool_output: true, scope: 'workspace' });
    push('HistorySearch', { query: 'peer', scope: 'peer' });
    push('HistoryRead', { turn: 0 });
  }
  if (profile === 'MEMORY_TODO' || profile === 'ALL_MIX') {
    push('TodoList', {
      todos: [
        { title: `Chaos verification batch ${seq}`, status: 'in_progress' },
        { title: 'Collect memory & latency telemetry', status: 'pending' },
      ],
    });
    push('MemorySearch', { mode: 'search', query: 'chaos benchmark' });
  }
  if (profile === 'THREAD' || profile === 'ALL_MIX') {
    push('ThreadList', { limit: 10 });
    if (workspaceDir && profile === 'THREAD') {
      push('ThreadCreate', {
        cwd: workspaceDir,
        prompt: `[CHAOS_SCOPE:thread_child_${seq}] ThreadCreate child probe ${seq}.`,
      });
    }
  }
  if (profile === 'SUBAGENT') {
    push('AgentRun', {
      name: `leaf_${seq}`,
      description: 'Chaos leaf worker',
      prompt: `[CHAOS_SCOPE:sub_leaf_${seq}] [TOOLS:WORKSPACE] Run quick workspace probe and reply ok.`,
      background: true,
    });
    push('AgentList', { include_finished: true });
  }
  if (profile === 'BRANCH') {
    push('Branch', {
      task: `Verify fresh side branch ${seq}`,
      seed: 'fresh',
      title: `Chaos Branch ${seq}`,
      name: `chaos_br_${seq}`,
    });
  }
  if (profile === 'GIANT_HISTORY') {
    push('HistoryList', { kind: 'turns', limit: 10 });
    push('HistoryList', { kind: 'agents', limit: 10 });
    push('HistorySearch', { query: 'Synthetic', include_tool_output: true, scope: 'session' });
    push('HistoryRead', { turn: 0 });
  }
  if (profile === 'AGENT_LIST_10K') {
    push('AgentList', { include_finished: true });
  }
  void arg;
  return calls;
}

function planFollowupToolCalls({ profile, toolResults, declaredToolNames, seq }) {
  const has = (name) => declaredToolNames.has(name);
  const calls = [];
  const combinedResultText = toolResults
    .map((tr) => (typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content ?? '')))
    .join('\n');

  if (profile === 'MEMORY_TODO' && has('MemoryRead')) {
    const idMatch = /"(m_[A-Za-z0-9_]+)"/u.exec(combinedResultText);
    if (idMatch) {
      calls.push({ id: `toolu_twin_${seq}_mr`, name: 'MemoryRead', input: { id: idMatch[1] } });
    }
  }

  if (profile === 'THREAD') {
    const threadMatch = /"session_id"\s*:\s*"([^"]+)"/u.exec(combinedResultText);
    const wsMatch = /"workspace_id"\s*:\s*"([^"]+)"/u.exec(combinedResultText);
    const hostMatch = /"host_id"\s*:\s*"([^"]+)"/u.exec(combinedResultText);
    if (threadMatch && wsMatch && hostMatch) {
      const threadRef = {
        host_id: hostMatch[1],
        workspace_id: wsMatch[1],
        session_id: threadMatch[1],
      };
      if (has('ThreadSend')) {
        calls.push({
          id: `toolu_twin_${seq}_ts`,
          name: 'ThreadSend',
          input: { thread: threadRef, content: `Chaos ThreadSend ping ${seq}` },
        });
      }
      if (has('ThreadRead')) {
        calls.push({
          id: `toolu_twin_${seq}_tr`,
          name: 'ThreadRead',
          input: { thread: threadRef, limit: 5 },
        });
      }
    }
  }

  if (profile === 'SUBAGENT' && has('AgentSend')) {
    const nameMatch = /leaf_\d+/u.exec(combinedResultText);
    if (nameMatch) {
      calls.push({
        id: `toolu_twin_${seq}_as`,
        name: 'AgentSend',
        input: { target: nameMatch[0], message: `Follow-up coordination ping ${seq}` },
      });
    }
  }

  if (profile === 'GIANT_HISTORY' && has('HistoryRead')) {
    const refMatch = /"(h1_[A-Za-z0-9_=-]+)"/u.exec(combinedResultText);
    if (refMatch) {
      calls.push({
        id: `toolu_twin_${seq}_hr_ref`,
        name: 'HistoryRead',
        input: { ref: refMatch[1], max_chars: 2000 },
      });
    }
  }

  return calls;
}

export async function createContractTwinServer(options = {}) {
  const seed = Number.isInteger(options.seed) ? options.seed : 20261120;
  const rng = mulberry32(seed);
  const mode = options.mode ?? 'clean';
  const defaultFaultRate = mode === 'storm' ? 0.4 : mode === 'prod' ? 0.08 : 0;
  const faultRate = typeof options.faultRate === 'number' ? options.faultRate : defaultFaultRate;
  const faultWeights = options.faultWeights ?? DEFAULT_FAULT_WEIGHTS;
  const early413ThresholdBytes = options.early413ThresholdBytes ?? 256 * 1024;
  const requireAuthHeader = options.requireAuthHeader !== false;
  const enableTls = options.enableTls !== false;
  let workspaceDir = options.workspaceDir ?? '';

  const threadStore = new Map();
  const pending413Scopes = new Map();
  const oneShotFaultFired = new Set();
  const scopeToolStep = new Map();
  const scopeAttempts = new Map();
  const scopeAttemptTimestamps = new Map();
  const toolIdToName = new Map();
  const barriers = new Map();
  const tickLoops = new Map();
  const requestTrace = [];
  const violations = [];

  function ensureTickLoop(loopId) {
    let entry = tickLoops.get(loopId);
    if (!entry) {
      entry = {
        id: loopId,
        stopped: false,
        offeredTicks: [],
        consumedTicks: [],
        missedOffers: 0,
        waiter: null,
      };
      tickLoops.set(loopId, entry);
    }
    return entry;
  }

  function waitForNextTick(loopId, res) {
    const entry = ensureTickLoop(loopId);
    if (entry.offeredTicks.length > 0) {
      const tick = entry.offeredTicks.shift();
      entry.consumedTicks.push({ ...tick, consumedAtMs: performance.now() });
      return Promise.resolve(tick);
    }
    if (entry.stopped) return Promise.resolve(null);
    return new Promise((resolve) => {
      const onClose = () => {
        if (res?.writableFinished) return;
        if (entry.waiter === finish) entry.waiter = null;
        resolve(null);
      };
      const finish = (tick) => {
        res?.off?.('close', onClose);
        if (tick) entry.consumedTicks.push({ ...tick, consumedAtMs: performance.now() });
        resolve(tick);
      };
      entry.waiter = finish;
      res?.once?.('close', onClose);
    });
  }

  function ensureBarrier(barrierId) {
    let entry = barriers.get(barrierId);
    if (!entry) {
      let releaseFn;
      const promise = new Promise((resolve) => {
        releaseFn = resolve;
      });
      entry = { promise, releaseFn, released: false, arrived: 0, waiters: [] };
      barriers.set(barrierId, entry);
    }
    return entry;
  }

  function noteBarrierArrival(barrierId) {
    const entry = ensureBarrier(barrierId);
    entry.arrived += 1;
    for (const w of entry.waiters.splice(0)) {
      if (entry.arrived >= w.target) w.resolve(entry.arrived);
      else entry.waiters.push(w);
    }
    return entry;
  }
  const faultsInjected = Object.create(null);
  const toolStats = Object.create(null);
  const counters = {
    totalRequests: 0,
    http1Requests: 0,
    http2Requests: 0,
    anthropicRequests: 0,
    openaiRequests: 0,
    succeededResponses: 0,
    contractViolations: 0,
    threadCreates: 0,
    threadContinues: 0,
    early413Rejected: 0,
    early413VerifiedStripped: 0,
    toolCallsIssued: 0,
    toolResultsReceived: 0,
    toolResultsErrored: 0,
    activeStreams: 0,
    peakActiveStreams: 0,
  };

  let msgSeq = 0;

  function recordToolIssued(name, id) {
    counters.toolCallsIssued += 1;
    toolIdToName.set(id, name);
    if (toolIdToName.size > 20_000) {
      const oldest = toolIdToName.keys().next().value;
      if (oldest) toolIdToName.delete(oldest);
    }
    if (!toolStats[name]) toolStats[name] = { issued: 0, resultsOk: 0, resultsError: 0 };
    toolStats[name].issued += 1;
  }

  function recordToolResults(results) {
    for (const tr of results) {
      counters.toolResultsReceived += 1;
      const name = toolIdToName.get(tr.tool_use_id) ?? 'unknown';
      if (!toolStats[name]) toolStats[name] = { issued: 0, resultsOk: 0, resultsError: 0 };
      const rawText = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content ?? '');
      const rawBytes = Buffer.byteLength(rawText, 'utf8');
      toolStats[name].lastResultBytes = rawBytes;
      toolStats[name].lastResultChars = rawText.length;
      toolStats[name].lastResultLineCount = rawText.length > 0 ? rawText.split('\n').length : 0;
      toolStats[name].lastResultHead = rawText.slice(0, 320);
      toolStats[name].lastResultTail = rawText.length > 320 ? rawText.slice(-240) : '';
      if (name === 'AgentList') {
        const subMatches = rawText.match(/subagent_\d{4,5}/gu);
        toolStats[name].lastSubagentMentionCount = subMatches ? new Set(subMatches).size : 0;
        let parsedCount = null;
        try {
          const parsed = JSON.parse(rawText);
          if (Array.isArray(parsed)) parsedCount = parsed.length;
          else if (Array.isArray(parsed?.agents)) parsedCount = parsed.agents.length;
          else if (Array.isArray(parsed?.children)) parsedCount = parsed.children.length;
        } catch {}
        toolStats[name].lastParsedEntryCount = parsedCount;
        toolStats[name].lastHasOmissionNotice = /\bomitted\b|\btruncated\b|\bfurther\b|\bmore\b/iu.test(rawText);
      }
      if (tr.is_error === true) {
        counters.toolResultsErrored += 1;
        toolStats[name].resultsError += 1;
      } else {
        toolStats[name].resultsOk += 1;
      }
    }
  }

  function recordViolation(status, code, message, details = {}) {
    counters.contractViolations += 1;
    const entry = {
      at: new Date().toISOString(),
      status,
      code,
      message,
      ...details,
    };
    violations.push(entry);
    return entry;
  }

  function sendJson(res, status, payload, extraHeaders = {}) {
    if (res.writableEnded || res.destroyed) return;
    const buf = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(buf.byteLength),
      ...extraHeaders,
    });
    res.end(buf);
  }

  function recordFault(kind) {
    faultsInjected[kind] = (faultsInjected[kind] ?? 0) + 1;
  }

  function selectFault({ promptText, scopeKey, bodyBytes, mediaInfo, isAnthropic }) {
    const tagged = detectTaggedFault(promptText);
    if (tagged) {
      const shotKey = `${scopeKey}:${tagged}`;
      if (tagged === 'soft_safety' || tagged === 'rate_limit_429_no_retry') {
        return tagged;
      }
      if (!oneShotFaultFired.has(shotKey)) {
        oneShotFaultFired.add(shotKey);
        return tagged;
      }
      return null;
    }

    if (faultRate <= 0) return null;
    if (pending413Scopes.has(scopeKey)) return null;
    if (rng() >= faultRate) return null;
    let candidate = pickWeightedFault(rng, faultWeights);
    if (candidate === 'early_413' && mediaInfo.count === 0 && bodyBytes < early413ThresholdBytes) {
      candidate = 'ping_eof';
    }
    if (!isAnthropic && (candidate === 'soft_safety' || candidate === 'malformed_tool')) {
      candidate = 'ping_eof';
    }
    const shotKey = `${scopeKey}:rng:${candidate}`;
    if (oneShotFaultFired.has(shotKey)) return null;
    oneShotFaultFired.add(shotKey);
    return candidate;
  }

  function sendAnthropicToolUse(res, { model, messageId, calls, stream }) {
    for (const c of calls) recordToolIssued(c.name, c.id);
    if (!stream) {
      counters.succeededResponses += 1;
      sendJson(res, 200, {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 64, output_tokens: 32 },
      });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    });
    res.flushHeaders?.();
    res.write(
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 64, output_tokens: 1 },
        },
      })}\n\n`,
    );
    calls.forEach((c, idx) => {
      res.write(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} },
        })}\n\n`,
      );
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) },
        })}\n\n`,
      );
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`);
    });
    res.write(
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 32 },
      })}\n\n`,
    );
    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    counters.succeededResponses += 1;
    res.end();
  }

  async function sendAnthropicSuccess(res, req, { model, replyText, messageId, stream, barrierId, streamHoldMs = 0 }) {
    if (!stream) {
      counters.succeededResponses += 1;
      sendJson(res, 200, {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: replyText }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 48, output_tokens: 16 },
      });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    });
    res.flushHeaders?.();
    const prefixEvents = [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 48, output_tokens: 1 },
          },
        },
      },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${replyText} ` } } },
    ];
    for (const { event, data } of prefixEvents) {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    if (barrierId) {
      const entry = noteBarrierArrival(barrierId);
      if (!entry.released) {
        await Promise.race([
          entry.promise,
          new Promise((resolve) => {
            const onAbort = () => {
              if (!res.writableFinished) resolve();
            };
            res.once('close', onAbort);
            entry.promise.finally(() => res.off('close', onAbort));
          }),
        ]);
      }
    }
    if (streamHoldMs > 0 && !res.writableEnded && !res.destroyed) {
      const deadline = Date.now() + streamHoldMs;
      let aborted = false;
      const onClose = () => {
        if (!res.writableFinished) aborted = true;
      };
      res.once('close', onClose);
      let chunkIndex = 0;
      try {
        while (!aborted && !res.writableEnded && !res.destroyed) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await new Promise((resolve) => {
            const onAbort = () => {
              clearTimeout(t);
              resolve();
            };
            const t = setTimeout(() => {
              res.off('close', onAbort);
              resolve();
            }, Math.min(120, remaining));
            res.once('close', onAbort);
          });
          if (aborted || res.writableEnded || res.destroyed) break;
          chunkIndex += 1;
          res.write(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: `tok${chunkIndex} ` },
            })}\n\n`,
          );
        }
      } finally {
        res.off('close', onClose);
      }
    }
    if (res.writableEnded || res.destroyed) return;
    const suffixEvents = [
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '[stream-complete]' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 16 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ];
    for (const { event, data } of suffixEvents) {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    counters.succeededResponses += 1;
    res.end();
  }

  function sendOpenAiSuccess(res, { isResponsesApi, model, replyText, messageId, stream }) {
    if (!stream) {
      counters.succeededResponses += 1;
      if (isResponsesApi) {
        sendJson(res, 200, {
          id: messageId,
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: replyText }] }],
          usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52 },
        });
      } else {
        sendJson(res, 200, {
          id: messageId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
        });
      }
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    });
    res.flushHeaders?.();
    if (isResponsesApi) {
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: replyText })}\n\n`);
      res.end(
        `event: response.completed\ndata: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: messageId,
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: replyText }] }],
            usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52 },
          },
        })}\n\n`,
      );
    } else {
      res.write(
        `data: ${JSON.stringify({
          id: messageId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { role: 'assistant', content: replyText }, finish_reason: null }],
        })}\n\n`,
      );
      res.end(
        `data: ${JSON.stringify({
          id: messageId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
        })}\n\ndata: [DONE]\n\n`,
      );
    }
    counters.succeededResponses += 1;
  }

  async function injectFaultResponse(req, res, { faultKind, isAnthropic, isResponsesApi, model, messageId, scopeKey, bodyBytes, mediaInfo }) {
    recordFault(faultKind);
    if (faultKind === 'early_413') {
      counters.early413Rejected += 1;
      pending413Scopes.set(scopeKey, {
        originalBytes: bodyBytes,
        originalMediaChars: mediaInfo.totalChars,
        originalMediaCount: mediaInfo.count,
        degradeAttempts: 0,
        at: Date.now(),
      });
      sendJson(res, 413, {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'request_body_too_large',
          message: 'Request entity too large; reduce or strip media attachments.',
        },
      });
      return;
    }

    if (faultKind === 'rate_limit_429') {
      sendJson(
        res,
        429,
        {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
            message: 'Rate limit exceeded (synthetic twin injection)',
          },
        },
        { 'retry-after': '0' },
      );
      return;
    }

    if (faultKind === 'rate_limit_429_retry_after') {
      sendJson(
        res,
        429,
        {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
            message: 'Synchronized 429 burst with Retry-After and x-should-retry: true',
          },
        },
        { 'retry-after': '1', 'x-should-retry': 'true' },
      );
      return;
    }

    if (faultKind === 'rate_limit_429_no_retry') {
      sendJson(
        res,
        429,
        {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
            message: 'Upstream 429 with explicit HTTP x-should-retry: false veto header',
          },
        },
        { 'retry-after': '5', 'x-should-retry': 'false' },
      );
      return;
    }

    if (faultKind === 'gateway_524') {
      sendJson(
        res,
        524,
        {
          type: 'error',
          error: {
            type: 'server_error',
            code: 'gateway_timeout_524',
            message: 'Cloudflare origin timeout (524) — retryable upstream stall',
          },
        },
        { 'x-should-retry': 'true' },
      );
      return;
    }

    if (faultKind === 'thread_lost') {
      sendJson(res, 400, {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'thread_not_found',
          details: { error_code: 'thread_not_found' },
          message: 'Previous message thread expired on upstream gateway.',
        },
      });
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    });
    res.flushHeaders?.();

    if (faultKind === 'ping_eof') {
      if (isAnthropic) {
        res.write(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`);
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } },
          })}\n\n`,
        );
      } else {
        res.write(': ping\n\n');
      }
      await new Promise((r) => setTimeout(r, 5));
      if (res.stream && typeof res.stream.close === 'function') {
        res.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      } else {
        res.socket?.destroy();
      }
      return;
    }

    if (faultKind === 'ping_error') {
      res.write(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`);
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } },
        })}\n\n`,
      );
      res.write(
        `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: {
            type: 'overloaded_error',
            code: 'overloaded_error',
            message: 'Upstream gateway overloaded immediately after ping',
          },
        })}\n\n`,
      );
      res.end();
      return;
    }

    if (faultKind === 'soft_safety') {
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } },
        })}\n\n`,
      );
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: "This request was blocked by Gemini's filters. Please review https://policies.google.com/terms/generative-ai/use-policy for more information.",
          },
        })}\n\n`,
      );
      res.write(
        `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            code: 'antigravity_soft_safety_stream_cut',
            retryable: false,
            message: "This request was blocked by Gemini's filters (generative-ai/use-policy)",
          },
        })}\n\n`,
      );
      res.end();
      return;
    }

    if (faultKind === 'malformed_tool') {
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } },
        })}\n\n`,
      );
      res.write(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: `toolu_broken_${msgSeq}`, name: 'Read', input: {} },
        })}\n\n`,
      );
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path": "/tmp/unterminated' },
        })}\n\n`,
      );
      res.write(
        `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            code: 'antigravity_malformed_function_call',
            message: 'Upstream emitted malformed function call JSON',
          },
        })}\n\n`,
      );
      res.end();
      return;
    }

    if (faultKind === 'mid_stream_eof') {
      if (isAnthropic) {
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } },
          })}\n\n`,
        );
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
        res.write(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Partial output before abrupt mid-stream disconnect...' },
          })}\n\n`,
        );
      } else if (isResponsesApi) {
        res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Partial output before abrupt disconnect...' })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ id: messageId, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Partial output...' }, finish_reason: null }] })}\n\n`);
      }
      await new Promise((r) => setTimeout(r, 8));
      if (res.stream && typeof res.stream.close === 'function') {
        res.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      } else {
        res.socket?.destroy();
      }
      return;
    }

    if (faultKind === 'slow_drip') {
      res.write(': slow-drip-start\n\n');
      await new Promise((resolve) => {
        const onAbort = () => {
          if (res.writableFinished) return;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          res.off('close', onAbort);
          resolve();
        }, 60);
        res.once('close', onAbort);
      });
      if (!res.writableEnded && !res.destroyed) {
        await sendAnthropicSuccess(res, req, { model, replyText: 'Recovered after slow drip.', messageId, stream: true, barrierId: null });
      }
    }
  }

  function handleRequest(req, res) {
    counters.totalRequests += 1;
    if (req.httpVersionMajor >= 2) counters.http2Requests += 1;
    else counters.http1Requests += 1;

    const urlPath = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && (urlPath === '/v1/models' || urlPath === '/models')) {
      sendJson(res, 200, {
        object: 'list',
        data: [
          { id: 'twin-anthropic', object: 'model' },
          { id: 'twin-openai', object: 'model' },
        ],
      });
      return;
    }

    if (req.method === 'GET' && urlPath === '/healthz') {
      sendJson(res, 200, { ok: true, counters });
      return;
    }

    const authHeader = extractHeader(req.headers, 'authorization') ?? extractHeader(req.headers, 'x-api-key');
    if (requireAuthHeader && (!authHeader || authHeader.trim().length === 0)) {
      const v = recordViolation(401, 'missing_auth_header', 'Missing Authorization or x-api-key header', { urlPath });
      sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', code: v.code, message: v.message } });
      return;
    }

    const contentLengthHeader = Number(extractHeader(req.headers, 'content-length') ?? '0');
    const isAnthropic = urlPath.includes('/messages');
    const isResponsesApi = urlPath.includes('/responses');

    const chunks = [];
    let earlyRejected = false;

    const maybeEarly413HeaderCheck = extractHeader(req.headers, 'x-chaos-force-early-413') === '1';
    if (maybeEarly413HeaderCheck && contentLengthHeader >= early413ThresholdBytes) {
      earlyRejected = true;
      const scopeKey = extractHeader(req.headers, 'x-chaos-scope') ?? `cl-${contentLengthHeader}`;
      counters.early413Rejected += 1;
      recordFault('early_413');
      pending413Scopes.set(scopeKey, {
        originalBytes: contentLengthHeader,
        originalMediaChars: contentLengthHeader,
        originalMediaCount: 1,
        at: Date.now(),
      });
      sendJson(res, 413, {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'request_body_too_large',
          message: 'Early 413 rejection before body upload completed',
        },
      });
      req.resume();
      return;
    }

    req.on('data', (chunk) => {
      if (earlyRejected) return;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on('end', () => {
      if (earlyRejected) return;
      void (async () => {
        counters.activeStreams += 1;
        if (counters.activeStreams > counters.peakActiveStreams) {
          counters.peakActiveStreams = counters.activeStreams;
        }
        try {
          const rawBuf = Buffer.concat(chunks);
          const bodyBytes = rawBuf.byteLength;
          let body;
          try {
            body = JSON.parse(rawBuf.toString('utf8'));
          } catch {
            const v = recordViolation(400, 'invalid_json', 'Request body is not valid JSON', { urlPath, bodyBytes });
            sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', code: v.code, message: v.message } });
            return;
          }

          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            const v = recordViolation(400, 'invalid_body_object', 'Request body must be a JSON object', { urlPath });
            sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', code: v.code, message: v.message } });
            return;
          }

          if (typeof body.model !== 'string' || body.model.trim().length === 0) {
            const v = recordViolation(422, 'missing_model', 'Request JSON missing non-empty string field "model"', { urlPath });
            sendJson(res, 422, { type: 'error', error: { type: 'invalid_request_error', code: v.code, message: v.message } });
            return;
          }

          const llmModelHeader = extractHeader(req.headers, 'x-llm-model');
          if (llmModelHeader !== undefined && llmModelHeader.trim() !== '' && llmModelHeader.trim() !== body.model) {
            const v = recordViolation(
              422,
              'x_llm_model_mismatch',
              `X-LLM-Model header "${llmModelHeader}" does not match body.model "${body.model}"`,
              { header: llmModelHeader, model: body.model },
            );
            sendJson(res, 422, { type: 'error', error: { type: 'invalid_request_error', code: v.code, message: v.message } });
            return;
          }

          const promptText = extractAllPromptText(body);
          const scopeKey = extractScopeKey(req.headers, body, promptText);
          scopeAttempts.set(scopeKey, (scopeAttempts.get(scopeKey) ?? 0) + 1);
          const tsList = scopeAttemptTimestamps.get(scopeKey) ?? [];
          tsList.push(Date.now());
          scopeAttemptTimestamps.set(scopeKey, tsList);
          const mediaInfo = countMediaBlocks(body);

          const pending413 = pending413Scopes.get(scopeKey);
          if (pending413) {
            const shrankBytes = bodyBytes < pending413.originalBytes;
            const shrankMedia = mediaInfo.totalChars < pending413.originalMediaChars || mediaInfo.count < pending413.originalMediaCount;
            if (!shrankBytes && !shrankMedia) {
              if (body.thread !== undefined && pending413.degradeAttempts === 0) {
                pending413.degradeAttempts = 1;
                counters.early413Rejected += 1;
                sendJson(res, 413, {
                  type: 'error',
                  error: {
                    type: 'invalid_request_error',
                    code: 'request_body_too_large',
                    message: 'Request still too large after media degrade; strip media attachments.',
                  },
                });
                return;
              }
              const v = recordViolation(
                422,
                'post_413_payload_not_reduced',
                `Retry after 413 did not reduce payload (${bodyBytes} >= ${pending413.originalBytes} bytes, mediaChars ${mediaInfo.totalChars} >= ${pending413.originalMediaChars})`,
                { scopeKey, bodyBytes, previousBytes: pending413.originalBytes },
              );
              sendJson(res, 422, { type: 'error', error: { type: 'invalid_request_error', code: v.code, message: v.message } });
              return;
            }
            pending413Scopes.delete(scopeKey);
            counters.early413VerifiedStripped += 1;
          }

          if (isAnthropic) {
            counters.anthropicRequests += 1;
            if (!Array.isArray(body.messages) || body.messages.length === 0) {
              const v = recordViolation(422, 'invalid_messages', 'Anthropic request must include a non-empty messages array', { urlPath });
              sendJson(res, 422, { type: 'error', error: { type: 'invalid_request_error', code: v.code, message: v.message } });
              return;
            }
            if (typeof body.max_tokens !== 'number' || !Number.isInteger(body.max_tokens) || body.max_tokens <= 0) {
              const v = recordViolation(422, 'invalid_max_tokens', 'Anthropic request requires positive integer max_tokens', { max_tokens: body.max_tokens });
              sendJson(res, 422, { type: 'error', error: { type: 'invalid_request_error', code: v.code, message: v.message } });
              return;
            }

            const cacheControlCount = countCacheControlBreakpoints({
              system: body.system,
              tools: body.tools,
              messages: body.messages,
            });
            if (cacheControlCount > MAX_CACHE_CONTROL_BREAKPOINTS) {
              const v = recordViolation(
                400,
                'cache_control_limit_exceeded',
                `cache_control breakpoints (${cacheControlCount}) exceeded Anthropic hard limit of ${MAX_CACHE_CONTROL_BREAKPOINTS}`,
                { cacheControlCount },
              );
              sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', code: v.code, message: v.message } });
              return;
            }

            const betaTokens = parseBetaTokens(extractHeader(req.headers, 'anthropic-beta'), body.betas);
            let effectiveMessages = body.messages;
            let effectiveTools = Array.isArray(body.tools) ? body.tools : [];
            if (body.thread !== undefined || betaTokens.has(ANTHROPIC_THREADS_BETA)) {
              if (!body.thread || typeof body.thread !== 'object') {
                const v = recordViolation(422, 'missing_thread_param', `Header ${ANTHROPIC_THREADS_BETA} sent without valid body.thread object`);
                sendJson(res, 422, { type: 'error', error: { type: 'invalid_request_error', code: v.code, message: v.message } });
                return;
              }
              if (body.thread.type === 'create') {
                counters.threadCreates += 1;
                effectiveMessages = body.messages;
              } else if (body.thread.type === 'continue') {
                counters.threadContinues += 1;
                const prevId = body.thread.previous_message_id;
                if (typeof prevId !== 'string' || prevId.length === 0) {
                  const v = recordViolation(422, 'invalid_previous_message_id', 'thread.continue missing previous_message_id');
                  sendJson(res, 422, { type: 'error', error: { type: 'invalid_request_error', code: v.code, message: v.message } });
                  return;
                }
                const prevThread = threadStore.get(prevId);
                if (!prevThread) {
                  const v = recordViolation(400, 'thread_not_found', `thread.continue references unknown previous_message_id "${prevId}"`, { prevId });
                  sendJson(res, 400, {
                    type: 'error',
                    error: {
                      type: 'invalid_request_error',
                      code: 'thread_not_found',
                      details: { error_code: 'thread_not_found' },
                      message: v.message,
                    },
                  });
                  return;
                }
                effectiveMessages = [...prevThread.messages, ...body.messages];
                if (effectiveTools.length === 0 && Array.isArray(prevThread.tools)) {
                  effectiveTools = prevThread.tools;
                }
              } else {
                const v = recordViolation(422, 'invalid_thread_type', `Unsupported thread.type "${String(body.thread.type)}"`);
                sendJson(res, 422, { type: 'error', error: { type: 'invalid_request_error', code: v.code, message: v.message } });
                return;
              }
            }

            const pairingError = validateAnthropicToolPairing(effectiveMessages);
            if (pairingError) {
              const v = recordViolation(400, 'tool_pairing_violation', pairingError, { urlPath });
              sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', code: v.code, message: v.message } });
              return;
            }

            const latestUser = extractLatestUserMessage(effectiveMessages);
            if (latestUser.toolResults.length > 0) {
              recordToolResults(latestUser.toolResults);
            }

            msgSeq += 1;
            const messageId = `msg_twin_${String(msgSeq).padStart(6, '0')}`;
            const faultKind = selectFault({ promptText, scopeKey, bodyBytes, mediaInfo, isAnthropic: true });
            if (faultKind) {
              await injectFaultResponse(req, res, {
                faultKind,
                isAnthropic: true,
                isResponsesApi: false,
                model: body.model,
                messageId,
                scopeKey,
                bodyBytes,
                mediaInfo,
              });
              return;
            }

            const effectivePromptText = extractAllPromptText({ messages: effectiveMessages });
            const latestTurn = extractLatestTurnPrompt(effectiveMessages);
            const effectiveScopeKey = extractScopeKey(
              req.headers,
              { messages: effectiveMessages },
              latestTurn.text || effectivePromptText || promptText,
            );
            const toolSpec = detectToolProfile(effectivePromptText || promptText);
            const s10Directive = detectS10Directive(latestTurn.text || effectivePromptText || promptText);
            const v23Plan = detectV23ToolPlan(latestTurn.text);
            const coupledTickLoop = detectCoupledTickLoop(latestTurn.text);
            const declaredToolNames = new Set(
              effectiveTools.map((t) => (t && typeof t === 'object' ? t.name : null)).filter(Boolean),
            );
            const prevStep = scopeToolStep.get(effectiveScopeKey) ?? 0;

            if (requestTrace.length >= 20_000) {
              requestTrace.shift();
            }
            requestTrace.push({
                seq: msgSeq,
                messageId,
                receivedAtMonotonicMs: performance.now(),
                receivedAtWallMs: Date.now(),
                scopeKey: effectiveScopeKey,
                turnToolRound: latestTurn.turnToolRound,
                hasToolResults: latestUser.toolResults.length > 0,
                latestUserText: latestUser.text.slice(0, 600),
                latestTurnText: latestTurn.text.slice(0, 600),
                systemPromptSnippet: extractSystemPromptSnippet(body),
              });

            if (coupledTickLoop !== null) {
              const tick =
                latestTurn.turnToolRound < coupledTickLoop.maxSteps
                  ? await waitForNextTick(coupledTickLoop.id, res)
                  : null;
              if (tick !== null) {
                const tickToolName = declaredToolNames.has('Read')
                  ? 'Read'
                  : declaredToolNames.has('Glob')
                    ? 'Glob'
                    : declaredToolNames.has('TodoList')
                      ? 'TodoList'
                      : null;
                if (tickToolName) {
                  const callId = `coupled_tick_${coupledTickLoop.id}_${tick.seq}_${msgSeq}`;
                  const modIdx = String(((tick.seq - 1) % 120) + 1).padStart(3, '0');
                  const toolInput =
                    tickToolName === 'Read'
                      ? { path: `src/mod-${modIdx}.ts`, line_offset: 1, n_lines: 4 }
                      : tickToolName === 'Glob'
                        ? { pattern: `src/mod-${modIdx}.ts` }
                        : { todos: [{ title: `Coupled tick ${tick.seq}`, status: 'in_progress' }] };
                  toolIdToName.set(callId, tickToolName);
                  if (!toolStats[tickToolName]) toolStats[tickToolName] = { invoked: 0, resultsOk: 0, resultsError: 0 };
                  toolStats[tickToolName].invoked += 1;
                  const calls = [{ id: callId, name: tickToolName, input: toolInput }];
                  threadStore.set(messageId, {
                    messages: [
                      ...effectiveMessages,
                      {
                        role: 'assistant',
                        content: [
                          { type: 'text', text: `[COUPLED_TICK:${String(tick.seq).padStart(4, '0')}]` },
                          { type: 'tool_use', id: callId, name: tickToolName, input: toolInput },
                        ],
                      },
                    ],
                    tools: effectiveTools,
                    createdAt: Date.now(),
                  });
                  await streamPacedAnthropicResponse(res, req, {
                    model: body.model,
                    messageId,
                    replyText: `[COUPLED_TICK:${String(tick.seq).padStart(4, '0')}] live stream step`,
                    toolCalls: calls,
                    targetDeltas: 3,
                    cadenceMs: 2,
                  });
                  return;
                }
              }
              const doneText = `COUPLED_TICK_LOOP_DONE [${coupledTickLoop.id}] steps=${latestTurn.turnToolRound}`;
              threadStore.set(messageId, {
                messages: [...effectiveMessages, { role: 'assistant', content: [{ type: 'text', text: doneText }] }],
                tools: effectiveTools,
                createdAt: Date.now(),
              });
              await streamPacedAnthropicResponse(res, req, {
                model: body.model,
                messageId,
                replyText: doneText,
                targetDeltas: 3,
                cadenceMs: 2,
              });
              return;
            }

            if (v23Plan !== null) {
              const lastToolText = extractToolResultText(latestUser.toolResults);
              const taskIdMatch =
                /\btask_id["':\s=]+([A-Za-z0-9_-]+)/u.exec(lastToolText) ??
                /\b(bash_[A-Za-z0-9_-]+|agent_[A-Za-z0-9_-]+)\b/u.exec(lastToolText);
              const branchIdMatch =
                /\bbranch_id["':\s=]+([A-Za-z0-9_-]+)/u.exec(lastToolText) ??
                /\b(branch_[A-Za-z0-9_-]+)\b/u.exec(lastToolText);
              const interpCtx = {
                lastToolText,
                lastTaskId: taskIdMatch?.[1] ?? '',
                lastBranchId: branchIdMatch?.[1] ?? '',
              };
              const step = v23Plan.steps[latestTurn.turnToolRound];
              if (step && Array.isArray(step.calls) && step.calls.length > 0) {
                const needed = step.calls.map((c) => c.name);
                const preflight = checkRequiredToolSchemas(declaredToolNames, needed);
                if (!preflight.ok) {
                  const v = recordViolation(
                    422,
                    'missing_required_tool_schema',
                    `V23_TOOL_PLAN missing required tools: ${preflight.missing.join(', ')}`,
                    { missing: preflight.missing },
                  );
                  sendJson(res, 422, { type: 'error', error: { type: 'invalid_request_error', code: v.code, message: v.message } });
                  return;
                }
                const calls = step.calls.map((c, ci) => {
                  const callId = `v23_${msgSeq}_s${latestTurn.turnToolRound}_c${ci}`;
                  toolIdToName.set(callId, c.name);
                  if (!toolStats[c.name]) toolStats[c.name] = { invoked: 0, resultsOk: 0, resultsError: 0 };
                  toolStats[c.name].invoked += 1;
                  return {
                    id: callId,
                    name: c.name,
                    input: interpolatePlanValue(c.input ?? {}, interpCtx),
                  };
                });
                threadStore.set(messageId, {
                  messages: [
                    ...effectiveMessages,
                    {
                      role: 'assistant',
                      content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
                    },
                  ],
                  tools: effectiveTools,
                  createdAt: Date.now(),
                });
                if (step.barrierId) {
                  const bEntry = noteBarrierArrival(step.barrierId);
                  if (!bEntry.released) {
                    await Promise.race([
                      bEntry.promise,
                      new Promise((resolve) => {
                        const onAbort = () => {
                          if (!res.writableFinished) resolve();
                        };
                        res.once('close', onAbort);
                        bEntry.promise.finally(() => res.off('close', onAbort));
                      }),
                    ]);
                  }
                }
                await streamPacedAnthropicResponse(res, req, {
                  model: body.model,
                  messageId,
                  thinkingText: step.thinking ?? `Executing v2.3 plan step ${latestTurn.turnToolRound}.`,
                  toolCalls: calls,
                  targetDeltas: Math.max(4, Number(step.deltas ?? 8)),
                  cadenceMs: Math.max(2, Number(step.cadenceMs ?? 5)),
                });
                return;
              }
              const finalText = interpolatePlanValue(v23Plan.finalText ?? `V23_PLAN_DONE [${messageId}]`, interpCtx);
              threadStore.set(messageId, {
                messages: [...effectiveMessages, { role: 'assistant', content: [{ type: 'text', text: finalText }] }],
                tools: effectiveTools,
                createdAt: Date.now(),
              });
              await streamPacedAnthropicResponse(res, req, {
                model: body.model,
                messageId,
                replyText: finalText,
                targetDeltas: 6,
                cadenceMs: 5,
              });
              return;
            }

            if (latestTurn.text.includes("Drain this session's committed outbox.")) {
              if (latestTurn.turnToolRound === 0) {
                const preflight = checkRequiredToolSchemas(declaredToolNames, ['Read', 'ThreadSend']);
                if (!preflight.ok) {
                  const v = recordViolation(
                    422,
                    'missing_required_tool_schema',
                    `Cron outbox drain missing required tools: ${preflight.missing.join(', ')}`,
                    { missing: preflight.missing },
                  );
                  sendJson(res, 422, { type: 'error', error: { type: 'invalid_request_error', code: v.code, message: v.message } });
                  return;
                }
                const callId = `v23_cron_read_${msgSeq}`;
                toolIdToName.set(callId, 'Read');
                if (!toolStats.Read) toolStats.Read = { invoked: 0, resultsOk: 0, resultsError: 0 };
                toolStats.Read.invoked += 1;
                const calls = [{ id: callId, name: 'Read', input: { path: '.kiki-s11-outbox.json' } }];
                threadStore.set(messageId, {
                  messages: [...effectiveMessages, { role: 'assistant', content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })) }],
                  tools: effectiveTools,
                  createdAt: Date.now(),
                });
                await streamPacedAnthropicResponse(res, req, {
                  model: body.model,
                  messageId,
                  thinkingText: 'Reading persisted outbox file before sending.',
                  toolCalls: calls,
                  targetDeltas: 6,
                  cadenceMs: 5,
                });
                return;
              }
              if (latestTurn.turnToolRound === 1) {
                const rawToolOut = stripReadLinePrefixes(extractToolResultText(latestUser.toolResults));
                let outbox = null;
                try {
                  outbox = JSON.parse(rawToolOut);
                } catch {
                  const jm = /\{[\s\S]*\}/u.exec(rawToolOut);
                  if (jm) outbox = JSON.parse(jm[0]);
                }
                if (!outbox?.toWorkspaceId || !outbox?.toSessionId || !outbox?.idempotencyKey) {
                  const finalText = `CRON_OUTBOX_PARSE_ERROR: ${rawToolOut.slice(0, 200)}`;
                  threadStore.set(messageId, {
                    messages: [...effectiveMessages, { role: 'assistant', content: [{ type: 'text', text: finalText }] }],
                    tools: effectiveTools,
                    createdAt: Date.now(),
                  });
                  await streamPacedAnthropicResponse(res, req, { model: body.model, messageId, replyText: finalText, targetDeltas: 4, cadenceMs: 5 });
                  return;
                }
                const callId = `v23_cron_send_${msgSeq}`;
                toolIdToName.set(callId, 'ThreadSend');
                if (!toolStats.ThreadSend) toolStats.ThreadSend = { invoked: 0, resultsOk: 0, resultsError: 0 };
                toolStats.ThreadSend.invoked += 1;
                const calls = [
                  {
                    id: callId,
                    name: 'ThreadSend',
                    input: {
                      thread: { workspace_id: outbox.toWorkspaceId, session_id: outbox.toSessionId },
                      content: String(outbox.payloadText ?? ''),
                      idempotency_key: String(outbox.idempotencyKey),
                    },
                  },
                ];
                threadStore.set(messageId, {
                  messages: [...effectiveMessages, { role: 'assistant', content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })) }],
                  tools: effectiveTools,
                  createdAt: Date.now(),
                });
                await streamPacedAnthropicResponse(res, req, {
                  model: body.model,
                  messageId,
                  thinkingText: 'Delivering persisted outbox intent via ThreadSend.',
                  toolCalls: calls,
                  targetDeltas: 6,
                  cadenceMs: 5,
                });
                return;
              }
              const finalText = `CRON_OUTBOX_DRAINED [${messageId}]`;
              threadStore.set(messageId, {
                messages: [...effectiveMessages, { role: 'assistant', content: [{ type: 'text', text: finalText }] }],
                tools: effectiveTools,
                createdAt: Date.now(),
              });
              await streamPacedAnthropicResponse(res, req, { model: body.model, messageId, replyText: finalText, targetDeltas: 4, cadenceMs: 5 });
              return;
            }

            if (s10Directive?.kind === 'orchestrator_storm' && latestUser.toolResults.length === 0 && prevStep === 0) {
              const preflight = checkRequiredToolSchemas(declaredToolNames, REQUIRED_ORCHESTRATOR_TOOLS);
              if (!preflight.ok) {
                const v = recordViolation(
                  422,
                  'missing_required_tool_schema',
                  `S10 orchestrator missing required tools: ${preflight.missing.join(', ')}`,
                  { missing: preflight.missing },
                );
                sendJson(res, 422, { type: 'error', error: { type: 'invalid_request_error', code: v.code, message: v.message } });
                return;
              }
              scopeToolStep.set(effectiveScopeKey, 1);
              const astScriptMatch = /astScript=([^\s]+)/u.exec(promptText);
              const astTargetMatch = /astTargetDir=([^\s]+)/u.exec(promptText);
              const astScript = (astScriptMatch?.[1] ?? '').replace(/\.$/u, '');
              const astTargetDir = (astTargetMatch?.[1] ?? '').replace(/\.$/u, '');
              const calls = [];
              for (let c = 0; c < s10Directive.children; c += 1) {
                const needle = `NEEDLE_${String(c).padStart(4, '0')}`;
                const bucket = `mod_${String(c % 20).padStart(2, '0')}`;
                const targetFile = `s10-src/${bucket}/unit_${String(c).padStart(4, '0')}.ts`;
                const childPrompt = [
                  `[CHAOS_SCOPE:s10_child_${s10Directive.runId}_${c}]`,
                  `[S10_CHILD:idx=${c},steps=${s10Directive.steps},deltas=${s10Directive.deltasPerStep},cadenceMs=${s10Directive.cadenceMs},runId=${s10Directive.runId},needle=${needle},targetFile=${targetFile},astScript=${astScript},astTargetDir=${astTargetDir}]`,
                  `Execute real 6-stage tool workload for child ${c} on ${targetFile}.`,
                ].join(' ');
                const callId = `s10_orch_${s10Directive.runId}_c${c}_${msgSeq}`;
                toolIdToName.set(callId, 'AgentRun');
                if (!toolStats.AgentRun) toolStats.AgentRun = { invoked: 0, resultsOk: 0, resultsError: 0 };
                toolStats.AgentRun.invoked += 1;
                const safeWaveRun = String(s10Directive.runId ?? 's10').replace(/[^a-z0-9_]/giu, '_').toLowerCase();
                calls.push({
                  id: callId,
                  name: 'AgentRun',
                  input: {
                    profile: 'general',
                    model_alias: 'twin-anthropic',
                    effort: 'high',
                    name: `s10_${safeWaveRun}_${c}`,
                    description: `S10 live workload child ${c}`,
                    background: true,
                    prompt: childPrompt,
                  },
                });
              }
              threadStore.set(messageId, {
                messages: [
                  ...effectiveMessages,
                  {
                    role: 'assistant',
                    content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
                  },
                ],
                tools: effectiveTools,
                createdAt: Date.now(),
              });
              await streamPacedAnthropicResponse(res, req, {
                model: body.model,
                messageId,
                thinkingText: `Orchestrating ${calls.length} concurrent native background AgentRun workers for S10 run ${s10Directive.runId}.`,
                toolCalls: calls,
                targetDeltas: Math.min(80, s10Directive.deltasPerStep),
                cadenceMs: s10Directive.cadenceMs,
              });
              return;
            }

            if (s10Directive?.kind === 'child_chain') {
              const preflight = checkRequiredToolSchemas(declaredToolNames, REQUIRED_CHILD_CHAIN_TOOLS);
              if (!preflight.ok) {
                const v = recordViolation(
                  422,
                  'missing_required_tool_schema',
                  `S10 child missing required tools: ${preflight.missing.join(', ')}`,
                  { missing: preflight.missing },
                );
                sendJson(res, 422, { type: 'error', error: { type: 'invalid_request_error', code: v.code, message: v.message } });
                return;
              }
              const plannedStep = planS10ChildStep({
                directive: s10Directive,
                stepIndex: prevStep,
                toolResults: latestUser.toolResults,
                declaredToolNames,
                workspaceDir,
                seq: msgSeq,
              });
              scopeToolStep.set(effectiveScopeKey, prevStep + 1);
              if (plannedStep.calls.length > 0) {
                for (const c of plannedStep.calls) {
                  toolIdToName.set(c.id, c.name);
                  if (!toolStats[c.name]) toolStats[c.name] = { invoked: 0, resultsOk: 0, resultsError: 0 };
                  toolStats[c.name].invoked += 1;
                }
                threadStore.set(messageId, {
                  messages: [
                    ...effectiveMessages,
                    {
                      role: 'assistant',
                      content: plannedStep.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
                    },
                  ],
                  tools: effectiveTools,
                  createdAt: Date.now(),
                });
                await streamPacedAnthropicResponse(res, req, {
                  model: body.model,
                  messageId,
                  thinkingText: plannedStep.thinking,
                  toolCalls: plannedStep.calls,
                  targetDeltas: s10Directive.deltasPerStep,
                  cadenceMs: s10Directive.cadenceMs,
                });
                return;
              }
              const finalText = plannedStep.replyText ?? `S10_CHILD_DONE [${messageId}]`;
              threadStore.set(messageId, {
                messages: [...effectiveMessages, { role: 'assistant', content: [{ type: 'text', text: finalText }] }],
                tools: effectiveTools,
                createdAt: Date.now(),
              });
              await streamPacedAnthropicResponse(res, req, {
                model: body.model,
                messageId,
                thinkingText: plannedStep.thinking,
                replyText: finalText,
                targetDeltas: s10Directive.deltasPerStep,
                cadenceMs: s10Directive.cadenceMs,
              });
              return;
            }

            if (toolSpec && declaredToolNames.size > 0 && latestUser.toolResults.length === 0 && prevStep === 0) {
              const planned = planToolCalls({
                profile: toolSpec.profile,
                arg: toolSpec.arg,
                declaredToolNames,
                workspaceDir,
                seq: msgSeq,
              });
              if (planned.length > 0) {
                scopeToolStep.set(scopeKey, 1);
                threadStore.set(messageId, {
                  messages: [
                    ...effectiveMessages,
                    {
                      role: 'assistant',
                      content: planned.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
                    },
                  ],
                  tools: effectiveTools,
                  createdAt: Date.now(),
                });
                sendAnthropicToolUse(res, { model: body.model, messageId, calls: planned, stream: body.stream !== false });
                return;
              }
            } else if (toolSpec && declaredToolNames.size > 0 && latestUser.toolResults.length > 0 && prevStep === 1) {
              const followups = planFollowupToolCalls({
                profile: toolSpec.profile,
                toolResults: latestUser.toolResults,
                declaredToolNames,
                seq: msgSeq,
              });
              if (followups.length > 0) {
                scopeToolStep.set(scopeKey, 2);
                threadStore.set(messageId, {
                  messages: [
                    ...effectiveMessages,
                    {
                      role: 'assistant',
                      content: followups.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
                    },
                  ],
                  tools: effectiveTools,
                  createdAt: Date.now(),
                });
                sendAnthropicToolUse(res, { model: body.model, messageId, calls: followups, stream: body.stream !== false });
                return;
              }
            }

            const replyText = `Twin OK [${messageId}]`;
            const barrierId = detectBarrierId(promptText);
            const streamHoldMs = detectStreamHoldMs(latestUser.text);
            threadStore.set(messageId, {
              messages: [...effectiveMessages, { role: 'assistant', content: [{ type: 'text', text: replyText }] }],
              tools: effectiveTools,
              createdAt: Date.now(),
            });
            if (threadStore.size > 4096) {
              const oldest = threadStore.keys().next().value;
              if (oldest) threadStore.delete(oldest);
            }
            await sendAnthropicSuccess(res, req, {
              model: body.model,
              replyText,
              messageId,
              stream: body.stream !== false,
              barrierId,
              streamHoldMs,
            });
            return;
          }

          counters.openaiRequests += 1;
          if (!isResponsesApi && (!Array.isArray(body.messages) || body.messages.length === 0)) {
            const v = recordViolation(422, 'invalid_openai_messages', 'OpenAI chat completions request missing non-empty messages array', { urlPath });
            sendJson(res, 422, { error: { type: 'invalid_request_error', code: v.code, message: v.message } });
            return;
          }
          msgSeq += 1;
          const messageId = `resp_twin_${String(msgSeq).padStart(6, '0')}`;
          const faultKind = selectFault({ promptText, scopeKey, bodyBytes, mediaInfo, isAnthropic: false });
          if (faultKind) {
            await injectFaultResponse(req, res, {
              faultKind,
              isAnthropic: false,
              isResponsesApi,
              model: body.model,
              messageId,
              scopeKey,
              bodyBytes,
              mediaInfo,
            });
            return;
          }
          sendOpenAiSuccess(res, {
            isResponsesApi,
            model: body.model,
            replyText: `Twin OK [${messageId}]`,
            messageId,
            stream: body.stream !== false,
          });
        } finally {
          counters.activeStreams = Math.max(0, counters.activeStreams - 1);
        }
      })();
    });
  }

  const httpServer = http.createServer(handleRequest);
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const httpAddr = httpServer.address();
  const httpPort = typeof httpAddr === 'object' && httpAddr ? httpAddr.port : 0;

  let h2Server = null;
  let h2Port = null;
  let tlsCert = null;
  if (enableTls) {
    tlsCert = generateLoopbackTlsCert();
    h2Server = http2.createSecureServer(
      { key: tlsCert.key, cert: tlsCert.cert, allowHTTP1: true },
      handleRequest,
    );
    await new Promise((resolve, reject) => {
      h2Server.once('error', reject);
      h2Server.listen(0, '127.0.0.1', resolve);
    });
    const h2Addr = h2Server.address();
    h2Port = typeof h2Addr === 'object' && h2Addr ? h2Addr.port : 0;
  }

  return {
    httpPort,
    httpBaseUrl: `http://127.0.0.1:${httpPort}`,
    httpV1BaseUrl: `http://127.0.0.1:${httpPort}/v1`,
    h2Port,
    h2BaseUrl: h2Port ? `https://127.0.0.1:${h2Port}` : null,
    h2V1BaseUrl: h2Port ? `https://127.0.0.1:${h2Port}/v1` : null,
    tlsCert,
    setWorkspaceDir: (dir) => {
      workspaceDir = dir;
    },
    prepareBarrier: (barrierId) => {
      const entry = ensureBarrier(barrierId);
      return {
        getArrivedCount: () => entry.arrived,
        waitForArrivals: (target, timeoutMs = 15_000) => {
          if (entry.arrived >= target) return Promise.resolve(entry.arrived);
          return new Promise((resolve) => {
            const timer = setTimeout(() => {
              resolve(entry.arrived);
            }, timeoutMs);
            entry.waiters.push({
              target,
              resolve: (count) => {
                clearTimeout(timer);
                resolve(count);
              },
            });
          });
        },
        release: () => {
          if (!entry.released) {
            entry.released = true;
            entry.releaseFn();
          }
        },
      };
    },
    createTickLoop: (loopId) => {
      const entry = ensureTickLoop(loopId);
      return {
        offerTick: (seq) => {
          if (entry.stopped) return false;
          const tick = { seq, offeredAtMs: performance.now() };
          if (entry.waiter) {
            const w = entry.waiter;
            entry.waiter = null;
            w(tick);
            return true;
          }
          if (entry.offeredTicks.length >= 4) {
            entry.missedOffers += 1;
            entry.offeredTicks.shift();
          }
          entry.offeredTicks.push(tick);
          return true;
        },
        stop: () => {
          entry.stopped = true;
          if (entry.waiter) {
            const w = entry.waiter;
            entry.waiter = null;
            w(null);
          }
        },
        getStats: () => ({
          id: entry.id,
          stopped: entry.stopped,
          pendingOffers: entry.offeredTicks.length,
          consumedCount: entry.consumedTicks.length,
          missedOffers: entry.missedOffers,
          consumedTicks: [...entry.consumedTicks],
        }),
      };
    },
    getRequestTrace: () => [...requestTrace],
    clearRequestTrace: () => {
      requestTrace.length = 0;
    },
    getStats: () => ({
      seed,
      mode,
      faultRate,
      counters: { ...counters },
      faultsInjected: { ...faultsInjected },
      toolStats: structuredClone(toolStats),
      violations: [...violations],
      pending413Scopes: pending413Scopes.size,
      trackedThreads: threadStore.size,
      scopeAttempts: Object.fromEntries(scopeAttempts.entries()),
      scopeAttemptTimestamps: Object.fromEntries(scopeAttemptTimestamps.entries()),
    }),
    resetStats: () => {
      violations.length = 0;
      for (const k of Object.keys(faultsInjected)) delete faultsInjected[k];
      for (const k of Object.keys(toolStats)) delete toolStats[k];
      pending413Scopes.clear();
      oneShotFaultFired.clear();
      scopeToolStep.clear();
      scopeAttempts.clear();
      scopeAttemptTimestamps.clear();
      toolIdToName.clear();
      for (const k of Object.keys(counters)) counters[k] = 0;
    },
    close: async () => {
      for (const tl of tickLoops.values()) {
        tl.stopped = true;
        if (tl.waiter) {
          const w = tl.waiter;
          tl.waiter = null;
          w(null);
        }
      }
      for (const b of barriers.values()) {
        if (!b.released) {
          b.released = true;
          b.releaseFn();
        }
      }
      const closePromises = [
        new Promise((resolve) => httpServer.close(() => resolve())),
        h2Server ? new Promise((resolve) => h2Server.close(() => resolve())) : Promise.resolve(),
      ];
      try {
        httpServer.closeAllConnections?.();
      } catch {}
      try {
        h2Server?.closeAllConnections?.();
      } catch {}
      await Promise.race([
        Promise.all(closePromises),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    },
  };
}
