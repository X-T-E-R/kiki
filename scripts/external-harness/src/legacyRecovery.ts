import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeBytesAt, nativeStringsAt } from './protobuf';
import {
  DEFAULT,
  LEGACY_NATIVE_STEP,
  LEGACY_NETWORK_FAILURE,
  MAX_FRAME_BYTES,
  NATIVE_DONE,
  NATIVE_ERROR,
  NATIVE_ID,
  NATIVE_TOOL_NAME,
  type AuditRecord,
  type LegacyRecoveryProof,
  type LegacyToolProof,
} from './types';

interface LegacyTranscriptEntry {
  step_index: number;
  type: string;
  status: string;
  error?: string;
  tool_calls?: Array<{ name: string }>;
}

async function readLegacyTranscript(path: string): Promise<LegacyTranscriptEntry[]> {
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 2 * MAX_FRAME_BYTES) {
      throw new Error('AGY legacy transcript exceeds the recovery limit');
    }
    const data = Buffer.alloc(before.size + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    const after = await file.stat();
    if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('AGY legacy transcript changed during recovery');
    }
    return data
      .subarray(0, bytesRead)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as LegacyTranscriptEntry);
  } finally {
    await file.close();
  }
}

export interface LegacyNativeRecoveryInput {
  nativeHome: string;
  cwd: string;
  additionalDirectories?: string[];
  sessionId: string;
  proof?: LegacyRecoveryProof;
  model: string;
}

export interface LegacyNativeRecoveryResult {
  conversationId: string;
  model: string;
  effort: string;
}

