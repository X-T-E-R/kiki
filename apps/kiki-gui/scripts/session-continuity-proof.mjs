/**
 * Fixture-only browser proof: node scripts/session-continuity-proof.mjs
 * Optional --output=PATH selects an independent output directory; no directory
 * is cleared. Uses isolated loopback fixture/Vite servers and browser storage,
 * never a user home or model provider. evidence.json records API identities,
 * prompt/create payloads, storage after real reloads, and transition assertions.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as createPortProbe } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { startFixtureServer, FIXTURE_TOKEN } from './fixture-server.mjs';
import { SID, profiles, capabilityTargets } from '../fixtures/session-continuity.scenario.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const output = outputArg === undefined
  ? join(ROOT, '.tmp', 'session-continuity-proof', String(Date.now()))
  : resolve(outputArg.slice('--output='.length));
await mkdir(output, { recursive: true });
const evidence = { requests: [], payloads: [], states: [], checks: [] };
const fixture = await startFixtureServer({ port: 0, scenario: 'session-continuity' });
fixture.sessions.get(SID).transcript.commit('main', [{ op: 'meta.merge', meta: {
  agent: { model: 'fixture/model-b', thinkingEffort: 'high' },
  modes: { plan: { enteredAt: '2026-09-06T00:00:00Z' }, swarm: { enteredAt: '2026-09-06T00:00:00Z' } },
} }]);
const fixtureUrl = `http://127.0.0.1:${fixture.http.address().port}`;
process.env.KIKI_SERVER_URL = fixtureUrl;
let catalogError = false;
let profileDeleted = false;
let modelDeleted = false;
let capabilityError = false;
let recoveryError = false;
let delayBinding = false;
/**
 * The seeded capability answer, shared by both transports: the GUI reads the
 * agent panel through `POST /api/klient/call` (agentPanelService.read), while
 * the REST `/api/agents/capabilities` route stays covered for older callers.
 * Both must agree, or the same assertion would pass on one and time out on
 * the other.
 */
