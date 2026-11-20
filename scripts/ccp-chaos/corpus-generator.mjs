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

function buildTurnWireLines(turnId, baseTime, outputPayload) {
  const ts = baseTime + turnId * 1000;
  const turnKey = String(turnId);
  const stepUuid = `step-${turnId}-1`;
  const callId = `call-${turnId}-1`;
  const toolDef = CORPUS_TOOL_ROTATION[turnId % CORPUS_TOOL_ROTATION.length];
  return [
    JSON.stringify({
      type: 'turn.prompt',
      turnId,
      promptId: `prompt-${turnId}`,
      input: [{ type: 'text', text: `Synthetic chaos benchmark turn ${turnId} invoking ${toolDef.name}` }],
      origin: { kind: 'user' },
      time: ts,
    }),
    JSON.stringify({
      type: 'context.append_message',
      message: {
        id: `msg-user-${turnId}`,
        role: 'user',
        content: [{ type: 'text', text: `Synthetic chaos benchmark turn ${turnId} invoking ${toolDef.name}` }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      time: ts + 2,
    }),
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
          text: `Synthetic assistant summary for turn ${turnId} after ${toolDef.name} verifying zero-PII corpus layout.`,
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
  ];
}

function writeGiantWireFile(filePath, { targetBytes, spikeLineBytes, baseTime }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'w');
  let writtenBytes = 0;
  let turnId = 0;
  let spikeLinesWritten = 0;

  try {
    const headerBuf = Buffer.from(
      `${JSON.stringify({ type: 'metadata', protocol_version: '1.6', created_at: baseTime })}\n`,
      'utf8',
    );
    fs.writeSync(fd, headerBuf);
    writtenBytes += headerBuf.byteLength;

    const spikePayload = 'S'.repeat(Math.max(1024, spikeLineBytes - 256));
    const regularPayload = 'R'.repeat(Math.min(256 * 1024, Math.max(4096, Math.floor(targetBytes / 32))));

    const regularCycle = Buffer.from(
      `${Array.from({ length: CORPUS_TOOL_ROTATION.length }, (_, idx) =>
        buildTurnWireLines(idx + 1, baseTime, regularPayload).join('\n'),
      ).join('\n')}\n`,
      'utf8',
    );
    const regularSingle = Buffer.from(`${buildTurnWireLines(1, baseTime, regularPayload).join('\n')}\n`, 'utf8');
    const spikeTemplate = Buffer.from(`${buildTurnWireLines(2, baseTime, spikePayload).join('\n')}\n`, 'utf8');

    const tailTurns = 24;
    const tailChunks = [];
    for (let i = 0; i < tailTurns; i += 1) {
      tailChunks.push(...buildTurnWireLines(i + 1, baseTime, `tail-turn-output-${i + 1}`));
    }
    const tailReserveBytes = Buffer.byteLength(`${tailChunks.join('\n')}\n`, 'utf8');
    const mainFillTarget = Math.max(0, targetBytes - tailReserveBytes);

    let iteration = 0;
    while (writtenBytes < mainFillTarget) {
      if (spikeLinesWritten < 4 && (iteration === 0 || (iteration % 12 === 0 && writtenBytes + spikeTemplate.byteLength <= targetBytes))) {
        fs.writeSync(fd, spikeTemplate);
        writtenBytes += spikeTemplate.byteLength;
        spikeLinesWritten += 1;
        turnId += 1;
      } else if (targetBytes >= 64 * MiB && writtenBytes + regularCycle.byteLength <= mainFillTarget) {
        fs.writeSync(fd, regularCycle);
        writtenBytes += regularCycle.byteLength;
        turnId += CORPUS_TOOL_ROTATION.length;
      } else {
        fs.writeSync(fd, regularSingle);
        writtenBytes += regularSingle.byteLength;
        turnId += 1;
      }
      iteration += 1;
    }

    const finalTailChunks = [];
    for (let i = 0; i < tailTurns; i += 1) {
      turnId += 1;
      finalTailChunks.push(...buildTurnWireLines(turnId, baseTime, `tail-turn-output-${turnId}`));
    }
    const tailBuf = Buffer.from(`${finalTailChunks.join('\n')}\n`, 'utf8');
    fs.writeSync(fd, tailBuf);
    writtenBytes += tailBuf.byteLength;
  } finally {
    fs.closeSync(fd);
  }

  return {
    bytes: writtenBytes,
    turns: turnId,
    spikeLinesWritten,
  };
}

export function buildChaosConfigToml({ anthropicBaseUrl, openaiBaseUrl, enableSearch = false }) {
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
    '[thread_communication]',
    'enabled = true',
    '',
    '[cron]',
    'manualTick = true',
    '',
    '[search]',
    `enabled = ${enableSearch ? 'true' : 'false'}`,
    '',
  ];
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

export function retargetRestoredCorpus({ dir, anthropicBaseUrl, openaiBaseUrl, enableSearch = false }) {
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
    buildChaosConfigToml({ anthropicBaseUrl, openaiBaseUrl, enableSearch }),
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

  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.mkdirSync(homeDir, { recursive: true });
  seedSyntheticWorkspaceFiles(workspaceDir, options.workspaceFileCount ?? 120);

  const workspaceId = computeChaosWorkDirKey(workspaceDir);
  const baseTime = 1_760_000_000_000;
  const nowIso = new Date(baseTime).toISOString();

  fs.writeFileSync(
    path.join(homeDir, 'workspaces.json'),
    JSON.stringify({
      version: 1,
      workspaces: {
        [workspaceId]: {
          root: workspaceDir,
          name: 'Chaos Benchmark Workspace',
          created_at: nowIso,
          last_opened_at: nowIso,
        },
      },
      deleted_workspace_ids: [],
    }),
    'utf8',
  );

  fs.writeFileSync(
    path.join(homeDir, 'config.toml'),
    buildChaosConfigToml({ anthropicBaseUrl, openaiBaseUrl, enableSearch: false }),
    'utf8',
  );

  const giantSessionId = 'chaos_giant_3g';
  const giantSessionDir = path.join(homeDir, 'sessions', workspaceId, giantSessionId);
  const giantMainWirePath = path.join(giantSessionDir, 'agents', 'main', 'wire.jsonl');
  const mainWireStats = writeGiantWireFile(giantMainWirePath, {
    targetBytes: giantWireBytes,
    spikeLineBytes,
    baseTime,
  });

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

  for (let i = 0; i < backgroundSessionCount; i += 1) {
    const sid = `chaos_bg_${String(i + 1).padStart(4, '0')}`;
    const sDir = path.join(homeDir, 'sessions', workspaceId, sid);
    fs.mkdirSync(path.join(sDir, 'agents', 'main'), { recursive: true });
    fs.writeFileSync(path.join(sDir, 'agents', 'main', 'wire.jsonl'), minimalSubWire, 'utf8');
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
        cwd: workspaceDir,
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
  }

  const elapsedMs = Number((performance.now() - startedAt).toFixed(2));
  return {
    rootDir,
    homeDir,
    workspaceDir,
    workspaceId,
    giantSessionId,
    heavySubagentId,
    giantMainWirePath,
    giantMainWireBytes: mainWireStats.bytes,
    giantMainWireGiB: Number((mainWireStats.bytes / GiB).toFixed(3)),
    spikeLinesWritten: mainWireStats.spikeLinesWritten,
    heavySubagentBytes: heavySubStats.bytes,
    subagentCount,
    backgroundSessionCount,
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
