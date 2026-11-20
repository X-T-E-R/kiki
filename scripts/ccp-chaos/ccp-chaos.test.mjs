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
  validateSunsetTrigger,
} from './check-test-hygiene.mjs';
import { createContractTwinServer } from './contract-twin-server.mjs';
import { generateChaosCorpus } from './corpus-generator.mjs';

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
