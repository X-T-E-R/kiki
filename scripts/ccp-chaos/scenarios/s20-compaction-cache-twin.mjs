import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createContractTwinServer } from '../contract-twin-server.mjs';
import { CompactionCacheOracle, buildWireSegments, compareWireSegments } from '../twin/compaction-cache-oracle.mjs';

let tsLoaderReady = false;

function ensureAgentCoreTsLoader() {
  if (tsLoaderReady) return;
  tsLoaderReady = true;
  registerHooks({
    load(url, context, nextLoad) {
      const clean = url.split('?')[0];
      if (url.includes('?raw') || /\.(md|txt|toml|sql)$/u.test(clean)) {
        const sourceText = readFileSync(fileURLToPath(clean), 'utf8');
        return {
          format: 'module',
          shortCircuit: true,
          source: `export default ${JSON.stringify(sourceText)};`,
        };
      }
      return nextLoad(url, context);
    },
  });
  const req = createRequire(new URL('../../../packages/agent-core-v2/package.json', import.meta.url));
  req('tsx/esm/api').register();
}

function buildLargeHistory(turns = 20) {
  const messages = [];
  const blockPayload = 'Detailed engineering context segment verifying real KV prefix cache byte fidelity across turns. '.repeat(145);
  for (let i = 0; i < turns; i += 1) {
    messages.push({
      role: 'user',
      origin: { kind: 'user' },
      content: [{ type: 'text', text: `[Turn ${i}] User prompt with large context payload:\n${blockPayload}\nmarker=T${i}` }],
      toolCalls: [],
    });
    const tcId = `toolu_hist_${String(i).padStart(2, '0')}`;
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: `[Turn ${i}] Inspecting module_${i}.ts` }],
      toolCalls: [{ type: 'function', id: tcId, name: 'Read', arguments: JSON.stringify({ path: `src/module_${i}.ts` }) }],
    });
    messages.push({
      role: 'tool',
      toolCallId: tcId,
      name: 'Read',
      content: [{ type: 'text', text: `// module_${i}.ts\nexport const val_${i} = ${i};\n${blockPayload}` }],
      toolCalls: [],
    });
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: `[Turn ${i}] Completed analysis of module_${i}.ts with findings F_${i}.` }],
      toolCalls: [],
    });
  }
  messages.push({
    role: 'user',
    origin: { kind: 'user' },
    content: [{ type: 'text', text: 'Final settled user prompt before compaction boundary.' }],
    toolCalls: [],
  });
  return messages;
}

async function createRealTwinAgent(mods, { twin, providerType, modelProtocol, model, capabilities = {}, extraProviderConfig = {}, maxContextSize = 200_000, thinkingLevel = 'off' }) {
  const {
    createTestAgent,
    appService,
    IProtocolAdapterRegistry,
    ProtocolAdapterRegistry,
    IAgentToolRegistryService,
    IAgentProfileService,
  } = mods;

  const isAnthropic = modelProtocol === 'anthropic';
  const isGemini = modelProtocol === 'google-genai';
  const baseUrl = isAnthropic
    ? twin.httpBaseUrl
    : isGemini
      ? twin.httpBaseUrl
      : twin.httpV1BaseUrl;

  const providerName = `twin_${providerType}`;
  const providerEntry = {
    type: providerType,
    apiKey: 'twin-s20-key',
    baseUrl,
    ...extraProviderConfig,
  };

  const capList = [];
  if (capabilities.image_in) capList.push('image_in');
  if (capabilities.thinking) capList.push('thinking');
  if (capabilities.tool_use !== false) capList.push('tool_use');

  const initialConfig = {
    worktree: { cleanup: { auto: false } },
    providers: { [providerName]: providerEntry },
    models: {
      [model]: {
        provider: providerName,
        protocol: modelProtocol,
        model,
        maxContextSize,
        maxOutputSize: 8192,
        capabilities: capList,
        defaultEffort: thinkingLevel,
      },
    },
    defaultProvider: providerName,
    defaultModel: model,
  };

  const ctx = createTestAgent(
    [appService(IProtocolAdapterRegistry, new ProtocolAdapterRegistry())],
    { initialConfig, autoConfigure: false },
  );
  await ctx.ready;

  const registry = ctx.get(IAgentToolRegistryService);
  if (!registry.list().some((t) => t.name === 'Read')) {
    registry.register({
      name: 'Read',
      description: 'Read a text file from workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          cache_control: { type: 'object', properties: { type: { type: 'string' } } },
        },
        required: ['path'],
      },
      resolveExecution: () => ({ approvalRule: 'Read', execute: async () => ({ output: 'ok' }) }),
    }, { source: 'builtin' });
  }
  const profile = ctx.get(IAgentProfileService);
  profile.update({
    modelAlias: model,
    systemPrompt: 'You are Kiki executing real production compaction cache verification. '.repeat(30),
    thinkingLevel,
    activeToolNames: ['Read'],
  });
  return ctx;
}

