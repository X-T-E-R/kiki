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

    // 2. Readonly /btw branch_seed MUST hit warm prefix >=99% bound strictly to turnAudit.seq, lock maxTokens, and NOT consume parent thread/WS
    const btwSummary = await compaction.prepareSummary({
      authorizedHistory: context.get(),
      compactCount: 20,
      disposition: 'branch_seed',
    }, new AbortController().signal);
    const btwAudit = twin.getWireAuditLog().at(-1);
    const btwBound = twin.verifyWarmContinuation({
      parentSeq: turnAudit.seq,
      candidateSeq: btwAudit.seq,
      expectMaxTokensLocked: true,
      maxExtraSegments: 4,
      forbiddenSubstrings: ['pending_unsettled_1'],
      expectedSuffixContains: 'You are about to run out of context',
    });
    assertCheck('btw_readonly_warm_hit', Boolean(btwSummary && btwBound.ok && btwBound.boundHitRatio >= 0.99 && btwAudit?.incrementalTransport === null), {
      boundHitRatio: btwBound.boundHitRatio,
      maxTokensMatched: btwBound.maxTokensMatched,
      parentMaxTokens: btwBound.parentMaxTokens,
      candidateMaxTokens: btwBound.candidateMaxTokens,
      suffixSegmentCount: btwBound.suffixSegmentCount,
      reasons: btwBound.reasons,
      incrementalTransport: btwAudit?.incrementalTransport,
      firstDiff: btwBound.firstDiff,
    });

    // 3. Warm exclusive A2 compaction (K=20 < P < H) MUST hit warm prefix >=99% bound strictly to turnAudit.seq and use incremental transport when supported
    const compactSummary = await compaction.prepareSummary({
      authorizedHistory: context.get(),
      compactCount: 20,
      disposition: 'replace_window',
    }, new AbortController().signal);
    const compactAudit = twin.getWireAuditLog().at(-1);
    const compactBound = twin.verifyWarmContinuation({
      parentSeq: turnAudit.seq,
      candidateSeq: compactAudit.seq,
      expectMaxTokensLocked: true,
      maxExtraSegments: 4,
      forbiddenSubstrings: ['pending_unsettled_1'],
      expectedSuffixContains: 'You are about to run out of context',
    });
    const expectedIncremental = laneConfig.expectedIncrementalTransport ?? null;
    const incrementalOk = expectedIncremental === null
      ? true
      : compactAudit?.incrementalTransport === expectedIncremental;
    assertCheck('exclusive_a2_warm_hit', Boolean(compactSummary && compactBound.ok && compactBound.boundHitRatio >= 0.99 && incrementalOk), {
      boundHitRatio: compactBound.boundHitRatio,
      maxTokensMatched: compactBound.maxTokensMatched,
      suffixSegmentCount: compactBound.suffixSegmentCount,
      reasons: compactBound.reasons,
      incrementalTransport: compactAudit?.incrementalTransport,
      expectedIncremental,
      breakpointCount: compactAudit?.breakpointCount ?? null,
      firstDiff: compactBound.firstDiff,
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
      const round2Bound = twin.verifyWarmContinuation({
        parentSeq: turnAudit.seq,
        candidateSeq: round2Audit.seq,
        expectMaxTokensLocked: true,
        maxExtraSegments: 4,
        forbiddenSubstrings: ['pending_unsettled_1'],
        expectedSuffixContains: 'Correction: Your previous compaction attempt invoked a tool',
      });
      assertCheck('tool_guard_1_round_recovery', Boolean(
        correctedSummary &&
        !correctedSummary.includes('Invalid mixed summary text') &&
        round1Audit &&
        round2Audit &&
        round2Bound.ok &&
        round2Bound.boundHitRatio >= 0.99 &&
        round2Audit.incrementalTransport === null
      ), {
        round1HitRatio: round1Audit?.hitRatio,
        round2BoundHitRatio: round2Bound.boundHitRatio,
        round2Reasons: round2Bound.reasons,
        round2Incremental: round2Audit?.incrementalTransport,
        round2FirstDiff: round2Bound.firstDiff,
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

    // 6. Cutpoint / cold fork isolation: allowSourceCacheEnvelope=false MUST NOT reuse warm envelope, MUST NOT be incremental, and MUST NOT leak post-cutpoint sentinel
    if (laneConfig.testColdIsolation === true) {
      const sentinel = 'FUTURE_UNAUTHORIZED_SENTINEL_999';
      context.append({ role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: sentinel }], toolCalls: [] });
      const cutpointSummary = await compaction.prepareSummary({
        authorizedHistory: context.get().slice(0, 8),
        compactCount: 8,
        disposition: 'fork_seed',
        scope: { allowSourceCacheEnvelope: false },
      }, new AbortController().signal);
      const cutAudit = twin.getWireAuditLog().at(-1);
      const cutCheck = twin.verifyWarmContinuation({
        parentSeq: turnAudit.seq,
        candidateSeq: cutAudit.seq,
        expectMaxTokensLocked: false,
        forbiddenSubstrings: [sentinel, 'pending_unsettled_1'],
      });
      assertCheck('cutpoint_cold_isolation', Boolean(
        cutpointSummary &&
        cutAudit &&
        cutAudit.incrementalTransport === null &&
        cutCheck.leakedForbidden.length === 0 &&
        !cutCheck.exactPrefixMatched
      ), {
        totalTokens: cutAudit?.totalTokens,
        incrementalTransport: cutAudit?.incrementalTransport,
        leakedForbidden: cutCheck.leakedForbidden,
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
    maxContextSize: 400_000,
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
    const degradedTurnAudit = twin.getWireAuditLog().at(-1);

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
    const bound = twin.verifyWarmContinuation({
      parentSeq: degradedTurnAudit.seq,
      candidateSeq: audit.seq,
      expectMaxTokensLocked: true,
      maxExtraSegments: 4,
      expectedSuffixContains: 'You are about to run out of context',
    });
    const passed = Boolean(bound.ok && bound.boundHitRatio >= 0.99);
    return {
      lane: 'media_413_degraded_inheritance',
      protocol: 'openai_chat',
      passed,
      checks: [{
        name: 'degraded_prefix_preserved_with_trailing_media',
        ok: passed,
        detail: {
          boundHitRatio: bound.boundHitRatio,
          exactPrefixMatched: bound.exactPrefixMatched,
          maxTokensMatched: bound.maxTokensMatched,
          reasons: bound.reasons,
          firstDiff: bound.firstDiff,
        },
      }],
    };
  } finally {
    await ctx.dispose();
  }
}

async function runManualCompactionCommitAndForkScenario(mods, twin) {
  const {
    IAgentContextMemoryService,
    IAgentLLMRequesterService,
    IAgentFullCompactionService,
    buildBranchSeedMessages,
  } = mods;
  twin.resetCacheOracle();
  const ctx = await createRealTwinAgent(mods, {
    twin,
    providerType: 'anthropic',
    modelProtocol: 'anthropic',
    model: 'claude-sonnet-4-6',
    maxContextSize: 400_000,
    extraProviderConfig: { anthropicMessageThreads: { mode: 'auto' } },
  });
  const checks = [];
  const assertCheck = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  try {
    const context = ctx.get(IAgentContextMemoryService);
    const requester = ctx.get(IAgentLLMRequesterService);
    const compaction = ctx.get(IAgentFullCompactionService);
    const history = buildLargeHistory(24);
    context.append(...history);

    const turn = await requester.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    context.append({ role: 'assistant', content: turn.message.content, toolCalls: [] });
    const turnAudit = twin.getWireAuditLog().at(-1);

    // Real branch/fork seed entrypoint (hot readonly — must hit warm prefix and preserve parent thread!)
    const hotBuilt = await buildBranchSeedMessages({
      mode: 'compact',
      carry: { last: 2 },
      sourceHistory: context.get(),
      sourceAgentId: 'main',
      sessionId: 's20-session',
      epoch: 0,
      estimateText: (text) => Math.ceil(text.length / 4),
      summarize: (settled, compactCount) => compaction.prepareSummary({
        authorizedHistory: settled,
        compactCount,
        disposition: 'fork_seed',
        scope: { allowSourceCacheEnvelope: true },
      }, new AbortController().signal),
    });
    const hotForkAudit = twin.getWireAuditLog().at(-1);
    const hotBound = twin.verifyWarmContinuation({
      parentSeq: turnAudit.seq,
      candidateSeq: hotForkAudit.seq,
      expectMaxTokensLocked: true,
      maxExtraSegments: 4,
    });
    assertCheck('real_hot_fork_seed_readonly_warm_hit', Boolean(
      hotBuilt.messages.length > 0 &&
      hotBound.ok &&
      hotBound.boundHitRatio >= 0.99 &&
      hotForkAudit.incrementalTransport === null
    ), {
      boundHitRatio: hotBound.boundHitRatio,
      reasons: hotBound.reasons,
      incrementalTransport: hotForkAudit?.incrementalTransport,
    });

    // Real cutpoint fork seed entrypoint with future sentinel appended after cutpoint
    const sentinel = 'FUTURE_CUTPOINT_SENTINEL_888';
    const cutpointHistory = context.get().slice(0, 12);
    const cutBuilt = await buildBranchSeedMessages({
      mode: 'compact',
      carry: { last: 1 },
      sourceHistory: cutpointHistory,
      sourceAgentId: 'main',
      sessionId: 's20-session',
      epoch: 0,
      estimateText: (text) => Math.ceil(text.length / 4),
      summarize: (settled, compactCount) => compaction.prepareSummary({
        authorizedHistory: settled,
        compactCount,
        disposition: 'fork_seed',
        scope: { allowSourceCacheEnvelope: false },
      }, new AbortController().signal),
    });
    const cutAudit = twin.getWireAuditLog().at(-1);
    const cutBound = twin.verifyWarmContinuation({
      parentSeq: turnAudit.seq,
      candidateSeq: cutAudit.seq,
      expectMaxTokensLocked: false,
      forbiddenSubstrings: [sentinel],
    });
    assertCheck('real_cutpoint_fork_seed_cold_isolated', Boolean(
      cutBuilt.messages.length > 0 &&
      cutAudit.incrementalTransport === null &&
      cutBound.leakedForbidden.length === 0 &&
      !cutBound.exactPrefixMatched
    ), {
      totalTokens: cutAudit?.totalTokens,
      incrementalTransport: cutAudit?.incrementalTransport,
    });

    // Real manual compaction commit entrypoint (compaction.begin + durable commit splice)
    const countBefore = context.get().length;
    const tailTextBefore = 'Tail message preserved verbatim after manual commit.';
    context.append({ role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: tailTextBefore }], toolCalls: [] });
    const started = compaction.begin({ source: 'manual', strategy: 'summarize' });
    const commitResult = await compaction.compacting?.promise;
    const commitAudit = twin.getWireAuditLog().at(-1);
    const commitBound = twin.verifyWarmContinuation({
      parentSeq: turnAudit.seq,
      candidateSeq: commitAudit.seq,
      expectMaxTokensLocked: true,
      maxExtraSegments: 4,
    });
    const afterMessages = context.get();
    assertCheck('real_manual_compaction_begin_and_commit', Boolean(
      started &&
      commitResult &&
      commitResult.compactedCount > 0 &&
      commitBound.ok &&
      commitBound.boundHitRatio >= 0.99 &&
      commitAudit.incrementalTransport === 'anthropic_thread_continue' &&
      afterMessages.length < countBefore &&
      afterMessages.some((m) => m.origin?.kind === 'compaction_summary')
    ), {
      compactedCount: commitResult?.compactedCount,
      beforeLen: countBefore,
      afterLen: afterMessages.length,
      boundHitRatio: commitBound.boundHitRatio,
      incrementalTransport: commitAudit?.incrementalTransport,
      reasons: commitBound.reasons,
    });

    const violations = twin.getStats().violations;
    assertCheck('zero_twin_violations', violations.length === 0, { violations });

    return {
      lane: 'real_entry_manual_commit_and_fork_seed',
      protocol: 'anthropic',
      passed: checks.every((c) => c.ok),
      checks,
    };
  } finally {
    await ctx.dispose();
  }
}

async function runAnthropic4SlotAutoCacheContinueScenario(mods, twin) {
  const { AnthropicChatProvider } = mods;
  twin.resetCacheOracle();
  const provider = new AnthropicChatProvider({
    apiKey: 'twin-s20-key',
    baseUrl: twin.httpBaseUrl,
    model: 'claude-sonnet-4-6',
    stream: true,
    anthropicMessageThreads: { mode: 'auto' },
  });
  const tools = [{
    name: 'Read',
    description: 'Read workspace file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  }];
  const sys = 'System prompt for 4-slot automatic cache_control thread continuation. '.repeat(30);
  const firstMessages = [
    { role: 'user', content: [{ type: 'text', text: 'Turn 1 large payload '.repeat(400) }], toolCalls: [] },
  ];
  const drain = async (streamed) => {
    const parts = [];
    for await (const part of streamed) parts.push(part);
    return parts;
  };
  const firstParts = await drain(await provider.generate(sys, tools, firstMessages, {
    requestParams: { cache_control: { type: 'ephemeral' } },
    cacheKey: 's20-auto-4slot',
    anthropicThreadDisposition: 'turn',
  }));
  const turnAudit = twin.getWireAuditLog().at(-1);
  const assistantText = firstParts.filter((p) => p.type === 'text').map((p) => p.text).join('');

  const secondMessages = [
    ...firstMessages,
    { role: 'assistant', content: [{ type: 'text', text: assistantText }], toolCalls: [] },
    { role: 'user', content: [{ type: 'text', text: 'Compaction summary delta under 4-slot auto cache_control.' }], toolCalls: [] },
  ];
  await drain(await provider.generate(sys, tools, secondMessages, {
    requestParams: { cache_control: { type: 'ephemeral' } },
    cacheKey: 's20-auto-4slot',
    anthropicThreadDisposition: 'auxiliary_exclusive',
  }));
  const continueAudit = twin.getWireAuditLog().at(-1);
  const violations = twin.getStats().violations;
  const passed = Boolean(
    continueAudit &&
    continueAudit.incrementalTransport === 'anthropic_thread_continue' &&
    violations.length === 0
  );
  return {
    lane: 'anthropic_4slot_auto_cache_thread_continue',
    protocol: 'anthropic',
    passed,
    checks: [{
      name: '4slot_tool_system_toplevel_delta_continue_succeeds',
      ok: passed,
      detail: {
        incrementalTransport: continueAudit?.incrementalTransport,
        hitRatio: continueAudit?.hitRatio,
        violations,
      },
    }],
  };
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

  // 10. Negative control: max_tokens mutation (4096 -> 8192) MUST be caught by bound parent verification
  const maxTokTamper = structuredClone(baseAnthropicBody);
  maxTokTamper.max_tokens = 8192;
  maxTokTamper.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
  maxTokTamper.messages.push({ role: 'user', content: [{ type: 'text', text: 'compact' }] });
  const maxTokAudit = oracle.evaluate({ protocol: 'anthropic', body: maxTokTamper, recordIntoCache: false });
  const maxTokCheck = oracle.verifyWarmContinuation({
    parentSeq: 1,
    candidateSeq: maxTokAudit.seq,
    expectMaxTokensLocked: true,
  });
  results.push({
    name: 'tamper_max_tokens_mutation',
    detected: !maxTokCheck.ok && !maxTokCheck.maxTokensMatched && maxTokCheck.reasons.some((r) => r.startsWith('max_tokens_mutated')),
    detail: { reasons: maxTokCheck.reasons, parentMax: maxTokCheck.parentMaxTokens, candMax: maxTokCheck.candidateMaxTokens },
  });

  // 11. Negative control: unauthorized future-message sentinel appended after valid prefix MUST be caught
  const sentinelTamper = structuredClone(baseAnthropicBody);
  sentinelTamper.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
  sentinelTamper.messages.push({ role: 'user', content: [{ type: 'text', text: 'FUTURE_UNAUTHORIZED_SENTINEL_999' }] });
  const sentinelAudit = oracle.evaluate({ protocol: 'anthropic', body: sentinelTamper, recordIntoCache: false });
  const sentinelCheck = oracle.verifyWarmContinuation({
    parentSeq: 1,
    candidateSeq: sentinelAudit.seq,
    expectMaxTokensLocked: true,
    forbiddenSubstrings: ['FUTURE_UNAUTHORIZED_SENTINEL_999'],
  });
  results.push({
    name: 'tamper_unauthorized_suffix_injection',
    detected: !sentinelCheck.ok && sentinelCheck.leakedForbidden.includes('FUTURE_UNAUTHORIZED_SENTINEL_999'),
    detail: { reasons: sentinelCheck.reasons, leakedForbidden: sentinelCheck.leakedForbidden },
  });

  // 12. Negative control: parent-turn mismatch (matching an older partition entry instead of bound parent) MUST be caught
  const secondParentBody = structuredClone(baseAnthropicBody);
  secondParentBody.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'turn 2 reply' }] });
  secondParentBody.messages.push({ role: 'user', content: [{ type: 'text', text: 'turn 2 prompt' }] });
  const secondParentAudit = oracle.evaluate({ protocol: 'anthropic', body: secondParentBody });
  const wrongParentCand = structuredClone(baseAnthropicBody);
  wrongParentCand.messages.push({ role: 'user', content: [{ type: 'text', text: 'compact against stale turn 1' }] });
  const wrongParentAudit = oracle.evaluate({ protocol: 'anthropic', body: wrongParentCand, recordIntoCache: false });
  const parentMismatchCheck = oracle.verifyWarmContinuation({
    parentSeq: secondParentAudit.seq,
    candidateSeq: wrongParentAudit.seq,
    expectMaxTokensLocked: true,
  });
  results.push({
    name: 'tamper_parent_turn_mismatch',
    detected: !parentMismatchCheck.ok && !parentMismatchCheck.exactPrefixMatched,
    detail: { reasons: parentMismatchCheck.reasons, firstDiff: parentMismatchCheck.firstDiff?.section },
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
    seedBuilderMod,
    anthropicProviderMod,
  ] = await Promise.all([
    import('../../../packages/agent-core-v2/test/harness/agent.ts'),
    import('../../../packages/agent-core-v2/src/kosong/provider/protocolAdapterRegistry.ts'),
    import('../../../packages/agent-core-v2/src/agent/contextMemory/contextMemory.ts'),
    import('../../../packages/agent-core-v2/src/agent/llmRequester/llmRequester.ts'),
    import('../../../packages/agent-core-v2/src/agent/fullCompaction/fullCompaction.ts'),
    import('../../../packages/agent-core-v2/src/agent/profile/profile.ts'),
    import('../../../packages/agent-core-v2/src/agent/toolRegistry/toolRegistry.ts'),
    import('../../../packages/agent-core-v2/src/features/btw/seedBuilder.ts'),
    import('../../../packages/agent-core-v2/src/kosong/provider/bases/anthropic/anthropic.ts'),
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
    buildBranchSeedMessages: seedBuilderMod.buildBranchSeedMessages,
    AnthropicChatProvider: anthropicProviderMod.AnthropicChatProvider,
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
    lanes.push(await runManualCompactionCommitAndForkScenario(mods, twin));
    lanes.push(await runAnthropic4SlotAutoCacheContinueScenario(mods, twin));
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
