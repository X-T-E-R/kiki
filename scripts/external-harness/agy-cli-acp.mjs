// Denial accounting, step usage and subagent projection are adapted from Paseo (Apache-2.0).
// Copyright (c) 2025-present Mohamed Boudra. Modified for Kiki's ACP bridge; see packages/acp-client/THIRD_PARTY_NOTICES.md.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, open, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { registerProjectMcpPlugin, recoverProjectMcpPlugin, recoverDeadProjectMcpPlugins } from './agy-mcp-plugin.mjs';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerProjectHook, recoverProjectHook, AGY_STEERING_HOOK_KEY, AGY_COMMAND_GUIDANCE_HOOK_KEY } from './agy-hook-registration.mjs';
import { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { openPermissionChannel, permissionChannelIdentity, requestHookPermission } from './agy-permission-hook.mjs';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT = 'engine-default';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

const NATIVE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const NATIVE_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/i;
const LEGACY_NATIVE_STEP = { user: 14, planner: 15, error: 17, ephemeral: 90, system: 101, tool: 132 };
const NATIVE_DONE = 3;
const NATIVE_ERROR = 7;
const LEGACY_NETWORK_FAILURE = 'There was a network issue connecting to the server, please try again.';
const NETWORK_RECOVERY_INSTRUCTION = 'The connection to the model provider was interrupted after your last completed step. '
  + 'Continue the same task from where it stopped. Do not repeat tool calls that already finished.';
const MAX_CONSECUTIVE_NETWORK_RECOVERIES = 5;
const NETWORK_RECOVERY_BACKOFF_MS = [1000, 3000, 7000, 15000, 25000];
const NETWORK_RECOVERY_EXIT_GRACE_MS = 5000;
const ERROR_RESULT_WATCHDOG_MS = 15000;

export function takeNewDenials(actions, reported) {
  const counts = new Map();
  const fresh = (actions ?? []).filter(action => {
    const key = JSON.stringify([action?.action, action?.display_name]);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count > (reported.get(key) ?? 0);
  });
  for (const [key, count] of counts) reported.set(key, Math.max(count, reported.get(key) ?? 0));
  return fresh;
}

export function accumulateStepUsage(usageSteps, totals, step) {
  if (step?.state !== 'DONE' || !step.usage || !Number.isSafeInteger(step.step_index) || usageSteps.has(step.step_index)) return false;
  usageSteps.add(step.step_index);
  totals.inputTokens += Number(step.usage.input_tokens) || 0;
  totals.outputTokens += Number(step.usage.output_tokens) || 0;
  totals.cachedReadTokens += Number(step.usage.cache_read_tokens) || 0;
  totals.thoughtTokens += Number(step.usage.thinking_tokens) || 0;
  totals.totalTokens += Number(step.usage.total_tokens) || 0;
  return true;
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, thoughtTokens: 0, totalTokens: 0 };
}

function subagentPayload(step) {
  if (!step?.subagent_info) return undefined;
  return { subagents: (step.subagent_info.subagents ?? []).map(child => ({
    type_name: child?.type_name,
    initial_prompt: child?.initial_prompt,
    conversation_id: child?.conversation_id,
    log_uri: child?.log_uri,
  })) };
}

function nativeBytesAt(value, path, optionalLast = false, repeatedLast = false) {
  let bytes = Buffer.from(value);
  for (const [index, field] of path.entries()) {
    let offset = 0;
    let selected;
    const repeated = [];
    const last = index === path.length - 1;
    const integer = () => {
      let value = 0;
      for (let shift = 0; shift <= 49 && offset < bytes.length; shift += 7) {
        const byte = bytes[offset++];
        value += (byte & 127) * 2 ** shift;
        if (!(byte & 128)) return value;
      }
      throw new Error('Unsupported AGY native metadata encoding');
    };
    while (offset < bytes.length) {
      const key = integer();
      const number = Math.floor(key / 8);
      const wire = key % 8;
      if (!number) throw new Error('Unsupported AGY native metadata field');
      if (wire === 0) integer();
      else if (wire === 1 || wire === 5) offset += wire === 1 ? 8 : 4;
      else if (wire === 2) {
        const length = integer();
        if (length > bytes.length - offset) throw new Error('Truncated AGY native metadata');
        if (number === field) {
          const slice = bytes.subarray(offset, offset + length);
          if (repeatedLast && last) repeated.push(slice.toString('utf8'));
          else if (selected !== undefined) throw new Error('Ambiguous AGY native metadata binding');
          else selected = slice;
        }
        offset += length;
      } else throw new Error('Unsupported AGY native metadata wire type');
      if (offset > bytes.length) throw new Error('Truncated AGY native metadata');
    }
    if (repeatedLast && last) {
      if (!repeated.length && !optionalLast) throw new Error('Unconfirmed AGY native metadata binding');
      return repeated;
    }
    if (selected === undefined) {
      if (optionalLast) return repeatedLast ? [] : undefined;
      throw new Error('Unconfirmed AGY native metadata binding');
    }
    bytes = selected;
  }
  return bytes.toString('utf8');
}

function nativeStringsAt(value, path, optionalLast = false) {
  return nativeBytesAt(value, path, optionalLast, true);
}

async function readLegacyTranscript(path) {
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 2 * MAX_FRAME_BYTES) throw new Error('AGY legacy transcript exceeds the recovery limit');
    const data = Buffer.alloc(before.size + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    const after = await file.stat();
    if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('AGY legacy transcript changed during recovery');
    return data.subarray(0, bytesRead).toString('utf8').trim().split('\n').map(JSON.parse);
  } finally { await file.close(); }
}

export async function readLegacyNativeRecovery({ nativeHome, cwd, additionalDirectories = [], sessionId, proof, model }) {
  const extraDirs = proof?.additionalDirectories ?? [];
  const disclosedCwd = proof?.disclosedCwd;
  const terminalError = proof?.terminalError ?? LEGACY_NETWORK_FAILURE;
  if (proof?.version !== 1 || proof.sessionId !== sessionId || !NATIVE_ID.test(sessionId) || !NATIVE_ID.test(proof.conversationId) || !isAbsolute(cwd) ||
      !Array.isArray(additionalDirectories) || additionalDirectories.some(dir => typeof dir !== 'string' || !isAbsolute(dir)) ||
      !Array.isArray(extraDirs) || extraDirs.some(dir => typeof dir !== 'string' || !isAbsolute(dir)) ||
      (disclosedCwd !== undefined && (typeof disclosedCwd !== 'string' || !isAbsolute(disclosedCwd))) ||
      proof.model !== model || typeof proof.effort !== 'string' || typeof terminalError !== 'string' || !terminalError.trim() ||
      /^(?:interrupted|canceled|cancelled)$/i.test(terminalError.trim()) ||
      !Array.isArray(proof.tools) || !proof.tools.length || proof.tools.length > 1000 ||
      proof.tools.some(tool => !Number.isSafeInteger(tool?.stepIndex) || tool.stepIndex < 0 || !NATIVE_TOOL_NAME.test(tool.name ?? '') ||
        (tool.failed !== undefined && tool.failed !== true) ||
        (tool.error !== undefined && (typeof tool.error !== 'string' || !tool.error.trim()))) ||
      new Set(proof.tools.map(tool => tool.stepIndex)).size !== proof.tools.length) {
    throw new Error('AGY legacy load requires an exact original session and completed native tool mapping');
  }
  const canonical = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  if ((disclosedCwd !== undefined && canonical(disclosedCwd) !== canonical(cwd)) ||
      (additionalDirectories.length > 0 && (disclosedCwd === undefined || extraDirs.length !== additionalDirectories.length ||
        extraDirs.some((dir, index) => canonical(dir) !== canonical(additionalDirectories[index])))) ||
      (extraDirs.length > 0 && (extraDirs.length !== additionalDirectories.length ||
        extraDirs.some((dir, index) => canonical(dir) !== canonical(additionalDirectories[index]))))) {
    throw new Error('AGY legacy native conversation or workspace differs from its original binding');
  }
  const expectedRoots = new Set([cwd, ...additionalDirectories].map(canonical));
  if (expectedRoots.size !== 1 + additionalDirectories.length) {
    throw new Error('AGY legacy native conversation or workspace differs from its original binding');
  }
  const conversationId = proof.conversationId;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(resolve(nativeHome, 'conversations', `${conversationId}.db`), { readOnly: true });
  try {
    db.exec('BEGIN');
    const metadata = db.prepare('SELECT data FROM trajectory_metadata_blob WHERE id = ? AND length(data) <= 65536').get('main');
    const data = metadata?.data ?? [];
    const nativeRootUris = nativeStringsAt(data, [7]);
    const nativeRoots = new Set(nativeRootUris.map(uri => canonical(fileURLToPath(uri))));
    if (nativeBytesAt(data, [6]) !== conversationId || nativeRootUris.length !== expectedRoots.size ||
        nativeRoots.size !== expectedRoots.size || [...expectedRoots].some(root => !nativeRoots.has(root))) {
      throw new Error('AGY legacy native conversation or workspace differs from its original binding');
    }
    const baseModel = proof.effort !== DEFAULT && model.endsWith(`-${proof.effort}`)
      ? model.slice(0, -(proof.effort.length + 1))
      : model;
    const exactModel = value => value === model || value === `gemini-api://models/${model}`;
    const totalModels = Number(db.prepare('SELECT COUNT(*) AS count FROM (SELECT 1 FROM gen_metadata LIMIT 1001)').get()?.count ?? 0);
    if (totalModels === 0 || totalModels > 1000) {
      throw new Error('AGY legacy native model differs from its original binding');
    }
    const models = db.prepare('SELECT CASE WHEN length(data) <= ? THEN data END AS data FROM gen_metadata ORDER BY idx LIMIT 1001');
    let rowIndex = 0;
    let sawModel = false;
    let sawExactModel = false;
    for (const row of models.iterate(MAX_FRAME_BYTES)) {
      const isLast = rowIndex === totalModels - 1;
      rowIndex += 1;
      const bytes = row.data ?? [];
      const name = nativeBytesAt(bytes, [1, 19], true);
      const uri = nativeBytesAt(bytes, [3, 28], true);
      if (name === undefined && uri === undefined && !isLast) {
        throw new Error('AGY legacy native model differs from its original binding');
      }
      if (name !== undefined && name !== model && name !== baseModel) {
        throw new Error('AGY legacy native model differs from its original binding');
      }
      if (uri !== undefined && !exactModel(uri)) {
        throw new Error('AGY legacy native model differs from its original binding');
      }
      if (name !== undefined || uri !== undefined) sawModel = true;
      if (name === model || (uri !== undefined && exactModel(uri))) sawExactModel = true;
    }
    if (db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'executor_metadata')) {
      const execMeta = db.prepare('SELECT CASE WHEN length(data) <= ? THEN data END AS data FROM executor_metadata ORDER BY idx LIMIT 10');
      for (const row of execMeta.iterate(MAX_FRAME_BYTES)) {
        const uri = nativeBytesAt(row.data ?? [], [10, 1, 28], true);
        if (uri !== undefined && !exactModel(uri)) {
          throw new Error('AGY legacy native model differs from its original binding');
        }
        if (uri !== undefined && exactModel(uri)) sawExactModel = true;
      }
    }
    if (rowIndex !== totalModels || !sawModel || !sawExactModel) {
      throw new Error('AGY legacy native model differs from its original binding');
    }
    const steps = db.prepare('SELECT idx, step_type, status FROM steps ORDER BY idx LIMIT 10001').all();
    if (!steps.length || steps.length > 10000 || steps.some((step, index) => step.idx !== index ||
        !Object.values(LEGACY_NATIVE_STEP).includes(step.step_type) ||
        (step.step_type === LEGACY_NATIVE_STEP.tool ? step.status !== NATIVE_DONE && step.status !== NATIVE_ERROR : step.status !== NATIVE_DONE)) ||
        steps.filter(step => step.step_type === LEGACY_NATIVE_STEP.user).length !== 1) {
      throw new Error('AGY legacy native turn has unresolved steps or unknown steering; do not replay it');
    }
    const step0Row = db.prepare('SELECT step_payload FROM steps WHERE idx = 0 AND length(step_payload) <= 65536').get();
    const step0Bytes = step0Row?.step_payload ?? [];
    if (proof.promptSha256 !== undefined) {
      const step0Text = nativeBytesAt(step0Bytes, [19, 2], true);
      if (typeof step0Text !== 'string' || createHash('sha256').update(step0Text).digest('hex') !== proof.promptSha256) {
        throw new Error('AGY legacy native initial prompt differs from its audited prompt digest');
      }
    }
    const step0Uris = nativeStringsAt(step0Bytes, [19, 12, 12], true);
    if (step0Uris.length > 0) {
      const step0Roots = new Set(step0Uris.map(uri => canonical(fileURLToPath(uri))));
      if (step0Uris.length !== expectedRoots.size || step0Roots.size !== expectedRoots.size ||
          [...expectedRoots].some(root => !step0Roots.has(root))) {
        throw new Error('AGY legacy native conversation or workspace differs from its original binding');
      }
    }
    const terminal = steps.at(-1);
    const payload = db.prepare('SELECT step_payload FROM steps WHERE idx = ? AND length(step_payload) <= 65536').get(terminal.idx);
    const terminalBytes = payload?.step_payload ?? [];
    const terminalErr1 = nativeBytesAt(terminalBytes, [24, 3, 1], true);
    const terminalErr2 = nativeBytesAt(terminalBytes, [24, 3, 2], true);
    if (terminal.step_type !== LEGACY_NATIVE_STEP.error || (terminalErr1 !== terminalError && terminalErr2 !== terminalError)) {
      throw new Error('AGY legacy native turn has no confirmed terminal network failure');
    }
    const toolSteps = steps.filter(step => step.step_type === LEGACY_NATIVE_STEP.tool);
    const toolByIndex = new Map(toolSteps.map(step => [step.idx, step]));
    if (toolByIndex.size !== proof.tools.length || proof.tools.some(tool => !toolByIndex.has(tool.stepIndex))) {
      throw new Error('AGY legacy native tools differ from the completed Kiki tool mapping');
    }
    const selectStepPayload = db.prepare('SELECT step_payload FROM steps WHERE idx = ? AND length(step_payload) <= 65536');
    for (const tool of proof.tools) {
      const step = toolByIndex.get(tool.stepIndex);
      if ((tool.failed === true) !== (step.status === NATIVE_ERROR)) {
        throw new Error('AGY legacy native tools differ from the completed Kiki tool mapping');
      }
      const toolPayload = selectStepPayload.get(tool.stepIndex)?.step_payload ?? [];
      const nativeName = nativeBytesAt(toolPayload, [5, 4, 2], true);
      if (nativeName !== undefined && nativeName !== tool.name) {
        throw new Error('AGY legacy native tools differ from the completed Kiki tool mapping');
      }
      if (tool.failed === true) {
        const nativeErr = nativeBytesAt(toolPayload, [31, 2], true) ?? nativeBytesAt(toolPayload, [31, 3], true);
        if (!nativeErr || /^tool call denied by pre-tool hook:/i.test(nativeErr.trimStart()) ||
            (tool.error !== undefined && nativeErr !== tool.error)) {
          throw new Error('AGY legacy native tools differ from the completed Kiki tool mapping');
        }
      }
    }
    const transcript = await readLegacyTranscript(resolve(nativeHome, 'brain', conversationId, '.system_generated', 'logs', 'transcript_full.jsonl'));
    const declared = transcript.flatMap(step => step.tool_calls ?? []);
    const transcriptErrorStep = transcript.at(-1);
    const alignedErrorStep = steps[transcript.length - 1];
    const alignedErrorBytes = alignedErrorStep?.step_type === LEGACY_NATIVE_STEP.error
      ? (selectStepPayload.get(alignedErrorStep.idx)?.step_payload ?? [])
      : undefined;
    const alignedErr1 = alignedErrorBytes ? nativeBytesAt(alignedErrorBytes, [24, 3, 1], true) : undefined;
    const alignedErr2 = alignedErrorBytes ? nativeBytesAt(alignedErrorBytes, [24, 3, 2], true) : undefined;
    const transcriptErrorText = typeof transcriptErrorStep?.error === 'string' && transcriptErrorStep.error.trim()
      ? transcriptErrorStep.error
      : undefined;
    if (transcript.some((step, index) => step.step_index !== index ||
        (step.type === 'GENERIC' ? step.status !== 'DONE' && step.status !== 'ERROR' : step.status !== 'DONE')) ||
        transcript.length < steps.length - 1 || transcript.length > steps.length ||
        transcriptErrorStep?.type !== 'ERROR_MESSAGE' || alignedErrorStep?.step_type !== LEGACY_NATIVE_STEP.error ||
        (transcriptErrorText !== undefined && transcriptErrorText !== alignedErr1 && transcriptErrorText !== alignedErr2 && transcriptErrorText !== terminalError) ||
        transcript.filter(step => step.type === 'USER_INPUT').length !== 1 ||
        transcript.filter(step => step.type === 'GENERIC').length !== toolByIndex.size ||
        declared.length !== proof.tools.length || declared.some((tool, index) => tool.name !== proof.tools[index].name) ||
        proof.tools.some(tool => {
          const entry = transcript[tool.stepIndex];
          return entry?.type !== 'GENERIC' ||
            (tool.failed === true ? entry.status !== 'ERROR' || (tool.error !== undefined && entry.error !== tool.error) : entry.status !== 'DONE');
        })) {
      throw new Error('AGY legacy native transcript is not fully reconciled or differs from the completed Kiki tool mapping');
    }
    return { conversationId, model, effort: proof.effort };
  } finally { db.close(); }
}