async function runProtocolLane(mods, twin, laneConfig) {
  const {
    IAgentContextMemoryService,
    IAgentLLMRequesterService,
    IAgentFullCompactionService,
    IAgentProfileService,
  } = mods;

  twin.resetCacheOracle();
  const ctx = await createRealTwinAgent(mods, { twin, ...laneConfig });
  const checks = [];
  const assertCheck = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail });
  };

  try {
    const context = ctx.get(IAgentContextMemoryService);
    const requester = ctx.get(IAgentLLMRequesterService);
    const compaction = ctx.get(IAgentFullCompactionService);
    const profile = ctx.get(IAgentProfileService);

    const history = buildLargeHistory(laneConfig.turns ?? 24);
    context.append(...history);

    // 1. Real settled turn establishes TurnCacheEnvelope and provider KV cache
    const turnRes = await requester.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    context.append({ role: 'assistant', content: turnRes.message.content, toolCalls: [] });
    const turnAudit = twin.getWireAuditLog().at(-1);
    assertCheck('turn_settled', Boolean(turnAudit && turnAudit.totalTokens > 500), {
      seq: turnAudit?.seq,
      totalTokens: turnAudit?.totalTokens,
      incrementalTransport: turnAudit?.incrementalTransport,
    });

    // Hot-update profile status / generation (R3/R4 must stay warm)
    await profile.republishStatus();

    // Append trailing settled user + unsettled tool_use so K < P < H
    context.append(
      { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Trailing turn before unsettled tool.' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'Unsettled tool call in H.' }], toolCalls: [{ type: 'function', id: 'pending_unsettled_1', name: 'Read', arguments: '{"path":"pending.ts"}' }] },
    );

    // 2. Readonly /btw branch_seed MUST hit warm prefix >=99% and NOT consume parent thread/WS
    const btwSummary = await compaction.prepareSummary({
      authorizedHistory: context.get(),
      compactCount: 20,
      disposition: 'branch_seed',
    }, new AbortController().signal);
    const btwAudit = twin.getWireAuditLog().at(-1);
    assertCheck('btw_readonly_warm_hit', Boolean(btwSummary && btwAudit && btwAudit.exactPrefixMatched && btwAudit.hitRatio >= 0.99), {
      hitRatio: btwAudit?.hitRatio,
      exactPrefixMatched: btwAudit?.exactPrefixMatched,
      incrementalTransport: btwAudit?.incrementalTransport,
      firstDiff: btwAudit?.firstDiff,
    });

    // 3. Warm exclusive A2 compaction (K=20 < P < H) MUST hit warm prefix >=99% and use incremental transport when supported
    const compactSummary = await compaction.prepareSummary({
      authorizedHistory: context.get(),
      compactCount: 20,
      disposition: 'replace_window',
    }, new AbortController().signal);
    const compactAudit = twin.getWireAuditLog().at(-1);
    const expectedIncremental = laneConfig.expectedIncrementalTransport ?? null;
    const incrementalOk = expectedIncremental === null
      ? true
      : compactAudit?.incrementalTransport === expectedIncremental;
    assertCheck('exclusive_a2_warm_hit', Boolean(compactSummary && compactAudit && compactAudit.exactPrefixMatched && compactAudit.hitRatio >= 0.99 && incrementalOk), {
      hitRatio: compactAudit?.hitRatio,
      exactPrefixMatched: compactAudit?.exactPrefixMatched,
      incrementalTransport: compactAudit?.incrementalTransport,
      expectedIncremental,
      breakpointCount: compactAudit?.breakpointCount ?? null,
      firstDiff: compactAudit?.firstDiff,
    });

    // 4. Single tool-call violation (mixed valid text + tool_use) -> 1 prefix-preserving correction -> succeeds
    if (laneConfig.testToolGuard !== false) {
      twin.armNextAction({
        kind: 'tool_call_violation',
        mixedText: 'Invalid mixed summary text that MUST be discarded.',
        toolName: 'Read',
      });
      const correctedSummary = await compaction.prepareSummary({
        authorizedHistory: context.get(),
        compactCount: 20,
        disposition: 'replace_window',
      }, new AbortController().signal);
      const auditLog = twin.getWireAuditLog();
      const round2Audit = auditLog.at(-1);
      const round1Audit = auditLog.at(-2);
      const round2DiffOnlyInCompactionPrompt =
        round2Audit?.firstDiff === null ||
        String(round2Audit?.firstDiff?.candidatePreview ?? '').includes('You are about to run out of context');
      assertCheck('tool_guard_1_round_recovery', Boolean(
        correctedSummary &&
        !correctedSummary.includes('Invalid mixed summary text') &&
        round1Audit &&
        round2Audit &&
        round2DiffOnlyInCompactionPrompt &&
        round2Audit.hitRatio >= 0.99 &&
        round2Audit.incrementalTransport === null
      ), {
        round1HitRatio: round1Audit?.hitRatio,
        round2HitRatio: round2Audit?.hitRatio,
        round2Incremental: round2Audit?.incrementalTransport,
        round2FirstDiff: round2Audit?.firstDiff,
      });

      // Double violation MUST fail deterministically with compaction_tool_output
      twin.armNextAction({ kind: 'tool_call_violation', mixedText: 'Fail 1', toolName: 'Read' });
      twin.armNextAction({ kind: 'tool_call_violation', mixedText: 'Fail 2', toolName: 'Read' });
      let doubleErrCode = null;
      try {
        await compaction.prepareSummary({
          authorizedHistory: context.get(),
          compactCount: 20,
          disposition: 'replace_window',
        }, new AbortController().signal);
      } catch (err) {
        doubleErrCode = err?.code ?? String(err);
      }
      assertCheck('tool_guard_double_fail', doubleErrCode === 'compaction_tool_output', { doubleErrCode });
    }

    // 5. Overflow ladder: armed context_overflow on A2 -> falls back cleanly to A1
    if (laneConfig.testOverflow === true) {
      twin.armNextAction({ protocol: laneConfig.oracleProtocol, kind: 'context_overflow' });
      const overflowSummary = await compaction.prepareSummary({
        authorizedHistory: context.get(),
        compactCount: 20,
        disposition: 'replace_window',
      }, new AbortController().signal);
      assertCheck('overflow_a2_to_a1_recovery', Boolean(overflowSummary), { summaryLen: overflowSummary?.length ?? 0 });
    }

    // 6. Cutpoint / cold fork isolation: allowSourceCacheEnvelope=false MUST NOT reuse warm envelope or leak post-cutpoint messages
    if (laneConfig.testColdIsolation === true) {
      const cutpointSummary = await compaction.prepareSummary({
        authorizedHistory: context.get().slice(0, 8),
        compactCount: 8,
        disposition: 'fork_seed',
        scope: { allowSourceCacheEnvelope: false },
      }, new AbortController().signal);
      const cutAudit = twin.getWireAuditLog().at(-1);
      assertCheck('cutpoint_cold_isolation', Boolean(cutpointSummary && cutAudit && cutAudit.incrementalTransport === null), {
        totalTokens: cutAudit?.totalTokens,
        incrementalTransport: cutAudit?.incrementalTransport,
      });
    }

    const twinViolations = twin.getStats().violations;
    assertCheck('zero_twin_contract_violations', twinViolations.length === 0, { violations: twinViolations });

    return {
      lane: laneConfig.name,
      protocol: laneConfig.oracleProtocol,
      passed: checks.every((c) => c.ok),
      checks,
      wsStats: laneConfig.oracleProtocol === 'openai_responses_ws' ? twin.getWsStats() : undefined,
    };
  } finally {
    await ctx.dispose();
  }
}

