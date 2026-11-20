import assert from 'node:assert/strict';
import fs from 'node:fs';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  checkDiffMockRatchet,
  collectRegisteredFlagIds,
  collectRegisteredRoutes,
  defineTestContract,
  extractInlineContracts,
  runTestHygieneCheck,
  scanIntraMonorepoMocks,
  validateSunsetTrigger,
} from './check-test-hygiene.mjs';
import { clone10kSubagents } from './clone-10k-subagents.mjs';
import { createContractTwinServer } from './contract-twin-server.mjs';
import { generateChaosCorpus } from './corpus-generator.mjs';
import { parseCcpCliArgs, resolveAccountSources, resolveManifestPath } from './run-on-ccp.mjs';
import {
  computeSoakLinearSlopes,
  generateExtremeMediaSession,
  generateSyntheticMp4,
  generateSyntheticWav,
} from './scenario-soak-and-media-weaknet.mjs';
import {
  computeOggCrc32,
  evaluateS9Verdict,
  generateValidOggOpus,
  resolveS9TierConfig,
  seedS9ChaosExtensions,
} from './scenario-s9-browser-flight-recorder.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

defineTestContract({
  invariant: 'Contract-Verifying Twin rejects wire schema/cache_control/thread/tool-pairing/post-413 violations and serves HTTP/1.1 + HTTP/2 TLS',
  mechanism: 'Prevents blind mock-upstream pass-through regressions under 128-way concurrent SSE streaming, 413 body stripping, and midstream barriers',
  covers: ['POST /v1/messages', 'scripts/ccp-chaos/contract-twin-server.mjs'],
  sunset_when: 'Physically delete this test suite if Anthropic Messages v1 wire transport or Contract-Verifying Twin is retired; never add compatibility shims',
  sunset: { kind: 'symbolRemoved', file: 'scripts/ccp-chaos/contract-twin-server.mjs', symbol: 'createContractTwinServer' },
  tags: ['chaos', 'contract'],
});

defineTestContract({
  invariant: 'Anti-zombie hygiene checker enforces 4-element test contracts and verifies real registered flags and routes',
  mechanism: 'Detects orphaned feature-flag/route/symbol tests, newly added intra-monorepo vi.mock calls, and unexempted .skip zombies in PR diffs',
  covers: ['scripts/ccp-chaos/check-test-hygiene.mjs', 'scripts/check-repo-meta.mjs'],
  sunset_when: 'Physically delete flag-specific sunset assertions when persistence_minidb_readmodel graduates and is removed from registerFlagDefinition',
  sunset: { kind: 'flagRemoved', flag: 'persistence_minidb_readmodel' },
  tags: ['hygiene'],
});

defineTestContract({
  invariant: '10,000-subagent scale benchmark corpus and Scenario S6 verify bounded cold snapshot/AgentList payloads and on-demand cold historical search',
  mechanism: 'Generates a >18 MiB multi-depth state.json with 10,000 subagents and exercises cold snapshot, ContentRef drain, search API, AgentList tool output size, and Playwright CDP virtualization',
  covers: [
    'GET /api/sessions/{session_id}/snapshot',
    'scripts/ccp-chaos/clone-10k-subagents.mjs',
    'scripts/ccp-chaos/scenario-10k-subagents.mjs',
  ],
  sunset_when: 'Physically delete this contract if the 10k-subagent scale harness or session snapshot API is retired; never weaken assertions or add compatibility shims',
  sunset: { kind: 'symbolRemoved', file: 'scripts/ccp-chaos/clone-10k-subagents.mjs', symbol: 'clone10kSubagents' },
  tags: ['chaos', 'scale-10k'],
});

defineTestContract({
  invariant: 'Accelerated multi-day client/server soak (Scenario S7) bounds JS heap, DOM nodes, event listeners, ObjectURLs, and server RSS/FD slope across 200 lifecycle cycles',
  mechanism: 'Runs time-compressed 20x timers, 200 SPA session/page/overlay/reconnect cycles with live streaming turns, and measures linear GC checkpoint slopes (C1->C4)',
  covers: [
    'scripts/ccp-chaos/scenario-soak-and-media-weaknet.mjs',
    'scripts/ccp-chaos/chaos-scale-runner.mjs',
  ],
  sunset_when: 'Physically delete this contract if the long-running soak harness or browser SPA shell is retired; never weaken leak-slope checkpoints',
  sunset: { kind: 'symbolRemoved', file: 'scripts/ccp-chaos/scenario-soak-and-media-weaknet.mjs', symbol: 'runScenarioS7LongRunningSoak' },
  tags: ['chaos', 'soak', 'memory-leak'],
});

defineTestContract({
  invariant: 'Extreme multimodal timeline (600+ images, 70 AV assets) under 3 Mbps / 180 ms RTT weak network and 32 concurrent giant requests prevents HTTP starvation and 64-grant exhaustion',
  mechanism: 'Generates canonical kimi-file media corpus, probes POST /api/sessions/:id/media-playback past MAX_GRANTS=64 with Range fetches, and runs CDP weak-net scroll + concurrent upload/abort storm',
  covers: [
    'POST /api/sessions/:sessionId/media-playback',
    'scripts/ccp-chaos/scenario-soak-and-media-weaknet.mjs',
  ],
  sunset_when: 'Physically delete this contract if session media-playback grants or the S8 weak-network media harness is retired; never mask 429 or starvation regressions',
  sunset: { kind: 'symbolRemoved', file: 'scripts/ccp-chaos/scenario-soak-and-media-weaknet.mjs', symbol: 'runScenarioS8MediaWeakNetStorm' },
  tags: ['chaos', 'media', 'weak-network'],
});