async function inspectNativeErrorWatchdogState({ nativeHome, conversationId }) {
  if (typeof nativeHome !== 'string' || !nativeHome || !NATIVE_ID.test(conversationId ?? '')) {
    return { status: 'missing_db' };
  }
  const dbPath = resolve(nativeHome, 'conversations', `${conversationId}.db`);
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
    const latest = db.prepare('SELECT idx, step_type, status, CASE WHEN length(step_payload) <= 65536 THEN step_payload END AS step_payload FROM steps ORDER BY idx DESC LIMIT 1').get();
    if (!latest) return { status: 'no_terminal_error' };
    const incomplete = db.prepare('SELECT idx, step_type, status FROM steps WHERE (step_type = ? AND status NOT IN (?, ?)) OR (step_type != ? AND status != ?) LIMIT 1')
      .get(LEGACY_NATIVE_STEP.tool, NATIVE_DONE, NATIVE_ERROR, LEGACY_NATIVE_STEP.tool, NATIVE_DONE);
    if (incomplete) return { status: 'incomplete_steps' };
    if (latest.step_type !== LEGACY_NATIVE_STEP.error) return { status: 'no_terminal_error' };
    const bytes = latest.step_payload ?? [];
    const err1 = nativeBytesAt(bytes, [24, 3, 1], true);
    const err2 = nativeBytesAt(bytes, [24, 3, 2], true);
    if (typeof err1 === 'string' && err1.trim()) {
      return { status: 'terminal_error', stepIndex: latest.idx, summary: err1, detail: err2, error: err2 || err1 };
    }
    return { status: 'retrying', stepIndex: latest.idx, detail: err2 };
  } catch (error) {
    if (error?.code === 'ERR_SQLITE_ERROR' || /unable to open database file/i.test(String(error?.message ?? ''))) {
      return { status: 'missing_db' };
    }
    return { status: 'db_error' };
  } finally {
    try { db?.close(); } catch {}
  }
}

function unconsumedNetworkContinuationProof(records, { sessionId, conversationId, model, effort, cwd, additionalDirectories = [] }) {
  if (!Array.isArray(records) || !NATIVE_ID.test(sessionId ?? '') || !NATIVE_ID.test(conversationId ?? '')) return undefined;
  let lastTurnIndex = -1;
  for (let index = 0; index < records.length; index += 1) {
    const type = records[index]?.type;
    if (type === 'native_turn_pending' || type === 'native_turn_reconciled') lastTurnIndex = index;
  }
  if (lastTurnIndex < 0 || records[lastTurnIndex]?.type !== 'native_turn_pending') return undefined;
  let launchIndex = -1;
  for (let index = lastTurnIndex; index >= 0; index -= 1) {
    if (records[index]?.type === 'launch') { launchIndex = index; break; }
  }
  if (launchIndex < 0 || records.some((record, index) => index > launchIndex && record?.type === 'launch')) return undefined;
  if (records.some(record => ['session_loaded', 'legacy_native_recovered'].includes(record?.type))) return undefined;
  if (records.filter(record => record?.type === 'prompt_sent').length !== 1) return undefined;
  const launch = records[launchIndex];
  if (!Number.isSafeInteger(launch?.pid) || launch.pid <= 0) return undefined;
  const turnRecords = records.slice(lastTurnIndex + 1);
  const promptSent = turnRecords.filter(record => record?.type === 'prompt_sent');
  if (promptSent.length !== 1 || !/^[0-9a-f]{64}$/i.test(String(promptSent[0].promptSha256 ?? ''))) return undefined;
  const consumed = turnRecords.filter(record => record?.type === 'prompt_consumed');
  if (consumed.length !== 1 || consumed[0].stepIndex !== 0) return undefined;
  if (turnRecords.some(record => typeof record?.type === 'string' && (record.type.startsWith('steer_') || record.type === 'pre_tool_hook_denied'))) return undefined;
  const results = turnRecords.filter(record => record?.type === 'agy_result');
  const requested = turnRecords.filter(record => record?.type === 'network_recovery_requested');
  const sent = turnRecords.filter(record => record?.type === 'network_recovery_sent');
  if (results.length !== 1 || requested.length !== 1 || sent.length !== 1) return undefined;
  if (results[0].conversationId !== conversationId || results[0].status !== 'ERROR' ||
      requested[0].conversationId !== conversationId || requested[0].nativeStatus !== 'ERROR' ||
      requested[0].attempt !== 1 || requested[0].totalAttempts !== 1 ||
      sent[0].conversationId !== conversationId || sent[0].attempt !== 1 || sent[0].relaunched !== false) return undefined;
  const sentIndex = turnRecords.indexOf(sent[0]);
  if (sentIndex < turnRecords.indexOf(requested[0]) || sentIndex < turnRecords.indexOf(results[0]) ||
      sentIndex <= turnRecords.indexOf(consumed[0])) return undefined;
  const afterSent = turnRecords.slice(sentIndex + 1);
  if (afterSent.some(record => record?.type !== 'native_frame_delivered' && record?.type !== 'close')) return undefined;
  const closes = afterSent.filter(record => record?.type === 'close');
  if (closes.length !== 1 || closes[0].pid !== launch.pid || closes[0].processEnded !== true ||
      (closes[0].signal !== undefined && closes[0].signal !== null) ||
      (closes[0].exitCode !== undefined && (!Number.isSafeInteger(closes[0].exitCode) || closes[0].exitCode < 0))) return undefined;
  const toolsByStep = new Map();
  for (const record of turnRecords) {
    if (record?.type !== 'tool_state') continue;
    const match = /^agy-([0-9a-f-]+)-(\d+)$/i.exec(String(record.toolCallId ?? ''));
    if (!match || match[1] !== conversationId) return undefined;
    const stepIndex = Number(match[2]);
    if (!Number.isSafeInteger(stepIndex) || stepIndex <= 0) return undefined;
    toolsByStep.set(stepIndex, {
      stepIndex,
      name: record.name,
      state: record.state,
      ...(typeof record.error === 'string' && record.error.trim() ? { error: record.error } : {}),
    });
  }
  if (!toolsByStep.size) return undefined;
  const tools = [];
  for (const tool of [...toolsByStep.values()].sort((a, b) => a.stepIndex - b.stepIndex)) {
    if (tool.state !== 'DONE' && tool.state !== 'ERROR') return undefined;
    tools.push({
      stepIndex: tool.stepIndex,
      name: tool.name,
      ...(tool.state === 'ERROR' ? { failed: true } : {}),
      ...(tool.state === 'ERROR' && tool.error ? { error: tool.error } : {}),
    });
  }
  return {
    version: 1,
    sessionId,
    conversationId,
    model,
    effort,
    promptSha256: String(promptSent[0].promptSha256).toLowerCase(),
    terminalError: requested[0].error,
    disclosedCwd: cwd,
    additionalDirectories: additionalDirectories.length ? [...additionalDirectories] : undefined,
    tools,
  };
}

export function launchArgs(session) {
  validateEffort(session.model, session.effort);
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
  if (session.conversationId) args.push('--conversation', session.conversationId);
  if (session.model !== DEFAULT) args.push('--model', session.model);
  if (session.effort !== DEFAULT && !session.model.startsWith('claude-')) args.push('--effort', session.effort);
  const mode = session.permissionMode ?? DEFAULT;
  if (mode === 'yolo') args.push('--dangerously-skip-permissions');
  const settings = mode === 'manual' ? { toolPermission: 'request-review', agentMode: 'default' }
    : mode === 'auto' ? { toolPermission: 'request-review', agentMode: 'auto' }
      : mode === 'yolo' ? { toolPermission: 'always-proceed', agentMode: 'accept-edits', allowNonWorkspaceAccess: true, enableTerminalSandbox: false }
        : undefined;
  const accountSettings = session.accountBound ? {
    modelProvider: 'gemini',
    customModelsConfig: { customModels: { [session.model]: { modelName: `gemini-api://models/${session.model}`,
      toolFormatterType: 'TOOL_FORMATTER_TYPE_NONE' } } },
  } : undefined;
  if (settings !== undefined || accountSettings !== undefined) args.push('--settings', JSON.stringify({ ...settings, ...accountSettings }));
  for (const dir of session.additionalDirectories) args.push('--add-dir', dir);
  return args;
}