async function run413DegradedMediaScenario(mods, twin) {
  const { IAgentContextMemoryService, IAgentLLMRequesterService, IAgentFullCompactionService } = mods;
  twin.resetCacheOracle();
  const ctx = await createRealTwinAgent(mods, {
    twin,
    providerType: 'openai',
    modelProtocol: 'openai',
    model: 'gpt-4o-s20-media',
    capabilities: { image_in: true },
  });
  try {
    const context = ctx.get(IAgentContextMemoryService);
    const requester = ctx.get(IAgentLLMRequesterService);
    const compaction = ctx.get(IAgentFullCompactionService);

    const makeImg = (id) => ({ type: 'image_url', imageUrl: { url: `https://example.test/s20_${id}.png` } });
    const bigPad = 'Media turn context payload for 413 degraded prefix cache lock. '.repeat(11_500);
    context.append(
      { role: 'user', origin: { kind: 'user' }, content: [makeImg('0'), makeImg('1'), makeImg('2'), makeImg('3'), { type: 'text', text: bigPad }], toolCalls: [] },
    );

    twin.armNextAction({ protocol: 'openai_chat', kind: 'http_413' });
    const turn = await requester.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    context.append({ role: 'assistant', content: turn.message.content, toolCalls: [] });

    context.append({
      role: 'user',
      origin: { kind: 'user' },
      content: [makeImg('4_trailing'), { type: 'text', text: 'New trailing image must not degrade prefix images.' }],
      toolCalls: [],
    });

    await compaction.prepareSummary({
      authorizedHistory: context.get(),
      compactCount: 2,
      disposition: 'replace_window',
    }, new AbortController().signal);

    const audit = twin.getWireAuditLog().at(-1);
    const passed = Boolean(audit && audit.exactPrefixMatched && audit.hitRatio >= 0.99);
    return {
      lane: 'media_413_degraded_inheritance',
      protocol: 'openai_chat',
      passed,
      checks: [{
        name: 'degraded_prefix_preserved_with_trailing_media',
        ok: passed,
        detail: {
          hitRatio: audit?.hitRatio,
          exactPrefixMatched: audit?.exactPrefixMatched,
          firstDiff: audit?.firstDiff,
        },
      }],
    };
  } finally {
    await ctx.dispose();
  }
}

