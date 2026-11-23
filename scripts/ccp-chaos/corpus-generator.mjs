import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

export function computeChaosWorkDirKey(workDir) {
  const slashed = workDir.replaceAll('\\', '/');
  const isWin = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/u.test(slashed);
  const rawNorm = isWin
    ? path.win32.normalize(slashed).replaceAll('\\', '/').toLowerCase()
    : path.posix.normalize(workDir);
  const normalized = rawNorm.length > 1 ? rawNorm.replace(/\/+$/u, '') : rawNorm;
  const base = normalized.split('/').pop() ?? 'workspace';
  const slug =
    base
      .toLowerCase()
      .replaceAll(/[^a-z0-9._-]+/gu, '-')
      .replaceAll(/^-+|-+$/gu, '')
      .slice(0, 40)
      .replaceAll(/^-+|-+$/gu, '') || 'workspace';
  return `wd_${slug}_${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

const CORPUS_TOOL_ROTATION = [
  { name: 'Grep', args: (t) => ({ pattern: `CHAOS_TOKEN_${String(t % 120).padStart(3, '0')}`, output_mode: 'content' }) },
  { name: 'Read', args: (t) => ({ path: `src/mod-${String((t % 120) + 1).padStart(3, '0')}.ts`, line_offset: -20, n_lines: 20 }) },
  { name: 'Glob', args: () => ({ pattern: 'src/**/*.ts' }) },
  { name: 'HistorySearch', args: (t) => ({ query: `Synthetic benchmark ${t % 16}`, include_tool_output: true, scope: 'workspace' }) },
  { name: 'HistoryList', args: () => ({ kind: 'turns', limit: 10 }) },
  { name: 'HistoryRead', args: (t) => ({ turn: t % 8 }) },
  { name: 'MemorySearch', args: () => ({ mode: 'search', query: 'chaos benchmark' }) },
  { name: 'TodoList', args: (t) => ({ todos: [{ title: `Checkpoint ${t}`, status: 'done' }] }) },
  { name: 'AgentRun', args: (t) => ({ name: `sub_${t % 64}`, description: 'Synthetic worker', prompt: 'Audit module', background: true }) },
  { name: 'AgentList', args: () => ({ include_finished: true }) },
  { name: 'ThreadList', args: () => ({ limit: 10 }) },
  { name: 'ThreadRead', args: (t) => ({ thread: { session_id: `chaos_bg_${String((t % 20) + 1).padStart(4, '0')}` } }) },
];

export function formatTurnMarker(turnId) {
  return `TURN_MARKER_${String(turnId).padStart(6, '0')}`;
}

function buildTallSystemReminderText(turnId, marker) {
  const lines = [
    `Host runtime snapshot rev ${turnId} (${marker}). Full diagnostic context snapshot.`,
    '',
    '## Active Workspace State',
    `- Turn anchor: ${marker}`,
    `- Snapshot revision: ${turnId}`,
    '- Policy: coupled workstation stress fixture with overflowing scrollable reminder body.',
    '',
    '## Observed Modules & Checkpoints',
  ];
  for (let i = 1; i <= 64; i += 1) {
    lines.push(
      `[${String(i).padStart(2, '0')}] ${marker} subsystem_${String(i).padStart(2, '0')}: residency=tracked digest=${String((turnId * 31 + i * 17) % 999983).padStart(6, '0')} lines=${120 + i * 7} status=verified`,
    );
  }
  lines.push('', `End of reminder snapshot ${marker}.`);
  return `<system-reminder>\n${lines.join('\n')}\n</system-reminder>`;
}

function buildTurnWireLines(turnId, baseTime, outputPayload, options = {}) {
  const ts = baseTime + turnId * 1000;
  const turnKey = String(turnId);
  const marker = formatTurnMarker(turnId);
  const stepUuid = `step-${turnId}-1`;
  const callId = `call-${turnId}-1`;
  const toolDef = CORPUS_TOOL_ROTATION[turnId % CORPUS_TOOL_ROTATION.length];
  const userText = `${marker} Synthetic chaos benchmark turn ${turnId} invoking ${toolDef.name}`;
  const lines = [
    JSON.stringify({
      type: 'turn.prompt',
      turnId,
      promptId: `prompt-${turnId}`,
      userMessageId: `msg-user-${turnId}`,
      input: [{ type: 'text', text: userText }],
      origin: { kind: 'user', payload: { userMessageId: `msg-user-${turnId}` } },
      time: ts,
    }),
    JSON.stringify({
      type: 'context.append_message',
      message: {
        id: `msg-user-${turnId}`,
        role: 'user',
        content: [{ type: 'text', text: userText }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      time: ts + 2,
    }),
  ];
  if (options.includeTallReminder) {
    lines.push(
      JSON.stringify({
        type: 'context.append_message',
        message: {
          id: `msg-reminder-${turnId}`,
          role: 'user',
          content: [{ type: 'text', text: buildTallSystemReminderText(turnId, marker) }],
          toolCalls: [],
          origin: { kind: 'injection', variant: 'runtime_snapshot', ownerPromptId: `prompt-${turnId}` },
        },
        time: ts + 3,
      }),
    );
  }
  lines.push(
    JSON.stringify({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', turnId: turnKey, step: 1, uuid: stepUuid },
      time: ts + 5,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        turnId: turnKey,
        stepUuid,
        toolCallId: callId,
        name: toolDef.name,
        args: JSON.stringify(toolDef.args(turnId)),
      },
      time: ts + 10,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        toolCallId: callId,
        result: { output: outputPayload, isError: false },
      },
      time: ts + 20,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        turnId: turnKey,
        stepUuid,
        part: {
          type: 'text',
          text: [
            `Assistant summary for ${marker} (turn ${turnId}) after ${toolDef.name}:`,
            `- Verified zero-PII corpus layout and unique addressable turn identity ${turnId}.`,
            `- Tool ${toolDef.name} completed cleanly with ${outputPayload.length} chars output.`,
          ].join('\n'),
        },
      },
      time: ts + 30,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: { type: 'step.end', turnId: turnKey, step: 1, uuid: stepUuid },
      time: ts + 40,
    }),
    JSON.stringify({
      type: 'turn.ended',
      turnId,
      durationMs: 50,
      reason: 'completed',
      time: ts + 50,
    }),
  );
  return lines;
}

export function writeGiantWireFile(filePath, { targetBytes, spikeLineBytes, baseTime, minTurns = null }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'w');
  let writtenBytes = 0;
  let turnId = 0;
  let spikeLinesWritten = 0;
  let tallRemindersWritten = 0;
  const manifestTurns = [];

  try {
    const headerBuf = Buffer.from(
      `${JSON.stringify({ type: 'metadata', protocol_version: '1.6', created_at: baseTime })}\n`,
      'utf8',
    );
    fs.writeSync(fd, headerBuf);
    writtenBytes += headerBuf.byteLength;

    const tailTurns = 24;
    const requestedMinTurns = Number.isInteger(minTurns) && minTurns > tailTurns
      ? minTurns
      : targetBytes >= 256 * MiB
        ? 340
        : targetBytes >= 4 * MiB
          ? 72
          : 36;
    const targetBodyTurns = Math.max(requestedMinTurns - tailTurns, 12);
    const effectiveSpikeBytes = Math.min(
      Math.max(1024, spikeLineBytes - 256),
      Math.max(1024, Math.floor(targetBytes / 16)),
    );
    const spikeCount = targetBytes >= 16 * MiB ? 4 : targetBytes >= 4 * MiB ? 2 : 0;
    const spikeTotalBytes = spikeCount * effectiveSpikeBytes;
    const tailReserveBytes = tailTurns * 2048;
    const bodyTargetBytes = Math.max(0, targetBytes - writtenBytes - tailReserveBytes);
    const perBodyTurnBytes = Math.max(
      2048,
      Math.min(
        4 * MiB,
        Math.floor(Math.max(0, bodyTargetBytes - spikeTotalBytes) / Math.max(1, targetBodyTurns - spikeCount)),
      ),
    );
    const spikePayload = 'S'.repeat(effectiveSpikeBytes);
    const regularPayload = 'R'.repeat(perBodyTurnBytes);

    let batchChunks = [];
    let batchBytes = 0;
    const flushBatch = () => {
      if (batchChunks.length === 0) return;
      const buf = Buffer.from(batchChunks.join(''), 'utf8');
      fs.writeSync(fd, buf);
      batchChunks = [];
      batchBytes = 0;
    };

    const appendTurn = (payload, includeTallReminder) => {
      turnId += 1;
      const byteOffset = writtenBytes;
      const text = `${buildTurnWireLines(turnId, baseTime, payload, { includeTallReminder }).join('\n')}\n`;
      const byteLength = Buffer.byteLength(text, 'utf8');
      batchChunks.push(text);
      batchBytes += byteLength;
      writtenBytes += byteLength;
      if (includeTallReminder) tallRemindersWritten += 1;
      manifestTurns.push({
        turnId,
        promptId: `prompt-${turnId}`,
        userMessageId: `msg-user-${turnId}`,
        marker: formatTurnMarker(turnId),
        byteOffset,
        byteLength,
        hasSystemReminder: Boolean(includeTallReminder),
      });
      if (batchBytes >= 4 * MiB) flushBatch();
    };

    const spikeStride = Math.max(1, Math.floor(targetBodyTurns / Math.max(1, spikeCount)));
    while (turnId < targetBodyTurns || writtenBytes < targetBytes - tailReserveBytes) {
      const nextTurnIdx = turnId;
      const isSpike =
        spikeLinesWritten < spikeCount &&
        (nextTurnIdx === 0 || (nextTurnIdx % spikeStride === 0 && writtenBytes + effectiveSpikeBytes <= targetBytes));
      const includeTallReminder = turnId > 0 && turnId % 25 === 0;
      if (isSpike) {
        appendTurn(spikePayload, includeTallReminder);
        spikeLinesWritten += 1;
      } else {
        appendTurn(regularPayload, includeTallReminder);
      }
    }

    for (let i = 0; i < tailTurns; i += 1) {
      const isTailReminderTurn = i === tailTurns - 4 || i === tailTurns - 2;
      appendTurn(`tail-turn-output-${turnId + 1}`, isTailReminderTurn);
    }
    flushBatch();
  } finally {
    fs.closeSync(fd);
  }

  return {
    bytes: writtenBytes,
    turns: turnId,
    distinctTurns: manifestTurns.length,
    spikeLinesWritten,
    tallRemindersWritten,
    manifest: {
      wirePath: filePath,
      actualBytes: writtenBytes,
      distinctTurnCount: manifestTurns.length,
      spikeLinesWritten,
      tallRemindersWritten,
      turns: manifestTurns,
    },
  };
}

/**
 * Independently scans a staged wire.jsonl file on disk (never trusting generator
 * counters alone) to qualify actual byte size, distinct completed turn IDs,
 * zero duplicate turn IDs, tall scrollable `<system-reminder>` presence, and
 * produce an ordered manifest of addressable turns.
 */
export function qualifyGiantWireFixture(wirePath, { minBytes = 256 * MiB, minDistinctTurns = 300 } = {}) {
  const failures = [];
  if (!fs.existsSync(wirePath)) {
    return {
      ok: false,
      wirePath,
      actualBytes: 0,
      distinctTurnCount: 0,
      duplicateTurnIds: [],
      tallReminderCount: 0,
      turns: [],
      failures: [`Wire fixture does not exist: ${wirePath}`],
    };
  }
  const stat = fs.statSync(wirePath);
  const actualBytes = stat.size;
  const fd = fs.openSync(wirePath, 'r');
  const seenPromptTurnIds = new Set();
  const seenEndedTurnIds = new Set();
  const seenPromptIds = new Set();
  const seenUserMessageIds = new Set();
  const seenMarkers = new Set();
  const duplicateTurnIds = [];
  const duplicateEndedTurnIds = [];
  const duplicatePromptIds = [];
  const duplicateUserMessageIds = [];
  const duplicateMarkers = [];
  const turnEntries = new Map();
  let tallReminderCount = 0;
  let lastTurnWithAssistantText = null;
  let offset = 0;
  const chunkSize = 4 * MiB;
  const buf = Buffer.allocUnsafe(chunkSize);
  let leftover = Buffer.alloc(0);

  try {
    while (offset < actualBytes) {
      const bytesRead = fs.readSync(fd, buf, 0, Math.min(chunkSize, actualBytes - offset), offset);
      if (bytesRead <= 0) break;
      const chunkStart = offset - leftover.byteLength;
      const combined = leftover.byteLength > 0
        ? Buffer.concat([leftover, buf.subarray(0, bytesRead)])
        : buf.subarray(0, bytesRead);
      let lineStart = 0;
      for (let i = 0; i < combined.byteLength; i += 1) {
        if (combined[i] !== 0x0a) continue;
        const lineBuf = combined.subarray(lineStart, i);
        const lineByteOffset = chunkStart + lineStart;
        lineStart = i + 1;
        if (lineBuf.byteLength === 0) continue;
        // Fast prefilter before JSON.parse so 256 MiB+ giant lines skip parsing giant RRR payloads
        const headSlice = lineBuf.subarray(0, Math.min(512, lineBuf.byteLength)).toString('utf8');
        if (headSlice.includes('"type":"turn.prompt"')) {
          const rec = JSON.parse(lineBuf.toString('utf8'));
          const tid = Number(rec.turnId);
          if (seenPromptTurnIds.has(tid)) {
            if (duplicateTurnIds.length < 20) duplicateTurnIds.push(tid);
          } else {
            seenPromptTurnIds.add(tid);
          }
          if (typeof rec.promptId === 'string' && rec.promptId.length > 0) {
            if (seenPromptIds.has(rec.promptId)) {
              if (duplicatePromptIds.length < 20) duplicatePromptIds.push(rec.promptId);
            } else {
              seenPromptIds.add(rec.promptId);
            }
          }
          const umid = rec.userMessageId ?? rec.origin?.payload?.userMessageId ?? null;
          if (typeof umid === 'string' && umid.length > 0) {
            if (seenUserMessageIds.has(umid)) {
              if (duplicateUserMessageIds.length < 20) duplicateUserMessageIds.push(umid);
            } else {
              seenUserMessageIds.add(umid);
            }
          }
          const promptText = Array.isArray(rec.input)
            ? rec.input.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ')
            : '';
          const markerMatch = /TURN_MARKER_\d{6}/u.exec(promptText);
          const markerVal = markerMatch ? markerMatch[0] : null;
          if (markerVal) {
            if (seenMarkers.has(markerVal)) {
              if (duplicateMarkers.length < 20) duplicateMarkers.push(markerVal);
            } else {
              seenMarkers.add(markerVal);
            }
          }
          turnEntries.set(tid, {
            turnId: tid,
            promptId: rec.promptId ?? null,
            userMessageId: umid,
            marker: markerVal ?? promptText.slice(0, 48),
            byteOffset: lineByteOffset,
            completed: false,
            hasAssistantText: false,
            hasSystemReminder: false,
          });
        } else if (headSlice.includes('"type":"turn.ended"')) {
          const rec = JSON.parse(lineBuf.toString('utf8'));
          const tid = Number(rec.turnId);
          if (seenEndedTurnIds.has(tid)) {
            if (duplicateEndedTurnIds.length < 20) duplicateEndedTurnIds.push(tid);
          } else {
            seenEndedTurnIds.add(tid);
          }
          if (rec.reason === 'completed') {
            const entry = turnEntries.get(tid);
            if (entry) entry.completed = true;
          }
        } else if (headSlice.includes('"type":"context.append_message"') && (headSlice.includes('reminder') || headSlice.includes('injection') || headSlice.includes('runtime_snapshot'))) {
          const text = lineBuf.toString('utf8');
          const rec = JSON.parse(text);
          const originKind = rec?.message?.origin?.kind;
          const bodyText = Array.isArray(rec?.message?.content)
            ? rec.message.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
            : '';
          if (
            originKind === 'injection' &&
            bodyText.includes('<system-reminder>') &&
            bodyText.split('\n').length >= 40
          ) {
            tallReminderCount += 1;
            const ownerPid = rec?.message?.origin?.ownerPromptId;
            if (typeof ownerPid === 'string' && ownerPid.startsWith('prompt-')) {
              const ownerTid = Number(ownerPid.slice('prompt-'.length));
              const entry = turnEntries.get(ownerTid);
              if (entry) entry.hasSystemReminder = true;
            }
          }
        } else if (headSlice.includes('"type":"content.part"')) {
          const rec = JSON.parse(lineBuf.toString('utf8'));
          const rawTurnKey = rec?.event?.turnId;
          const partText = rec?.event?.part?.text;
          if (typeof partText === 'string' && partText.trim().length > 0) {
            const parsedTid = typeof rawTurnKey === 'string' && rawTurnKey.startsWith('t')
              ? Number(rawTurnKey.slice(1))
              : Number(rawTurnKey);
            if (Number.isFinite(parsedTid)) {
              const entry = turnEntries.get(parsedTid);
              if (entry) entry.hasAssistantText = true;
              lastTurnWithAssistantText = parsedTid;
            }
          }
        }
      }
      leftover = lineStart < combined.byteLength ? Buffer.from(combined.subarray(lineStart)) : Buffer.alloc(0);
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }

  const completedTurns = [...turnEntries.values()]
    .filter((entry) => entry.completed)
    .toSorted((a, b) => a.turnId - b.turnId);
  const newestCompleted = completedTurns.at(-1) ?? null;
  const nonemptyTailSlot = Boolean(newestCompleted && newestCompleted.hasAssistantText);
  if (actualBytes < minBytes) {
    failures.push(`Wire actualBytes=${actualBytes} < required minBytes=${minBytes}`);
  }
  if (completedTurns.length < minDistinctTurns) {
    failures.push(`Wire distinct completed turns=${completedTurns.length} < required minDistinctTurns=${minDistinctTurns}`);
  }
  if (duplicateTurnIds.length > 0) {
    failures.push(`Wire contains duplicate turn.prompt turnIds: ${duplicateTurnIds.slice(0, 10).join(', ')}`);
  }
  if (duplicateEndedTurnIds.length > 0) {
    failures.push(`Wire contains duplicate turn.ended turnIds: ${duplicateEndedTurnIds.slice(0, 10).join(', ')}`);
  }
  if (duplicatePromptIds.length > 0) {
    failures.push(`Wire contains duplicate promptIds: ${duplicatePromptIds.slice(0, 10).join(', ')}`);
  }
  if (duplicateUserMessageIds.length > 0) {
    failures.push(`Wire contains duplicate userMessageIds: ${duplicateUserMessageIds.slice(0, 10).join(', ')}`);
  }
  if (duplicateMarkers.length > 0) {
    failures.push(`Wire contains duplicate turn markers: ${duplicateMarkers.slice(0, 10).join(', ')}`);
  }
  if (tallReminderCount === 0) {
    failures.push('Wire contains zero tall scrollable injection <system-reminder> entries (>=40 lines)');
  }
  if (!nonemptyTailSlot) {
    failures.push(`Tail turn (${newestCompleted?.turnId ?? 'none'}) lacks nonempty assistant content (lastAssistantTurn=${lastTurnWithAssistantText})`);
  }

  return {
    ok: failures.length === 0,
    wirePath,
    actualBytes,
    distinctTurnCount: completedTurns.length,
    duplicateTurnIds,
    duplicateEndedTurnIds,
    duplicatePromptIds,
    duplicateUserMessageIds,
    duplicateMarkers,
    tallReminderCount,
    nonemptyTailSlot,
    turns: completedTurns,
    failures,
  };
}

export function buildChaosConfigToml({
  anthropicBaseUrl,
  openaiBaseUrl,
  enableSearch = true,
  sessionResidency = null,
}) {
  const lines = [
    'default_model = "twin-anthropic"',
    '',
    '[providers.twin_anthropic]',
    'type = "anthropic"',
    `base_url = ${JSON.stringify(anthropicBaseUrl)}`,
    'api_key = "twin-chaos-key"',
    '',
    '[providers.twin_openai]',
    'type = "openai"',
    `base_url = ${JSON.stringify(openaiBaseUrl)}`,
    'api_key = "twin-chaos-key"',
    '',
    '[models.twin-anthropic]',
    'provider = "twin_anthropic"',
    'model = "twin-anthropic"',
    'max_context_size = 200000',
    'capabilities = ["thinking", "image_in"]',
    'support_efforts = ["low", "medium", "high"]',
    'default_effort = "high"',
    '',
    '[models.twin-openai]',
    'provider = "twin_openai"',
    'model = "twin-openai"',
    'max_context_size = 200000',
    'capabilities = ["thinking", "image_in"]',
    'support_efforts = ["low", "medium", "high"]',
    'default_effort = "high"',
    '',
    '[retry]',
    'max_attempts = 4',
    '',
    '[subagent]',
    'max_direct_children = 0',
    'max_total_subagents = 0',
    '',
    '[thread_communication]',
    'enabled = true',
    '',
    '[cron]',
    'no_jitter = true',
    '',
    '[search]',
    `enabled = ${enableSearch ? 'true' : 'false'}`,
    '',
  ];
  if (sessionResidency && typeof sessionResidency === 'object') {
    lines.push('[session_residency]');
    if (Number.isInteger(sessionResidency.maxLiveSessions)) {
      lines.push(`max_live_sessions = ${sessionResidency.maxLiveSessions}`);
    }
    if (Number.isInteger(sessionResidency.maxConcurrentRestores)) {
      lines.push(`max_concurrent_restores = ${sessionResidency.maxConcurrentRestores}`);
    }
    if (Number.isInteger(sessionResidency.maxQueuedRestores)) {
      lines.push(`max_queued_restores = ${sessionResidency.maxQueuedRestores}`);
    }
    if (Number.isInteger(sessionResidency.idleTtlMs)) {
      lines.push(`idle_ttl_ms = ${sessionResidency.idleTtlMs}`);
    }
    if (Number.isInteger(sessionResidency.minIdleMs)) {
      lines.push(`min_idle_ms = ${sessionResidency.minIdleMs}`);
    }
    if (Number.isInteger(sessionResidency.sweepIntervalMs)) {
      lines.push(`sweep_interval_ms = ${sessionResidency.sweepIntervalMs}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function seedSyntheticWorkspaceFiles(workspaceDir, count = 120) {
  const srcDir = path.join(workspaceDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# Synthetic Chaos Workspace\n', 'utf8');
  for (let i = 1; i <= count; i += 1) {
    const id = String(i).padStart(3, '0');
    const lines = [
      `export const CHAOS_TOKEN_${id} = "synthetic-chaos-marker-${id}";`,
      `export function computeSyntheticChecksum_${id}(seed: number): number {`,
      `  let acc = seed ^ ${i * 2654435761};`,
      `  for (let k = 0; k < 16; k += 1) acc = ((acc << 5) - acc + k) | 0;`,
      `  return acc >>> 0;`,
      `}`,
      `// Tail anchor line for Read negative line_offset verification (${id})`,
      '',
    ];
    fs.writeFileSync(path.join(srcDir, `mod-${id}.ts`), lines.join('\n'), 'utf8');
  }
}

export function retargetRestoredCorpus({ dir, anthropicBaseUrl, openaiBaseUrl, enableSearch = true, sessionResidency = null }) {
  const rootDir = path.resolve(dir);
  const homeDir = path.join(rootDir, 'home');
  const workspaceDir = path.join(rootDir, 'workspace');
  const wsPath = path.join(homeDir, 'workspaces.json');
  const workspaces = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
  const workspaceId = Object.keys(workspaces.workspaces)[0];
  const giantSessionId = 'chaos_giant_3g';
  const heavySubagentId = 'subagent_0001';
  const giantMainWirePath = path.join(homeDir, 'sessions', workspaceId, giantSessionId, 'agents', 'main', 'wire.jsonl');
  const mainStat = fs.statSync(giantMainWirePath);
  const heavyStat = fs.statSync(path.join(homeDir, 'sessions', workspaceId, giantSessionId, 'agents', heavySubagentId, 'wire.jsonl'));
  const stateJson = JSON.parse(
    fs.readFileSync(path.join(homeDir, 'sessions', workspaceId, giantSessionId, 'state.json'), 'utf8'),
  );
  fs.writeFileSync(
    path.join(homeDir, 'config.toml'),
    buildChaosConfigToml({ anthropicBaseUrl, openaiBaseUrl, enableSearch, sessionResidency }),
    'utf8',
  );
  return {
    rootDir,
    homeDir,
    workspaceDir,
    workspaceId,
    giantSessionId,
    heavySubagentId,
    giantMainWirePath,
    giantMainWireBytes: mainStat.size,
    giantMainWireGiB: Number((mainStat.size / GiB).toFixed(3)),
    spikeLinesWritten: 4,
    heavySubagentBytes: heavyStat.size,
    subagentCount: Math.max(0, Object.keys(stateJson.agents ?? {}).length - 1),
    backgroundSessionCount: Math.max(0, fs.readdirSync(path.join(homeDir, 'sessions', workspaceId)).length - 1),
    restoredFromArchive: true,
    elapsedMs: 0,
  };
}

export function generateChaosCorpus(options = {}) {
  const startedAt = performance.now();
  const rootDir = path.resolve(options.dir ?? '/tmp/kiki-chaos-nvme');
  const homeDir = path.join(rootDir, 'home');
  const workspaceDir = path.join(rootDir, 'workspace');
  const giantWireBytes =
    typeof options.giantWireBytes === 'number'
      ? options.giantWireBytes
      : Math.round((options.giantGiB ?? 3.1) * GiB);
  const spikeLineBytes =
    typeof options.spikeLineBytes === 'number'
      ? options.spikeLineBytes
      : Math.round((options.spikeLineMiB ?? 4) * MiB);
  const subagentCount = options.subagentCount ?? 1520;
  const heavySubagentBytes =
    typeof options.heavySubagentBytes === 'number'
      ? options.heavySubagentBytes
      : Math.round((options.heavySubagentMiB ?? 16) * MiB);
  const backgroundSessionCount = options.backgroundSessionCount ?? 80;
  const anthropicBaseUrl = options.anthropicBaseUrl ?? 'http://127.0.0.1:9';
  const openaiBaseUrl = options.openaiBaseUrl ?? 'http://127.0.0.1:9/v1';

  const enableSearch = options.enableSearch !== false;
  const sessionResidency = options.sessionResidency ?? null;
  const workspaceCount = Math.max(1, Number(options.workspaceCount ?? 1));

  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.mkdirSync(homeDir, { recursive: true });
  seedSyntheticWorkspaceFiles(workspaceDir, options.workspaceFileCount ?? 120);

  const workspaceId = computeChaosWorkDirKey(workspaceDir);
  const baseTime = 1_760_000_000_000;
  const nowIso = new Date(baseTime).toISOString();

  const workspaceEntries = {
    [workspaceId]: {
      root: workspaceDir,
      name: 'Chaos Benchmark Workspace',
      created_at: nowIso,
      last_opened_at: nowIso,
    },
  };
  const extraWorkspaceIds = [];
  if (workspaceCount > 1) {
    const extraRoot = path.join(rootDir, 'extra-workspaces');
    for (let w = 1; w < workspaceCount; w += 1) {
      const wDir = path.join(extraRoot, `ws-${String(w).padStart(3, '0')}`);
      fs.mkdirSync(wDir, { recursive: true });
      const wId = computeChaosWorkDirKey(wDir);
      extraWorkspaceIds.push({ id: wId, root: wDir });
      workspaceEntries[wId] = {
        root: wDir,
        name: `Chaos Workspace #${w + 1}`,
        created_at: nowIso,
        last_opened_at: nowIso,
      };
    }
  }

  fs.writeFileSync(
    path.join(homeDir, 'workspaces.json'),
    JSON.stringify({
      version: 1,
      workspaces: workspaceEntries,
      deleted_workspace_ids: [],
    }),
    'utf8',
  );

  fs.writeFileSync(
    path.join(homeDir, 'config.toml'),
    buildChaosConfigToml({ anthropicBaseUrl, openaiBaseUrl, enableSearch, sessionResidency }),
    'utf8',
  );

  const giantSessionId = 'chaos_giant_3g';
  const giantSessionDir = path.join(homeDir, 'sessions', workspaceId, giantSessionId);
  const giantMainWirePath = path.join(giantSessionDir, 'agents', 'main', 'wire.jsonl');
  const mainWireStats = writeGiantWireFile(giantMainWirePath, {
    targetBytes: giantWireBytes,
    spikeLineBytes,
    baseTime,
    minTurns: options.minMainTurns ?? null,
  });
  const giantWireManifestPath = path.join(rootDir, 'giant-wire-manifest.json');
  fs.writeFileSync(giantWireManifestPath, `${JSON.stringify(mainWireStats.manifest, null, 2)}\n`, 'utf8');

  const heavySubagentId = 'subagent_0001';
  const heavySubWirePath = path.join(giantSessionDir, 'agents', heavySubagentId, 'wire.jsonl');
  const heavySubStats = writeGiantWireFile(heavySubWirePath, {
    targetBytes: heavySubagentBytes,
    spikeLineBytes: Math.min(spikeLineBytes, 512 * 1024),
    baseTime: baseTime + 50_000,
  });

  const agents = {
    main: {
      type: 'main',
      displayName: 'Main',
      model: 'twin-anthropic',
      thinkingEffort: 'high',
      createdAt: baseTime,
      contextTokens: 84_200,
      toolCallCount: mainWireStats.turns,
    },
  };

  const minimalSubWire = `${JSON.stringify({ time: baseTime, type: 'metadata', payload: { protocolVersion: '1.3' } })}\n${buildTurnWireLines(1, baseTime, 'subagent-result-ok').join('\n')}\n`;

  for (let i = 1; i <= subagentCount; i += 1) {
    const aid = `subagent_${String(i).padStart(4, '0')}`;
    const isBranch = i === subagentCount;
    agents[aid] = {
      type: 'sub',
      parentAgentId: 'main',
      displayName: isBranch ? 'Branch Audit' : `Worker #${i}`,
      model: 'twin-anthropic',
      thinkingEffort: 'high',
      status: 'completed',
      createdAt: baseTime + i * 10,
      completedAt: baseTime + i * 10 + 500,
      resultSummary: `Completed synthetic task ${i}`,
      contextTokens: 4096 + (i % 1024),
      toolCallCount: 2,
      ...(isBranch ? { labels: { branch: 'chaos-branch', branchSealed: 'true' } } : {}),
    };
    if (i <= 24 || isBranch) {
      if (aid !== heavySubagentId) {
        const subDir = path.join(giantSessionDir, 'agents', aid);
        fs.mkdirSync(subDir, { recursive: true });
        fs.writeFileSync(path.join(subDir, 'wire.jsonl'), minimalSubWire, 'utf8');
      }
    }
  }

  fs.writeFileSync(
    path.join(giantSessionDir, 'state.json'),
    JSON.stringify({
      id: giantSessionId,
      version: 2,
      title: 'Giant 3.1 GiB Chaos Session',
      titleKind: 'custom',
      createdAt: baseTime,
      updatedAt: baseTime + 1_000_000,
      archived: false,
      cwd: workspaceDir,
      lastTurnReason: 'completed',
      agents,
    }),
    'utf8',
  );

  const allWorkspaces = [{ id: workspaceId, root: workspaceDir }, ...extraWorkspaceIds];
  const backgroundSessionRecords = [];
  for (let i = 0; i < backgroundSessionCount; i += 1) {
    const sid = `chaos_bg_${String(i + 1).padStart(4, '0')}`;
    const targetWs = allWorkspaces[i < 4 ? 0 : i % allWorkspaces.length];
    const sDir = path.join(homeDir, 'sessions', targetWs.id, sid);
    fs.mkdirSync(path.join(sDir, 'agents', 'main'), { recursive: true });
    const bgWire =
      i < 4
        ? `${JSON.stringify({ time: baseTime, type: 'metadata', payload: { protocolVersion: '1.3' } })}\n${buildTurnWireLines(1, baseTime, `WORKSTATION_CLIFF_SEARCH_NEEDLE bg-session-${i + 1}`).join('\n')}\n`
        : minimalSubWire;
    fs.writeFileSync(path.join(sDir, 'agents', 'main', 'wire.jsonl'), bgWire, 'utf8');
    fs.writeFileSync(
      path.join(sDir, 'state.json'),
      JSON.stringify({
        id: sid,
        version: 2,
        title: `Background Cold Session #${i + 1}`,
        titleKind: 'custom',
        createdAt: baseTime - (i + 1) * 1000,
        updatedAt: baseTime - (i + 1) * 500,
        archived: false,
        cwd: targetWs.root,
        lastTurnReason: 'completed',
        agents: {
          main: {
            type: 'main',
            displayName: 'Main',
            model: 'twin-anthropic',
            createdAt: baseTime - (i + 1) * 1000,
            contextTokens: 1200,
          },
        },
      }),
      'utf8',
    );
    backgroundSessionRecords.push({ id: sid, workspaceId: targetWs.id, cwd: targetWs.root });
  }

  const elapsedMs = Number((performance.now() - startedAt).toFixed(2));
  return {
    rootDir,
    homeDir,
    workspaceDir,
    workspaceId,
    workspaceCount,
    enableSearch,
    giantSessionId,
    heavySubagentId,
    giantMainWirePath,
    giantMainWireBytes: mainWireStats.bytes,
    giantMainWireGiB: Number((mainWireStats.bytes / GiB).toFixed(3)),
    giantMainDistinctTurns: mainWireStats.distinctTurns,
    giantMainTallReminders: mainWireStats.tallRemindersWritten,
    giantWireManifestPath,
    giantWireManifest: mainWireStats.manifest,
    spikeLinesWritten: mainWireStats.spikeLinesWritten,
    heavySubagentBytes: heavySubStats.bytes,
    subagentCount,
    backgroundSessionCount,
    backgroundSessionRecords,
    restoredFromArchive: false,
    elapsedMs,
  };
}

const isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename);
if (isMain) {
  const args = process.argv.slice(2);
  let dir = '/tmp/kiki-chaos-nvme';
  let giantGiB = 3.1;
  let subagentCount = 1520;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dir' && args[i + 1]) dir = args[++i];
    else if (args[i] === '--giant-gib' && args[i + 1]) giantGiB = Number(args[++i]) || 3.1;
    else if (args[i] === '--subagents' && args[i + 1]) subagentCount = Number(args[++i]) || 1520;
  }
  const summary = generateChaosCorpus({ dir, giantGiB, subagentCount });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