export function promptText(blocks) {
  if (!Array.isArray(blocks) || blocks.some(b => b.type !== 'text' || typeof b.text !== 'string')) {
    throw new Error('This AGY ACP adapter accepts text prompts only; CLI rich-input support has not been verified');
  }
  const text = blocks.map(b => b.text).join('\n');
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES / 2) throw new Error('AGY prompt exceeds the adapter frame limit');
  return text;
}

export function encodedEffort(model) {
  return EFFORTS.find(effort => model.endsWith(`-${effort}`));
}

export function validateEffort(model, effort) {
  if (![DEFAULT, ...EFFORTS].includes(effort)) throw new Error('Unsupported AGY effort selection');
  const encoded = encodedEffort(model);
  if (effort === DEFAULT) return;
  if (encoded === undefined) {
    throw new Error(`AGY model ID ${model} does not embed an effort; effort ${effort} is not an advertised config for this id`);
  }
  if (effort !== encoded) {
    throw new Error(`AGY model ID ${model} encodes effort ${encoded} and conflicts with effort ${effort}; select the corresponding raw AGY model ID instead`);
  }
}

const CATALOG_TIMEOUT_MS = 20_000;
const CATALOG_MAX_BYTES = 65_536;

/** First whitespace token of each `agy models` row. Header and comment rows are not ids. */
export function vendorModelIds(output) {
  const values = [];
  const seen = new Set();
  for (const line of String(output).split(/\r?\n/u)) {
    const first = (line.trim().split(/\s+/u)[0] ?? '').trim();
    if (first === '' || first.startsWith('#') || /^(?:id|model|models|name)$/iu.test(first)) continue;
    if (first.length > 256 || /\s/u.test(first) || seen.has(first)) continue;
    seen.add(first);
    values.push(first);
  }
  return values;
}

function safeDiagnosticLine(text) {
  const line = text.trim();
  if (line.length === 0 || /(?:token|bearer|api[_-]?key|secret|authorization|password)/iu.test(line) || /[A-Za-z0-9+/_-]{32,}={0,2}/u.test(line) || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(line)) return undefined;
  return line.slice(0, 180);
}

export function catalogDiagnostic(text) {
  const line = String(text).split(/\r?\n/u).map(part => part.trim()).find(Boolean) ?? '';
  return safeDiagnosticLine(line) ?? 'AGY model catalog probe failed';
}