defineTestContract({
  invariant: 'Full-stack browser flight recorder (Scenario S9) catches phase settling flashes, transcript remount/scroll collapses, audio skeleton flashes/redundant re-mints, overlapping/unrounded/nested-scroll popups, Sidebar blank voids, and QuickSwitcher blind arrow scroll under live server load',
  mechanism: 'Drives real built apps/kiki-gui in Playwright Chromium with a frame-by-frame rAF+MutationObserver+PerformanceObserver flight recorder against a live kap-server loaded with mega wire, 10k sessions/subagents, personas, Ogg/Opus+MP4 media, concurrent streaming turns, and live SessionIndex churn',
  covers: [
    'POST /api/sessions/:sessionId/media-playback',
    'GET /media-preview/:previewId',
    'scripts/ccp-chaos/scenario-s9-browser-flight-recorder.mjs',
    'scripts/ccp-chaos/chaos-scale-runner.mjs',
  ],
  sunset_when: 'Physically delete this contract if the Scenario S9 browser flight recorder or kiki-gui browser shell is retired; never weaken flight-recorder breach assertions',
  sunset: { kind: 'symbolRemoved', file: 'scripts/ccp-chaos/scenario-s9-browser-flight-recorder.mjs', symbol: 'runScenarioS9BrowserFlightRecorder' },
  tags: ['chaos', 'browser', 'flight-recorder', 's9'],
});