export async function readLegacyNativeRecovery({
  nativeHome,
  cwd,
  additionalDirectories = [],
  sessionId,
  proof,
  model,
}: LegacyNativeRecoveryInput): Promise<LegacyNativeRecoveryResult> {
  const extraDirs = proof?.additionalDirectories ?? [];
  const disclosedCwd = proof?.disclosedCwd;
  const terminalError = proof?.terminalError ?? LEGACY_NETWORK_FAILURE;
  if (
    proof?.version !== 1 ||
    proof.sessionId !== sessionId ||
    !NATIVE_ID.test(sessionId) ||
    !NATIVE_ID.test(proof.conversationId) ||
    !isAbsolute(cwd) ||
    !Array.isArray(additionalDirectories) ||
    additionalDirectories.some((dir) => typeof dir !== 'string' || !isAbsolute(dir)) ||
    !Array.isArray(extraDirs) ||
    extraDirs.some((dir) => typeof dir !== 'string' || !isAbsolute(dir)) ||
    (disclosedCwd !== undefined && (typeof disclosedCwd !== 'string' || !isAbsolute(disclosedCwd))) ||
    proof.model !== model ||
    typeof proof.effort !== 'string' ||
    typeof terminalError !== 'string' ||
    !terminalError.trim() ||
    /^(?:interrupted|canceled|cancelled)$/i.test(terminalError.trim()) ||
    !Array.isArray(proof.tools) ||
    !proof.tools.length ||
    proof.tools.length > 1000 ||
    proof.tools.some(
      (tool) =>
        !Number.isSafeInteger(tool?.stepIndex) ||
        tool.stepIndex < 0 ||
        !NATIVE_TOOL_NAME.test(tool.name ?? '') ||
        (tool.failed !== undefined && tool.failed !== true) ||
        (tool.error !== undefined && (typeof tool.error !== 'string' || !tool.error.trim())),
    ) ||
    new Set(proof.tools.map((tool) => tool.stepIndex)).size !== proof.tools.length
  ) {
    throw new Error('AGY legacy load requires an exact original session and completed native tool mapping');
  }
  const canonical = (value: string): string =>
    process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  if (
    (disclosedCwd !== undefined && canonical(disclosedCwd) !== canonical(cwd)) ||
    (additionalDirectories.length > 0 &&
      (disclosedCwd === undefined ||
        extraDirs.length !== additionalDirectories.length ||
        extraDirs.some((dir, index) => canonical(dir) !== canonical(additionalDirectories[index]!)))) ||
    (extraDirs.length > 0 &&
      (extraDirs.length !== additionalDirectories.length ||
        extraDirs.some((dir, index) => canonical(dir) !== canonical(additionalDirectories[index]!))))
  ) {
    throw new Error('AGY legacy native conversation or workspace differs from its original binding');
  }
  const expectedRoots = new Set([cwd, ...additionalDirectories].map(canonical));
  if (expectedRoots.size !== 1 + additionalDirectories.length) {
    throw new Error('AGY legacy native conversation or workspace differs from its original binding');
  }
  const conversationId = proof.conversationId;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(resolve(nativeHome, 'conversations', `${conversationId}.db`), {
    readOnly: true,
  });
  try {
    db.exec('BEGIN');
    const metadata = db
      .prepare('SELECT data FROM trajectory_metadata_blob WHERE id = ? AND length(data) <= 65536')
      .get('main') as { data?: Uint8Array } | undefined;
    const data = metadata?.data ?? new Uint8Array(0);
    const nativeRootUris = nativeStringsAt(data, [7]);
    const nativeRoots = new Set(nativeRootUris.map((uri) => canonical(fileURLToPath(uri))));
    if (
      nativeBytesAt(data, [6]) !== conversationId ||
      nativeRootUris.length !== expectedRoots.size ||
      nativeRoots.size !== expectedRoots.size ||
      [...expectedRoots].some((root) => !nativeRoots.has(root))
    ) {
      throw new Error('AGY legacy native conversation or workspace differs from its original binding');
    }
    const baseModel =
      proof.effort !== DEFAULT && model.endsWith(`-${proof.effort}`)
        ? model.slice(0, -(proof.effort.length + 1))
        : model;
    const exactModel = (value: string): boolean =>
      value === model || value === `gemini-api://models/${model}`;
    const totalModels = Number(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM (SELECT 1 FROM gen_metadata LIMIT 1001)')
          .get() as { count?: number } | undefined
      )?.count ?? 0,
    );
    if (totalModels === 0 || totalModels > 1000) {
      throw new Error('AGY legacy native model differs from its original binding');
    }
    const models = db.prepare(
      'SELECT CASE WHEN length(data) <= ? THEN data END AS data FROM gen_metadata ORDER BY idx LIMIT 1001',
    );
    let rowIndex = 0;
    let sawModel = false;
    let sawExactModel = false;
    for (const row of models.iterate(MAX_FRAME_BYTES) as Iterable<{ data?: Uint8Array | null }>) {
      const isLast = rowIndex === totalModels - 1;
      rowIndex += 1;
      const bytes = row.data ?? new Uint8Array(0);
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
    if (
      db
        .prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?')
        .get('table', 'executor_metadata')
    ) {
      const execMeta = db.prepare(
        'SELECT CASE WHEN length(data) <= ? THEN data END AS data FROM executor_metadata ORDER BY idx LIMIT 10',
      );
      for (const row of execMeta.iterate(MAX_FRAME_BYTES) as Iterable<{ data?: Uint8Array | null }>) {
        const uri = nativeBytesAt(row.data ?? new Uint8Array(0), [10, 1, 28], true);
        if (uri !== undefined && !exactModel(uri)) {
          throw new Error('AGY legacy native model differs from its original binding');
        }
        if (uri !== undefined && exactModel(uri)) sawExactModel = true;
      }
    }
    if (rowIndex !== totalModels || !sawModel || !sawExactModel) {
      throw new Error('AGY legacy native model differs from its original binding');
    }
    const steps = db
      .prepare('SELECT idx, step_type, status FROM steps ORDER BY idx LIMIT 10001')
      .all() as Array<{ idx: number; step_type: number; status: number }>;
    const allowedStepTypes: readonly number[] = Object.values(LEGACY_NATIVE_STEP);
    if (
      !steps.length ||
      steps.length > 10000 ||
      steps.some(
        (step, index) =>
          step.idx !== index ||
          !allowedStepTypes.includes(step.step_type) ||
          (step.step_type === LEGACY_NATIVE_STEP.tool
            ? step.status !== NATIVE_DONE && step.status !== NATIVE_ERROR
            : step.status !== NATIVE_DONE),
      ) ||
      steps.filter((step) => step.step_type === LEGACY_NATIVE_STEP.user).length !== 1
    ) {
      throw new Error('AGY legacy native turn has unresolved steps or unknown steering; do not replay it');
    }
    const step0Row = db
      .prepare('SELECT step_payload FROM steps WHERE idx = 0 AND length(step_payload) <= 65536')
      .get() as { step_payload?: Uint8Array } | undefined;
    const step0Bytes = step0Row?.step_payload ?? new Uint8Array(0);
    if (proof.promptSha256 !== undefined) {
      const step0Text = nativeBytesAt(step0Bytes, [19, 2], true);
      if (
        typeof step0Text !== 'string' ||
        createHash('sha256').update(step0Text).digest('hex') !== proof.promptSha256
      ) {
        throw new Error('AGY legacy native initial prompt differs from its audited prompt digest');
      }
    }
    const step0Uris = nativeStringsAt(step0Bytes, [19, 12, 12], true);
    if (step0Uris.length > 0) {
      const step0Roots = new Set(step0Uris.map((uri) => canonical(fileURLToPath(uri))));
      if (
        step0Uris.length !== expectedRoots.size ||
        step0Roots.size !== expectedRoots.size ||
        [...expectedRoots].some((root) => !step0Roots.has(root))
      ) {
        throw new Error('AGY legacy native conversation or workspace differs from its original binding');
      }
    }
    const terminal = steps.at(-1)!;
    const payload = db
      .prepare('SELECT step_payload FROM steps WHERE idx = ? AND length(step_payload) <= 65536')
      .get(terminal.idx) as { step_payload?: Uint8Array } | undefined;
    const terminalBytes = payload?.step_payload ?? new Uint8Array(0);
    const terminalErr1 = nativeBytesAt(terminalBytes, [24, 3, 1], true);
    const terminalErr2 = nativeBytesAt(terminalBytes, [24, 3, 2], true);
    if (
      terminal.step_type !== LEGACY_NATIVE_STEP.error ||
      (terminalErr1 !== terminalError && terminalErr2 !== terminalError)
    ) {
      throw new Error('AGY legacy native turn has no confirmed terminal network failure');
    }
    const toolSteps = steps.filter((step) => step.step_type === LEGACY_NATIVE_STEP.tool);
    const toolByIndex = new Map(toolSteps.map((step) => [step.idx, step]));
    if (toolByIndex.size !== proof.tools.length || proof.tools.some((tool) => !toolByIndex.has(tool.stepIndex))) {
      throw new Error('AGY legacy native tools differ from the completed Kiki tool mapping');
    }
    const selectStepPayload = db.prepare(
      'SELECT step_payload FROM steps WHERE idx = ? AND length(step_payload) <= 65536',
    );
    for (const tool of proof.tools) {
      const step = toolByIndex.get(tool.stepIndex)!;
      if ((tool.failed === true) !== (step.status === NATIVE_ERROR)) {
        throw new Error('AGY legacy native tools differ from the completed Kiki tool mapping');
      }
      const toolRow = selectStepPayload.get(tool.stepIndex) as { step_payload?: Uint8Array } | undefined;
      const toolPayload = toolRow?.step_payload ?? new Uint8Array(0);
      const nativeName = nativeBytesAt(toolPayload, [5, 4, 2], true);
      if (nativeName !== undefined && nativeName !== tool.name) {
        throw new Error('AGY legacy native tools differ from the completed Kiki tool mapping');
      }
      if (tool.failed === true) {
        const nativeErr =
          nativeBytesAt(toolPayload, [31, 2], true) ?? nativeBytesAt(toolPayload, [31, 3], true);
        if (
          !nativeErr ||
          /^tool call denied by pre-tool hook:/i.test(nativeErr.trimStart()) ||
          (tool.error !== undefined && nativeErr !== tool.error)
        ) {
          throw new Error('AGY legacy native tools differ from the completed Kiki tool mapping');
        }
      }
    }
    const transcript = await readLegacyTranscript(
      resolve(nativeHome, 'brain', conversationId, '.system_generated', 'logs', 'transcript_full.jsonl'),
    );
    const declared = transcript.flatMap((step) => step.tool_calls ?? []);
    const transcriptErrorStep = transcript.at(-1);
    const alignedErrorStep = steps[transcript.length - 1];
    const alignedErrorRow =
      alignedErrorStep?.step_type === LEGACY_NATIVE_STEP.error
        ? (selectStepPayload.get(alignedErrorStep.idx) as { step_payload?: Uint8Array } | undefined)
        : undefined;
    const alignedErrorBytes = alignedErrorRow
      ? (alignedErrorRow.step_payload ?? new Uint8Array(0))
      : undefined;
    const alignedErr1 = alignedErrorBytes ? nativeBytesAt(alignedErrorBytes, [24, 3, 1], true) : undefined;
    const alignedErr2 = alignedErrorBytes ? nativeBytesAt(alignedErrorBytes, [24, 3, 2], true) : undefined;
    const transcriptErrorText =
      typeof transcriptErrorStep?.error === 'string' && transcriptErrorStep.error.trim()
        ? transcriptErrorStep.error
        : undefined;
    if (
      transcript.some(
        (step, index) =>
          step.step_index !== index ||
          (step.type === 'GENERIC'
            ? step.status !== 'DONE' && step.status !== 'ERROR'
            : step.status !== 'DONE'),
      ) ||
      transcript.length < steps.length - 1 ||
      transcript.length > steps.length ||
      transcriptErrorStep?.type !== 'ERROR_MESSAGE' ||
      alignedErrorStep?.step_type !== LEGACY_NATIVE_STEP.error ||
      (transcriptErrorText !== undefined &&
        transcriptErrorText !== alignedErr1 &&
        transcriptErrorText !== alignedErr2 &&
        transcriptErrorText !== terminalError) ||
      transcript.filter((step) => step.type === 'USER_INPUT').length !== 1 ||
      transcript.filter((step) => step.type === 'GENERIC').length !== toolByIndex.size ||
      declared.length !== proof.tools.length ||
      declared.some((tool, index) => tool.name !== proof.tools[index]!.name) ||
      proof.tools.some((tool) => {
        const entry = transcript[tool.stepIndex];
        return (
          entry?.type !== 'GENERIC' ||
          (tool.failed === true
            ? entry.status !== 'ERROR' || (tool.error !== undefined && entry.error !== tool.error)
            : entry.status !== 'DONE')
        );
      })
    ) {
      throw new Error(
        'AGY legacy native transcript is not fully reconciled or differs from the completed Kiki tool mapping',
      );
    }
    return { conversationId, model, effort: proof.effort };
  } finally {
    db.close();
  }
}