export function readVendorModelCatalog({ cliPath, cliPrefix = [], spawnProcess = spawn, stopProcess, timeoutMs = CATALOG_TIMEOUT_MS, maxOutputBytes = CATALOG_MAX_BYTES } = {}) {
  return new Promise(resolveCatalog => {
    let child;
    let settled = false;
    let overflow = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCatalog(result);
    };
    const timer = setTimeout(() => {
      const stopping = child === undefined ? undefined : Promise.resolve(stopProcess ? stopProcess(child) : child.kill?.()).catch(() => {});
      void Promise.resolve(stopping).finally(() => finish({ ok: false, diagnostic: 'AGY model catalog probe timed out' }));
    }, timeoutMs);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    try {
      child = spawnProcess(cliPath, [...cliPrefix, 'models'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      finish({ ok: false, diagnostic: catalogDiagnostic(error instanceof Error ? error.message : String(error)) });
      return;
    }
    const take = (current, chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const next = Buffer.concat([current, bytes]);
      if (next.length > maxOutputBytes) {
        overflow = true;
        child.kill?.();
        return next.subarray(0, maxOutputBytes);
      }
      return next;
    };
    child.stdout?.on('data', chunk => { stdout = take(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = take(stderr, chunk); });
    child.once?.('error', error => finish({ ok: false, diagnostic: catalogDiagnostic(error instanceof Error ? error.message : String(error)) }));
    child.once?.('close', code => {
      if (overflow) finish({ ok: false, diagnostic: 'AGY model catalog probe exceeded the output limit' });
      else if (code !== 0) finish({ ok: false, diagnostic: catalogDiagnostic(stderr.toString('utf8') || `AGY model catalog probe exited ${code}`) });
      else finish({ ok: true, ids: vendorModelIds(stdout.toString('utf8')) });
    });
  });
}

export function configOptions(session) {
  const effort = encodedEffort(session.model);
  const options = [{ id: 'effort', name: 'AGY effort', category: 'thought_level', type: 'select', currentValue: session.effort,
    options: [{ value: DEFAULT, name: 'Follow AGY settings' }, ...(effort ? [{ value: effort, name: effort }] : [])] }];
  if (Array.isArray(session.modelChoices)) {
    options.push({ id: 'model', name: 'AGY model', category: 'model', type: 'select', currentValue: session.model,
      options: session.modelChoices.length === 0 ? [] : [
        ...session.accountBound ? [] : [{ value: DEFAULT, name: 'Follow AGY settings' }],
        ...session.modelChoices.map(id => ({ value: id, name: id }))] });
  }
  options.push({ id: 'native-agent', name: 'AGY native agent', category: 'native_agent', type: 'select',
    currentValue: DEFAULT, options: [{ value: DEFAULT, name: 'Follow AGY default agent' }] });
  options.push({ id: 'permission-mode', name: 'AGY permissions', category: 'permission_mode', type: 'select',
    currentValue: session.permissionMode ?? DEFAULT, options: [
      { value: DEFAULT, name: 'Follow AGY settings' }, { value: 'manual', name: 'Request review' },
      { value: 'auto', name: 'AGY auto mode' }, { value: 'yolo', name: 'Full access' },
    ] });
  return options;
}

async function terminate(child) {
  const running = () => child?.pid !== undefined && child.exitCode === null && child.signalCode === null;
  if (!running()) return;
  let onClose;
  const closed = new Promise(done => { onClose = done; child.once('close', onClose); });
  try {
    if (process.platform === 'win32') {
      const killer = spawn(resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await new Promise((done, reject) => {
        killer.once('error', reject);
        killer.once('close', (code, signal) => code === 0 ? done() : reject(new Error(`taskkill exited with ${code ?? signal}`)));
      });
    } else if (!child.kill('SIGTERM')) throw new Error('SIGTERM was not delivered');
  } catch (error) {
    if (running()) {
      child.off('close', onClose);
      throw new Error(`Could not stop the owned AGY process: ${error.message}`, { cause: error });
    }
  }
  await closed;
}

export class AgyBridge {
  constructor({ cliPath, cliPrefix = [], auditDir, nativeHome = resolve(homedir(), '.gemini', 'antigravity-cli'), model = DEFAULT, spawnProcess = spawn, stopProcess = terminate, account, onAccountExit, continuationExitGraceMs = NETWORK_RECOVERY_EXIT_GRACE_MS, networkRecoveryBackoffMs = NETWORK_RECOVERY_BACKOFF_MS, maxConsecutiveNetworkRecoveries = MAX_CONSECUTIVE_NETWORK_RECOVERIES, errorResultWatchdogMs = ERROR_RESULT_WATCHDOG_MS } = {}) {
    this.stopProcess = stopProcess;
    this.continuationExitGraceMs = continuationExitGraceMs;
    this.networkRecoveryBackoffMs = networkRecoveryBackoffMs;
    this.maxConsecutiveNetworkRecoveries = maxConsecutiveNetworkRecoveries;
    this.errorResultWatchdogMs = errorResultWatchdogMs;
    if (!isAbsolute(cliPath ?? '')) throw new Error('Pass the exact absolute AGY executable path');
    if (typeof model !== 'string' || !model || /\s/.test(model)) throw new Error('AGY model must be a nonempty engine ID');
    if (account && model !== DEFAULT && !account.modelIds.includes(model)) throw new Error('The selected account does not provide the bound AGY model');
    this.account = account;
    this.requestedModel = model;
    this.onAccountExit = onAccountExit;
    this.model = account && model === DEFAULT ? account.modelIds[0] : model;
    this.cliPath = cliPath;
    this.cliPrefix = cliPrefix;
    this.auditDir = auditDir;
    this.nativeHome = nativeHome;
    this.spawnProcess = spawnProcess;
    this.sessions = new Map();
  }

  async audit(session, type, data) {
    if (!this.auditDir) return;
    await mkdir(this.auditDir, { recursive: true });
    await appendFile(resolve(this.auditDir, `${session.id}.ndjson`), JSON.stringify({ at: new Date().toISOString(), type, ...data }) + '\n');
  }

  initialize(version) {
    return { protocolVersion: version, agentInfo: { name: 'agy-cli-acp', version: '0.2.0' },
      agentCapabilities: { loadSession: Boolean(this.auditDir), promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false }, sessionCapabilities: { additionalDirectories: {} } },
      authMethods: [], _meta: { steering: { supported: true } } };
  }

  async requestPermission() {
    return { decision: 'ask' };
  }

  async newSession(params, id = randomUUID(), event = 'session_new', recovery) {
    const mcpServers = params.mcpServers ?? [];
    if (!Array.isArray(mcpServers) || mcpServers.some(server => !server || typeof server.name !== 'string' ||
      !server.name || typeof server.command !== 'string' || !server.command ||
      !Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string') ||
      !Array.isArray(server.env) || server.env.some(entry => typeof entry.name !== 'string' || typeof entry.value !== 'string'))) {
      throw new Error('AGY session MCP requires named stdio servers with command, args and env');
    }
    if (params._meta?.systemPromptOverride !== undefined) throw new Error('System replacement is unsupported; use explicit Kiki preamble delivery');
    if (!isAbsolute(params.cwd)) throw new Error('AGY workspace must be absolute');
    const dirs = params.additionalDirectories ?? [];
    if (!Array.isArray(dirs) || dirs.some(d => typeof d !== 'string' || !isAbsolute(d))) throw new Error('Additional directories must be absolute');
    const session = { id, cwd: params.cwd, additionalDirectories: dirs, model: this.model, effort: DEFAULT,
      modelChoices: this.modelChoices, accountBound: this.account !== undefined,
      mcpServers: structuredClone(mcpServers), mcpPlugin: undefined, mcpBound: new Set(), mcpReady: new Set(),
      permissionIdentity: permissionChannelIdentity(), permissionChannel: undefined,
      child: undefined, active: undefined, broken: false, init: undefined, exited: undefined, denialCounts: new Map(), toolIds: new Map(), toolDetails: new Map(), toolInputs: new Map() };
    this.sessions.set(session.id, session);
    try {
      await this.recoverDeadOwnedResources(session);
      await this.audit(session, event, { cwd: session.cwd, additionalDirectories: dirs, delivery: event === 'session_new' ? 'first_user_preamble' : 'native_conversation', systemOverride: false, recovery });
      return { sessionId: session.id, configOptions: configOptions(session) };
    } catch (error) {
      await session.permissionChannel?.close();
      await this.closeSteeringHook(session).catch(() => {});
      this.sessions.delete(session.id);
      throw error;
    }
  }

  async loadSession(params) {
    if (!this.auditDir) throw new Error('AGY native load requires the existing adapter audit directory');
    if (!/^[0-9a-f-]{36}$/i.test(params.sessionId)) throw new Error('Invalid AGY adapter session ID');
    if (this.sessions.has(params.sessionId)) throw new Error('AGY session is already owned by this connection');
    const auditPath = resolve(this.auditDir, `${params.sessionId}.ndjson`);
    const readAudit = async () => (await readFile(auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const records = await readAudit().catch(error => {
      if (error.code !== 'ENOENT' || params._meta?.['kiki.agyLegacyRecovery'] === undefined) throw error;
      return undefined;
    });
    const workspace = records?.find(record => ['session_new', 'legacy_native_recovered'].includes(record.type));
    const launch = records?.findLast(record => record.type === 'launch');
    if (records === undefined || !launch && workspace?.type === 'legacy_native_recovered') {
      return this.loadLegacySession(params, readAudit, workspace);
    }
    const init = records.findLast(record => record.type === 'agy_init');
    if (!workspace || !launch || !init?.conversationId || records.indexOf(init) < records.indexOf(launch)) {
      throw new Error('AGY session has no confirmed native conversation to load; retain the failed attempt and create a new session');
    }
    if (resolve(params.cwd) !== resolve(workspace.cwd)
      || JSON.stringify(params.additionalDirectories ?? []) !== JSON.stringify(workspace.additionalDirectories ?? [])) {
      throw new Error('AGY native load workspace differs from its original binding');
    }
    if (records.some(record => record.type === 'mcp_agent_registered')) {
      throw new Error('This native conversation used the former custom MCP agent; retain its original adapter for recovery or create a new native main session');
    }
    const mcpBinding = records.findLast(record => record.type === 'mcp_plugin_registered');
    if (mcpBinding && typeof mcpBinding.name !== 'string') throw new Error('AGY native load has no audited MCP plugin namespace; preserve its original adapter for recovery');
    if (mcpBinding && JSON.stringify(params.mcpServers?.map(server => server.name) ?? []) !== JSON.stringify(mcpBinding.servers)) {
      throw new Error('AGY native load requires fresh MCP connections matching its original server names');
    }
    const argValue = name => { const index = launch.args.lastIndexOf(name); return index < 0 ? DEFAULT : launch.args[index + 1]; };
    const model = argValue('--model') === DEFAULT ? init.model : argValue('--model');
    if (typeof model !== 'string' || !model || (this.account ? !this.account.modelIds.includes(model) || this.requestedModel !== DEFAULT && model !== this.requestedModel
      : this.model !== DEFAULT && model !== this.model)) throw new Error(this.account
        ? 'AGY native load model differs from its original binding or is unavailable for the selected account'
        : 'AGY native load model differs from its original binding or was not confirmed');
    const effort = launch.effort ?? argValue('--effort');
    validateEffort(model, effort);
    if (processAlive(launch.pid)) throw new Error('AGY native conversation still has an owned process; close it before loading');
    const release = await this.claimResume(params.sessionId);
    try {
      const latest = await readAudit();
      const retired = latest.findLast(record => record.type === 'cancel_requested' || record.type === 'cancel_failed'
        || record.type === 'cancel' && record.resumeSupported === false
        || record.type === 'tool_terminal_missing' && record.tools?.length);
      if (retired) {
        const error = new Error(`AGY native session is retired or unreconciled (${retired.type}); inspect the native outcome before deciding what to run in a fresh session; do not replay interrupted prompts or commands`);
        error.code = 'AGY_SESSION_RETIRED';
        error.details = { reason: retired.type, unresolvedTools: retired.unresolvedTools ?? retired.tools ?? [] };
        throw error;
      }
      const turn = latest.findLast(record => record.type === 'native_turn_pending' || record.type === 'native_turn_reconciled');
      if (turn?.type === 'native_turn_pending') {
        const unconsumedProof = !mcpBinding
          ? unconsumedNetworkContinuationProof(latest, {
            sessionId: params.sessionId,
            conversationId: init.conversationId,
            model,
            effort,
            cwd: workspace.cwd,
            additionalDirectories: workspace.additionalDirectories ?? [],
          })
          : undefined;
        let reconciled = false;
        if (unconsumedProof !== undefined) {
          try {
            await readLegacyNativeRecovery({
              nativeHome: this.nativeHome,
              cwd: workspace.cwd,
              additionalDirectories: workspace.additionalDirectories ?? [],
              sessionId: params.sessionId,
              proof: unconsumedProof,
              model,
            });
            reconciled = true;
          } catch {}
        }
        if (!reconciled) {
          const error = new Error('AGY native session has an unconfirmed turn; wait for its native outcome to be reconciled before loading; do not replay the interrupted prompt or commands');
          error.code = 'AGY_SESSION_UNCONFIRMED';
          throw error;
        }
        await this.audit({ id: params.sessionId }, 'native_turn_reconciled', {
          conversationId: init.conversationId,
          status: 'ERROR',
          reconciledFromNativeDb: true,
          unconsumedContinuationAttempt: 1,
        });
      }
      await this.newSession(params, params.sessionId, 'session_loaded');
      const session = this.session(params.sessionId);
      session.model = model;
      session.effort = effort;
      session.conversationId = init.conversationId;
      session.mcpNamespace = mcpBinding?.name;
      session.releaseResume = release;
      return { configOptions: configOptions(session) };
    } catch (error) { await release(); this.sessions.delete(params.sessionId); throw error; }
  }

  async claimResume(sessionId) {
    await mkdir(this.auditDir, { recursive: true });
    const path = resolve(this.auditDir, `${sessionId}.resume-lock`);
    const claim = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    let file;
    try { file = await open(path, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readFile(path, 'utf8');
      if (processAlive(JSON.parse(previous).pid)) throw new Error('AGY native conversation is already being loaded');
      throw new Error(`AGY native load lease is stale; recover only this exact owned lease after confirming no live adapter: ${path}`);
    }
    try { await file.writeFile(claim); } finally { await file.close(); }
    return async () => {
      try { if (await readFile(path, 'utf8') === claim) await unlink(path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
  }

  async loadLegacySession(params, readAudit, previous) {
    const additionalDirectories = params.additionalDirectories ?? [];
    if ((params.mcpServers?.length ?? 0) !== 0 ||
        !Array.isArray(additionalDirectories) ||
        additionalDirectories.some(dir => typeof dir !== 'string' || !isAbsolute(dir))) {
      throw new Error('AGY legacy native recovery requires the original default-home non-MCP binding');
    }
    if (previous && (resolve(params.cwd) !== resolve(previous.cwd) ||
        JSON.stringify(additionalDirectories) !== JSON.stringify(previous.additionalDirectories ?? []))) {
      throw new Error('AGY legacy native conversation or workspace differs from its original binding');
    }
    const proof = previous?.recovery?.proof ?? params._meta?.['kiki.agyLegacyRecovery'];
    const release = await this.claimResume(params.sessionId);
    try {
      const latest = await readAudit().catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return [];
      });
      const latestRecovery = latest.find(record => record.type === 'legacy_native_recovered');
      if (JSON.stringify(latestRecovery) !== JSON.stringify(previous) ||
          latest.some(record => !['legacy_native_recovered', 'session_loaded', 'owned_recovery', 'permission_mode_configured', 'close'].includes(record.type))) {
        throw new Error('AGY legacy recovery state changed; preserve the original session without replay');
      }
      const model = proof?.model;
      if (typeof model !== 'string' || !model || (this.requestedModel !== DEFAULT && model !== this.requestedModel) ||
          (this.account && !this.account.modelIds.includes(model))) throw new Error('AGY legacy native model is not available for this binding');
      const recovered = await readLegacyNativeRecovery({ nativeHome: this.nativeHome, cwd: params.cwd,
        additionalDirectories, sessionId: params.sessionId, proof, model });
      validateEffort(recovered.model, recovered.effort);
      await this.newSession(params, params.sessionId, previous ? 'session_loaded' : 'legacy_native_recovered', previous ? undefined : { ...recovered, proof });
      const session = this.session(params.sessionId);
      session.model = recovered.model;
      session.effort = recovered.effort;
      session.conversationId = recovered.conversationId;
      session.releaseResume = release;
      return { configOptions: configOptions(session) };
    } catch (error) { await release(); this.sessions.delete(params.sessionId); throw error; }
  }

  session(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Unknown AGY session; use session/load for exact audited native recovery. Fork is unsupported');
    return session;
  }

  async loadVendorModels() {
    if (this.account) {
      this.modelChoices = this.account.modelIds;
      return;
    }
    try {
      const result = await readVendorModelCatalog({
        cliPath: this.cliPath, cliPrefix: this.cliPrefix, spawnProcess: this.spawnProcess, stopProcess: this.stopProcess,
      });
      this.modelChoices = result.ok ? result.ids : undefined;
      this.modelDiagnostic = result.ok ? undefined : result.diagnostic;
    } catch (error) {
      this.modelChoices = undefined;
      this.modelDiagnostic = catalogDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  setModel(session, value) {
    if (session.accountBound && value === DEFAULT) value = this.account.modelIds[0];
    if (typeof value !== 'string' || value.length === 0 || /\s/u.test(value)) throw new Error('AGY model must be a nonempty engine ID');
    if (session.child && session.model !== value) throw new Error('AGY model/effort is frozen after process launch; select a fresh session');
    if (!Array.isArray(session.modelChoices)) throw new Error('AGY model catalog is unavailable; model is selected by argv in its own namespace');
    if (value !== DEFAULT && value !== session.model && !session.modelChoices.includes(value)) {
      throw new Error(`AGY model ID ${value} is not in the vendor catalog`);
    }
    validateEffort(value, session.effort);
    session.model = value;
    return { configOptions: configOptions(session) };
  }

  setConfig(params) {
    const session = this.session(params.sessionId);
    if (params.configId === 'model') return this.setModel(session, params.value);
    if (params.configId === 'permission-mode') return this.setPermissionMode(session, params.value);
    if (params.configId === 'native-agent') {
      if (params.value !== DEFAULT) throw Error('AGY adapter supports only the native default agent; other native agents have not been discovered');
      return { configOptions: configOptions(session) };
    }
    const key = params.configId === 'effort' ? 'effort' : undefined;
    if (!key) throw new Error('Unsupported AGY config option; model is selected by argv in its own namespace');
    if (session.child && session[key] !== params.value) throw new Error('AGY model/effort is frozen after process launch; select a fresh session');
    validateEffort(session.model, params.value);
    session[key] = params.value;
    return { configOptions: configOptions(session) };
  }

  async setPermissionMode(session, value) {
    if (![DEFAULT, 'manual', 'auto', 'yolo'].includes(value)) throw Error(`AGY native permission mode ${value} is unsupported; review requires the Kiki native executor`);
    if (session.permissionMode === value) return { configOptions: configOptions(session) };
    if (session.active) throw Error('AGY permission mode cannot change during an active turn');
    if (session.child) {
      const conversationId = session.init?.conversation_id;
      if (!conversationId || session.broken) throw Error('AGY permission changes require a confirmed healthy native conversation');
      session.restarting = true;
      try {
        await this.stopProcess(session.child);
        await session.cleanup;
        session.conversationId = conversationId;
        session.child = undefined;
        session.init = undefined;
        session.exited = undefined;
        session.cleanup = undefined;
        session.permissionChannel = undefined;
        session.mcpPlugin = undefined;
        session.mcpBound.clear();
        session.mcpReady.clear();
        session.broken = false;
      } finally { session.restarting = false; }
    }
    session.permissionMode = value;
    await this.audit(session, 'permission_mode_configured', { value, mechanism: 'native-session-settings' });
    return { configOptions: configOptions(session) };
  }

  async syncPermissionHook(session) {
    session.permissionChannel ??= await openPermissionChannel(input => ['mcp_bootstrap', 'mcp_ready'].includes(input?.type)
      ? this.bindMcpBootstrap(session, input) : input?.type === 'steer_poll' ? this.pollSteering(session, input)
        : this.requestPermission(), session.permissionIdentity);
  }

  async registerMcpPlugin(session) {
    if (!session.mcpServers.length || session.mcpPlugin) return;
    session.mcpPlugin = await registerProjectMcpPlugin({ cwd: session.cwd, sessionId: session.id, namespace: session.mcpNamespace,
      nodePath: process.execPath, handlerPath: fileURLToPath(import.meta.url), servers: session.mcpServers });
    await this.audit(session, 'mcp_plugin_registered', { name: session.mcpPlugin.name, path: session.mcpPlugin.path,
      servers: session.mcpServers.map(server => server.name), nativeAgent: 'engine-default' });
  }

  async bindMcpBootstrap(session, input) {
    if (!session.mcpPlugin || !Object.hasOwn(session.mcpPlugin.env, input.key) || session.broken) {
      return { decision: 'deny', reason: 'The MCP bootstrap does not belong to this active session' };
    }
    if (input.type === 'mcp_ready') {
      if (!session.mcpBound.has(input.key)) return { decision: 'deny', reason: 'The MCP bootstrap has not been admitted' };
      session.mcpReady.add(input.key);
    } else session.mcpBound.add(input.key);
    await this.audit(session, input.type === 'mcp_ready' ? 'mcp_stdio_ready' : 'mcp_stdio_bound',
      { server: session.mcpServers[Object.keys(session.mcpPlugin.env).indexOf(input.key)].name });
    return { decision: 'allow' };
  }

  /**
   * A previous adapter killed before its close ran can leave its owned hook keys and MCP
   * plugin in this workspace. Before this session registers its own, recover only those
   * whose every recorded owner process has exited; live leases, edited files and foreign
   * entries are preserved and reported in the audit instead of failing the session.
   */
  async recoverDeadOwnedResources(session) {
    if (session.ownedRecoveryDone) return;
    session.ownedRecoveryDone = true;
    const results = {};
    try {
      results.hooks = (await recoverProjectHook({ cwd: session.cwd, nodePath: process.execPath,
        handlerPath: fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url)) })).status;
    } catch (error) { results.hooks = { status: 'preserved', reason: error instanceof Error ? error.message : String(error) }; }
    try { results.plugins = await recoverDeadProjectMcpPlugins({ cwd: session.cwd }); }
    catch (error) { results.plugins = { status: 'preserved', reason: error instanceof Error ? error.message : String(error) }; }
    if (results.hooks !== 'no-owned-registration' || results.plugins.length) this.auditQuietly(session, 'owned_recovery', results);
  }

  async registerSteeringHook(session) {
    session.steeringRegistration ??= await registerProjectHook({ cwd: session.cwd, nodePath: process.execPath,
      handlerPath: fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url)), sessionId: session.id,
      key: AGY_STEERING_HOOK_KEY, args: ['--steering'] });
    if (!session.child && !session.conversationId) {
      session.commandGuidanceRegistration ??= await registerProjectHook({ cwd: session.cwd, nodePath: process.execPath,
        handlerPath: fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url)), sessionId: session.id,
        key: AGY_COMMAND_GUIDANCE_HOOK_KEY, args: ['--command-guidance'] });
    }
  }

  /**
   * Removes the turn's owned steering and startup guidance keys. A failed removal keeps
   * its registration for the next turn end, cancel or close; cleanup never replaces the result.
   */
  async closeSteeringHook(session) {
    const errors = [];
    for (const key of ['steeringRegistration', 'commandGuidanceRegistration']) {
      const registration = session[key];
      if (!registration) continue;
      try {
        await registration.close();
        if (session[key] === registration) session[key] = undefined;
      } catch (error) {
        this.auditQuietly(session, 'steering_hook_close_failed', { registration: key, error: error instanceof Error ? error.message : String(error) });
        errors.push(error);
      }
    }
    if (errors.length) throw errors[0];
  }

  auditQuietly(session, type, data) {
    this.audit(session, type, data).catch(() => {});
  }

  /**
   * Accepts one steering message for the running native turn. The text waits in this
   * session until AGY's next PostInvocation hook drains it into the same invocation loop.
   * An idle session returns `promptRequired` so the host submits a normal prompt instead.
   */
  async steer(params) {
    const session = this.session(params.sessionId);
    const active = session.active;
    if (!active || session.broken || !session.steeringRegistration) return { outcome: 'promptRequired', reason: 'noRunningTurn' };
    const text = promptText(params.prompt);
    const id = randomUUID();
    await this.audit(session, 'steer_queued', { steerId: id, sha256: createHash('sha256').update(text).digest('hex') });
    if (session.active !== active || session.broken || !session.steeringRegistration) {
      this.auditQuietly(session, 'steer_not_delivered', { steerIds: [id] });
      return { outcome: 'promptRequired', reason: 'turnEnded' };
    }
    return new Promise(resolveSteer => active.steering.push({ id, text, resolve: resolveSteer }));
  }

  releaseSteering(session, active) {
    const pending = active.steering.splice(0);
    if (pending.length) this.auditQuietly(session, 'steer_not_delivered', { steerIds: pending.map(item => item.id) });
    for (const item of pending) item.resolve({ outcome: 'promptRequired', reason: 'turnEnded' });
  }

  async pollSteering(session, input) {
    const active = session.active;
    if (!active || session.broken || !session.init || input.conversationId !== session.init.conversation_id) {
      return { decision: 'deny', reason: 'AGY steering poll does not belong to the running turn' };
    }
    if (active.steering.length === 0) return { decision: 'allow', steering: { injectSteps: [] } };
    const batch = active.steering.splice(0);
    this.auditQuietly(session, 'steer_delivering', { steerIds: batch.map(item => item.id), invocationNum: input.invocationNum });
    let settled = false;
    const settle = (outcome, type) => {
      if (settled) return;
      settled = true;
      if (outcome !== 'injected') active.steerDeliveryUnknown = true;
      this.auditQuietly(session, type, { steerIds: batch.map(item => item.id) });
      for (const item of batch) item.resolve({ outcome });
    };
    return { decision: 'allow', steering: { injectSteps: batch.map(item => ({ userMessage: item.text })) },
      afterWrite: () => settle('injected', 'steer_delivered'),
      afterFailure: () => settle('deliveryUnknown', 'steer_delivery_unknown') };
  }

  async start(session) {
    session.denialCounts = new Map();
    await this.registerMcpPlugin(session);
    const args = [...this.cliPrefix, ...launchArgs(session)];
    const env = { ...process.env, ...session.permissionIdentity };
    for (const key of Object.keys(env)) if (key.startsWith('KIKI_AGY_MCP_')) delete env[key];
    Object.assign(env, session.mcpPlugin?.env);
    const account = this.account;
    if (account) Object.assign(env, { GEMINI_API_KEY: account.apiKey, GOOGLE_GEMINI_BASE_URL: account.baseUrl });
    const redact = text => account ? text.replaceAll(account.apiKey, '[redacted]').replaceAll(account.baseUrl, '[redacted]') : text;
    let child;
    try {
      await session.mcpPlugin?.beforeLaunch();
      child = this.spawnProcess(this.cliPath, args, { cwd: session.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    } catch (error) {
      await session.permissionChannel?.close();
      await this.closeSteeringHook(session).catch(() => {});
      await session.mcpPlugin?.close();
      throw error;
    }
    session.child = child;
    session.exited = new Promise(done => child.once('close', done));
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let stderr = Buffer.alloc(0);
    let stderrTruncated = false;
    let delivery = Promise.resolve();
    let ingress = Promise.resolve();
    let sequence = 0;
    let stdoutFailed = false;
    session.drainReceived = () => {
      stdoutFailed = true;
      return Promise.all([ingress, delivery]);
    };
    session.queueInternalAction = action => {
      delivery = delivery.then(action).catch(fail);
      return delivery;
    };
    const fail = error => {
      session.broken = true;
      if (!session.cancelling) void this.stopProcess(child).catch(() => {});
      return this.loseTurn(session, error);
    };
    const failFrame = error => {
      stdoutFailed = true;
      session.broken = true;
      if (!session.cancelling) void this.stopProcess(child).catch(() => {});
      delivery = delivery.then(() => this.loseTurn(session, error));
    };
    child.stdout.on('data', chunk => {
      if (stdoutFailed) return;
      buffer += decoder.write(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { failFrame(new Error('AGY stdout frame exceeds 1 MiB')); return; }
        let event;
        try { event = JSON.parse(line, account ? (_key, value) => typeof value === 'string' ? redact(value) : value : undefined); }
        catch { failFrame(new Error('AGY emitted invalid NDJSON')); return; }
        const frame = { sequence: ++sequence, receivedAt: new Date().toISOString(), event: event?.event,
          stepIndex: event?.step_update?.step_index, stepType: event?.step_update?.step_type,
          state: event?.step_update?.state, status: event?.result?.status };
        this.clearErrorResultWatchdog(session.active);
        ingress = ingress.then(() => this.audit(session, 'native_frame_received', frame)).catch(fail);
        delivery = delivery.then(async () => {
          await this.event(session, event);
          await this.audit(session, 'native_frame_delivered', { sequence: frame.sequence });
        }).catch(fail);
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) failFrame(new Error('AGY stdout frame exceeds 1 MiB'));
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      if (/auto-denied|soft.denied|permission.*denied/i.test(text) && session.active) session.active.denied = true;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrTruncated ||= stderr.length + bytes.length > 8192;
      const tail = Buffer.concat([stderr, bytes.subarray(Math.max(0, bytes.length - 8192))]);
      stderr = tail.subarray(Math.max(0, tail.length - 8192));
      if (!account) process.stderr.write(chunk);
    });
    child.stdin.on('error', error => {
      if (session.child === child && session.active?.continuationWriter !== child) void fail(error);
    });
    child.on('error', fail);
    child.once('close', (code, signal) => {
      const lines = stderr.toString('utf8').split(/\r?\n/u);
      if (stderrTruncated) lines.shift();
      const diagnostic = lines.map(line => safeDiagnosticLine(redact(line))).findLast(line => line !== undefined);
      stderr = Buffer.alloc(0);
      const owned = child;
      const channel = session.permissionChannel;
      if (session.child === owned) session.broken = true;
      session.cleanup = (async () => {
        try {
          await Promise.all([ingress, delivery]);
        } finally {
          if (session.child !== owned) return;
          if (session.active && !session.cancelling) {
            const message = `AGY exited before terminal result (code: ${code ?? 'none'}, signal: ${signal ?? 'none'})${diagnostic === undefined ? '' : `: ${diagnostic}`}`;
            const error = new Error(message);
            error.code = 'AGY_EARLY_EXIT';
            error.details = { exitCode: code ?? null, signal: signal ?? null, diagnostic };
            await this.loseTurn(session, error);
          }
          await channel?.close();
          await this.closeSteeringHook(session).catch(() => {});
          await session.mcpPlugin?.close();
          if (!session.restarting) await session.releaseResume?.();
        }
      })();
      const ended = () => { if (account && session.child === owned && !session.restarting) this.onAccountExit?.(); };
      void session.cleanup.then(ended, error => {
        process.stderr.write(`AGY owned permission cleanup failed: ${redact(error.message)}\n`);
        ended();
      });
    });
    try { await session.mcpPlugin?.launched(child.pid); }
    catch (error) { await this.stopProcess(child); await session.cleanup; throw error; }
    return this.audit(session, 'launch', { cliPath: this.cliPath, args, effort: session.effort, pid: child.pid, cwd: session.cwd });
  }

  unresolvedTools(session) {
    return [...session.toolIds].filter(([, status]) => status === 'pending')
      .map(([toolCallId]) => ({ toolCallId, ...session.toolDetails.get(toolCallId) }));
  }

  unknownToolMessage(reason, tools) {
    return `${reason}: ${tools.map(tool => `${tool.toolCallId} (${tool.name ?? 'unknown tool'}, ${tool.state ?? 'unknown state'})`).join(', ')}; execution state is unknown; do not replay these calls or reuse this session until their native state is reconciled`;
  }

  async settlePendingTools(session, active, message) {
    for (const [toolCallId, status] of session.toolIds) {
      if (status !== 'pending') continue;
      session.toolIds.set(toolCallId, 'settled');
      await active.client.notify('session/update', { sessionId: session.id,
        update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: message } }] } });
    }
  }

  async rejectUnconfirmedTurn(session, active, error, unresolved, preserveMessage = false) {
    const message = unresolved.length ? this.unknownToolMessage(error.message, unresolved) : error.message;
    if (unresolved.length) {
      error.details = { ...error.details, unresolvedTools: unresolved };
      if (!preserveMessage) error.message = message;
      await this.settlePendingTools(session, active, message).catch(() => {});
    }
    session.failure = `${message}; create a fresh session`;
    active.reject(error);
  }

  async loseTurn(session, error) {
    const active = session.active;
    if (!active || session.cancelling) return;
    this.clearErrorResultWatchdog(active);
    session.active = undefined;
    const unresolved = this.unresolvedTools(session);
    if (unresolved.length) await this.audit(session, 'tool_terminal_missing', { reason: 'stream_lost', tools: unresolved }).catch(auditError => {
      error.details = { ...error.details, retirementAuditError: auditError.message };
    });
    await this.rejectUnconfirmedTurn(session, active, error, unresolved);
  }

  clearErrorResultWatchdog(active) {
    if (!active?.errorWatchdog) return;
    clearTimeout(active.errorWatchdog);
    active.errorWatchdog = undefined;
  }

  armErrorResultWatchdog(session, active) {
    this.clearErrorResultWatchdog(active);
    if (typeof this.errorResultWatchdogMs !== 'number' || this.errorResultWatchdogMs <= 0 || !Number.isFinite(this.errorResultWatchdogMs)) return;
    if (session.active !== active || session.cancelling || session.restarting) return;
    const child = session.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const token = Symbol('errorWatchdog');
    active.errorWatchdogToken = token;
    const timer = setTimeout(() => {
      if (active.errorWatchdog === timer) active.errorWatchdog = undefined;
      if (session.active !== active || active.errorWatchdogToken !== token || session.cancelling || session.restarting || session.child !== child) return;
      void session.queueInternalAction?.(() => this.onErrorResultWatchdog(session, active, child, token));
    }, this.errorResultWatchdogMs);
    timer.unref?.();
    active.errorWatchdog = timer;
  }

  async onErrorResultWatchdog(session, active, child, token) {
    if (session.active !== active || active.errorWatchdogToken !== token || session.cancelling || session.restarting || session.child !== child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (active.lastStepType !== 'error_message' || active.lastStepState !== 'DONE') return;
    const conversationId = session.init?.conversation_id ?? session.conversationId;
    const dbState = await inspectNativeErrorWatchdogState({ nativeHome: this.nativeHome, conversationId });
    if (session.active !== active || active.errorWatchdogToken !== token || session.cancelling || session.restarting || session.child !== child) return;
    if (dbState.status === 'retrying' && (active.consecutiveErrorSteps ?? 0) < 2) {
      this.armErrorResultWatchdog(session, active);
      return;
    }
    if (dbState.status === 'no_terminal_error') return;
    const unresolved = this.unresolvedTools(session);
    const errorText = dbState.status === 'terminal_error'
      ? (dbState.error ?? LEGACY_NETWORK_FAILURE)
      : active.lastErrorStepText || LEGACY_NETWORK_FAILURE;
    await this.audit(session, 'error_result_watchdog_triggered', {
      conversationId,
      stepIndex: active.lastStepIndex,
      consecutiveErrorSteps: active.consecutiveErrorSteps ?? 1,
      dbStatus: dbState.status,
      unresolvedCount: unresolved.length,
    });
    if (session.active !== active || session.cancelling) return;
    if (dbState.status === 'incomplete_steps' || dbState.status === 'db_error' || !active.promptConsumed || unresolved.length > 0) {
      session.broken = true;
      await session.permissionChannel?.close();
      await this.stopProcess(child).catch(() => {});
      await session.exited;
      if (session.active !== active || session.cancelling) return;
      const error = new Error(`AGY stalled after error_message step ${active.lastStepIndex ?? 'unknown'} without emitting a terminal result (${dbState.status})`);
      error.code = 'AGY_ERROR_RESULT_TIMEOUT';
      error.details = { conversationId, stepIndex: active.lastStepIndex, dbStatus: dbState.status };
      await this.loseTurn(session, error);
      return;
    }
    await this.event(session, {
      event: 'result',
      result: {
        conversation_id: conversationId,
        status: 'ERROR',
        error: errorText,
      },
      _watchdogSynthesized: true,
      _watchdogConfirmedFlush: dbState.status === 'terminal_error' || (dbState.status === 'missing_db' && NATIVE_ID.test(conversationId ?? '')),
    });
  }

  async event(session, event) {
    if (!event || typeof event !== 'object') throw new Error('Invalid AGY event');
    if (event.event === 'init') {
      if (session.init) throw new Error('AGY sent duplicate init');
      const init = event.init;
      const sameWorkspace = typeof init?.cwd === 'string' &&
        (process.platform === 'win32'
          ? resolve(init.cwd).toLowerCase() === resolve(session.cwd).toLowerCase()
          : resolve(init.cwd) === resolve(session.cwd));
      if (!sameWorkspace) throw new Error('AGY init cwd does not match the frozen workspace binding; do not run tools in another project');
      if (session.model !== DEFAULT && init?.model !== session.model) throw new Error('AGY init model does not match the explicit binding');
      if (session.conversationId && event.conversation_id !== session.conversationId) throw new Error('AGY init conversation does not match the exact native resume binding');
      session.init = event;
      await this.audit(session, 'agy_init', { conversationId: event.conversation_id, model: init?.model,
        agent: init?.agent, cwd: init?.cwd, projectId: init?.project_id ?? event.project_id, permissionMode: init?.permission_mode, tools: init?.tools });
      return;
    }
    const active = session.active;
    if (!active && session.broken) return;
    if (!active) throw new Error('AGY event arrived outside an active turn');
    if (event.event === 'step_update') {
      const step = event.step_update;
      if (!step || typeof step.step_type !== 'string') throw new Error('Malformed AGY step');
      if (step.step_type === 'user_input' && step.state === 'DONE') {
        active.promptConsumed = true;
        active.continuationWriter = undefined;
        active.lastStepType = 'user_input';
        active.lastStepState = step.state;
        active.lastStepIndex = step.step_index;
        active.consecutiveErrorSteps = 0;
        active.lastErrorStepText = undefined;
        active.finalResponseDone = false;
        active.finalResponseStepIndex = undefined;
        active.finalResponseText = '';
        if (Number.isSafeInteger(step.step_index)) active.progressFloor = Math.max(active.progressFloor, step.step_index);
        await this.audit(session, 'prompt_consumed', { stepIndex: step.step_index });
      } else {
        active.lastStepType = step.step_type;
        active.lastStepState = step.state;
        active.lastStepIndex = step.step_index;
        if (step.step_type === 'error_message') {
          active.consecutiveErrorSteps = (active.consecutiveErrorSteps ?? 0) + 1;
          const stepError = typeof step.error === 'string' && step.error ? step.error
            : typeof step.error?.message === 'string' && step.error.message ? step.error.message
            : typeof step.text_delta === 'string' && step.text_delta ? step.text_delta
            : undefined;
          if (stepError !== undefined) active.lastErrorStepText = stepError;
        } else {
          active.consecutiveErrorSteps = 0;
          active.lastErrorStepText = undefined;
        }
        if (step.step_type !== 'agent_response') {
          active.finalResponseDone = false;
          active.finalResponseStepIndex = undefined;
          active.finalResponseText = '';
        }
      }
      active.usageSteps ??= new Set();
      active.usage ??= emptyUsage();
      if (accumulateStepUsage(active.usageSteps, active.usage, step)) {
        await this.audit(session, 'native_usage', { stepIndex: step.step_index, usage: { ...active.usage } });
      }
      const freshStep = active.promptConsumed && Number.isSafeInteger(step.step_index) && step.step_index > active.progressFloor;
      if (step.step_type === 'agent_response') {
        if (active.finalResponseStepIndex !== step.step_index) {
          active.finalResponseStepIndex = step.step_index;
          active.finalResponseText = '';
          active.finalResponseDone = false;
        }
        if (typeof step.text_delta === 'string' && step.text_delta) {
          active.text += step.text_delta;
          active.finalResponseText += step.text_delta;
          await active.client.notify('session/update', { sessionId: session.id,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.text_delta } } });
        }
        active.finalResponseDone = step.state === 'DONE' && active.finalResponseText.length > 0;
        if (freshStep && active.finalResponseDone && active.finalResponseText.trim()) active.progressSinceRecovery = true;
      }
      if (step.step_type === 'tool' || step.step_type === 'subagent') {
        const id = `agy-${event.conversation_id ?? session.init?.conversation_id}-${step.step_index}`;
        const previousName = session.toolDetails.get(id)?.name;
        const detail = { name: step.tool_name ?? step.tool_info?.name ?? previousName ?? (step.step_type === 'subagent' ? 'invoke_subagent' : undefined), state: step.state };
        const parameters = step.tool_info?.parameters ?? step.parameters;
        const structured = subagentPayload(step);
        const rawInput = structured === undefined ? parameters : {
          ...(parameters !== null && typeof parameters === 'object' && !Array.isArray(parameters) ? parameters : {}),
          ...structured,
        };
        const previousInput = session.toolInputs.get(id);
        if (rawInput !== undefined) session.toolInputs.set(id, rawInput);
        session.toolDetails.set(id, detail);
        if (!session.toolIds.has(id)) {
          session.toolIds.set(id, 'pending');
          await active.client.notify('session/update', { sessionId: session.id, update: { sessionUpdate: 'tool_call',
            toolCallId: id, title: detail.name ?? 'AGY tool', name: detail.name, kind: 'other', status: 'in_progress', rawInput, ...(structured === undefined ? {} : { _meta: structured }) } });
        } else if (session.active === active && step.state !== 'DONE' && step.state !== 'ERROR' && session.toolIds.get(id) === 'pending' &&
          (detail.name !== previousName || rawInput !== undefined && JSON.stringify(rawInput) !== JSON.stringify(previousInput))) {
          await active.client.notify('session/update', { sessionId: session.id, update: { sessionUpdate: 'tool_call_update',
            toolCallId: id, title: detail.name, name: detail.name, status: 'in_progress', rawInput: rawInput ?? previousInput, ...(structured === undefined ? {} : { _meta: structured }) } });
        }
        await this.audit(session, 'tool_state', { toolCallId: id, ...detail });
        if (session.active === active && (step.state === 'DONE' || step.state === 'ERROR') && session.toolIds.get(id) === 'pending') {
          const failed = step.state === 'ERROR' || Boolean(step.tool_info?.error);
          if (freshStep && !failed) active.progressSinceRecovery = true;
          const error = step.tool_info?.error ?? step.error;
          session.toolIds.set(id, 'settled');
          const errorText = typeof error === 'string' ? error : error?.message;
          const output = step.tool_info?.output ?? step.tool_info?.result ?? errorText ?? (failed ? 'AGY tool reported an error' : undefined);
          if (failed && /^tool call denied by pre-tool hook:/i.test(String(errorText ?? output ?? '').trimStart())) {
            (active.preToolDenied ??= new Set()).add(id);
            await this.audit(session, 'pre_tool_hook_denied', { toolCallId: id, error: errorText ?? output });
          }
          const finalInput = rawInput ?? previousInput;
          await active.client.notify('session/update', { sessionId: session.id,
            update: { sessionUpdate: 'tool_call_update', toolCallId: id, title: detail.name, name: detail.name,
              status: failed ? 'failed' : 'completed', rawInput: finalInput, ...(structured === undefined ? {} : { _meta: structured }),
              rawOutput: output, content: typeof output === 'string'
                ? [{ type: 'content', content: { type: 'text', text: output } }] : undefined } });
        }
      }
      if (step.step_type === 'error_message' && step.state === 'DONE') {
        this.armErrorResultWatchdog(session, active);
      }
      return;
    }
    this.clearErrorResultWatchdog(active);
    if (event.event !== 'result' || !event.result) throw new Error(`Unsupported AGY event: ${event.event}`);
    const result = event.result;
    await this.audit(session, 'agy_result', { conversationId: result.conversation_id, status: result.status,
      numTurns: result.num_turns, usage: result.usage, deniedActions: result.denied_actions,
      synthesizedByWatchdog: event._watchdogSynthesized === true ? true : undefined,
      responseSha256: createHash('sha256').update(result.response ?? '').digest('hex') });
    const newDenials = takeNewDenials(result.denied_actions, session.denialCounts);
    if (session.active !== active || session.cancelling) return;
    if (result.status === 'SUCCESS' && session.mcpServers.length !== session.mcpReady.size) {
      throw new Error('AGY did not activate and initialize the requested session MCP plugin; preserve native plugin/MCP off settings and review the connection instead of switching agents');
    }
    const unresolved = this.unresolvedTools(session);
    const unresolvedMessage = unresolved.length
      ? this.unknownToolMessage('AGY terminal result arrived before a tool terminal update', unresolved) : undefined;
    if (unresolved.length) {
      session.broken = true;
      session.failure = unresolvedMessage;
      await this.audit(session, 'tool_terminal_missing', { conversationId: result.conversation_id, nativeStatus: result.status, tools: unresolved });
    }
    let error;
    let stopReason = 'end_turn';
    let stopAfterResult = false;
    let postResponseTerminalError;
    const nonRecoverableError = /\b(?:401|403|429|RESOURCE_EXHAUSTED|UNAUTHENTICATED|PERMISSION_DENIED)\b|quota[\s_-]*(?:reached|exceeded|exhausted)|rate[\s_-]*limit|insufficient[\s_-]*quota|unauthorized|authentication\s+failed/i;
    const lateTransportDisconnect = result.status === 'ERROR'
      && typeof result.error === 'string'
      && /\b(?:wsarecv|wsasend|connectex|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|EOF|UNAVAILABLE|DEADLINE_EXCEEDED|502|503|504)\b|socket\s+hang\s+up|dial\s+tcp|read\s+tcp|write\s+tcp|actively\s+refused|connection\s+refused|connection\s+attempt\s+failed|connection\s+was\s+forcibly\s+closed|broken\s+pipe|tls\s+handshake\s+timeout|context\s+deadline\s+exceeded|http2:\s+(?:client\s+connection\s+(?:lost|force\s+closed)|server\s+sent\s+GOAWAY)|stream\s+error:\s+stream\s+ID|bad\s+gateway|service\s+unavailable|gateway\s+timeout/i.test(result.error)
      && !nonRecoverableError.test(result.error);
    const replayedSummaryError = result.status === 'ERROR'
      && typeof result.error === 'string'
      && (result.error === LEGACY_NETWORK_FAILURE || /^The stream was interrupted\. Please continue the task you were working on\.$/i.test(result.error))
      && !nonRecoverableError.test(result.error);
    const confirmedFinalResponse = Boolean(
      (lateTransportDisconnect || replayedSummaryError)
      && active.promptConsumed
      && !unresolved.length
      && active.steering.length === 0
      && !active.steerDeliveryUnknown
      && active.lastStepType === 'agent_response'
      && active.lastStepState === 'DONE'
      && active.finalResponseDone
      && active.text.length > active.segmentStart
      && (lateTransportDisconnect
        ? typeof result.response !== 'string' || result.response.length === 0 || result.response === active.text.slice(active.segmentStart)
        : typeof result.response === 'string' && result.response.length > 0 && result.response === active.text.slice(active.segmentStart)),
    );
    const recoverableNetworkError = (lateTransportDisconnect || replayedSummaryError)
      && !confirmedFinalResponse
      && active.promptConsumed
      && unresolved.length === 0
      && active.steering.length === 0
      && !active.steerDeliveryUnknown
      && !active.denied
      && newDenials.length === 0
      && !active.preToolDenied?.size;
    if (recoverableNetworkError && active.progressSinceRecovery) {
      active.networkRecoveries = 0;
      active.progressSinceRecovery = false;
    }
    const continuationAllowed = recoverableNetworkError
      && active.networkRecoveries < this.maxConsecutiveNetworkRecoveries;
    if (continuationAllowed) {
      const attempt = active.networkRecoveries + 1;
      const preservedTools = session.toolIds.size;
      await this.audit(session, 'network_recovery_requested', {
        conversationId: result.conversation_id, nativeStatus: result.status, error: result.error,
        attempt, totalAttempts: active.networkRecoveriesTotal + 1, preservedTools, preservedTextLength: active.text.length,
        liveChild: Boolean(session.child && session.child.exitCode === null && session.child.signalCode === null),
      });
      if (session.active !== active || session.cancelling) return;
      active.networkRecoveries = attempt;
      active.networkRecoveriesTotal += 1;
      try {
        const sent = await this.continueNetworkFailure(session, active, attempt, result, {
          allowForcedExit: event._watchdogConfirmedFlush === true,
        });
        if (sent?.outcome === 'sent') {
          await this.audit(session, 'network_recovery_sent', {
            conversationId: sent.conversationId, attempt, relaunched: sent.relaunched,
            bytes: sent.bytes, frameSha256: sent.frameSha256,
          });
          return;
        }
        active.networkRecoveries -= 1;
        active.networkRecoveriesTotal -= 1;
        if (sent?.outcome === 'unknown') {
          const message = `AGY terminal status ${result.status}: ${result.error ?? 'no success result'};`
            + ` delivery of automatic continuation ${attempt} is unconfirmed`
            + '; it is not re-sent and no new conversation is opened; inspect the native outcome before continuing';
          await this.audit(session, 'network_recovery_failed', {
            conversationId: result.conversation_id, attempt, delivery: 'unknown',
          });
          error = new Error(message);
          error.details = { nativeError: result.error, attempt, recoveries: active.networkRecoveriesTotal, preservedTools,
            conversationId: result.conversation_id, delivery: 'unknown' };
          session.broken = true;
          session.failure = message;
          stopAfterResult = true;
        } else if (sent?.outcome === 'exit_unconfirmed') {
          const message = `AGY terminal status ${result.status}: ${result.error ?? 'no success result'};`
            + ` headless CLI did not exit cleanly after the terminal error (${sent.reason}`
            + `; exitCode: ${sent.exitCode ?? 'none'}, signal: ${sent.signal ?? 'none'})`
            + '; native state flush is unconfirmed, so automatic continuation was not sent; inspect the native outcome before continuing';
          await this.audit(session, 'network_recovery_failed', {
            conversationId: result.conversation_id, attempt, delivery: 'not_sent',
            reason: sent.reason, exitCode: sent.exitCode ?? null, signal: sent.signal ?? null,
          });
          error = new Error(message);
          error.details = { nativeError: result.error, attempt, recoveries: active.networkRecoveriesTotal, preservedTools,
            conversationId: result.conversation_id, delivery: 'not_sent', reason: sent.reason,
            exitCode: sent.exitCode ?? null, signal: sent.signal ?? null };
          session.broken = true;
          session.failure = message;
          stopAfterResult = true;
        } else {
          await this.audit(session, 'network_recovery_skipped', {
            conversationId: result.conversation_id, attempt, reason: 'conversation_evidence_incomplete',
          });
        }
      } catch (continueError) {
        active.networkRecoveries -= 1;
        active.networkRecoveriesTotal -= 1;
        const message = `AGY terminal status ${result.status}: ${result.error ?? 'no success result'};`
          + ` automatic continuation ${attempt} could not be delivered: ${continueError instanceof Error ? continueError.message : String(continueError)}`
          + '; delivery of the continuation is unknown and it is not retried; inspect the native outcome before continuing';
        await this.audit(session, 'network_recovery_failed', {
          conversationId: result.conversation_id, attempt, delivery: 'unknown',
          error: continueError instanceof Error ? continueError.message : String(continueError),
        });
        error = new Error(message);
        error.details = { nativeError: result.error, attempt, recoveries: active.networkRecoveriesTotal, preservedTools,
          conversationId: result.conversation_id, delivery: 'unknown' };
        session.broken = true;
        session.failure = message;
        stopAfterResult = true;
      }
    }
    if (recoverableNetworkError && !continuationAllowed) {
      const preservedTools = session.toolIds.size;
      const consecutiveRecoveries = active.networkRecoveries;
      const message = `AGY terminal status ${result.status}: ${result.error ?? 'no success result'}; automatic continuation stopped after`
        + ` ${consecutiveRecoveries} consecutive attempts without progress;`
        + ` every completed tool result (${preservedTools}) and native conversation ${result.conversation_id ?? '(unknown)'} are retained;`
        + ' load that exact native conversation to continue it, instead of replaying the prompt or the finished tool calls';
      await this.audit(session, 'network_recovery_exhausted', {
        conversationId: result.conversation_id, error: result.error, recoveries: active.networkRecoveriesTotal, consecutiveRecoveries, preservedTools,
      });
      error = new Error(message);
      error.details = { nativeError: result.error, recoveries: active.networkRecoveriesTotal, consecutiveRecoveries, preservedTools,
        conversationId: result.conversation_id };
      session.broken = true;
      session.failure = message;
      stopAfterResult = true;
    }
    if (active.denied || newDenials.length > 0 || active.preToolDenied?.size) {
      active.denied = false;
      const actions = [...new Set(newDenials.map(action => typeof action?.action === 'string' ? action.action : 'unknown'))];
      const message = `AGY permission denied${actions.length ? ` for ${actions.join(', ')}` : ''}; ${active.preToolDenied?.size
        ? 'a PreToolUse hook rejected a tool before execution; retain the denial; terminal SUCCESS is not evidence that the requested work ran'
        : 'the native AGY permission policy did not approve the action'}${unresolvedMessage ? `; ${unresolvedMessage}` : ''}`;
      await this.settlePendingTools(session, active, message);
      process.stderr.write(`${message}\n`);
      error = new Error(message);
      error.code = 'AGY_PERMISSION_DENIED';
      error.details = { deniedToolCallIds: [...(active.preToolDenied ?? [])], unresolvedTools: unresolved };
    } else if (result.status === 'CANCELED' || result.status === 'INTERRUPTED' || (result.status === 'ERROR' && result.error === 'interrupted')) {
      const message = unresolvedMessage ?? `AGY turn ${result.status.toLowerCase()}; do not replay interrupted prompts or commands`;
      session.broken = true;
      session.failure = message;
      await this.settlePendingTools(session, active, message);
      stopReason = 'cancelled';
      stopAfterResult = true;
    } else if (result.status !== 'SUCCESS' && confirmedFinalResponse) {
      postResponseTerminalError = `AGY terminal status ${result.status}: ${result.error ?? 'no success result'}`;
      session.broken = true;
      session.failure = postResponseTerminalError;
      stopAfterResult = true;
    } else if (result.status !== 'SUCCESS' && error === undefined) {
      const message = `AGY terminal status ${result.status}: ${result.error ?? 'no success result'}`;
      await this.settlePendingTools(session, active, unresolvedMessage ?? message);
      error = new Error(unresolvedMessage ? `${message}; ${unresolvedMessage}` : message);
      session.broken = true;
      session.failure = error.message;
      stopAfterResult = true;
    } else if (unresolvedMessage) {
      await this.settlePendingTools(session, active, unresolvedMessage);
      error = new Error(unresolvedMessage);
      error.code = 'AGY_TOOL_TERMINAL_MISSING';
      error.details = { conversationId: result.conversation_id, unresolvedTools: unresolved };
    } else if (error === undefined && active.text.length === active.segmentStart && result.response) {
      await active.client.notify('session/update', { sessionId: session.id,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: result.response } } });
    }
    if (session.active !== active || session.cancelling) return;
    if (postResponseTerminalError !== undefined) {
      await this.audit(session, 'post_response_terminal_error', {
        conversationId: result.conversation_id,
        status: result.status,
        error: result.error,
        stepIndex: active.finalResponseStepIndex,
        responseSha256: createHash('sha256').update(active.text).digest('hex'),
      });
    }
    if (stopReason === 'cancelled') {
      await this.audit(session, 'cancel', { pid: session.child?.pid, processEnded: false, resumeSupported: false, unresolvedTools: unresolved });
    } else if (!unresolved.length && error?.details?.delivery !== 'unknown' && error?.details?.delivery !== 'not_sent') {
      await this.audit(session, 'native_turn_reconciled', {
        status: result.status,
        preservedCompletedResponse: postResponseTerminalError !== undefined ? true : undefined,
      });
    }
    if (session.active !== active || session.cancelling) return;
    session.active = undefined;
    if (stopAfterResult) {
      await session.permissionChannel?.close();
      await this.stopProcess(session.child).catch(() => {});
      await session.exited;
      await this.closeSteeringHook(session).catch(() => {});
      await session.mcpPlugin?.close();
      if (!session.restarting) await session.releaseResume?.();
    }
    if (error) active.reject(error);
    else active.resolve({ stopReason, ...(active.usageSteps?.size ? { usage: { ...active.usage } } : {}) });
  }

  async prompt(params, client) {
    const session = this.session(params.sessionId);
    if (session.broken) throw new Error(session.failure ?? 'AGY process ended; create a fresh session (no implicit resume/history handoff)');
    if (session.active) throw new Error('AGY session already has an active turn');
    const content = promptText(params.prompt);
    const promise = new Promise((resolveTurn, rejectTurn) => {
      const active = { client, text: '', steering: [], networkRecoveries: 0, networkRecoveriesTotal: 0, segmentStart: 0,
        progressSinceRecovery: false, progressFloor: -1, recoveryAbort: new AbortController(), usageSteps: new Set(), usage: emptyUsage(), denied: false,
        resolve: value => { this.clearErrorResultWatchdog(active); this.releaseSteering(session, active); void this.closeSteeringHook(session).catch(() => {}).then(() => resolveTurn(value)); },
        reject: error => { this.clearErrorResultWatchdog(active); this.releaseSteering(session, active); void this.closeSteeringHook(session).catch(() => {}).then(() => rejectTurn(error)); } };
      session.active = active;
    });
    promise.catch(() => {});
    try {
      session.preparing = (async () => {
        await this.recoverDeadOwnedResources(session);
        await this.syncPermissionHook(session);
        await this.registerSteeringHook(session);
        if (!session.broken && !session.child) await this.start(session);
      })();
      try { await session.preparing; } finally { session.preparing = undefined; }
      if (session.broken) return await promise;
      await this.audit(session, 'native_turn_pending');
      if (session.broken) return await promise;
      const frame = JSON.stringify({ event: 'user', message: { content } }) + '\n';
      try {
        await new Promise((done, reject) => session.child.stdin.write(frame, error => error ? reject(error) : done()));
      } catch (error) {
        if (session.broken) return await promise;
        throw error;
      }
      await this.audit(session, 'prompt_sent', { bytes: Buffer.byteLength(frame),
        promptSha256: createHash('sha256').update(content).digest('hex'),
        frameSha256: createHash('sha256').update(frame).digest('hex'), delivery: 'unchanged_user_text' });
      return await promise;
    } catch (error) {
      if (session.active) { this.clearErrorResultWatchdog(session.active); this.releaseSteering(session, session.active); session.active = undefined; }
      await this.closeSteeringHook(session).catch(() => {});
      throw error;
    }
  }

  async cancel(params) {
    const session = this.session(params.sessionId);
    if (session.cancelling) return session.cancelling;
    session.cancelling = this.cancelOwnedSession(session);
    try { await session.cancelling; } finally { session.cancelling = undefined; }
  }

  /**
   * Continues the same native conversation after a recoverable network terminal error, using
   * only evidence the adapter already confirmed: the finished terminal result, the native UUID
   * conversation ID it named, settled tool states, and a natural process exit.
   *
   * After emitting a terminal `result: ERROR` frame, headless AGY ends its invocation loop and
   * exits once its native SQLite and transcript flush completes. Close its stdin, wait for that
   * natural exit, relaunch the CLI with the recorded `--conversation`, and send only the
   * continuation frame. If the process must be force-stopped on timeout or exits via a signal,
   * native persistence is unconfirmed and the continuation is not sent.
   */
  async continueNetworkFailure(session, active, attempt, result, { allowForcedExit = false } = {}) {
    if (session.active !== active || session.cancelling || active.denied) return undefined;
    const conversationId = typeof result?.conversation_id === 'string' && result.conversation_id ? result.conversation_id : undefined;
    if (!conversationId || !NATIVE_ID.test(conversationId)) return undefined;
    if (session.init?.conversation_id !== undefined && session.init.conversation_id !== conversationId) return undefined;
    if (session.conversationId !== undefined && session.conversationId !== conversationId) return undefined;
    const owned = session.child;
    if (!owned) return undefined;
    const frame = JSON.stringify({ event: 'user',
      message: { content: `${NETWORK_RECOVERY_INSTRUCTION} (automatic continuation ${attempt}).` } }) + '\n';
    session.restarting = true;
    let exitUnconfirmed;
    try {
      const prepare = async () => {
        let forceStopped = false;
        if (owned.exitCode === null && owned.signalCode === null) {
          owned.stdin.end();
          let timer;
          const stopFallback = new Promise((_, reject) => {
            timer = setTimeout(() => {
              forceStopped = true;
              void this.stopProcess(owned).catch(reject);
            }, this.continuationExitGraceMs);
          });
          try { await Promise.race([session.exited, stopFallback]); } finally { clearTimeout(timer); }
        }
        await session.exited;
        if (session.active !== active || session.cancelling) return;
        const exitCode = owned.exitCode ?? null;
        const signal = owned.signalCode ?? null;
        await session.permissionChannel?.close();
        await this.closeSteeringHook(session);
        await session.mcpPlugin?.close();
        session.child = undefined;
        session.init = undefined;
        session.exited = undefined;
        session.cleanup = undefined;
        session.permissionChannel = undefined;
        session.mcpPlugin = undefined;
        session.mcpBound.clear();
        session.mcpReady.clear();
        if (!allowForcedExit && (forceStopped || signal !== null || !Number.isSafeInteger(exitCode) || exitCode < 0)) {
          exitUnconfirmed = {
            outcome: 'exit_unconfirmed',
            conversationId,
            reason: forceStopped ? 'exit_timeout_stopped' : signal !== null ? 'signal_exit' : 'missing_exit_code',
            exitCode,
            signal,
          };
          return;
        }
        await this.audit(session, 'close', {
          pid: owned.pid,
          processEnded: true,
          exitCode,
          signal,
          forcedAfterWatchdog: allowForcedExit && forceStopped ? true : undefined,
        });
        const backoff = this.networkRecoveryBackoffMs[Math.min(attempt - 1, this.networkRecoveryBackoffMs.length - 1)] ?? 0;
        const { signal: recoverySignal } = active.recoveryAbort;
        if (backoff > 0) {
          try { await delay(backoff, undefined, { signal: recoverySignal }); }
          catch (error) { if (error.code !== 'ABORT_ERR') throw error; }
        }
        if (session.active !== active || session.cancelling || recoverySignal.aborted) return;
        session.conversationId = conversationId;
        session.broken = false;
        await this.syncPermissionHook(session);
        await this.registerSteeringHook(session);
        if (session.active !== active || session.cancelling) return;
        await this.start(session);
      };
      session.preparing = prepare();
      try { await session.preparing; } finally { session.preparing = undefined; }
    } finally { session.restarting = false; }
    if (exitUnconfirmed) return exitUnconfirmed;
    if (session.active !== active || session.broken || session.cancelling) return undefined;
    const relaunched = await this.#writeContinuation(session, active, frame);
    if (relaunched === 'not-written') return undefined;
    if (relaunched === 'unknown') return { outcome: 'unknown', conversationId };
    return { outcome: 'sent', conversationId, relaunched: true, bytes: Buffer.byteLength(frame),
      frameSha256: createHash('sha256').update(frame).digest('hex') };
  }

  async #writeContinuation(session, active, frame) {
    const child = session.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return 'not-written';
    active.continuationWriter = child;
    active.promptConsumed = false;
    active.consecutiveErrorSteps = 0;
    active.lastErrorStepText = undefined;
    active.segmentStart = active.text.length;
    active.finalResponseDone = false;
    active.finalResponseStepIndex = undefined;
    active.finalResponseText = '';
    active.progressSinceRecovery = false;
    try {
      await new Promise((done, reject) => child.stdin.write(frame, error => error ? reject(error) : done()));
      return 'written';
    } catch {
      return 'unknown';
    }
  }

  async cancelOwnedSession(session) {
    const active = session.active;
    this.clearErrorResultWatchdog(active);
    active?.recoveryAbort.abort();
    session.broken = true;
    let requestAuditError;
    try {
      try { await this.audit(session, 'cancel_requested', { pid: session.child?.pid, resumeSupported: false }); }
      catch (error) { requestAuditError = error; }
      await session.preparing?.catch(() => {});
      await session.permissionChannel?.close();
      await this.stopProcess(session.child);
      await session.exited;
      await session.cleanup;
      await this.closeSteeringHook(session).catch(() => {});
      await session.mcpPlugin?.close();
      if (requestAuditError) throw requestAuditError;
      const unresolved = this.unresolvedTools(session);
      if (active && unresolved.length) {
        await this.settlePendingTools(session, active, this.unknownToolMessage('AGY turn cancelled before a tool terminal update', unresolved));
      }
      await this.audit(session, 'cancel', { pid: session.child?.pid, processEnded: true, resumeSupported: false, unresolvedTools: unresolved });
      active?.resolve({ stopReason: 'cancelled' });
    } catch (error) {
      await session.drainReceived?.();
      session.active = undefined;
      const unresolved = this.unresolvedTools(session);
      const exitCode = session.child?.exitCode ?? null;
      const signal = session.child?.signalCode ?? null;
      const outcome = { processEnded: exitCode !== null || signal !== null, exitCode, signal };
      const failure = requestAuditError ?? error;
      const cancelError = failure === error ? undefined : { code: error.code, message: error.message };
      failure.details = { ...failure.details, ...outcome, cancelError };
      await this.audit(session, 'cancel_failed', { pid: session.child?.pid, ...outcome, unresolvedTools: unresolved, cancelError }).catch(auditError => {
        failure.details.retirementAuditError = auditError.message;
      });
      if (active) await this.rejectUnconfirmedTurn(session, active, failure, unresolved, failure === requestAuditError);
      throw failure;
    } finally {
      session.active = undefined;
    }
  }

  close() {
    this.closePromise ??= Promise.all([...this.sessions.values()].map(async session => {
      if (session.cancelling) await session.cancelling.catch(() => {});
      const active = session.active; this.clearErrorResultWatchdog(active); session.active = undefined; session.broken = true;
      try {
        const unresolved = this.unresolvedTools(session);
        if (active && unresolved.length) {
          await this.audit(session, 'tool_terminal_missing', { reason: 'connection_closed', tools: unresolved });
          await this.settlePendingTools(session, active, this.unknownToolMessage('ACP connection closed before a tool terminal update', unresolved));
        }
      } finally {
        active?.reject(new Error('ACP connection closed'));
        await session.preparing?.catch(() => {});
        await session.permissionChannel?.close();
        if (session.child && session.child.exitCode === null && session.child.signalCode === null) {
          session.child.stdin.end();
          let timer;
          const stopFailure = new Promise((_, reject) => {
            timer = setTimeout(() => { void this.stopProcess(session.child).catch(reject); }, 3000);
          });
          try { await Promise.race([session.exited, stopFailure]); } finally { clearTimeout(timer); }
        }
        await session.cleanup;
        await this.closeSteeringHook(session).catch(() => {});
        await session.mcpPlugin?.close();
        await session.releaseResume?.();
        await this.audit(session, 'close', { pid: session.child?.pid, processEnded: true });
      }
    }));
    return this.closePromise;
  }
}

