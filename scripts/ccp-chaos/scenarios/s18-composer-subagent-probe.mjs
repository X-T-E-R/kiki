import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { writeGiantWireFile } from '../corpus-generator.mjs';
import { quantiles } from '../../perf/metrics.mjs';

function encodeToolPlan(plan) {
  return `[V23_TOOL_PLAN:${Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url')}]`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function roundMs(value) {
  return Number(value.toFixed(2));
}

async function apiJson(endpoint, token, method, urlPath, body = undefined, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(`${endpoint}${urlPath}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text, elapsedMs: roundMs(performance.now() - t0) };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      json: null,
      text: '',
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: roundMs(performance.now() - t0),
    };
  } finally {
    clearTimeout(timer);
  }
}

function deepLinkFor(server, routePath) {
  const sep = routePath.includes('?') ? '&' : '?';
  return `${server.endpoint}${routePath}${sep}token=${encodeURIComponent(server.token)}`;
}

async function seedLargeThreadReadTarget(server, workspaceId, workspaceSessionsDir, targetBytes, index) {
  const created = await apiJson(server.endpoint, server.token, 'POST', '/api/sessions', {
    workspace_id: workspaceId,
    title: `S18 Heavy ThreadRead Target #${index}`,
  });
  const sid = created.json?.data?.id ?? created.json?.data?.session_id;
  if (!created.ok || !sid) return null;
  const mainAgentDir = path.join(workspaceSessionsDir, sid, 'agents', 'main');
  fs.mkdirSync(mainAgentDir, { recursive: true });
  const wirePath = path.join(mainAgentDir, 'wire.jsonl');
  writeGiantWireFile(wirePath, {
    targetBytes,
    spikeLineBytes: 512 * 1024,
    baseTime: Date.now() - 3600_000 - index * 600_000,
    minTurns: 60,
  });
  return { sessionId: sid, wirePath, bytes: fs.statSync(wirePath).size };
}

async function createSession(server, workspaceId, title) {
  const res = await apiJson(server.endpoint, server.token, 'POST', '/api/sessions', {
    workspace_id: workspaceId,
    title,
  });
  const sid = res.json?.data?.id ?? res.json?.data?.session_id;
  if (!res.ok || !sid) {
    throw new Error(`Failed to create session "${title}": status=${res.status} ${res.text?.slice(0, 200)}`);
  }
  return sid;
}

async function waitForSubagentsRunning(server, sessionId, expectedNames, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  const resolved = new Map();
  while (performance.now() < deadline) {
    const res = await apiJson(server.endpoint, server.token, 'GET', `/api/sessions/${sessionId}/subagents?limit=50`, undefined, 8_000);
    const list = Array.isArray(res.json?.data?.items)
      ? res.json.data.items
      : Array.isArray(res.json?.data)
        ? res.json.data
        : [];
    for (const entry of list) {
      const name = entry?.name ?? entry?.label ?? '';
      const id = entry?.agent_id ?? entry?.agentId ?? entry?.id;
      const status = entry?.status ?? '';
      if (id && id !== 'main' && expectedNames.includes(name) && (status === 'running' || status === 'active' || status === 'background')) {
        resolved.set(name, { agentId: id, name, status });
      }
    }
    if (resolved.size >= expectedNames.length) {
      return expectedNames.map((n) => resolved.get(n));
    }
    if (typeof server.inspectLiveAgents === 'function') {
      const live = await server.inspectLiveAgents(sessionId).catch(() => null);
      const childIds = Array.isArray(live?.childIds) ? live.childIds : [];
      if (childIds.length >= expectedNames.length && resolved.size < expectedNames.length) {
        return childIds.slice(0, expectedNames.length).map((id, idx) => ({
          agentId: id,
          name: expectedNames[idx] ?? id,
          status: 'running',
        }));
      }
    }
    await sleep(60);
  }
  return expectedNames.map((n) => resolved.get(n) ?? null).filter(Boolean);
}

