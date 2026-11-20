#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { computeChaosWorkDirKey } from './corpus-generator.mjs';

const MiB = 1024 * 1024;
const BASE_TIME = 1_760_100_000_000;
const MODELS = ['twin-anthropic', 'twin-openai'];
const EFFORTS = ['low', 'medium', 'high'];

function formatAgentId(index) {
  return `subagent_${String(index).padStart(5, '0')}`;
}

function buildResultSummary(index, roleLabel, parentAgentId, minChars = 1400, maxChars = 1500) {
  const modA = String((index % 120) + 1).padStart(3, '0');
  const modB = String(((index * 7) % 120) + 1).padStart(3, '0');
  const aid = formatAgentId(index);
  const head = [
    `[${aid}] ${roleLabel} completed deterministic audit under parent=${parentAgentId}.`,
    `Inspected src/mod-${modA}.ts and src/mod-${modB}.ts across cold session boundaries, verified wire framing checksums, tool_result pairing invariants, and bounded transcript hydration windows.`,
    `Findings: zero protocol violations, zero unhandled rejections, memory retention delta within steady-state envelope, and clean cursor continuation across segments.`,
  ].join(' ');
  const padUnit = ` [evidence#${index}:mod-${modA}->mod-${modB}:ok:checksum=${((index * 2654435761) >>> 0).toString(16).padStart(8, '0')}]`;
  const targetLen = Math.min(maxChars, minChars + (index % Math.max(1, maxChars - minChars + 1)));
  let text = head;
  while (text.length < targetLen) {
    text += padUnit;
  }
  return text.slice(0, targetLen);
}