export async function runSessionMcp(key) {
  if (!/^KIKI_AGY_MCP_[a-f0-9_]+_[0-9]+$/.test(key)) throw new Error('Invalid session MCP environment key');
  if (process.env[key] === undefined) {
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      if (!Object.hasOwn(request, 'id')) continue;
      let result;
      if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion,
        capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'kiki-unbound-session', version: '1' } };
      else if (request.method === 'tools/list') result = { tools: [] };
      else if (request.method === 'resources/list') result = { resources: [] };
      else if (request.method === 'resources/templates/list') result = { resourceTemplates: [] };
      else if (request.method === 'prompts/list') result = { prompts: [] };
      else if (request.method === 'ping') result = {};
      process.stdout.write(JSON.stringify(result === undefined
        ? { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'No Kiki session lease is bound to this process' } }
        : { jsonrpc: '2.0', id: request.id, result }) + '\n');
    }
    return;
  }
  const server = JSON.parse(process.env[key]);
  if (!server || typeof server.command !== 'string' || !Array.isArray(server.args) || !Array.isArray(server.env)) {
    throw new Error('Session MCP launch context is invalid');
  }
  const admission = await requestHookPermission({ type: 'mcp_bootstrap', key }, process.env, 10_000);
  if (admission.decision !== 'allow') throw new Error('The session MCP bootstrap was not admitted by its owning adapter');
  const env = { ...process.env, ...Object.fromEntries(server.env.map(entry => [entry.name, entry.value])) };
  for (const name of Object.keys(env)) if (name.startsWith('KIKI_AGY_')) delete env[name];
  const child = spawn(server.command, server.args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const closed = new Promise(done => child.once('close', done));
  const output = createInterface({ input: child.stdout });
  let failure;
  const fail = error => { failure ??= error; output.close(); };
  child.once('error', fail);
  child.stdin.on('error', fail);
  const lists = new Set();
  const input = createInterface({ input: process.stdin });
  input.on('line', line => {
    try { const frame = JSON.parse(line); if (frame.method === 'tools/list' && frame.id !== undefined) lists.add(frame.id); } catch {}
    child.stdin.write(line + '\n');
  });
  input.once('close', () => child.stdin.end());
  child.stderr.pipe(process.stderr);
  const stop = () => { void terminate(child).catch(fail); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    let ready = false;
    for await (const line of output) {
      let frame;
      try { frame = JSON.parse(line); } catch {}
      if (!ready && lists.has(frame?.id) && Array.isArray(frame?.result?.tools)) {
        const acknowledged = await requestHookPermission({ type: 'mcp_ready', key }, process.env, 10_000);
        if (acknowledged.decision !== 'allow') throw Error('The session MCP readiness was not admitted by its owning adapter');
        ready = true;
      }
      process.stdout.write(line + '\n');
    }
    if (failure instanceof Error) throw new Error(failure.message, { cause: failure });
    if (failure) throw new Error('AGY session MCP child failed', { cause: failure });
    process.exitCode = await closed ?? 1;
  } finally {
    input.close();
    process.stdin.pause();
    output.close();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (child.pid !== undefined) await terminate(child);
    await closed;
  }
}