async function waitForAgentBackendTerminal(server, sessionId, agentId, timeoutMs = 15_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const res = await apiJson(server.endpoint, server.token, 'GET', `/api/sessions/${sessionId}/subagents?limit=50`, undefined, 5_000);
    const list = Array.isArray(res.json?.data?.items)
      ? res.json.data.items
      : Array.isArray(res.json?.data)
        ? res.json.data
        : [];
    const entry = list.find((a) => (a?.agent_id ?? a?.agentId ?? a?.id) === agentId);
    const status = entry?.status ?? null;
    if (status && status !== 'running' && status !== 'active' && status !== 'background' && status !== 'starting') {
      return { reached: true, status, atEpochMs: Date.now() };
    }
    await sleep(15);
  }
  return { reached: false, status: null, atEpochMs: null };
}

export async function runComposerSendAndSubagentSyncProbe({
  server,
  twin,
  context,
  corpus,
  runId,
  mode,
  budgets,
  progress = () => {},
}) {
  const composerClearBudgetMs = budgets?.composerClearOrEchoP95Ms ?? 100;
  const promptAckBudgetMs = budgets?.promptHttpAckP95Ms ?? 500;
  const subagentSyncBudgetMs = budgets?.subagentStatusSyncP95Ms ?? 500;
  const largeTargetBytes = mode === 'coupled-release' ? 24 * 1024 * 1024 : 14 * 1024 * 1024;
  const workspaceSessionsDir = path.dirname(path.dirname(path.dirname(corpus.giantMainWirePath)));

  progress(
    `S18 [5b/7]: Seeding 3 extra large wires (${Math.round(largeTargetBytes / (1024 * 1024))}MiB ea) + launching 4x ThreadRead storm + 7 concurrent subagents + file-index churn for real Composer Enter & Subagent-sync probe...`,
  );

  // 1. Seed 3 extra cold multi-MiB wire sessions so 4 concurrent ThreadRead calls hit 4 distinct large wires
  const extraTargets = [];
  for (let i = 1; i <= 3; i += 1) {
    const seeded = await seedLargeThreadReadTarget(server, corpus.workspaceId, workspaceSessionsDir, largeTargetBytes, i);
    if (seeded) extraTargets.push(seeded);
  }
  const largeThreadReadTargets = [
    { sessionId: corpus.giantSessionId, bytes: fs.statSync(corpus.giantMainWirePath).size },
    ...extraTargets.map((t) => ({ sessionId: t.sessionId, bytes: t.bytes })),
  ];

  // Create 4 ThreadRead driver sessions + 1 background subagent swarm host + 1 interactive GUI session
  const threadReadDrivers = [];
  for (let i = 0; i < 4; i += 1) {
    threadReadDrivers.push(await createSession(server, corpus.workspaceId, `S18 ThreadRead Storm Driver #${i + 1}`));
  }
  const bgSwarmSessionId = await createSession(server, corpus.workspaceId, 'S18 Background Subagent Swarm Host');
  const interactiveSessionId = await createSession(server, corpus.workspaceId, 'S18 Composer & Subagent Sync Session');

  // 2. Start the 3 coupled background storms:
  //    (a) 4 concurrent cross-session ThreadRead loops hitting large wire.jsonl files
  //    (b) 5 concurrent background subagents writing tool outputs & wire records continuously
  //    (c) Workspace file-index churn (creating/updating/deleting files under workspaceDir/src/)
  let stopStorm = false;
  const stormStats = {
    largeThreadReadTargetCount: largeThreadReadTargets.length,
    largeThreadReadTotalMiB: roundMs(largeThreadReadTargets.reduce((acc, t) => acc + t.bytes, 0) / (1024 * 1024)),
    threadReadDispatched: 0,
    threadReadCompleted: 0,
    bgSubagentWavesDispatched: 0,
    bgSubagentWavesCompleted: 0,
    bgSubagentConcurrency: 5,
    trackedSubagentCount: 2,
    fileChurnOps: 0,
  };

  const churnDir = path.join(corpus.workspaceDir, 'src');
  fs.mkdirSync(churnDir, { recursive: true });
  const createdChurnFiles = new Set();

  const fileChurnPromise = (async () => {
    let seq = 0;
    while (!stopStorm) {
      seq += 1;
      const filePath = path.join(churnDir, `.s18-churn-${seq % 8}.ts`);
      try {
        if (seq % 5 === 0 && fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          createdChurnFiles.delete(filePath);
        } else {
          fs.writeFileSync(
            filePath,
            `export const S18_CHURN_${seq} = "${randomUUID()}";\nexport const TS = ${Date.now()};\n`,
            'utf8',
          );
          createdChurnFiles.add(filePath);
        }
        stormStats.fileChurnOps += 1;
      } catch {
        // ignore transient EBUSY on Windows
      }
      await sleep(75);
    }
    for (const fp of createdChurnFiles) {
      try {
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      } catch {
        // best-effort cleanup
      }
    }
  })();

  const threadReadStormPromises = threadReadDrivers.map((driverSid, driverIdx) =>
    (async () => {
      let round = 0;
      while (!stopStorm) {
        round += 1;
        const target = largeThreadReadTargets[(driverIdx + round) % largeThreadReadTargets.length];
        stormStats.threadReadDispatched += 1;
        const plan = encodeToolPlan({
          steps: [
            {
              calls: [
                {
                  name: 'ThreadRead',
                  input: {
                    thread: { session_id: target.sessionId },
                    limit: 25,
                  },
                },
              ],
            },
          ],
          finalText: `S18_TR_STORM_${driverIdx}_${round}`,
        });
        const r = await apiJson(
          server.endpoint,
          server.token,
          'POST',
          `/api/sessions/${driverSid}/prompts`,
          {
            content: [{ type: 'text', text: `[CHAOS_SCOPE:s18_tr_storm_${runId}_${driverIdx}_${round}] ${plan}` }],
          },
          20_000,
        );
        if (r.ok && r.json?.code === 0) {
          stormStats.threadReadCompleted += 1;
        }
        await sleep(60);
      }
    })(),
  );

  const bgSubagentStormPromise = (async () => {
    let wave = 0;
    while (!stopStorm) {
      wave += 1;
      stormStats.bgSubagentWavesDispatched += 1;
      const calls = [];
      for (let k = 1; k <= 5; k += 1) {
        const childPlan = encodeToolPlan({
          steps: [
            {
              calls: [
                { name: 'Read', input: { path: `src/mod-${String(((wave + k) % 10) + 1).padStart(3, '0')}.ts`, line_offset: 1, n_lines: 12 } },
                { name: 'Grep', input: { pattern: 'CHAOS_TOKEN', path: 'src' } },
              ],
            },
            {
              calls: [
                { name: 'Read', input: { path: `src/mod-${String(((wave + k + 3) % 10) + 1).padStart(3, '0')}.ts`, line_offset: 1, n_lines: 12 } },
              ],
            },
          ],
          finalText: `S18_BG_SUB_${wave}_${k}_DONE`,
        });
        calls.push({
          name: 'AgentRun',
          input: {
            description: `S18 bg worker w${wave} #${k}`,
            name: `s18_bg_w${wave}_${k}`,
            profile: 'general',
            model_alias: 'twin-anthropic',
            effort: 'high',
            background: false,
            prompt: `[CHAOS_SCOPE:s18_bg_sub_${runId}_${wave}_${k}] ${childPlan}`,
          },
        });
      }
      const hostPlan = encodeToolPlan({
        steps: [{ calls }],
        finalText: `S18_BG_SWARM_WAVE_${wave}_OK`,
      });
      const r = await apiJson(
        server.endpoint,
        server.token,
        'POST',
        `/api/sessions/${bgSwarmSessionId}/prompts`,
        {
          content: [{ type: 'text', text: `[CHAOS_SCOPE:s18_bg_swarm_${runId}_${wave}] ${hostPlan}` }],
        },
        30_000,
      );
      if (r.ok && r.json?.code === 0) {
        stormStats.bgSubagentWavesCompleted += 1;
      }
      await sleep(80);
    }
  })();

  // 3. Open the interactive GUI session in Playwright with right rail visible
  const page = await context.newPage();
  const childBarrier1Id = `s18_sync_b1_${runId}`;
  const childBarrier2Id = `s18_sync_b2_${runId}`;
  const parentBarrierId = `s18_sync_parent_${runId}`;
  const childBarrier1 = twin.prepareBarrier(childBarrier1Id);
  const childBarrier2 = twin.prepareBarrier(childBarrier2Id);
  const parentBarrier = twin.prepareBarrier(parentBarrierId);
  const trackedChildNames = ['s18_sync_child_1', 's18_sync_child_2'];

  const sends = [];
  const subagentSyncResults = [];
  const failures = [];
  let trackedChildren = [];
  let interactiveTurnPromise = null;

  try {
    await page.goto(deepLinkFor(server, `/s/${interactiveSessionId}`), {
      waitUntil: 'domcontentloaded',
      timeout: 25_000,
    });
    const input = page.locator('[data-composer-input]').first();
    await input.waitFor({ state: 'visible', timeout: 15_000 });

    // Ensure right inspector rail is open so [data-session-rail] [data-agent-id] is mounted
    const railVisible = await page.locator('[data-session-rail]').first().isVisible().catch(() => false);
    if (!railVisible) {
      const railToggle = page.locator('[data-rail-toggle], button[aria-label*="检查器"], button[aria-label*="Inspector"]').first();
      if (await railToggle.isVisible().catch(() => false)) {
        await railToggle.click({ timeout: 5_000 }).catch(() => undefined);
        await sleep(250);
      }
    }

    // Launch a running parent turn that spawns 2 barrier-held background child subagents
    // and then holds at parentBarrier so the parent session stays BUSY for both Queue (Enter) and Send now (Ctrl+Enter)
    const child1Plan = encodeToolPlan({
      steps: [
        { calls: [{ name: 'Read', input: { path: 'README.md', line_offset: 1, n_lines: 3 } }] },
        { barrierId: childBarrier1Id, calls: [{ name: 'Read', input: { path: 'README.md', line_offset: 1, n_lines: 4 } }] },
      ],
      finalText: 'S18_SYNC_CHILD_1_DONE',
    });
    const child2Plan = encodeToolPlan({
      steps: [
        { calls: [{ name: 'Read', input: { path: 'README.md', line_offset: 1, n_lines: 3 } }] },
        { barrierId: childBarrier2Id, calls: [{ name: 'Read', input: { path: 'README.md', line_offset: 1, n_lines: 4 } }] },
      ],
      finalText: 'S18_SYNC_CHILD_2_DONE',
    });
    const child1Prompt = `[CHAOS_SCOPE:s18_sync_c1_${runId}] ${child1Plan}`;
    const child2Prompt = `[CHAOS_SCOPE:s18_sync_c2_${runId}] ${child2Plan}`;
    const parentPlan = encodeToolPlan({
      steps: [
        {
          calls: [
            {
              name: 'AgentRun',
              input: {
                description: 'S18 sync child 1',
                name: trackedChildNames[0],
                profile: 'general',
                model_alias: 'twin-anthropic',
                effort: 'high',
                background: true,
                prompt: child1Prompt,
              },
            },
            {
              name: 'AgentRun',
              input: {
                description: 'S18 sync child 2',
                name: trackedChildNames[1],
                profile: 'general',
                model_alias: 'twin-anthropic',
                effort: 'high',
                background: true,
                prompt: child2Prompt,
              },
            },
          ],
        },
        {
          barrierId: parentBarrierId,
          calls: [{ name: 'Read', input: { path: 'src/mod-001.ts', line_offset: 1, n_lines: 6 } }],
        },
      ],
      finalText: 'S18_INTERACTIVE_PARENT_DONE',
    });

    interactiveTurnPromise = apiJson(
      server.endpoint,
      server.token,
      'POST',
      `/api/sessions/${interactiveSessionId}/prompts`,
      {
        content: [{ type: 'text', text: `[CHAOS_SCOPE:s18_sync_parent_${runId}] ${parentPlan}` }],
      },
      90_000,
    );

    // Wait for both tracked children and the parent to arrive at their barriers AND be running on server + visible in GUI
    await Promise.all([
      childBarrier1.waitForArrivals(1, 25_000).catch(() => 0),
      childBarrier2.waitForArrivals(1, 25_000).catch(() => 0),
      parentBarrier.waitForArrivals(1, 25_000).catch(() => 0),
    ]);
    trackedChildren = await waitForSubagentsRunning(server, interactiveSessionId, trackedChildNames, 15_000);

    // Give the GUI a short moment to paint the running child cards & right-rail roster rows, and let storm warm up
    await sleep(450);

    // Install in-page high-resolution observers for:
    //  (1) keydown(Enter) -> composer clear or optimistic echo (nonce in transcript/queue/steer)
    //  (2) subagent status sync in right rail [data-agent-id] AND timeline [data-subagent-id]/[data-subagent-ended]
    await page.evaluate((childIds) => {
      const readComposerText = () => {
        const el = document.querySelector('[data-composer-input]');
        if (!el) return '';
        if ('value' in el && typeof el.value === 'string') return el.value.trim();
        return (el.textContent ?? '').trim();
      };

      const sendState = {
        activeNonce: null,
        keydownAtMs: null,
        clearedAtMs: null,
        echoAtMs: null,
      };

      const checkSendProgress = () => {
        if (!sendState.activeNonce || sendState.keydownAtMs === null) return;
        const now = performance.now();
        if (sendState.clearedAtMs === null && readComposerText() === '') {
          sendState.clearedAtMs = now;
        }
        if (sendState.echoAtMs === null) {
          const scopeText =
            (document.querySelector('[data-transcript-scroll]')?.textContent ?? '') +
            ' ' +
            (document.querySelector('[data-queue-strip]')?.textContent ?? '') +
            ' ' +
            (document.querySelector('[data-composer-card]')?.parentElement?.textContent ?? '');
          if (scopeText.includes(sendState.activeNonce)) {
            sendState.echoAtMs = now;
          }
        }
      };

      document.addEventListener(
        'keydown',
        (ev) => {
          if (ev.key === 'Enter' && sendState.activeNonce && sendState.keydownAtMs === null) {
            sendState.keydownAtMs = performance.now();
          }
        },
        true,
      );
      document.addEventListener('input', checkSendProgress, true);

      const syncRecords = {};
      for (const cid of childIds) {
        syncRecords[cid] = {
          sawRunningInRail: false,
          sawRunningInTimeline: false,
          railSettledAtEpochMs: null,
          timelineSettledAtEpochMs: null,
        };
      }

      const inspectSubagentSync = () => {
        const nowEpoch = Date.now();
        for (const cid of childIds) {
          const rec = syncRecords[cid];
          const escaped = CSS.escape(cid);
          const railRow = document.querySelector(`[data-session-rail] [data-agent-id="${escaped}"]`);
          const railBucket = railRow?.getAttribute('data-roster-bucket') ?? null;
          const railStatus = railRow?.querySelector('[data-agent-status]')?.getAttribute('data-agent-status') ?? null;
          if (railBucket === 'running' || railStatus === 'running') {
            rec.sawRunningInRail = true;
          }
          if (rec.railSettledAtEpochMs === null) {
            const explicitTerminalStatus =
              railStatus === 'completed' || railStatus === 'idle' || railStatus === 'failed' || railStatus === 'cancelled';
            const explicitTerminalBucket = railBucket === 'ended' || railBucket === 'idle';
            const leftRunningAfterSeen = rec.sawRunningInRail && railBucket !== 'running' && railStatus !== 'running';
            if (explicitTerminalStatus || explicitTerminalBucket || leftRunningAfterSeen) {
              rec.railSettledAtEpochMs = nowEpoch;
            }
          }

          const endedRow = document.querySelector(`[data-transcript-scroll] [data-subagent-ended="${escaped}"]`);
          const tlCard = document.querySelector(`[data-transcript-scroll] [data-subagent-id="${escaped}"]`);
          const tlBusyDot = tlCard?.querySelector('.status-dot-busy, .bg-ink-soft') !== null;
          const tlSettledDot = tlCard?.querySelector('.bg-ink-faint, [data-subagent-result-summary]') !== null;
          if (tlCard && tlBusyDot && !endedRow) {
            rec.sawRunningInTimeline = true;
          }
          if (rec.timelineSettledAtEpochMs === null) {
            if (endedRow || (tlCard && tlSettledDot && !tlCard.querySelector('.status-dot-busy'))) {
              rec.timelineSettledAtEpochMs = nowEpoch;
            }
          }
        }
      };

      inspectSubagentSync();
      const mo = new MutationObserver(() => {
        checkSendProgress();
        inspectSubagentSync();
      });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });

      window.__s18ComposerSyncProbe = {
        armSend(nonce) {
          sendState.activeNonce = nonce;
          sendState.keydownAtMs = null;
          sendState.clearedAtMs = null;
          sendState.echoAtMs = null;
        },
        readSend() {
          checkSendProgress();
          const firstFeedbackAt =
            sendState.clearedAtMs !== null && sendState.echoAtMs !== null
              ? Math.min(sendState.clearedAtMs, sendState.echoAtMs)
              : sendState.clearedAtMs ?? sendState.echoAtMs;
          return {
            keydownAtMs: sendState.keydownAtMs,
            clearedAtMs: sendState.clearedAtMs,
            echoAtMs: sendState.echoAtMs,
            clearOrEchoMs:
              sendState.keydownAtMs !== null && firstFeedbackAt !== null
                ? Number(Math.max(0, firstFeedbackAt - sendState.keydownAtMs).toFixed(2))
                : null,
          };
        },
        readSync() {
          inspectSubagentSync();
          return JSON.parse(JSON.stringify(syncRecords));
        },
        disconnect() {
          mo.disconnect();
        },
      };
    }, trackedChildren.map((c) => c.agentId));

    // 4. Drive 4 REAL keyboard sends in <Composer /> under active coupled storm:
    //    2 queued sends (plain Enter while parent is running) + 2 running-state Send now steers (Control+Enter)
    const sendPlan = [
      { kind: 'queue', key: 'Enter', label: 'queue-1' },
      { kind: 'steer_now', key: 'Control+Enter', label: 'steer-now-1' },
      { kind: 'queue', key: 'Enter', label: 'queue-2' },
      { kind: 'steer_now', key: 'Control+Enter', label: 'steer-now-2' },
    ];

    for (let idx = 0; idx < sendPlan.length; idx += 1) {
      const step = sendPlan[idx];
      const nonce = `S18_COMP_${step.label}_${randomUUID().slice(0, 8)}`;

      await input.click({ timeout: 5_000 });
      await page.keyboard.insertText(`[CHAOS_SCOPE:s18_comp_${runId}_${idx}] ${nonce}`);
      await sleep(30);
      await page.evaluate((n) => window.__s18ComposerSyncProbe?.armSend(n), nonce);

      let promptHttpAckMs = null;
      let httpStatus = null;
      let admissionField = null;
      let sendModeField = null;
      let promptId = null;

      const submitT0 = performance.now();
      const respPromise = page
        .waitForResponse(
          (r) => {
            if (r.request().method() !== 'POST') return false;
            if (!r.url().includes(`/api/sessions/${interactiveSessionId}/prompts`)) return false;
            const postText = r.request().postData() ?? '';
            return postText.includes(nonce);
          },
          { timeout: 15_000 },
        )
        .then(async (r) => {
          promptHttpAckMs = roundMs(performance.now() - submitT0);
          httpStatus = r.status();
          try {
            const reqJson = r.request().postDataJSON();
            admissionField = reqJson?.admission ?? null;
            sendModeField = reqJson?.send_mode ?? reqJson?.sendMode ?? reqJson?.timing ?? null;
          } catch {
            // ignore
          }
          const body = await r.json().catch(() => null);
          promptId = body?.data?.prompt_id ?? body?.data?.id ?? null;
          return r;
        })
        .catch(() => null);

      await page.keyboard.press(step.key);

      // Poll up to 4s for composer clear or optimistic echo
      let clearOrEchoMs = null;
      let clearedAtMs = null;
      let echoAtMs = null;
      const uiDeadline = performance.now() + 4_000;
      while (performance.now() < uiDeadline) {
        const snap = await page.evaluate(() => window.__s18ComposerSyncProbe?.readSend?.() ?? null);
        if (snap && snap.clearOrEchoMs !== null) {
          clearOrEchoMs = snap.clearOrEchoMs;
          clearedAtMs = snap.clearedAtMs !== null && snap.keydownAtMs !== null ? roundMs(snap.clearedAtMs - snap.keydownAtMs) : null;
          echoAtMs = snap.echoAtMs !== null && snap.keydownAtMs !== null ? roundMs(snap.echoAtMs - snap.keydownAtMs) : null;
          break;
        }
        await sleep(15);
      }

      await respPromise;
      sends.push({
        index: idx + 1,
        kind: step.kind,
        key: step.key,
        nonce,
        composerClearOrEchoMs: clearOrEchoMs,
        composerClearedMs: clearedAtMs,
        optimisticEchoMs: echoAtMs,
        promptHttpAckMs,
        httpStatus,
        admissionField,
        sendModeField,
        durablePromptId: promptId,
        ok:
          clearOrEchoMs !== null &&
          clearOrEchoMs <= composerClearBudgetMs &&
          promptHttpAckMs !== null &&
          promptHttpAckMs <= promptAckBudgetMs &&
          httpStatus === 200 &&
          (admissionField === 'durable' || Boolean(promptId)),
      });

      await sleep(120);
    }

    // 5. Release the 2 tracked child subagent barriers WHILE the storm is still pounding,
    //    and measure subagent_status_sync_ms on BOTH right rail [data-agent-id] and timeline [data-subagent-id]
    const childBarriers = [childBarrier1, childBarrier2];
    for (let ci = 0; ci < trackedChildren.length; ci += 1) {
      const child = trackedChildren[ci];
      const barrier = childBarriers[ci];
      const releasedAtEpochMs = Date.now();
      barrier.release();

      const backendTerm = await waitForAgentBackendTerminal(server, interactiveSessionId, child.agentId, 15_000);
      const syncDeadline = performance.now() + 10_000;
      let domSync = null;
      while (performance.now() < syncDeadline) {
        const allSync = await page.evaluate(() => window.__s18ComposerSyncProbe?.readSync?.() ?? {});
        domSync = allSync[child.agentId] ?? null;
        if (domSync?.railSettledAtEpochMs !== null && domSync?.timelineSettledAtEpochMs !== null) {
          break;
        }
        await sleep(25);
      }

      const refEpoch = backendTerm.atEpochMs ?? releasedAtEpochMs;
      const railSyncMs =
        domSync?.railSettledAtEpochMs !== null && domSync?.railSettledAtEpochMs !== undefined
          ? roundMs(Math.max(0, domSync.railSettledAtEpochMs - refEpoch))
          : null;
      const timelineSyncMs =
        domSync?.timelineSettledAtEpochMs !== null && domSync?.timelineSettledAtEpochMs !== undefined
          ? roundMs(Math.max(0, domSync.timelineSettledAtEpochMs - refEpoch))
          : null;
      const subagentStatusSyncMs =
        railSyncMs !== null && timelineSyncMs !== null ? roundMs(Math.max(railSyncMs, timelineSyncMs)) : null;

      subagentSyncResults.push({
        agentId: child.agentId,
        name: child.name,
        backendReachedTerminal: backendTerm.reached,
        backendTerminalStatus: backendTerm.status,
        sawRunningInRail: domSync?.sawRunningInRail ?? false,
        sawRunningInTimeline: domSync?.sawRunningInTimeline ?? false,
        railSyncMs,
        timelineSyncMs,
        subagentStatusSyncMs,
        ok:
          backendTerm.reached &&
          railSyncMs !== null &&
          timelineSyncMs !== null &&
          subagentStatusSyncMs !== null &&
          subagentStatusSyncMs <= subagentSyncBudgetMs,
      });
    }

    await page.evaluate(() => window.__s18ComposerSyncProbe?.disconnect?.()).catch(() => undefined);
  } finally {
    // Always release all barriers and stop all background storms cleanly
    childBarrier1.release();
    childBarrier2.release();
    parentBarrier.release();
    stopStorm = true;
    await Promise.allSettled([
      fileChurnPromise,
      bgSubagentStormPromise,
      ...threadReadStormPromises,
      interactiveTurnPromise ?? Promise.resolve(),
    ]);
    await page.close().catch(() => undefined);
  }

  const clearSamples = sends.map((s) => s.composerClearOrEchoMs).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const ackSamples = sends.map((s) => s.promptHttpAckMs).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const syncSamples = subagentSyncResults
    .map((s) => s.subagentStatusSyncMs)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));

  const composerClearOrEchoStats = quantiles(clearSamples);
  const promptHttpAckStats = quantiles(ackSamples);
  const subagentStatusSyncStats = quantiles(syncSamples);

  const durableAdmissionCount = sends.filter((s) => s.admissionField === 'durable' || Boolean(s.durablePromptId)).length;
  const queueSendCount = sends.filter((s) => s.kind === 'queue' && s.httpStatus === 200).length;
  const steerNowSendCount = sends.filter((s) => s.kind === 'steer_now' && s.httpStatus === 200).length;

  if (stormStats.threadReadDispatched < 4 || stormStats.fileChurnOps <= 0) {
    failures.push(
      `Coupled background storm under-exercised (threadReadDispatched=${stormStats.threadReadDispatched}, fileChurnOps=${stormStats.fileChurnOps})`,
    );
  }
  if (clearSamples.length < sends.length || (composerClearOrEchoStats.p95 ?? Infinity) > composerClearBudgetMs) {
    failures.push(
      `composer_clear_or_echo_ms p95=${composerClearOrEchoStats.p95}ms > ${composerClearBudgetMs}ms (samples=${clearSamples.length}/${sends.length}, max=${composerClearOrEchoStats.max}ms)`,
    );
  }
  if (
    ackSamples.length < sends.length ||
    durableAdmissionCount < sends.length ||
    (promptHttpAckStats.p95 ?? Infinity) > promptAckBudgetMs
  ) {
    failures.push(
      `prompt_http_ack_ms p95=${promptHttpAckStats.p95}ms > ${promptAckBudgetMs}ms (samples=${ackSamples.length}/${sends.length}, durable=${durableAdmissionCount}/${sends.length}, max=${promptHttpAckStats.max}ms)`,
    );
  }
  if (
    subagentSyncResults.length < 2 ||
    syncSamples.length < subagentSyncResults.length ||
    (subagentStatusSyncStats.p95 ?? Infinity) > subagentSyncBudgetMs
  ) {
    failures.push(
      `subagent_status_sync_ms p95=${subagentStatusSyncStats.p95}ms > ${subagentSyncBudgetMs}ms (synced=${syncSamples.length}/${subagentSyncResults.length}, max=${subagentStatusSyncStats.max}ms)`,
    );
  }

  return {
    storm: stormStats,
    budgets: {
      composerClearOrEchoP95Ms: composerClearBudgetMs,
      promptHttpAckP95Ms: promptAckBudgetMs,
      subagentStatusSyncP95Ms: subagentSyncBudgetMs,
    },
    sends,
    queueSendCount,
    steerNowSendCount,
    durableAdmissionCount,
    composerClearOrEchoMs: composerClearOrEchoStats,
    promptHttpAckMs: promptHttpAckStats,
    subagentSync: subagentSyncResults,
    subagentStatusSyncMs: subagentStatusSyncStats,
    ok: failures.length === 0,
    failures,
  };
}