async function runAnthropicHighWatermarkThinkingScenario(mods, twin) {
  const { IAgentContextMemoryService, IAgentLLMRequesterService, IAgentFullCompactionService } = mods;
  twin.resetCacheOracle();
  const ctx = await createRealTwinAgent(mods, {
    twin,
    providerType: 'anthropic',
    modelProtocol: 'anthropic',
    model: 'claude-3-7-sonnet-20250219',
    maxContextSize: 22_000,
    capabilities: { thinking: true },
    thinkingLevel: 'high',
  });
  try {
    const context = ctx.get(IAgentContextMemoryService);
    const requester = ctx.get(IAgentLLMRequesterService);
    const compaction = ctx.get(IAgentFullCompactionService);

    const payload = 'Anthropic budget-thinking high watermark payload verifying size_degraded budget_tokens < max_tokens. '.repeat(550);
    context.append(
      { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: payload }], toolCalls: [] },
    );
    const turn = await requester.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    context.append({ role: 'assistant', content: turn.message.content, toolCalls: [] });

    const summary = await compaction.prepareSummary({
      authorizedHistory: context.get(),
      compactCount: 2,
      disposition: 'replace_window',
    }, new AbortController().signal);
    const violations = twin.getStats().violations;
    const passed = Boolean(summary && violations.length === 0);
    return {
      lane: 'anthropic_high_watermark_thinking',
      protocol: 'anthropic',
      passed,
      checks: [{
        name: 'high_watermark_thinking_no_budget_violation',
        ok: passed,
        detail: { summaryLen: summary?.length ?? 0, violations },
      }],
    };
  } finally {
    await ctx.dispose();
  }
}