export type WatchdogDbState =
  | { status: 'missing_db' }
  | { status: 'db_error' }
  | { status: 'no_terminal_error' }
  | { status: 'incomplete_steps' }
  | { status: 'terminal_error'; stepIndex: number; summary: string; detail?: string; error: string }
  | { status: 'retrying'; stepIndex: number; detail?: string };

export async function inspectNativeErrorWatchdogState({
  nativeHome,
  conversationId,
}: {
  nativeHome?: string;
  conversationId?: string;
}): Promise<WatchdogDbState> {
  if (typeof nativeHome !== 'string' || !nativeHome || !NATIVE_ID.test(conversationId ?? '')) {
    return { status: 'missing_db' };
  }
  const dbPath = resolve(nativeHome, 'conversations', `${conversationId}.db`);
  let db: { close(): void } | undefined;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const conn = new DatabaseSync(dbPath, { readOnly: true });
    db = conn;
    const latest = conn
      .prepare(
        'SELECT idx, step_type, status, CASE WHEN length(step_payload) <= 65536 THEN step_payload END AS step_payload FROM steps ORDER BY idx DESC LIMIT 1',
      )
      .get() as
      | { idx: number; step_type: number; status: number; step_payload?: Uint8Array | null }
      | undefined;
    if (!latest) return { status: 'no_terminal_error' };
    const incomplete = conn
      .prepare(
        'SELECT idx, step_type, status FROM steps WHERE (step_type = ? AND status NOT IN (?, ?)) OR (step_type != ? AND status != ?) LIMIT 1',
      )
      .get(
        LEGACY_NATIVE_STEP.tool,
        NATIVE_DONE,
        NATIVE_ERROR,
        LEGACY_NATIVE_STEP.tool,
        NATIVE_DONE,
      );
    if (incomplete) return { status: 'incomplete_steps' };
    if (latest.step_type !== LEGACY_NATIVE_STEP.error) return { status: 'no_terminal_error' };
    const bytes = latest.step_payload ?? new Uint8Array(0);
    const err1 = nativeBytesAt(bytes, [24, 3, 1], true);
    const err2 = nativeBytesAt(bytes, [24, 3, 2], true);
    if (typeof err1 === 'string' && err1.trim()) {
      return {
        status: 'terminal_error',
        stepIndex: latest.idx,
        summary: err1,
        detail: err2,
        error: err2 || err1,
      };
    }
    return { status: 'retrying', stepIndex: latest.idx, detail: err2 };
  } catch (error) {
    const err = error as { code?: string; message?: string } | undefined;
    if (
      err?.code === 'ERR_SQLITE_ERROR' ||
      /unable to open database file/i.test(String(err?.message ?? ''))
    ) {
      return { status: 'missing_db' };
    }
    return { status: 'db_error' };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export function unconsumedNetworkContinuationProof(
  records: readonly AuditRecord[],
  {
    sessionId,
    conversationId,
    model,
    effort,
    cwd,
    additionalDirectories = [],
  }: {
    sessionId: string;
    conversationId: string;
    model: string;
    effort: string;
    cwd: string;
    additionalDirectories?: string[];
  },
): LegacyRecoveryProof | undefined {
  if (!Array.isArray(records) || !NATIVE_ID.test(sessionId ?? '') || !NATIVE_ID.test(conversationId ?? '')) {
    return undefined;
  }
  let lastTurnIndex = -1;
  for (let index = 0; index < records.length; index += 1) {
    const type = records[index]?.type;
    if (type === 'native_turn_pending' || type === 'native_turn_reconciled') lastTurnIndex = index;
  }
  if (lastTurnIndex < 0 || records[lastTurnIndex]?.type !== 'native_turn_pending') return undefined;
  let launchIndex = -1;
  for (let index = lastTurnIndex; index >= 0; index -= 1) {
    if (records[index]?.type === 'launch') {
      launchIndex = index;
      break;
    }
  }
  if (
    launchIndex < 0 ||
    records.some((record, index) => index > launchIndex && record?.type === 'launch')
  ) {
    return undefined;
  }
  if (records.some((record) => ['session_loaded', 'legacy_native_recovered'].includes(record?.type))) {
    return undefined;
  }
  if (records.filter((record) => record?.type === 'prompt_sent').length !== 1) return undefined;
  const launch = records[launchIndex]!;
  if (!Number.isSafeInteger(launch['pid']) || (launch['pid'] as number) <= 0) return undefined;
  const turnRecords = records.slice(lastTurnIndex + 1);
  const promptSent = turnRecords.filter((record) => record?.type === 'prompt_sent');
  if (promptSent.length !== 1 || !/^[0-9a-f]{64}$/i.test(String(promptSent[0]!['promptSha256'] ?? ''))) {
    return undefined;
  }
  const consumed = turnRecords.filter((record) => record?.type === 'prompt_consumed');
  if (consumed.length !== 1 || consumed[0]!['stepIndex'] !== 0) return undefined;
  if (
    turnRecords.some(
      (record) =>
        typeof record?.type === 'string' &&
        (record.type.startsWith('steer_') || record.type === 'pre_tool_hook_denied'),
    )
  ) {
    return undefined;
  }
  const results = turnRecords.filter((record) => record?.type === 'agy_result');
  const requested = turnRecords.filter((record) => record?.type === 'network_recovery_requested');
  const sent = turnRecords.filter((record) => record?.type === 'network_recovery_sent');
  if (results.length !== 1 || requested.length !== 1 || sent.length !== 1) return undefined;
  if (
    results[0]!['conversationId'] !== conversationId ||
    results[0]!['status'] !== 'ERROR' ||
    requested[0]!['conversationId'] !== conversationId ||
    requested[0]!['nativeStatus'] !== 'ERROR' ||
    requested[0]!['attempt'] !== 1 ||
    requested[0]!['totalAttempts'] !== 1 ||
    sent[0]!['conversationId'] !== conversationId ||
    sent[0]!['attempt'] !== 1 ||
    sent[0]!['relaunched'] !== false
  ) {
    return undefined;
  }
  const sentIndex = turnRecords.indexOf(sent[0]!);
  if (
    sentIndex < turnRecords.indexOf(requested[0]!) ||
    sentIndex < turnRecords.indexOf(results[0]!) ||
    sentIndex <= turnRecords.indexOf(consumed[0]!)
  ) {
    return undefined;
  }
  const afterSent = turnRecords.slice(sentIndex + 1);
  if (
    afterSent.some(
      (record) => record?.type !== 'native_frame_delivered' && record?.type !== 'close',
    )
  ) {
    return undefined;
  }
  const closes = afterSent.filter((record) => record?.type === 'close');
  if (
    closes.length !== 1 ||
    closes[0]!['pid'] !== launch['pid'] ||
    closes[0]!['processEnded'] !== true ||
    (closes[0]!['signal'] !== undefined && closes[0]!['signal'] !== null) ||
    (closes[0]!['exitCode'] !== undefined &&
      (!Number.isSafeInteger(closes[0]!['exitCode']) || (closes[0]!['exitCode'] as number) < 0))
  ) {
    return undefined;
  }
  const toolsByStep = new Map<
    number,
    { stepIndex: number; name: string; state: string; error?: string }
  >();
  for (const record of turnRecords) {
    if (record?.type !== 'tool_state') continue;
    const match = /^agy-([0-9a-f-]+)-(\d+)$/i.exec(String(record['toolCallId'] ?? ''));
    if (!match || match[1] !== conversationId) return undefined;
    const stepIndex = Number(match[2]);
    if (!Number.isSafeInteger(stepIndex) || stepIndex <= 0) return undefined;
    toolsByStep.set(stepIndex, {
      stepIndex,
      name: record['name'] as string,
      state: record['state'] as string,
      ...(typeof record['error'] === 'string' && record['error'].trim()
        ? { error: record['error'] }
        : {}),
    });
  }
  if (!toolsByStep.size) return undefined;
  const tools: LegacyToolProof[] = [];
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
    promptSha256: String(promptSent[0]!['promptSha256']).toLowerCase(),
    terminalError: requested[0]!['error'] as string | undefined,
    disclosedCwd: cwd,
    additionalDirectories: additionalDirectories.length ? [...additionalDirectories] : undefined,
    tools,
  };
}