export function consumeAccountEnvironment(env = process.env) {
  const apiKey = env.GEMINI_API_KEY;
  const baseUrl = env.GOOGLE_GEMINI_BASE_URL;
  const rawModels = env.KIKI_AGY_ACCOUNT_MODELS;
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_GEMINI_BASE_URL;
  delete env.KIKI_AGY_ACCOUNT_MODELS;
  const modelIds = JSON.parse(rawModels ?? 'null');
  if (typeof apiKey !== 'string' || !apiKey || typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)
    || !Array.isArray(modelIds) || modelIds.length === 0
    || modelIds.some(id => typeof id !== 'string' || !id || /\s/.test(id) || id === DEFAULT)) {
    throw new Error('The selected account connection is unavailable; no global AGY fallback is allowed');
  }
  return { apiKey, baseUrl, modelIds };
}

export async function runBridge({ sdkPath, cliPath, cliPrefix = [], auditDir, model = DEFAULT, account } = {}) {
  if (!isAbsolute(sdkPath ?? '')) throw new Error('Pass an installed ACP SDK absolute path');
  const acp = await import(pathToFileURL(sdkPath).href);
  const bridge = new AgyBridge({ cliPath, cliPrefix, auditDir, model, account, onAccountExit: () => setImmediate(shutdown) });
  await bridge.loadVendorModels();
  const sessionRequest = handler => async ctx => {
    try { return await handler(ctx); }
    catch (error) {
      if (account) setImmediate(shutdown);
      throw new acp.RequestError(-32603, error instanceof Error ? error.message : String(error),
        { adapterCode: error?.code, details: error?.details });
    }
  };
  const connection = acp.agent({ name: 'agy-cli-acp', version: '0.2.0' })
    .onRequest('initialize', () => bridge.initialize(acp.PROTOCOL_VERSION))
    .onRequest('session/new', sessionRequest(ctx => bridge.newSession(ctx.params)))
    .onRequest('session/load', sessionRequest(ctx => bridge.loadSession(ctx.params)))
    .onRequest('session/set_config_option', ctx => bridge.setConfig(ctx.params))
    .onRequest('session/prompt', sessionRequest(ctx => bridge.prompt(ctx.params, ctx.client)))
    .onRequest('_session/steering', params => params, sessionRequest(ctx => bridge.steer(ctx.params)))
    .onNotification('session/cancel', ctx => bridge.cancel(ctx.params))
    .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void bridge.close().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.stdin.once('end', shutdown);
  try { await connection.closed; } finally { await bridge.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes('--version') || (process.argv.length === 3 && process.argv[2] === '--kiki-harness-account-version')) console.log('agy-cli-acp 0.2.0');
  else {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === '--mcp-stdio') {
      runSessionMcp(args[1]).catch(error => { console.error(error.message); process.exitCode = 1; });
    } else if (args.length === 3 && args[0] === '--recover-project-mcp') {
      if (!isAbsolute(args[1])) throw Error('AGY MCP recovery workspace must be absolute');
      recoverProjectMcpPlugin({ cwd: args[1], sessionId: args[2] })
        .then(result => console.log(JSON.stringify(result)))
        .catch(error => { console.error(error.message); process.exitCode = 1; });
    } else if (args.length === 2 && args[0] === '--recover-project-hook') {
      if (!isAbsolute(args[1])) throw Error('AGY hook recovery workspace must be absolute');
      recoverProjectHook({ cwd: args[1], nodePath: process.execPath,
        handlerPath: fileURLToPath(new URL('./agy-permission-hook.mjs', import.meta.url)) })
        .then(result => console.log(JSON.stringify(result)))
        .catch(error => { console.error(error.message); process.exitCode = 1; });
    } else {
      const accountBound = args.at(-1) === '--kiki-harness-account';
      if (accountBound) args.pop();
      if (args.length && (args.length !== 2 || args[0] !== '--model')) throw new Error('Only --model <AGY model ID> or --recover-project-hook <workspace> is supported');
      const account = accountBound ? consumeAccountEnvironment() : undefined;
      runBridge({ sdkPath: process.env.AGY_ACP_SDK_PATH, cliPath: process.env.AGY_CLI_PATH,
        auditDir: process.env.AGY_BRIDGE_AUDIT_DIR, model: args[1] ?? DEFAULT, account })
        .catch(error => { console.error(error.message); process.exitCode = 1; });
    }
  }
}