function buildSimpleTurnLines(turnId, ts, promptText, assistantText, toolName = 'Read', toolArgs = { path: 'README.md' }, toolOut = 'ok') {
  const turnKey = String(turnId);
  const stepUuid = `step-10k-${turnId}-1`;
  const callId = `call-10k-${turnId}-1`;
  return [
    JSON.stringify({
      type: 'turn.prompt',
      turnId,
      promptId: `prompt-10k-${turnId}`,
      input: [{ type: 'text', text: promptText }],
      origin: { kind: 'user' },
      time: ts,
    }),
    JSON.stringify({
      type: 'context.append_message',
      message: {
        id: `msg-10k-user-${turnId}`,
        role: 'user',
        content: [{ type: 'text', text: promptText }],
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
        name: toolName,
        args: JSON.stringify(toolArgs),
      },
      time: ts + 10,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.result',
        toolCallId: callId,
        result: { output: toolOut, isError: false },
      },
      time: ts + 20,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        turnId: turnKey,
        stepUuid,
        part: { type: 'text', text: assistantText },
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

function buildMainWireContent({ batchSubagents, runningIds, suspendedIds, totalCount }) {
  const lines = [
    JSON.stringify({ type: 'metadata', protocol_version: '1.6', created_at: BASE_TIME }),
  ];

  for (let turnId = 1; turnId <= 6; turnId += 1) {
    lines.push(
      ...buildSimpleTurnLines(
        turnId,
        BASE_TIME + turnId * 5_000,
        `10k-subagent scale benchmark setup turn ${turnId}: inspect workspace module ${turnId}.`,
        `Setup turn ${turnId} verified workspace checksums and prepared subagent fan-out.`,
        turnId % 2 === 0 ? 'Grep' : 'Read',
        turnId % 2 === 0 ? { pattern: `CHAOS_TOKEN_00${turnId}` } : { path: `src/mod-00${turnId}.ts` },
        `verified-setup-${turnId}`,
      ),
    );
  }

  // Turn 7: realistic 500-subagent batch fan-out turn
  const batchTurnId = 7;
  const batchTs = BASE_TIME + batchTurnId * 5_000;
  const batchTurnKey = String(batchTurnId);
  const batchStepUuid = 'step-10k-batch-7';
  const batchSize = Math.min(batchSubagents, totalCount);
  lines.push(
    JSON.stringify({
      type: 'turn.prompt',
      turnId: batchTurnId,
      promptId: 'prompt-10k-batch-7',
      input: [{ type: 'text', text: `Dispatch batch of ${batchSize} subagents across ${totalCount}-agent fleet.` }],
      origin: { kind: 'user' },
      time: batchTs,
    }),
    JSON.stringify({
      type: 'context.append_message',
      message: {
        id: 'msg-10k-user-7',
        role: 'user',
        content: [{ type: 'text', text: `Dispatch batch of ${batchSize} subagents across ${totalCount}-agent fleet.` }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      time: batchTs + 2,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: { type: 'step.begin', turnId: batchTurnKey, step: 1, uuid: batchStepUuid },
      time: batchTs + 5,
    }),
  );

  for (let i = 1; i <= batchSize; i += 1) {
    const aid = formatAgentId(i);
    const callId = `call-batch-${i}`;
    const tCall = batchTs + 10 + i * 2;
    lines.push(
      JSON.stringify({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          turnId: batchTurnKey,
          stepUuid: batchStepUuid,
          toolCallId: callId,
          name: 'AgentRun',
          args: JSON.stringify({
            name: aid,
            description: `Fleet worker ${i}`,
            prompt: `Audit slice ${i} of ${totalCount}`,
            background: true,
          }),
        },
        time: tCall,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          toolCallId: callId,
          result: { output: JSON.stringify({ agent_id: aid, status: 'started' }), isError: false },
        },
        time: tCall + 1,
      }),
    );
  }

  lines.push(
    JSON.stringify({
      type: 'context.append_loop_event',
      event: {
        type: 'content.part',
        turnId: batchTurnKey,
        stepUuid: batchStepUuid,
        part: {
          type: 'text',
          text: `Dispatched ${batchSize} subagents in batch turn 7 (total fleet ${totalCount}, active=${runningIds.length}, waiting=${suspendedIds.length}).`,
        },
      },
      time: batchTs + 2000,
    }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: { type: 'step.end', turnId: batchTurnKey, step: 1, uuid: batchStepUuid },
      time: batchTs + 2010,
    }),
    JSON.stringify({
      type: 'turn.ended',
      turnId: batchTurnId,
      durationMs: 2020,
      reason: 'completed',
      time: batchTs + 2020,
    }),
  );

  // Trailing turns so the visible tail renders crisp timeline turns immediately
  for (let turnId = 8; turnId <= 12; turnId += 1) {
    lines.push(
      ...buildSimpleTurnLines(
        turnId,
        BASE_TIME + turnId * 10_000,
        `10k-subagent scale verification turn ${turnId}: summarize completed worker results.`,
        `Fleet status turn ${turnId}: ${totalCount} subagents indexed across 3 hierarchy depths, ready for virtualized UI and ContentRef hydration checks.`,
        'AgentList',
        { include_finished: true },
        `{"total":${totalCount},"running":${runningIds.length},"suspended":${suspendedIds.length}}`,
      ),
    );
  }

  return `${lines.join('\n')}\n`;
}

function buildUniqueSubagentWire(aid, index, parentAgentId) {
  const ts = BASE_TIME + 50_000 + index * 10;
  const lines = [
    JSON.stringify({ type: 'metadata', protocol_version: '1.6', created_at: ts }),
    ...buildSimpleTurnLines(
      1,
      ts + 100,
      `Inspect unique assigned workload for ${aid} (parent=${parentAgentId}).`,
      `UNIQUE_SUBAGENT_RECEIPT:${aid}:parent=${parentAgentId}:index=${index}:status=verified`,
      'Read',
      { path: `src/mod-${String((index % 120) + 1).padStart(3, '0')}.ts`, line_offset: 1, n_lines: 10 },
      `module-content-verified-for-${aid}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

function resolveTemplateWire(homeDir, workspaceId, sourceSessionId) {
  const candidates = [
    path.join(homeDir, 'sessions', workspaceId, sourceSessionId, 'agents', 'subagent_0002', 'wire.jsonl'),
    path.join(homeDir, 'sessions', workspaceId, sourceSessionId, 'agents', 'subagent_0003', 'wire.jsonl'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const stat = fs.statSync(candidate);
      if (stat.size > 0 && stat.size <= 256 * 1024) {
        return fs.readFileSync(candidate, 'utf8');
      }
    }
  }
  return buildUniqueSubagentWire('subagent_template', 0, 'main');
}

function ensureSwitchAwaySession(homeDir, workspaceId, workspaceDir) {
  const lightSid = 'chaos_bg_0001';
  const lightDir = path.join(homeDir, 'sessions', workspaceId, lightSid);
  const lightWire = path.join(lightDir, 'agents', 'main', 'wire.jsonl');
  const lightState = path.join(lightDir, 'state.json');
  if (fs.existsSync(lightWire) && fs.existsSync(lightState)) {
    return lightSid;
  }
  fs.mkdirSync(path.dirname(lightWire), { recursive: true });
  fs.writeFileSync(lightWire, buildUniqueSubagentWire('light_main', 1, 'main'), 'utf8');
  fs.writeFileSync(
    lightState,
    JSON.stringify({
      id: lightSid,
      version: 2,
      title: 'Background Cold Session #1',
      titleKind: 'custom',
      createdAt: BASE_TIME - 10_000,
      updatedAt: BASE_TIME - 5_000,
      archived: false,
      cwd: workspaceDir,
      lastTurnReason: 'completed',
      agents: {
        main: {
          type: 'main',
          displayName: 'Main',
          model: 'twin-anthropic',
          createdAt: BASE_TIME - 10_000,
          contextTokens: 1200,
        },
      },
    }),
    'utf8',
  );
  return lightSid;
}

export function clone10kSubagents(options = {}) {
  const startedAt = performance.now();
  const rootDir = path.resolve(options.dir ?? '/tmp/kiki-chaos-nvme');
  const homeDir = path.join(rootDir, 'home');
  const workspaceDir = path.join(rootDir, 'workspace');
  const sourceSessionId = options.sourceSessionId ?? 'chaos_giant_3g';
  const targetSessionId = options.targetSessionId ?? 'chaos_10k_subagents';
  const subagentCount = Math.max(20, Math.floor(options.subagentCount ?? 10_000));
  const batchTurnSubagents = Math.min(options.batchTurnSubagents ?? 500, subagentCount);
  const minSummaryChars = options.minSummaryChars ?? (subagentCount >= 10_000 ? 1400 : 600);
  const maxSummaryChars = options.maxSummaryChars ?? 1500;

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const wsPath = path.join(homeDir, 'workspaces.json');
  let workspaceId;
  if (fs.existsSync(wsPath)) {
    const workspaces = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
    workspaceId = Object.keys(workspaces.workspaces ?? {})[0];
  }
  if (!workspaceId) {
    workspaceId = computeChaosWorkDirKey(workspaceDir);
    const nowIso = new Date(BASE_TIME).toISOString();
    fs.writeFileSync(
      wsPath,
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
  }

  const lightSessionId = ensureSwitchAwaySession(homeDir, workspaceId, workspaceDir);

  // Target hierarchy & status counts scaled cleanly for unit tests while exact at N = 10,000
  const runningCount = Math.min(8, Math.max(1, Math.floor((subagentCount * 8) / 10_000) || 1));
  const suspendedCount = Math.min(4, Math.max(1, Math.floor((subagentCount * 4) / 10_000) || 1));
  const branchCount = Math.min(12, Math.max(2, Math.floor((subagentCount * 12) / 10_000) || 2));
  const failedCount = Math.min(40, Math.max(2, Math.floor((subagentCount * 40) / 10_000) || 2));
  const directChildCount = Math.floor(subagentCount * 0.92);
  const depth2Count = Math.floor((subagentCount - directChildCount) * 0.75);
  const depth3Count = subagentCount - directChildCount - depth2Count;

  const runningStart = 1;
  const runningEnd = runningStart + runningCount - 1;
  const suspendedStart = runningEnd + 1;
  const suspendedEnd = suspendedStart + suspendedCount - 1;
  const branchStart = suspendedEnd + 1;
  const branchEnd = branchStart + branchCount - 1;
  const failedStart = Math.min(subagentCount, Math.max(branchEnd + 1, subagentCount >= 120 ? 65 : branchEnd + 1));
  const failedEnd = Math.min(subagentCount, failedStart + failedCount - 1);

  const coldHistoricalIdA = formatAgentId(Math.min(subagentCount, 42));
  const coldHistoricalIdB = formatAgentId(Math.max(2, Math.floor(subagentCount / 2)));
  const inspectedIds = new Set([
    formatAgentId(1),
    coldHistoricalIdA,
    coldHistoricalIdB,
    formatAgentId(subagentCount),
  ]);

  const targetSessionDir = path.join(homeDir, 'sessions', workspaceId, targetSessionId);
  const agentsDir = path.join(targetSessionDir, 'agents');
  fs.rmSync(targetSessionDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(agentsDir, 'main'), { recursive: true });

  const templateWireText = resolveTemplateWire(homeDir, workspaceId, sourceSessionId);
  const templateWirePath = path.join(targetSessionDir, '_cold_subagent_wire.template.jsonl');
  fs.writeFileSync(templateWirePath, templateWireText, 'utf8');

  const runningIds = [];
  const suspendedIds = [];
  const branchIds = [];
  const failedIds = [];

  const agents = {
    main: {
      type: 'main',
      displayName: 'Main',
      model: 'twin-anthropic',
      thinkingEffort: 'high',
      createdAt: BASE_TIME,
      contextTokens: 96_400,
      toolCallCount: batchTurnSubagents + 11,
    },
  };

  let hardlinkedCount = 0;
  let copiedCount = 0;
  let uniqueWireCount = 0;
  const depth2ParentSpan = Math.max(1, Math.min(60, directChildCount));
  const depth3ParentStart = directChildCount + 1;
  const depth3ParentSpan = Math.max(1, Math.min(50, depth2Count));

  for (let i = 1; i <= subagentCount; i += 1) {
    const aid = formatAgentId(i);
    let parentAgentId = 'main';
    let depth = 1;
    if (i > directChildCount && i <= directChildCount + depth2Count) {
      const parentIdx = ((i - directChildCount - 1) % depth2ParentSpan) + 1;
      parentAgentId = formatAgentId(parentIdx);
      depth = 2;
    } else if (i > directChildCount + depth2Count) {
      const parentIdx = depth3ParentStart + ((i - directChildCount - depth2Count - 1) % depth3ParentSpan);
      parentAgentId = formatAgentId(parentIdx);
      depth = 3;
    }

    const isRunning = i >= runningStart && i <= runningEnd;
    const isSuspended = i >= suspendedStart && i <= suspendedEnd;
    const isBranch = i >= branchStart && i <= branchEnd;
    const isFailed = i >= failedStart && i <= failedEnd;

    if (isRunning) runningIds.push(aid);
    if (isSuspended) suspendedIds.push(aid);
    if (isBranch) branchIds.push(aid);
    if (isFailed) failedIds.push(aid);

    const createdAt = BASE_TIME + 10_000 + i * 5;
    const model = MODELS[i % MODELS.length];
    const thinkingEffort = EFFORTS[i % EFFORTS.length];
    const roleLabel = aid === coldHistoricalIdA
      ? 'Cold Archive Needle #0042'
      : aid === coldHistoricalIdB
        ? `Mid-Fleet Cold Needle #${Math.max(2, Math.floor(subagentCount / 2))}`
        : isBranch
          ? `Branch Audit #${i - branchStart + 1}`
          : depth === 3
            ? `Leaf Verifier #${i}`
            : depth === 2
              ? `Sub-Worker #${i}`
              : `Fleet Worker #${i}`;

    const entry = {
      type: 'sub',
      parentAgentId,
      displayName: roleLabel,
      userLabel: aid,
      model,
      thinkingEffort,
      thinkingEffortExplicit: true,
      createdAt,
      taskId: `task_10k_${String(i).padStart(5, '0')}`,
      contextTokens: 4_096 + (i % 16_384),
      toolCallCount: 2 + (i % 12),
      usage: {
        inputOther: 1_200 + (i % 800),
        output: 420 + (i % 300),
        inputCacheRead: 2_400 + (i % 1_600),
        inputCacheCreation: 320 + (i % 128),
      },
      resultSummary: buildResultSummary(i, roleLabel, parentAgentId, minSummaryChars, maxSummaryChars),
    };

    if (isBranch) {
      const sealed = (i - branchStart) % 2 === 0;
      entry.labels = {
        branch: 'true',
        branchSeed: 'compact',
        branchInitiator: 'user',
        branchSealed: sealed ? 'true' : 'false',
        toolsLocked: 'false',
        branchBaseTurnId: '3',
      };
      entry.status = 'completed';
      entry.completedAt = createdAt + 1_500;
    } else if (isFailed) {
      entry.status = 'failed';
      entry.completedAt = createdAt + 950;
      entry.error = `Synthetic worker failure for ${aid}: upstream retry budget exhausted at slice ${i}`;
    } else if (isRunning) {
      entry.labels = { chaosState: 'running' };
    } else if (isSuspended) {
      entry.labels = { chaosState: 'suspended' };
    } else {
      entry.status = 'completed';
      entry.completedAt = createdAt + 1_200 + (i % 4_000);
    }

    agents[aid] = entry;

    const subDir = path.join(agentsDir, aid);
    fs.mkdirSync(subDir, { recursive: true });
    const subWirePath = path.join(subDir, 'wire.jsonl');
    if (inspectedIds.has(aid)) {
      fs.writeFileSync(subWirePath, buildUniqueSubagentWire(aid, i, parentAgentId), 'utf8');
      uniqueWireCount += 1;
    } else {
      try {
        fs.linkSync(templateWirePath, subWirePath);
        hardlinkedCount += 1;
      } catch {
        fs.copyFileSync(templateWirePath, subWirePath);
        copiedCount += 1;
      }
    }
  }

  fs.rmSync(templateWirePath, { force: true });

  const mainWirePath = path.join(agentsDir, 'main', 'wire.jsonl');
  const mainWireContent = buildMainWireContent({
    batchSubagents: batchTurnSubagents,
    runningIds,
    suspendedIds,
    totalCount: subagentCount,
  });
  fs.writeFileSync(mainWirePath, mainWireContent, 'utf8');

  const stateJsonPath = path.join(targetSessionDir, 'state.json');
  const statePayload = JSON.stringify({
    id: targetSessionId,
    version: 2,
    title: `10k Subagent Extreme Scale (${subagentCount} agents)`,
    titleKind: 'custom',
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME + 500_000,
    archived: false,
    cwd: workspaceDir,
    lastTurnReason: 'completed',
    agents,
  });
  fs.writeFileSync(stateJsonPath, statePayload, 'utf8');

  const stateBytes = fs.statSync(stateJsonPath).size;
  const mainWireBytes = fs.statSync(mainWirePath).size;
  const completedCount = subagentCount - runningIds.length - suspendedIds.length - failedIds.length;
  const elapsedMs = Number((performance.now() - startedAt).toFixed(2));

  return {
    rootDir,
    homeDir,
    workspaceDir,
    workspaceId,
    sessionId: targetSessionId,
    lightSessionId,
    subagentCount,
    hierarchy: {
      directChildren: directChildCount,
      depth2Grandchildren: depth2Count,
      depth3GreatGrandchildren: depth3Count,
    },
    statuses: {
      running: runningIds.length,
      suspended: suspendedIds.length,
      failed: failedIds.length,
      completed: completedCount,
      branches: branchIds.length,
    },
    inspectedSubagentIds: [...inspectedIds],
    coldHistoricalNeedleIds: [coldHistoricalIdA, coldHistoricalIdB],
    familyPopoverTargetId: formatAgentId(1),
    deepestInspectTargetId: formatAgentId(subagentCount),
    stateJsonPath,
    stateJsonBytes: stateBytes,
    stateJsonMiB: Number((stateBytes / MiB).toFixed(2)),
    exceeds16MiBColdMetaCap: stateBytes > 16 * MiB,
    mainWirePath,
    mainWireBytes,
    mainWireMiB: Number((mainWireBytes / MiB).toFixed(2)),
    wireLinkStats: {
      unique: uniqueWireCount,
      hardlinked: hardlinkedCount,
      copied: copiedCount,
    },
    elapsedMs,
  };
}

const isMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename);
if (isMain) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dir' && args[i + 1]) opts.dir = args[++i];
    else if (args[i] === '--source-session' && args[i + 1]) opts.sourceSessionId = args[++i];
    else if (args[i] === '--target-session' && args[i + 1]) opts.targetSessionId = args[++i];
    else if (args[i] === '--count' && args[i + 1]) opts.subagentCount = Number(args[++i]);
    else if (args[i] === '--batch-turn' && args[i + 1]) opts.batchTurnSubagents = Number(args[++i]);
  }
  const summary = clone10kSubagents(opts);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