describe('Contract-Verifying Twin Server (HTTP/1.1 + HTTP/2 TLS)', () => {
  let twin;

  before(async () => {
    twin = await createContractTwinServer({ mode: 'clean', seed: 42, enableTls: true });
  });

  after(async () => {
    await twin?.close();
  });

  it('accepts valid Anthropic create + continue message-threads requests over HTTP/1.1 and HTTP/2 TLS', async () => {
    const createRes = await fetch(`${twin.httpBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'twin-test-key',
        'x-llm-model': 'twin-anthropic',
        'anthropic-beta': 'message-threads-2026-08-12',
      },
      body: JSON.stringify({
        model: 'twin-anthropic',
        max_tokens: 1024,
        stream: false,
        thread: { type: 'create' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello twin', cache_control: { type: 'ephemeral' } }] }],
      }),
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json();
    assert.ok(created.id.startsWith('msg_twin_'));

    const contRes = await fetch(`${twin.httpBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'twin-test-key',
        'anthropic-beta': 'message-threads-2026-08-12',
      },
      body: JSON.stringify({
        model: 'twin-anthropic',
        max_tokens: 1024,
        stream: false,
        thread: { type: 'continue', previous_message_id: created.id },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Follow up turn' }] }],
      }),
    });
    assert.equal(contRes.status, 200);

    const h2Client = http2.connect(twin.h2BaseUrl, { rejectUnauthorized: false });
    try {
      const h2Result = await new Promise((resolve, reject) => {
        const req = h2Client.request({
          ':method': 'POST',
          ':path': '/v1/messages',
          'content-type': 'application/json',
          'x-api-key': 'twin-h2-key',
        });
        let status = 0;
        let data = '';
        req.on('response', (headers) => {
          status = Number(headers[':status']);
        });
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          data += chunk;
        });
        req.on('end', () => resolve({ status, body: JSON.parse(data) }));
        req.on('error', reject);
        req.end(
          JSON.stringify({
            model: 'twin-anthropic',
            max_tokens: 256,
            stream: false,
            messages: [{ role: 'user', content: 'HTTP/2 TLS ping' }],
          }),
        );
      });
      assert.equal(h2Result.status, 200);
      assert.ok(h2Result.body.id.startsWith('msg_twin_'));
    } finally {
      h2Client.close();
    }

    const stats = twin.getStats();
    assert.equal(stats.counters.contractViolations, 0);
    assert.ok(stats.counters.http2Requests >= 1);
    assert.ok(stats.counters.threadCreates >= 1);
    assert.ok(stats.counters.threadContinues >= 1);
  });

  it('rejects cache_control > 4, dangling thread id, unpaired tool_result, X-LLM-Model mismatch, and unreduced post-413 retry', async () => {
    twin.resetStats();

    const tooManyCacheRes = await fetch(`${twin.httpBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({
        model: 'twin-anthropic',
        max_tokens: 512,
        stream: false,
        system: [
          { type: 'text', text: 'sys1', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'sys2', cache_control: { type: 'ephemeral' } },
        ],
        tools: [{ name: 't1', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
              { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
            ],
          },
        ],
      }),
    });
    assert.equal(tooManyCacheRes.status, 400);

    const badThreadRes = await fetch(`${twin.httpBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-beta': 'message-threads-2026-08-12' },
      body: JSON.stringify({
        model: 'twin-anthropic',
        max_tokens: 512,
        stream: false,
        thread: { type: 'continue', previous_message_id: 'msg_nonexistent' },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(badThreadRes.status, 400);

    const orphanToolResultRes = await fetch(`${twin.httpBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({
        model: 'twin-anthropic',
        max_tokens: 512,
        stream: false,
        messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ghost', content: 'x' }] }],
      }),
    });
    assert.equal(orphanToolResultRes.status, 400);

    const mismatchHeaderRes = await fetch(`${twin.httpBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'x-llm-model': 'wrong-model' },
      body: JSON.stringify({
        model: 'twin-anthropic',
        max_tokens: 512,
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(mismatchHeaderRes.status, 422);

    const bigMediaPayload = JSON.stringify({
      model: 'twin-anthropic',
      max_tokens: 512,
      stream: false,
      metadata: { user_id: 'scope-413-test' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '[CHAOS:EARLY_413] test' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(20_000) } },
          ],
        },
      ],
    });
    const r413 = await fetch(`${twin.httpBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: bigMediaPayload,
    });
    assert.equal(r413.status, 413);

    const badRetry = await fetch(`${twin.httpBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: bigMediaPayload,
    });
    assert.equal(badRetry.status, 422);

    const goodRetry = await fetch(`${twin.httpBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({
        model: 'twin-anthropic',
        max_tokens: 512,
        stream: false,
        metadata: { user_id: 'scope-413-test' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'stripped media retry' }] }],
      }),
    });
    assert.equal(goodRetry.status, 200);
    assert.equal(twin.getStats().counters.early413VerifiedStripped, 1);
  });

  it('injects deterministic soft_safety and malformed_tool SSE error frames', async () => {
    const safetyRes = await fetch(`${twin.httpBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({
        model: 'twin-anthropic',
        max_tokens: 512,
        stream: true,
        metadata: { user_id: 'scope-safety' },
        messages: [{ role: 'user', content: '[CHAOS:SOFT_SAFETY] trigger soft safety' }],
      }),
    });
    const safetyText = await safetyRes.text();
    assert.ok(safetyText.includes('generative-ai/use-policy'));
    assert.ok(safetyText.includes('antigravity_soft_safety_stream_cut'));

    const malformedRes = await fetch(`${twin.httpBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({
        model: 'twin-anthropic',
        max_tokens: 512,
        stream: true,
        metadata: { user_id: 'scope-malformed' },
        messages: [{ role: 'user', content: '[CHAOS:MALFORMED_TOOL] trigger malformed tool' }],
      }),
    });
    const malformedText = await malformedRes.text();
    assert.ok(malformedText.includes('antigravity_malformed_function_call'));

    const recoveredRes = await fetch(`${twin.httpBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({
        model: 'twin-anthropic',
        max_tokens: 512,
        stream: false,
        metadata: { user_id: 'scope-malformed' },
        messages: [{ role: 'user', content: '[CHAOS:MALFORMED_TOOL] retry after malformed tool' }],
      }),
    });
    assert.equal(recoveredRes.status, 200);
  });

  it('emits multi-tool calls, validates returned tool_result pairing, and honors midstream barriers', async () => {
    twin.resetStats();
    const step1 = await fetch(`${twin.httpBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({
        model: 'twin-anthropic',
        max_tokens: 512,
        stream: false,
        metadata: { user_id: 'scope-tools-1' },
        tools: [
          { name: 'Glob', input_schema: { type: 'object' } },
          { name: 'Grep', input_schema: { type: 'object' } },
          { name: 'Read', input_schema: { type: 'object' } },
        ],
        messages: [{ role: 'user', content: '[TOOLS:WORKSPACE] run workspace tools' }],
      }),
    });
    assert.equal(step1.status, 200);
    const body1 = await step1.json();
    assert.equal(body1.stop_reason, 'tool_use');
    assert.equal(body1.content.length, 3);

    const step2 = await fetch(`${twin.httpBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({
        model: 'twin-anthropic',
        max_tokens: 512,
        stream: false,
        metadata: { user_id: 'scope-tools-1' },
        tools: [
          { name: 'Glob', input_schema: { type: 'object' } },
          { name: 'Grep', input_schema: { type: 'object' } },
          { name: 'Read', input_schema: { type: 'object' } },
        ],
        messages: [
          { role: 'user', content: '[TOOLS:WORKSPACE] run workspace tools' },
          { role: 'assistant', content: body1.content },
          {
            role: 'user',
            content: body1.content.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: 'ok' })),
          },
        ],
      }),
    });
    assert.equal(step2.status, 200);
    const body2 = await step2.json();
    assert.equal(body2.stop_reason, 'end_turn');
    assert.equal(twin.getStats().counters.toolCallsIssued, 3);
    assert.equal(twin.getStats().counters.toolResultsReceived, 3);

    const bar = twin.prepareBarrier('unit_barrier');
    const barFetch = fetch(`${twin.httpBaseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({
        model: 'twin-anthropic',
        max_tokens: 512,
        stream: true,
        metadata: { user_id: 'scope-bar-1' },
        messages: [{ role: 'user', content: '[CHAOS_BARRIER:unit_barrier] hold midstream' }],
      }),
    }).then((r) => r.text());
    const arrived = await bar.waitForArrivals(1, 5000);
    assert.equal(arrived, 1);
    bar.release();
    const sseText = await barFetch;
    assert.ok(sseText.includes('[stream-complete]'));
  });
});

describe('Zero-PII Chaos Corpus Generator', () => {
  it('generates valid giant wire with 4 MiB spike lines, subagent roster, workspaces.json, and config.toml', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiki-chaos-corpus-test-'));
    try {
      const summary = generateChaosCorpus({
        dir: tmpDir,
        giantWireBytes: 6 * 1024 * 1024,
        spikeLineBytes: 4 * 1024 * 1024,
        subagentCount: 40,
        heavySubagentBytes: 128 * 1024,
        backgroundSessionCount: 5,
      });
      assert.ok(summary.giantMainWireBytes >= 6 * 1024 * 1024);
      assert.ok(summary.spikeLinesWritten >= 1);
      assert.equal(summary.subagentCount, 40);
      assert.ok(fs.existsSync(path.join(summary.homeDir, 'workspaces.json')));
      assert.ok(fs.existsSync(path.join(summary.homeDir, 'config.toml')));

      const state = JSON.parse(
        fs.readFileSync(path.join(summary.homeDir, 'sessions', summary.workspaceId, summary.giantSessionId, 'state.json'), 'utf8'),
      );
      assert.equal(Object.keys(state.agents).length, 41);

      const firstLine = fs.readFileSync(summary.giantMainWirePath, 'utf8').split('\n')[0];
      const meta = JSON.parse(firstLine);
      assert.equal(meta.type, 'metadata');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Anti-Zombie Test Hygiene Gate (check-test-hygiene.mjs)', () => {
  it('validates real repo flags, symbols, routes, and catches expired/removed sunset triggers', () => {
    const flags = collectRegisteredFlagIds(REPO_ROOT);
    const routes = collectRegisteredRoutes(REPO_ROOT);
    assert.ok(flags.size >= 8, `Expected >=8 registered flags, got ${flags.size}`);
    assert.ok(routes.size >= 15, `Expected >=15 kap-server routes, got ${routes.size}`);
    assert.ok(flags.has('persistence_minidb_readmodel'));

    assert.equal(validateSunsetTrigger({ kind: 'flagRemoved', flag: 'persistence_minidb_readmodel' }, { repoRoot: REPO_ROOT, flagIds: flags }).valid, true);
    assert.equal(validateSunsetTrigger({ kind: 'flagRemoved', flag: 'deleted_ghost_flag_v0' }, { repoRoot: REPO_ROOT, flagIds: flags }).valid, false);
    assert.equal(validateSunsetTrigger({ kind: 'symbolRemoved', file: 'scripts/ccp-chaos/contract-twin-server.mjs', symbol: 'createContractTwinServer' }, { repoRoot: REPO_ROOT }).valid, true);
    assert.equal(validateSunsetTrigger({ kind: 'symbolRemoved', file: 'scripts/ccp-chaos/contract-twin-server.mjs', symbol: 'nonExistentSymbol' }, { repoRoot: REPO_ROOT }).valid, false);
    assert.equal(validateSunsetTrigger({ kind: 'expires', date: '2025-01-01', ticket: 'T-001' }, { repoRoot: REPO_ROOT, nowDate: '2026-11-20' }).valid, false);
    assert.equal(validateSunsetTrigger({ kind: 'expires', date: '2027-01-01', ticket: 'T-002' }, { repoRoot: REPO_ROOT, nowDate: '2026-11-20' }).valid, true);
  });

  it('catches newly added intra-monorepo vi.mock, expect.anything(), and .skip in PR diffs', () => {
    const syntheticDiff = [
      'diff --git a/packages/kap-server/test/newFeature.test.ts b/packages/kap-server/test/newFeature.test.ts',
      '+++ b/packages/kap-server/test/newFeature.test.ts',
      '@@ -1,0 +1,5 @@',
      "+import { vi } from 'vitest';",
      "+vi.mock('#/services/sessionIndex', () => ({ get: vi.fn() }));",
      "+vi.mock('@kiki/agent-core-v2', () => ({}));",
      "+it.skip('zombie test', () => expect(x).toEqual(expect.anything()));",
    ].join('\n');
    const ratchet = checkDiffMockRatchet({ repoRoot: REPO_ROOT, diffText: syntheticDiff });
    assert.equal(ratchet.mockViolations.length, 2);
    assert.equal(ratchet.weakAssertionViolations.length, 1);
    assert.equal(ratchet.disabledAddedViolations.length, 1);
  });

  it('passes cleanly on the current workspace repository scan and rejects incomplete 4-element contracts', () => {
    const report = runTestHygieneCheck({ repoRoot: REPO_ROOT, diffText: '' });
    assert.equal(report.ok, true, `Unexpected hygiene failure: ${JSON.stringify(report)}`);
    assert.equal(report.disabledTests.violations.length, 0);
    assert.equal(report.contractsChecked >= 2, true);

    assert.throws(
      () => defineTestContract({ invariant: 'Test helper returns true', mechanism: 'valid mechanism text', covers: ['POST /v1/messages'], sunset_when: 'Delete when removed from server', sunset: { kind: 'permanent' } }),
      /user-perceivable invariant/u,
    );
    assert.throws(
      () => defineTestContract({ invariant: 'Valid user-visible invariant text', sunset: { kind: 'permanent' } }),
      /@mechanism/u,
    );
    const parsed = extractInlineContracts('packages/foo/bar.test.ts', "defineTestContract({ invariant: 'short', sunset: { kind: 'permanent' } })");
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].mechanism, '');
  });
});

describe('CCP Manifest & Account Source Configuration (Zero-PII)', () => {
  it('resolves manifest path and account sources from env/manifest with clean defaults when no private manifest exists', () => {
    const examplePath = path.join(import.meta.dirname, 'corpus-manifest.example.json');
    const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
    assert.equal(example.account_id, 'acc_00000000000000000000000000000000');
    assert.equal(example.drive_folder_id, 'DRIVE_FOLDER_ID_EXAMPLE');
    assert.equal(example.binding.drive_file_id, 'DRIVE_FILE_ID_EXAMPLE');

    assert.equal(
      resolveManifestPath({}),
      path.join(import.meta.dirname, 'corpus-manifest.json'),
    );
    assert.equal(
      resolveManifestPath({ KIKI_CHAOS_MANIFEST_PATH: '/custom/private/manifest.json' }),
      '/custom/private/manifest.json',
    );

    assert.deepEqual(resolveAccountSources(null, {}), {});
    assert.deepEqual(resolveAccountSources(example, {}), example.account_sources);

    const merged = resolveAccountSources(
      {
        account_sources: {
          acc_from_manifest: { runnerSourceId: 'src_m', driveFolderId: 'folder_m' },
          acc_shared: { runnerSourceId: 'src_old', driveFolderId: 'folder_old' },
        },
      },
      {
        KIKI_CHAOS_ACCOUNT_SOURCES_JSON: JSON.stringify({
          acc_shared: { runnerSourceId: 'src_env', driveFolderId: 'folder_env' },
          acc_from_env: { runnerSourceId: 'src_e', driveFolderId: 'folder_e' },
        }),
      },
    );
    assert.deepEqual(merged, {
      acc_from_manifest: { runnerSourceId: 'src_m', driveFolderId: 'folder_m' },
      acc_shared: { runnerSourceId: 'src_env', driveFolderId: 'folder_env' },
      acc_from_env: { runnerSourceId: 'src_e', driveFolderId: 'folder_e' },
    });

    assert.throws(
      () => resolveAccountSources(null, { KIKI_CHAOS_ACCOUNT_SOURCES_JSON: '{bad-json' }),
      /Invalid KIKI_CHAOS_ACCOUNT_SOURCES_JSON/u,
    );

    const parsed = parseCcpCliArgs([
      '--s6-only',
      '--keep-runtime',
      '--sync-code-only',
      '--ttl',
      '240',
      '--idle-timeout',
      '120',
      '--tenk-subagents',
      '10000',
      '--s6-step-timeout-ms',
      '45000',
    ]);
    assert.equal(parsed.s6Only, true);
    assert.equal(parsed.keepRuntime, true);
    assert.equal(parsed.syncCodeOnly, true);
    assert.equal(parsed.ttlMinutes, 240);
    assert.equal(parsed.idleTimeoutMinutes, 120);
    assert.equal(parsed.tenKSubagentCount, 10000);
    assert.equal(parsed.s6StepTimeoutMs, 45000);
  });
});

describe('10k-Subagent Cloner & AGENT_LIST_10K Twin Telemetry', () => {
  it('clones a multi-depth subagent hierarchy with branches, statuses, hardlinked cold wires, and unique inspected wires', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiki-10k-clone-test-'));
    try {
      const summary = clone10kSubagents({
        dir: tmpDir,
        subagentCount: 250,
        batchTurnSubagents: 40,
        minSummaryChars: 550,
        maxSummaryChars: 650,
      });
      assert.equal(summary.subagentCount, 250);
      assert.equal(
        summary.hierarchy.directChildren +
          summary.hierarchy.depth2Grandchildren +
          summary.hierarchy.depth3GreatGrandchildren,
        250,
      );
      assert.ok(summary.hierarchy.depth2Grandchildren > 0);
      assert.ok(summary.hierarchy.depth3GreatGrandchildren > 0);
      assert.ok(summary.statuses.branches >= 2);
      assert.ok(summary.statuses.running >= 1);
      assert.ok(summary.statuses.suspended >= 1);
      assert.ok(summary.statuses.failed >= 2);
      assert.equal(summary.wireLinkStats.unique, 4);
      assert.equal(summary.wireLinkStats.hardlinked + summary.wireLinkStats.copied, 246);

      const state = JSON.parse(fs.readFileSync(summary.stateJsonPath, 'utf8'));
      assert.equal(Object.keys(state.agents).length, 251);
      assert.equal(state.agents.subagent_00042.displayName, 'Cold Archive Needle #0042');
      assert.ok(state.agents.subagent_00042.resultSummary.length >= 550 && state.agents.subagent_00042.resultSummary.length <= 650);

      const branchEntries = Object.values(state.agents).filter((a) => a?.labels?.branch === 'true');
      assert.equal(branchEntries.length, summary.statuses.branches);

      const inspectedWire = fs.readFileSync(
        path.join(summary.homeDir, 'sessions', summary.workspaceId, summary.sessionId, 'agents', 'subagent_00042', 'wire.jsonl'),
        'utf8',
      );
      assert.ok(inspectedWire.includes('UNIQUE_SUBAGENT_RECEIPT:subagent_00042'));
      assert.ok(fs.existsSync(path.join(summary.homeDir, 'sessions', summary.workspaceId, summary.lightSessionId, 'state.json')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('triggers AgentList(include_finished=true) via [TOOLS:AGENT_LIST_10K] and captures tool_result byte/row telemetry', async () => {
    const twin = await createContractTwinServer({ mode: 'clean', seed: 99, enableTls: false });
    try {
      const step1 = await fetch(`${twin.httpBaseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
        body: JSON.stringify({
          model: 'twin-anthropic',
          max_tokens: 512,
          stream: false,
          metadata: { user_id: 'scope-agentlist-10k' },
          tools: [{ name: 'AgentList', input_schema: { type: 'object' } }],
          messages: [{ role: 'user', content: '[TOOLS:AGENT_LIST_10K] inspect fleet' }],
        }),
      });
      assert.equal(step1.status, 200);
      const body1 = await step1.json();
      assert.equal(body1.stop_reason, 'tool_use');
      assert.equal(body1.content.length, 1);
      assert.equal(body1.content[0].name, 'AgentList');
      assert.deepEqual(body1.content[0].input, { include_finished: true });

      const samplePayload = JSON.stringify({
        agents: [
          { agent_id: 'subagent_00001', status: 'running' },
          { agent_id: 'subagent_00002', status: 'completed' },
        ],
        note: '9998 further children omitted',
      });
      const step2 = await fetch(`${twin.httpBaseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
        body: JSON.stringify({
          model: 'twin-anthropic',
          max_tokens: 512,
          stream: false,
          metadata: { user_id: 'scope-agentlist-10k' },
          tools: [{ name: 'AgentList', input_schema: { type: 'object' } }],
          messages: [
            { role: 'user', content: '[TOOLS:AGENT_LIST_10K] inspect fleet' },
            { role: 'assistant', content: body1.content },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: body1.content[0].id, content: samplePayload }],
            },
          ],
        }),
      });
      assert.equal(step2.status, 200);
      const stats = twin.getStats().toolStats.AgentList;
      assert.equal(stats.resultsOk, 1);
      assert.equal(stats.lastParsedEntryCount, 2);
      assert.equal(stats.lastSubagentMentionCount, 2);
      assert.equal(stats.lastHasOmissionNotice, true);
      assert.ok(stats.lastResultBytes > 0 && stats.lastResultBytes < 1024);
    } finally {
      await twin.close();
    }
  });
});

describe('Scenario S7 Soak Slopes & Scenario S8 Extreme Media Generator', () => {
  it('computes accurate linear per-cycle leak slopes across soak GC checkpoints', () => {
    const slopes = computeSoakLinearSlopes([
      { cycle: 20, jsHeapMb: 80, domNodes: 2000, jsEventListeners: 1000, liveObjectUrls: 1, serverRssMb: 1200, serverHeapMb: 600, serverOpenFds: 55 },
      { cycle: 80, jsHeapMb: 86, domNodes: 2060, jsEventListeners: 1060, liveObjectUrls: 1, serverRssMb: 1210, serverHeapMb: 605, serverOpenFds: 56 },
      { cycle: 200, jsHeapMb: 98, domNodes: 2180, jsEventListeners: 1180, liveObjectUrls: 3, serverRssMb: 1236, serverHeapMb: 618, serverOpenFds: 57 },
    ]);
    assert.equal(slopes.fromCycle, 20);
    assert.equal(slopes.toCycle, 200);
    assert.equal(slopes.deltaCycles, 180);
    assert.equal(slopes.jsHeapKbPerCycle, 102.4);
    assert.equal(slopes.domNodesPerCycle, 1);
    assert.equal(slopes.listenersPerCycle, 1);
    assert.equal(slopes.unrevokedObjectUrlsDelta, 2);
    assert.equal(slopes.serverRssKbPerCycle, 204.8);
    assert.equal(slopes.serverFdsDelta, 2);
  });

  it('generates canonical kimi-file extreme media session with valid PNG/MP4/WAV headers and metadata', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiki-s8-media-test-'));
    try {
      const mp4 = generateSyntheticMp4(64 * 1024);
      assert.equal(mp4.subarray(4, 12).toString('ascii'), 'ftypisom');
      const wav = generateSyntheticWav(64 * 1024);
      assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
      assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');

      const summary = generateExtremeMediaSession({
        dir: tmpDir,
        imageCount: 24,
        giantImageCount: 2,
        videoCount: 4,
        audioCount: 3,
        turnsCount: 4,
        giantPngWidth: 64,
        giantPngHeight: 64,
        regularPngWidth: 32,
        regularPngHeight: 32,
        videoBytes: 16 * 1024,
        audioBytes: 16 * 1024,
      });
      assert.equal(summary.imageCount, 24);
      assert.equal(summary.totalPlaybackAssets, 7);
      assert.equal(summary.videoFileIds.length, 4);
      assert.equal(summary.audioFileIds.length, 3);
      assert.ok(fs.existsSync(summary.mainWirePath));
      assert.ok(fs.existsSync(summary.stateJsonPath));

      const wireText = fs.readFileSync(summary.mainWirePath, 'utf8');
      assert.ok(wireText.includes('kimi-file://f_s8img_0001'));
      assert.ok(wireText.includes('kimi-file://f_s8vid_0001'));
      assert.ok(wireText.includes('kimi-file://f_s8aud_0001'));

      const metaPath = path.join(
        summary.homeDir,
        'sessions',
        summary.workspaceId,
        summary.sessionId,
        'media',
        'meta',
        'f_s8vid_0001.json',
      );
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      assert.equal(meta.version, 1);
      assert.equal(meta.key, 'f_s8vid_0001.mp4');
      assert.equal(meta.mediaType, 'video/mp4');

      const parsedFlags = parseCcpCliArgs(['--run-s7-s8', '--s7-cycles', '180']);
      assert.equal(parsedFlags.runS7S8, true);
      assert.equal(parsedFlags.s7Cycles, 180);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('enforces vi.doMock/mock.module/@nb-corp, multiline mocks, vi.mock(import(...)), and importOriginal value/vi.fn() overrides while exempting spy and clean importOriginal wrappers', () => {
    const diff = [
      '+++ b/packages/kap-server/test/sample.test.ts',
      '@@ -1,0 +1,12 @@',
      "+vi.doMock('../src/routes/sessionMedia', () => ({ openSessionMedia: () => null }));",
      "+mock.module('@nb-corp/nb-im', () => ({}));",
      "+vi.mock(import('../src/routes/prompts'), () => ({ registerPromptRoutes: () => {} }));",
      '+vi.mock(',
      "+  '../src/routes/hostMediaPreview',",
      '+  () => ({ registerHostMediaPreviewRoutes: () => {} }),',
      '+);',
      "+vi.mock('../src/externalClients/access', async (importOriginal) => ({ ...(await importOriginal()), open: vi.fn() }));",
      "+vi.mock('../src/lib/plainOverride', async (importOriginal) => ({ ...(await importOriginal()), enabled: false }));",
      "+vi.mock('../src/lib/mixedSpyOverride', async (importOriginal) => { const actual = await importOriginal(); return { ...actual, ok: vi.spyOn(actual, 'ok'), forged: () => 42 }; });",
      "+vi.mock('../src/lib/pureSpyWrapper', async (importOriginal) => { const actual = await importOriginal(); return { ...actual, ok: vi.spyOn(actual, 'ok') }; });",
      "+vi.mock('../src/services/history/logicalWireRead', { spy: true });",
      "+vi.mock('@nb-corp/nb-im', async (importOriginal) => ({ ...(await importOriginal()) }));",
      "+vi.mock('node:fs/promises', () => ({}));",
    ].join('\n');
    const ratchet = checkDiffMockRatchet({ diffText: diff });
    assert.equal(ratchet.mockViolations.length, 7);
    assert.deepEqual(
      ratchet.mockViolations.map((entry) => entry.target),
      [
        '../src/routes/sessionMedia',
        '@nb-corp/nb-im',
        '../src/routes/prompts',
        '../src/routes/hostMediaPreview',
        '../src/externalClients/access',
        '../src/lib/plainOverride',
        '../src/lib/mixedSpyOverride',
      ],
    );

    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'kiki-hygiene-tree-'));
    try {
      const kapTestDir = path.join(tmpRepo, 'packages', 'kap-server', 'test');
      const otherIntegDir = path.join(tmpRepo, 'packages', 'agent-core-v2', 'test');
      fs.mkdirSync(kapTestDir, { recursive: true });
      fs.mkdirSync(otherIntegDir, { recursive: true });
      fs.writeFileSync(
        path.join(kapTestDir, 'bad.test.ts'),
        "vi.mock(\n  '../src/routes/sessionMedia',\n  () => ({}),\n);\nvi.mock('../src/routes/ok', { spy: true });\n",
      );
      fs.writeFileSync(
        path.join(otherIntegDir, 'bad.integration.ts'),
        "vi.doMock('#/app/sessionIndex/sessionIndexService', () => ({}));\n",
      );
      const scanned = scanIntraMonorepoMocks(tmpRepo, { allowlist: new Set() });
      assert.equal(scanned.violations.length, 2);
      assert.deepEqual(
        scanned.violations.map((entry) => entry.file).sort(),
        [
          'packages/agent-core-v2/test/bad.integration.ts',
          'packages/kap-server/test/bad.test.ts',
        ],
      );
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});

describe('Scenario S9 Full-Stack Browser Flight Recorder Contracts', () => {
  it('generates RFC-valid Ogg/Opus binary with valid OggS pages, OpusHead/OpusTags, BOS/EOS flags, and CRC32', () => {
    const ogg = generateValidOggOpus(600);
    assert.equal(ogg.subarray(0, 4).toString('ascii'), 'OggS');
    assert.equal(ogg[5], 0x02); // BOS on first page
    assert.ok(ogg.includes(Buffer.from('OpusHead', 'ascii')));
    assert.ok(ogg.includes(Buffer.from('OpusTags', 'ascii')));

    // Verify every OggS page's CRC32 matches RFC 3533
    let offset = 0;
    let pages = 0;
    let sawEos = false;
    while (offset < ogg.length) {
      assert.equal(ogg.subarray(offset, offset + 4).toString('ascii'), 'OggS');
      const headerType = ogg[offset + 5];
      if ((headerType & 0x04) !== 0) sawEos = true;
      const segCount = ogg[offset + 26];
      let bodyLen = 0;
      for (let i = 0; i < segCount; i += 1) bodyLen += ogg[offset + 27 + i];
      const pageLen = 27 + segCount + bodyLen;
      const pageSlice = Buffer.from(ogg.subarray(offset, offset + pageLen));
      const storedCrc = pageSlice.readUInt32LE(22);
      pageSlice.writeUInt32LE(0, 22);
      assert.equal(computeOggCrc32(pageSlice), storedCrc);
      offset += pageLen;
      pages += 1;
    }
    assert.ok(pages >= 3);
    assert.equal(sawEos, true);
  });

  it('streams multi-chunk SSE tokens across [CHAOS:STREAM_HOLD:<ms>] on Contract Twin', async () => {
    const twin = await createContractTwinServer({ mode: 'clean', seed: 109, enableTls: false });
    try {
      const t0 = Date.now();
      const res = await fetch(`${twin.httpBaseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
        body: JSON.stringify({
          model: 'twin-anthropic',
          max_tokens: 256,
          stream: true,
          metadata: { user_id: 'scope-s9-hold' },
          messages: [{ role: 'user', content: '[CHAOS:STREAM_HOLD:300] stream slowly' }],
        }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      const elapsed = Date.now() - t0;
      assert.ok(elapsed >= 220, `Expected >= 220ms stream hold, got ${elapsed}ms`);
      assert.ok(text.includes('tok1 '));
      assert.ok(text.includes('[stream-complete]'));
    } finally {
      await twin.close();
    }
  });

  it('seeds S9 personas, multi-workspace scale sessions, and Ogg/MP4/PNG ScopedMediaStore session', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiki-s9-seed-test-'));
    try {
      const fullCfg = resolveS9TierConfig('full');
      const smokeCfg = resolveS9TierConfig('smoke');
      assert.equal(fullCfg.sessionCount, 10_000);
      assert.equal(fullCfg.subagentCount, 10_000);
      assert.equal(smokeCfg.sessionCount, 140);
      assert.equal(smokeCfg.quickSwitcherArrows, 35);

      const seeded = seedS9ChaosExtensions({
        dir: tmpDir,
        corpus: {
          rootDir: tmpDir,
          homeDir: path.join(tmpDir, 'home'),
          workspaceDir: path.join(tmpDir, 'workspace'),
        },
        tierConfig: resolveS9TierConfig('smoke', { sessionCount: 95, personaCount: 4 }),
      });
      assert.equal(seeded.personaIds.length, 4);
      assert.equal(seeded.seededSessionCount, 95);
      assert.ok(fs.existsSync(path.join(seeded.homeDir, 'personas', 's9-persona-01', 'persona.md')));
      const oggMeta = JSON.parse(
        fs.readFileSync(
          path.join(seeded.homeDir, 'sessions', seeded.primaryWorkspaceId, seeded.mediaSessionId, 'media', 'meta', 'f_s9ogg_0001.json'),
          'utf8',
        ),
      );
      assert.equal(oggMeta.mediaType, 'audio/ogg');
      assert.equal(oggMeta.key, 'f_s9ogg_0001.ogg');

      const parsedS9 = parseCcpCliArgs(['--tier', 'full', '--run-all', '--s9-only', '--run-s9']);
      assert.equal(parsedS9.tier, 'full');
      assert.equal(parsedS9.runAll, true);
      assert.equal(parsedS9.s9Only, true);
      assert.equal(parsedS9.runS9, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('hard-fails evaluateS9Verdict on any flight-recorder, audio, popup, sidebar, or QuickSwitcher breach', () => {
    const cleanInput = () => ({
      flightRecorder: {
        breaches: {
          phaseFlashToSettling: [],
          errorBoundaryMounts: [],
          transcriptRootRemounts: [],
          scrollHeightCollapses: [],
          unexpectedScrollSnapBacks: [],
          audioUnmounts: [],
          audioSkeletonFlashes: [],
          floatingOverlapBreaches: [],
          floatingRadiusBreaches: [],
          floatingScrollableBreaches: [],
        },
      },
      pageErrors: [],
      http5xxResponses: [],
      drill1: {
        roundsSucceeded: 10,
        composerUsableAfterAllRounds: true,
        composerPopupSweep: { triggersClicked: 4, breachCount: 0 },
      },
      drill2: {
        oggRangeProbe: { status: 206, rangeLatencyMs: 18 },
        mp4RangeProbe: { status: 206, rangeLatencyMs: 22 },
        mountedAudioCount: 2,
        attachmentPreviewOpened: true,
        redundantMediaPlaybackRemints: [],
      },
      drill3: {
        sidebar: { virtualized: true, personasToggleFound: true, maxBlankGapPx: 0 },
        quickSwitcher: { opened: true, highlightedMounted: true, highlightedInViewport: true },
        rightRail10k: { foundColdNeedleA: true },
      },
      serverHealth: { unhandledRejections: 0, uncaughtExceptions: 0 },
      tierConfig: resolveS9TierConfig('smoke'),
    });

    assert.equal(evaluateS9Verdict(cleanInput()).passed, true);

    const withPhaseFlash = cleanInput();
    withPhaseFlash.flightRecorder.breaches.phaseFlashToSettling.push({ from: 'active', to: 'settling' });
    assert.equal(evaluateS9Verdict(withPhaseFlash).passed, false);

    const withSidebarVoid = cleanInput();
    withSidebarVoid.drill3.sidebar.maxBlankGapPx = 450;
    assert.equal(evaluateS9Verdict(withSidebarVoid).passed, false);

    const withBlindSwitcher = cleanInput();
    withBlindSwitcher.drill3.quickSwitcher.highlightedInViewport = false;
    assert.equal(evaluateS9Verdict(withBlindSwitcher).passed, false);

    const withAudioRemint = cleanInput();
    withAudioRemint.drill2.redundantMediaPlaybackRemints.push({ sessionId: 'chaos_s9_media', fileId: 'f_s9ogg_0001' });
    assert.equal(evaluateS9Verdict(withAudioRemint).passed, false);

    const withSlowMediaRange = cleanInput();
    withSlowMediaRange.drill2.oggRangeProbe.rangeLatencyMs = 310;
    assert.equal(evaluateS9Verdict(withSlowMediaRange).passed, false);

    const withPopupOverlap = cleanInput();
    withPopupOverlap.flightRecorder.breaches.floatingOverlapBreaches.push({ count: 2 });
    assert.equal(evaluateS9Verdict(withPopupOverlap).passed, false);
  });
});