async function runNegativeControls(twin) {
  const results = [];
  const oracle = new CompactionCacheOracle();

  const baseAnthropicBody = {
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    tools: [{ name: 'Read', input_schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } }, cache_control: { type: 'ephemeral' } }],
    system: [{ type: 'text', text: 'System prompt baseline '.repeat(60), cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Early file_read content '.repeat(80) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Assistant reply '.repeat(40) }] },
      { role: 'user', content: [{ type: 'text', text: 'Second turn '.repeat(60), cache_control: { type: 'ephemeral' } }] },
    ],
  };
  oracle.evaluate({ protocol: 'anthropic', body: baseAnthropicBody });

  // 1. Tamper system prompt by 1 char
  const tamperSys = structuredClone(baseAnthropicBody);
  tamperSys.system[0].text += '!';
  const sysAudit = oracle.evaluate({ protocol: 'anthropic', body: tamperSys, recordIntoCache: false });
  results.push({
    name: 'tamper_system_prompt',
    detected: !sysAudit.exactPrefixMatched && sysAudit.firstDiff?.section === 'system',
    detail: { hitRatio: sysAudit.hitRatio, firstDiff: sysAudit.firstDiff?.section },
  });

  // 2. Tamper tools: []
  const tamperTools = structuredClone(baseAnthropicBody);
  tamperTools.tools = [];
  const toolsAudit = oracle.evaluate({ protocol: 'anthropic', body: tamperTools, recordIntoCache: false });
  results.push({
    name: 'tamper_tools_empty',
    detected: !toolsAudit.exactPrefixMatched && toolsAudit.hitRatio === 0,
    detail: { hitRatio: toolsAudit.hitRatio, firstDiff: toolsAudit.firstDiff?.section },
  });

  // 3. Tamper JSON key order in tool schema (must NOT be hidden by key sorting!)
  const tamperKeyOrder = structuredClone(baseAnthropicBody);
  tamperKeyOrder.tools[0].input_schema.properties = { b: { type: 'number' }, a: { type: 'string' } };
  const keyOrderAudit = oracle.evaluate({ protocol: 'anthropic', body: tamperKeyOrder, recordIntoCache: false });
  results.push({
    name: 'tamper_json_key_order',
    detected: !keyOrderAudit.exactPrefixMatched && keyOrderAudit.firstDiff?.section === 'tools',
    detail: { hitRatio: keyOrderAudit.hitRatio, firstDiff: keyOrderAudit.firstDiff?.section },
  });

  // 4. Tamper R1 early message rewrite
  const tamperR1 = structuredClone(baseAnthropicBody);
  tamperR1.messages[0].content[0].text = '[omitted file_read handoff]';
  const r1Audit = oracle.evaluate({ protocol: 'anthropic', body: tamperR1, recordIntoCache: false });
  results.push({
    name: 'tamper_r1_early_message_rewrite',
    detected: !r1Audit.exactPrefixMatched && r1Audit.firstDiff?.section === 'messages[0]',
    detail: { hitRatio: r1Audit.hitRatio, firstDiff: r1Audit.firstDiff?.section },
  });

  // 5. Tamper mid-prefix separator insertion
  const tamperSep = structuredClone(baseAnthropicBody);
  tamperSep.messages.splice(1, 0, { role: 'user', content: [{ type: 'text', text: '--- COMPACT BOUNDARY ---' }] });
  const sepAudit = oracle.evaluate({ protocol: 'anthropic', body: tamperSep, recordIntoCache: false });
  results.push({
    name: 'tamper_mid_prefix_separator',
    detected: !sepAudit.exactPrefixMatched && sepAudit.firstDiff?.section === 'messages[1]',
    detail: { hitRatio: sepAudit.hitRatio, firstDiff: sepAudit.firstDiff?.section },
  });

  // 6. Wire HTTP 400 on 5 Anthropic cache_control breakpoints
  const res5Bp = await fetch(`${twin.httpV1BaseUrl}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'twin-s20-key', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      stream: false,
      cache_control: { type: 'ephemeral' },
      tools: [{ name: 'A', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
      system: [
        { type: 'text', text: 's0', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 's1', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
    }),
  });
  const body5Bp = await res5Bp.json();
  results.push({
    name: 'tamper_anthropic_5_breakpoints',
    detected: res5Bp.status === 400 && body5Bp?.error?.code === 'cache_control_limit_exceeded',
    detail: { status: res5Bp.status, code: body5Bp?.error?.code },
  });

  // 7. Wire HTTP 400 on 5m before 1h TTL inversion
  const resTtl = await fetch(`${twin.httpV1BaseUrl}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'twin-s20-key', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      stream: false,
      tools: [{ name: 'A', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral', ttl: '5m' } }],
      system: [{ type: 'text', text: 's0', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }),
  });
  const bodyTtl = await resTtl.json();
  results.push({
    name: 'tamper_anthropic_ttl_inversion',
    detected: resTtl.status === 400 && bodyTtl?.error?.code === 'cache_control_ttl_order_invalid',
    detail: { status: resTtl.status, code: bodyTtl?.error?.code },
  });

  // 8. Wire HTTP 400 on thinking.budget_tokens >= max_tokens
  const resThink = await fetch(`${twin.httpV1BaseUrl}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'twin-s20-key', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      stream: false,
      thinking: { type: 'enabled', budget_tokens: 2048 },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }),
  });
  const bodyThink = await resThink.json();
  results.push({
    name: 'tamper_anthropic_thinking_budget_gte_max_tokens',
    detected: resThink.status === 400 && bodyThink?.error?.code === 'thinking_budget_exceeds_max_tokens',
    detail: { status: resThink.status, code: bodyThink?.error?.code },
  });

  // 9. Wire HTTP 400 on single-use Anthropic thread double-continue
  const resCreate = await fetch(`${twin.httpV1BaseUrl}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'twin-s20-key',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'message-threads-2026-08-12',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      stream: false,
      thread: { type: 'create' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'thread seed' }] }],
    }),
  });
  const created = await resCreate.json();
  const contPayload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    stream: false,
    thread: { type: 'continue', previous_message_id: created.id },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'delta' }] }],
  });
  const contHeaders = {
    'content-type': 'application/json',
    'x-api-key': 'twin-s20-key',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'message-threads-2026-08-12',
  };
  const resCont1 = await fetch(`${twin.httpV1BaseUrl}/messages`, { method: 'POST', headers: contHeaders, body: contPayload });
  const resCont2 = await fetch(`${twin.httpV1BaseUrl}/messages`, { method: 'POST', headers: contHeaders, body: contPayload });
  const bodyCont2 = await resCont2.json();
  results.push({
    name: 'tamper_anthropic_single_use_thread_reuse',
    detected: resCont1.status === 200 && resCont2.status === 400 && bodyCont2?.error?.code === 'thread_already_continued',
    detail: { firstStatus: resCont1.status, secondStatus: resCont2.status, code: bodyCont2?.error?.code },
  });

  // Verify compareWireSegments exports work symmetrically
  const segA = buildWireSegments({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'abc' }] } });
  const segB = buildWireSegments({ protocol: 'openai_chat', body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'abd' }] } });
  const cmp = compareWireSegments(segA.segments, segB.segments);
  results.push({
    name: 'oracle_exact_byte_diff_locator',
    detected: !cmp.exactPrefixMatched && cmp.firstDiff?.section === 'messages',
    detail: { firstDiff: cmp.firstDiff?.section },
  });

  return {
    passed: results.every((r) => r.detected),
    detectedCount: results.filter((r) => r.detected).length,
    totalCount: results.length,
    results,
  };
}