const capabilityPayload = (query) => {
  const live = query.session_id !== undefined && query.session_id !== null;
  return {
    context: live ? 'live' : 'draft', available: true,
    owner: { profile: 'workspace-main', agent_id: live ? query.agent_id : undefined },
    targets: capabilityTargets.map((target, i) => live ? {
      ...target, launch_allowed: i === 0, launch_unavailable_reason: i === 0 ? undefined : 'Plan mode blocks implementation dispatch',
      execution_restriction: i === 0 ? 'research-readonly' : undefined,
    } : target),
    // The inspector's capability section renders only when both collections are
    // reported; empty arrays are a present-and-empty answer, not a missing one.
    tools: [],
    skills: [],
  };
};
const baseHandle = fixture.handleHttp.bind(fixture);
fixture.handleHttp = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  const url = new URL(req.url, fixtureUrl);
  // The agent panel rides the klient transport: read the body, record the same
  // request identity the REST branch records, and answer from the same seed.
  if (req.method === 'POST' && url.pathname === '/api/klient/call') {
    if (req.headers.authorization !== `Bearer ${FIXTURE_TOKEN}`) {
      return fixture.envelope(res, null, 40101, 'Unauthorized');
    }
    const body = await fixture.readBody(req);
    if (body?.procedure?.service === 'agentPanelService' && body.procedure.method === 'read') {
      const query = body.params?.[0] ?? {};
      evidence.requests.push({
        path: '/api/agents/capabilities',
        query: Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])),
      });
      if (capabilityError) return fixture.envelope(res, null, 50301, 'capability fixture offline');
      return fixture.envelope(res, capabilityPayload(query));
    }
    // The model catalog also rides klient, so the deleted-model case has to be
    // applied here for the composer to see the model disappear.
    if (body?.procedure?.service === 'modelResolver' && body.procedure.method === 'listModels') {
      evidence.requests.push({ path: '/api/models', query: {} });
      if (modelDeleted) {
        // fixture.models is already normalized (id/provider_id), so filter on id.
        return fixture.envelope(res, structuredClone(fixture.models)
          .filter((model) => model.id !== 'fixture/model-b'));
      }
    }
    // Body already consumed: hand the parsed value to the fixture's router.
    return fixture.klient.route(res, url, body, req.method);
  }
  if (req.method === 'GET') {
    evidence.requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    if (url.pathname === '/api/agents') {
      if (catalogError) return fixture.envelope(res, null, 50301, 'catalog fixture offline');
      const items = profiles.filter((profile) => !profileDeleted || profile.name !== 'workspace-main');
      return fixture.envelope(res, { items });
    }
    if (url.pathname === '/api/agents/capabilities') {
      if (capabilityError) return fixture.envelope(res, null, 50301, 'capability fixture offline');
      return fixture.envelope(res, capabilityPayload(Object.fromEntries(url.searchParams)));
    }
    if (url.pathname === '/api/models' && modelDeleted) {
      return fixture.envelope(res, { items: fixture.models.filter((model) => model.model !== 'fixture/model-b') });
    }
    // Snapshot/transcript reads arrive on both the REST `/sessions/:id/...`
    // routes and the klient `/api/klient/session-view/:id/...` ones; the
    // failure and the delay must apply to whichever the client actually uses.
    const sessionRead = url.pathname.includes(`/sessions/${SID}`)
      || url.pathname.includes(`/session-view/${SID}`);
    if (sessionRead && (url.pathname.endsWith('/snapshot') || url.pathname.endsWith('/transcript') || url.pathname.endsWith('/transcript/catch-up') || url.pathname.endsWith(`/${SID}`))) {
      if (recoveryError && !url.pathname.endsWith(`/${SID}`)) return fixture.envelope(res, null, 50301, 'Saved transcript fixture unavailable');
      if (delayBinding) await new Promise((done) => setTimeout(done, 900));
    }
  }
  return baseHandle(req, res);
};
const probe = createPortProbe();
await new Promise((done, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', done); });
const webPort = probe.address().port;
await new Promise((done) => probe.close(done));
const vite = await createServer({ root: ROOT, server: { host: '127.0.0.1', port: webPort, strictPort: true, watch: { ignored: ['**/*.test.ts', '**/*.test.tsx'] } } });
await vite.listen();
const webUrl = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20_000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (request.method() === 'POST' && request.url().includes('/api/sessions')) {
    evidence.payloads.push({ url: new URL(request.url()).pathname, body: request.postDataJSON() });
  }
});
await page.addInitScript(() => {
  if (localStorage.getItem('kiki.locale') === null) localStorage.setItem('kiki.locale', 'zh');
  if (localStorage.getItem('kiki.onboarding') === null) {
    localStorage.setItem('kiki.onboarding', JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z' }));
  }
});
const shot = (name) => page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
const ready = async () => {
  await page.locator('textarea[data-composer]').waitFor();
  await page.waitForFunction(() => {
    const input = document.querySelector('textarea[data-composer]');
    return input !== null && !input.disabled && !document.querySelector('[data-selection-diagnostic]');
  });
  // The composer toolbar rides the transcript's growth for a frame or two after
  // a cold load; clicking a control mid-shift detaches it under Playwright.
  // Best-effort: a live session can keep re-rendering, so never block on it.
  await page.waitForFunction(() => {
    const seat = document.querySelector('[data-composer-seat]');
    if (seat === null) return true;
    const probe = window;
    const top = seat.getBoundingClientRect().top;
    const settled = probe.__kikiSeatTop === top;
    probe.__kikiSeatTop = top;
    return settled;
  }, undefined, { polling: 120, timeout: 4000 }).catch(() => undefined);
};
/** The session inspector starts collapsed; open it before reading into it. */
const openRail = async () => {
  // The agent workspace shows its inspector without a toggle; only the session
  // view collapses it. Click the toggle when there is one, then wait for it.
  // Two surfaces, two hooks: the session view's own toggle and the agent
  // workspace header's open-only entry (which disappears once expanded).
  const rail = page.locator('[data-session-rail]');
  if (await rail.count() === 0) {
    const toggle = page.locator('[data-rail-toggle], [data-agent-rail-toggle]').first();
    await toggle.waitFor();
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  }
  await rail.first().waitFor();
};
/**
 * The inspector's model/capability group is collapsed by default and only then
 * issues its capability read; every capability assertion needs it open.
 */
const openRailSetup = async () => {
  await openRail();
  const group = page.locator('[data-session-rail] [data-inspector-setup]');
  await group.waitFor();
  const summary = group.locator('summary, button').first();
  if ((await group.getAttribute('open')) === null
    && (await summary.getAttribute('aria-expanded')) !== 'true') {
    await summary.click();
  }
  await page.locator('[data-session-rail] [data-agent-capabilities-section]').waitFor();
};
const pick = async (id, value) => {
  // A freshly loaded transcript keeps growing for a frame or two after `ready`,
  // which drags the toolbar under the cursor; wait for the trigger to settle.
  const trigger = page.locator(`#${id}`);
  await trigger.waitFor();
  await trigger.click();
  const option = value.startsWith('fixture/')
    ? page.locator(`#${id}-list [role="option"][title="${value}"]`)
    : page.locator(`#${id}-list [role="option"]`).filter({ hasText: value }).first();
  await option.waitFor();
  await option.click();
};
const remember = async (name) => {
  evidence.states.push({ name, url: page.url(), storage: await page.evaluate(() => ({
    newDraft: JSON.parse(localStorage.getItem('kiki.newSessionDraft') ?? '{}'),
    sessions: JSON.parse(localStorage.getItem('kiki.composerStates') ?? '{}'),
  })), inputEnabled: await page.locator('textarea[data-composer]').isEnabled() });
};
try {
  await page.goto(`${webUrl}/new?server=${encodeURIComponent(fixtureUrl)}&token=${FIXTURE_TOKEN}`, { timeout: 120_000 });
  await ready();
  await pick('composer-agent-profile-select', 'workspace-main');
  await ready();
  await page.locator('textarea[data-composer]').fill('新会话草稿仍可发送');
  await remember('new-selected');
  assert.equal(evidence.states.at(-1).storage.newDraft.modelFromProfile, true);
  // Continue into the existing session from the sidebar, the one session list.
  await page.locator('[data-session-row]').filter({ hasText: '连续性验证会话' }).first().click();
  await ready();
  await page.goBack();
  await ready();
  await page.reload();
  await ready();
  await remember('new-back-reload');
  assert.equal(evidence.states.at(-1).storage.newDraft.workspaceId, 'wd_fixture_alpha_00000000000a');
  assert.equal(evidence.states.at(-1).storage.newDraft.modelOverride, 'fixture/model-b');
  assert.equal(evidence.states.at(-1).storage.newDraft.effortOverride, 'high');
  assert.equal(evidence.states.at(-1).storage.newDraft.modelFromProfile, true);
  // The draft dispatch diagnostic folds inside the workspace popover.
  await page.locator('[data-hero-workspace] > button').click();
  await page.locator('[data-agent-capabilities] > button').click();
  await page.locator('[data-capability-target="research"]').waitFor();
  assert.equal(await page.locator('[data-capability-context="draft"]').count(), 1);
  assert.equal(await page.getByText('当前允许启动', { exact: true }).count(), 0);
  await shot('01-new-reload-draft-capabilities-zh');
  await page.locator('[data-hero-workspace] > button').click();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForURL(/\/s\//);
  await ready();
  assert.ok(evidence.payloads.some(({ url, body }) => url === '/api/sessions' && body.agent_config?.profile === 'workspace-main' && body.agent_config?.model === 'fixture/model-b' && body.agent_config?.thinking === 'high'));
  evidence.checks.push('new -> existing -> back -> reload preserves workspace/profile/model/effort and sends create payload');

  await page.goto(`${webUrl}/s/${SID}`);
  await ready();
  await pick('composer-model-select', 'fixture/model-b');
  await page.locator('#composer-model-select').click();
  // A live session re-renders the effort row under the cursor (turn/usage
  // frames keep arriving), so Playwright's stability gate never settles here.
  // The click itself is what the proof asserts; force it past the gate.
  await page.locator('[data-effort="high"]').click({ force: true });
  await page.keyboard.press('Escape');
  await page.reload();
  await ready();
  await remember('session-manual-model-effort-reload');
  assert.equal(evidence.states.at(-1).storage.sessions[SID]?.modelOverride, 'fixture/model-b');
  assert.equal(evidence.states.at(-1).storage.sessions[SID]?.effortOverride, 'high');
  await pick('composer-model-select', '继承会话');
  await remember('session-inherited-model-local-high');
  delayBinding = true;
  await page.reload();
  await ready();
  delayBinding = false;
  await remember('session-delayed-binding-reload');
  assert.equal(evidence.states.at(-1).storage.sessions[SID]?.effortOverride, 'high');
  assert.equal(evidence.states.at(-1).storage.sessions[SID]?.modelOverride, undefined);
  await page.locator('textarea[data-composer]').fill('延迟快照后保持 high');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForTimeout(250);
  assert.ok(evidence.payloads.some(({ body }) => body.thinking === 'high' || body.thinking_effort === 'high'));
  // Live dispatch restrictions, through the inspector's capability section:
  // the research target is offered, and its Plan-mode read-only restriction is
  // stated on the target's own detail. Same facts as before, new surface.
  await openRailSetup();
  const capabilities = page.locator('[data-session-rail] [data-agent-capabilities-section]');
  await capabilities.getByRole('button', { name: /Subagents/ }).click();
  // The row's status badge opens the target's own dispatch detail (the profile
  // name beside it opens the profile instead, which carries no restriction).
  const researchRow = capabilities
    .locator('div')
    .filter({ has: page.locator('button', { hasText: /^research/ }) })
    .last();
  await researchRow.waitFor();
  await researchRow.getByRole('button', { name: /允许|受阻/ }).click();
  await page.locator('[data-subagent-detail]').getByText('仅限研究 · 只读执行', { exact: true }).waitFor();
  await shot('02-live-capabilities-plan-zh');
  await page.keyboard.press('Escape');
  evidence.checks.push('delayed session binding preserves inherited model + local high; actual prompt payload; live Plan restrictions');

  await page.goto(`${webUrl}/new?agent=workspace-main&workspace=wd_fixture_alpha_00000000000a`);
  await ready();
  catalogError = true;
  await page.reload();
  await page.getByText(/catalog fixture offline/).waitFor();
  assert.equal(await page.locator('textarea[data-composer]').isEnabled(), true);
  assert.match(await page.locator('#composer-agent-profile-select').innerText(), /workspace-main/);
  await shot('03-catalog-error-preserved-zh');
  catalogError = false;
  await page.locator('[data-selection-diagnostic]').getByRole('button', { name: '重试', exact: true }).click();
  await ready();
  profileDeleted = true;
  await page.reload();
  await page.getByText(/配置档“workspace-main”在此目录不可用/).waitFor();
  assert.equal(await page.locator('textarea[data-composer]').isEnabled(), true);
  await shot('04-profile-deleted-preserved-zh');
  profileDeleted = false;
  modelDeleted = true;
  await page.reload();
  await page.getByText(/模型“fixture\/model-b”已不可用/).waitFor();
  await shot('05-model-deleted-preserved-zh');
  modelDeleted = false;
  await page.reload();
  await ready();
  await page.locator('[data-hero-workspace] > button').click();
  await page.locator('input[aria-label]').filter({ visible: true }).last().fill('C:/fixture/custom');
  await page.locator('[data-hero-workspace] > button').click();
  await ready();
  assert.ok(evidence.requests.some(({ path, query }) => path === '/api/agents' && query.cwd === 'C:/fixture/custom' && query.effective === 'true'));
  evidence.checks.push('catalog error and deleted profile/model preserve choices with visible diagnostics; cwd effective query');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-hero-workspace] > button').click();
  await page.locator('[data-agent-capabilities] > button').click();
  await page.locator('[data-capability-target="research"]').waitFor();
  await shot('06-draft-capabilities-narrow-zh');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  capabilityError = true;
  await page.reload();
  await ready();
  await page.locator('[data-hero-workspace] > button').click();
  await page.locator('[data-agent-capabilities] > button').click();
  await page.getByText(/capability fixture offline/).waitFor();
  capabilityError = false;
  await page.locator('[data-agent-capabilities]').getByRole('button', { name: '重试', exact: true }).click();
  await page.locator('[data-capability-target="research"]').waitFor();
  await page.locator('[data-hero-workspace] > button').click();
  evidence.checks.push('capability error/retry and Chinese narrow layout');

  await page.setViewportSize({ width: 1440, height: 1000 });
  const chooseAlternateManually = async () => {
    await pick('composer-agent-profile-select', 'alternate-main');
    await ready();
    await pick('composer-model-select', 'fixture/model-a');
    await page.locator('#composer-model-select').click();
    await page.locator('[data-effort="low"]').click();
    await page.keyboard.press('Escape');
  };
  const checkEditedReload = async (target, name) => {
    await remember(`${name}-before`);
    const saved = evidence.states.at(-1).storage.newDraft;
    const requestStart = evidence.requests.length;
    await page.reload();
    await ready();
    await remember(`${name}-after`);
    const restored = evidence.states.at(-1).storage.newDraft;
    assert.deepEqual(restored, saved);
    assert.equal(restored.profile, 'alternate-main');
    assert.equal(restored.modelOverride, 'fixture/model-a');
    assert.equal(restored.effortOverride, 'low');
    assert.equal(restored.modelFromProfile, false);
    assert.equal(restored.effortFromProfile, false);
    assert.match(await page.locator('#composer-agent-profile-select').innerText(), /alternate-main/);
    if (target.cwd !== undefined) {
      assert.equal(restored.cwd, target.cwd);
      assert.match(await page.locator('[data-hero-workspace] > button').innerText(), /custom/);
    } else {
      assert.equal(restored.workspaceId, target.workspace_id);
      assert.equal(restored.cwd, '');
      assert.match(await page.locator('[data-hero-workspace] > button').innerText(), /Beta/);
    }
    const catalogRequests = evidence.requests.slice(requestStart).filter(({ path }) => path === '/api/agents');
    assert.ok(catalogRequests.length > 0);
    for (const { query } of catalogRequests) assert.deepEqual(query, { ...target, effective: 'true' });
    await shot(name);
    const payloadStart = evidence.payloads.length;
    await page.locator('textarea[data-composer]').fill(`CONT04 ${name}`);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.waitForURL(/\/s\//);
    await ready();
    const creates = evidence.payloads.slice(payloadStart).filter(({ url }) => url === '/api/sessions');
    assert.equal(creates.length, 1);
    assert.equal(creates[0].body.agent_config.profile, 'alternate-main');
    assert.equal(creates[0].body.agent_config.model, 'fixture/model-a');
    assert.equal(creates[0].body.agent_config.thinking, 'low');
    if (target.cwd !== undefined) {
      assert.equal(creates[0].body.metadata.cwd, target.cwd);
      assert.equal(creates[0].body.workspace_id, undefined);
    } else assert.equal(creates[0].body.workspace_id, target.workspace_id);
  };
  // Still on the old Alpha/P deep link after editing custom cwd and reloading
  // for the capability retry above. That reload must not revert the directory.
  await remember('cont04-custom-after-capability-reload');
  assert.equal(evidence.states.at(-1).storage.newDraft.cwd, 'C:/fixture/custom');
  await chooseAlternateManually();
  await checkEditedReload({ cwd: 'C:/fixture/custom' }, '09-cont04-cwd-profile-reload');

  await page.goto(`${webUrl}/new?agent=workspace-main&workspace=wd_fixture_alpha_00000000000a`);
  await ready();
  await page.locator('[data-hero-workspace] > button').click();
  await pick('new-workspace-select', 'Beta');
  await page.locator('[data-hero-workspace] > button').click();
  await ready();
  await chooseAlternateManually();
  await checkEditedReload({ workspace_id: 'wd_fixture_beta_00000000000b' }, '10-cont04-workspace-profile-reload');

  await page.goto(`${webUrl}/new?agent=workspace-main&workspace=wd_fixture_alpha_00000000000a`);
  await ready();
  await page.locator('[data-hero-workspace] > button').click();
  await page.locator('input[aria-label]').filter({ visible: true }).last().fill('C:/fixture/custom');
  await page.locator('[data-hero-workspace] > button').click();
  await ready();
  await chooseAlternateManually();
  await remember('cont04-stale-draft-before-new-link');
  const oldSource = evidence.states.at(-1).storage.newDraft.prefillSource;
  await page.goto(`${webUrl}/new?workspace=wd_fixture_beta_00000000000b&agent=agent`);
  await ready();
  await remember('cont04-new-different-deep-link');
  const newLink = evidence.states.at(-1).storage.newDraft;
  assert.equal(newLink.workspaceId, 'wd_fixture_beta_00000000000b');
  assert.equal(newLink.cwd, '');
  assert.equal(newLink.profile, 'agent');
  assert.notEqual(newLink.prefillSource, oldSource);
  assert.equal(newLink.modelFromProfile, true);
  assert.equal(newLink.effortFromProfile, true);
  assert.equal(newLink.modelOverride, undefined);
  await shot('11-cont04-new-deep-link-applied');
  evidence.checks.push('CONT04: old deep-link cwd/workspace/profile edits and same-value manual sources survive reload; effective queries and create payloads keep edited targets; a new different deep link overrides the saved draft');

  await page.goto(`${webUrl}/s/${SID}`);
  await ready();
  recoveryError = true;
  await fetch(`${fixtureUrl}/__control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resync', session_id: SID }) });
  await page.locator('[data-resync-status]').getByText(/Saved transcript fixture unavailable/).waitFor();
  await shot('07-resync-error-manual-retry-zh');
  assert.equal(await page.getByText('历史记录保持不变。', { exact: true }).count(), 1);
  recoveryError = false;
  await page.locator('[data-resync-status]').getByRole('button', { name: '立即重试', exact: true }).click();
  await ready();
  assert.equal(await page.locator('[data-resync-status]').count(), 0);
  evidence.checks.push('resync error exposes message and manual retry; history preserved');
  const emit = async (ops, agent_id = 'main') => {
    const response = await fetch(`${fixtureUrl}/__control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'emit_transcript', session_id: SID, agent_id, ops }) });
    assert.equal(response.ok, true);
  };
  const question = { interactionId: 'question-history-fixture', interactionKind: 'question', origin: { agentId: 'main' }, state: 'pending', request: {
    questions: [{ id: 'choice', question: '是否继续这项验证？', options: [{ id: 'yes', label: '继续' }, { id: 'no', label: '停止' }] }], createdAt: '2026-09-06T00:00:00Z',
  } };
  await emit([{ op: 'interaction.upsert', interaction: question }, { op: 'marker.upsert', item: { kind: 'marker', markerId: 'swarm-history-fixture', marker: 'swarm.exit', at: '2026-09-06T00:00:00Z' } }]);
  await page.getByText('是否继续这项验证？', { exact: true }).waitFor();
  await emit([{ op: 'interaction.upsert', interaction: { ...question, state: 'dismissed', response: { dismissed_at: '2026-09-06T00:01:00Z' } } }]);
  const history = page.locator('[data-history-run]').first();
  if (await history.count() > 0) {
    const toggle = history.locator('button').first();
    await toggle.waitFor();
    if (await toggle.getAttribute('aria-expanded') !== 'false') throw new Error('dismissed interaction history must start collapsed');
    assert.equal(await page.getByText('是否继续这项验证？', { exact: true }).isVisible(), false);
    await toggle.click();
  }
  // The dismissed fact and the question text share one history row, and the
  // text span also carries the origin ("main · …"), so match the row's content
  // rather than an exact standalone string.
  const dismissedLine = page.locator('[data-history-line]', { hasText: '问题已忽略' }).first();
  await dismissedLine.waitFor();
  assert.match(await dismissedLine.innerText(), /是否继续这项验证？/);
  await shot('08-terminal-activity-history-zh');
  const modeChip = await page.locator('[data-run-mode-chip]').innerText();
  assert.match(modeChip, /计划/);
  assert.doesNotMatch(modeChip, /并行|集群/);
  evidence.checks.push('pending question exits activity on terminal status; dismissed fact and swarm marker remain in expandable history; a historical swarm mode is not shown as an active composer mode');
  const task = { taskId: 'task-history-fixture', kind: 'shell', state: 'running', detached: true, description: '任务状态转换验证', outputTail: '', startedAt: '2026-09-06T00:00:00Z' };
  await emit([{ op: 'task.upsert', task }]);
  // Background tasks live in the inspector, which starts collapsed.
  await openRail();
  await page.locator('[data-tasks-scroll]').getByText('任务状态转换验证', { exact: true }).waitFor();
  // A completed task leaves the running rail (which lists running work only)
  // while its terminal outcome stays in the transcript's own activity history.
  // The task-detail modal reads a polled REST tail that `emit_transcript` does
  // not seed, so the transcript is the surface that carries this fact.
  await emit([{ op: 'task.upsert', task: { ...task, state: 'completed', endedAt: '2026-09-06T00:02:00Z', outputTail: 'fixture completed output' } }]);
  await page.waitForFunction(() => {
    const rail = document.querySelector('[data-tasks-scroll]');
    return rail === null || !rail.textContent.includes('任务状态转换验证');
  });
  // The inspector keeps reporting the session rather than emptying out.
  await page.locator('[data-session-rail]').waitFor();
  evidence.checks.push('a completed background task leaves the running-tasks rail without disturbing the rest of the inspector');
  await page.goto(`${webUrl}/s/${SID}/agent/child-fixture`);
  await openRailSetup();
  assert.ok(evidence.requests.some(({ path, query }) => path === '/api/agents/capabilities' && query.session_id === SID && query.agent_id === 'child-fixture'));
  evidence.checks.push('child agent page queries actual selected child id, not main');
  assert.ok(evidence.requests.some(({ path, query }) => path === '/api/agents/capabilities' && query.session_id === SID && query.agent_id === 'main'));
  assert.ok(evidence.requests.some(({ path, query }) => path === '/api/agents' && query.cwd === 'C:/fixture/alpha' && query.effective === 'true'));
  assert.deepEqual(errors, []);
  evidence.checks.push('actual live session/agent and effective session cwd query identities');
  console.log(JSON.stringify({ output, checks: evidence.checks }, null, 2));
} catch (error) {
  await shot('failure').catch(() => {});
  evidence.failure = String(error.stack ?? error);
  throw error;
} finally {
  evidence.pageErrors = errors;
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await browser.close();
  await vite.close();
  await fixture.stop();
}