export async function runS20CompactionCacheTwin(options = {}) {
  const startedAt = performance.now();
  ensureAgentCoreTsLoader();

  // Register real provider adapters
  await import('../../../packages/agent-core-v2/src/kosong/provider/bases/anthropic/index.ts');
  await import('../../../packages/agent-core-v2/src/kosong/provider/bases/openai/index.ts');
  await import('../../../packages/agent-core-v2/src/kosong/provider/bases/google-genai/index.ts');

  const [
    harnessMod,
    protocolRegMod,
    contextMemMod,
    llmReqMod,
    fullCompMod,
    profileMod,
    toolRegMod,
  ] = await Promise.all([
    import('../../../packages/agent-core-v2/test/harness/agent.ts'),
    import('../../../packages/agent-core-v2/src/kosong/provider/protocolAdapterRegistry.ts'),
    import('../../../packages/agent-core-v2/src/agent/contextMemory/contextMemory.ts'),
    import('../../../packages/agent-core-v2/src/agent/llmRequester/llmRequester.ts'),
    import('../../../packages/agent-core-v2/src/agent/fullCompaction/fullCompaction.ts'),
    import('../../../packages/agent-core-v2/src/agent/profile/profile.ts'),
    import('../../../packages/agent-core-v2/src/agent/toolRegistry/toolRegistry.ts'),
  ]);

  const mods = {
    createTestAgent: harnessMod.createTestAgent,
    appService: harnessMod.appService,
    IProtocolAdapterRegistry: (await import('../../../packages/agent-core-v2/src/kosong/protocol/protocol.ts')).IProtocolAdapterRegistry,
    ProtocolAdapterRegistry: protocolRegMod.ProtocolAdapterRegistry,
    IAgentContextMemoryService: contextMemMod.IAgentContextMemoryService,
    IAgentLLMRequesterService: llmReqMod.IAgentLLMRequesterService,
    IAgentFullCompactionService: fullCompMod.IAgentFullCompactionService,
    IAgentProfileService: profileMod.IAgentProfileService,
    IAgentToolRegistryService: toolRegMod.IAgentToolRegistryService,
  };

  const twin = await createContractTwinServer({ enableTls: false, faultRate: 0 });
  try {
    const lanes = [];

    lanes.push(await runProtocolLane(mods, twin, {
      name: 'anthropic_standard',
      providerType: 'anthropic',
      modelProtocol: 'anthropic',
      oracleProtocol: 'anthropic',
      model: 'claude-sonnet-4-6',
      maxContextSize: 400_000,
      capabilities: { thinking: true },
      thinkingLevel: 'medium',
      testOverflow: true,
      testColdIsolation: true,
    }));

    lanes.push(await runProtocolLane(mods, twin, {
      name: 'anthropic_message_threads',
      providerType: 'anthropic',
      modelProtocol: 'anthropic',
      oracleProtocol: 'anthropic',
      model: 'claude-sonnet-4-6',
      maxContextSize: 400_000,
      extraProviderConfig: { anthropicMessageThreads: { mode: 'auto' } },
      expectedIncrementalTransport: 'anthropic_thread_continue',
    }));

    lanes.push(await runProtocolLane(mods, twin, {
      name: 'openai_chat',
      providerType: 'openai',
      modelProtocol: 'openai',
      oracleProtocol: 'openai_chat',
      model: 'gpt-4o',
      maxContextSize: 400_000,
    }));

    lanes.push(await runProtocolLane(mods, twin, {
      name: 'deepseek_chat',
      providerType: 'openai',
      modelProtocol: 'openai',
      oracleProtocol: 'deepseek',
      model: 'deepseek-chat',
      maxContextSize: 400_000,
    }));

    lanes.push(await runProtocolLane(mods, twin, {
      name: 'openai_responses_http',
      providerType: 'openai_responses',
      modelProtocol: 'openai_responses',
      oracleProtocol: 'openai_responses',
      model: 'gpt-5-codex',
      maxContextSize: 400_000,
    }));

    lanes.push(await runProtocolLane(mods, twin, {
      name: 'openai_responses_ws',
      providerType: 'openai_responses',
      modelProtocol: 'openai_responses',
      oracleProtocol: 'openai_responses_ws',
      model: 'gpt-5-codex',
      maxContextSize: 400_000,
      extraProviderConfig: { responsesWebSocket: { targets: [twin.httpBaseUrl] } },
      expectedIncrementalTransport: 'responses_ws_previous_id',
    }));

    lanes.push(await runProtocolLane(mods, twin, {
      name: 'google_genai',
      providerType: 'google-genai',
      modelProtocol: 'google-genai',
      oracleProtocol: 'google_genai',
      model: 'gemini-2.5-pro',
      maxContextSize: 400_000,
    }));

    lanes.push(await run413DegradedMediaScenario(mods, twin));
    lanes.push(await runAnthropicHighWatermarkThinkingScenario(mods, twin));

    const negativeControls = await runNegativeControls(twin);

    const allLanesPassed = lanes.every((l) => l.passed);
    const verdict = {
      scenario: 'S20_COMPACTION_CACHE_TWIN',
      passed: allLanesPassed && negativeControls.passed,
      elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
      summary: {
        lanesPassed: lanes.filter((l) => l.passed).length,
        lanesTotal: lanes.length,
        negativeControlsDetected: negativeControls.detectedCount,
        negativeControlsTotal: negativeControls.totalCount,
      },
      lanes,
      negativeControls,
    };

    if (options.outPath) {
      writeFileSync(options.outPath, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
    }
    return verdict;
  } finally {
    await twin.close();
  }
}

const isCli =
  typeof process.argv[1] === 'string' &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isCli) {
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx !== -1 ? process.argv[outIdx + 1] : undefined;
  runS20CompactionCacheTwin({ outPath })
    .then((verdict) => {
      process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
      process.exit(verdict.passed ? 0 : 1);
    })
    .catch((err) => {
      process.stderr.write(`S20 fatal error: ${err?.stack ?? String(err)}\n`);
      process.exit(1);
    });
}
