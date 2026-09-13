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
const baseHandle = fixture.handleHttp.bind(fixture);
fixture.handleHttp = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  const url = new URL(req.url, fixtureUrl);
  if (req.method === 'GET') {
    evidence.requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    if (url.pathname === '/api/agents') {
      if (catalogError) return fixture.envelope(res, null, 50301, 'catalog fixture offline');
      const items = profiles.filter((profile) => !profileDeleted || profile.name !== 'workspace-main');
      return fixture.envelope(res, { items });
    }
    if (url.pathname === '/api/agents/capabilities') {
      if (capabilityError) return fixture.envelope(res, null, 50301, 'capability fixture offline');
      const live = url.searchParams.has('session_id');
      return fixture.envelope(res, {
        context: live ? 'live' : 'draft', available: true,
        owner: { profile: 'workspace-main', agent_id: live ? url.searchParams.get('agent_id') : undefined },
        targets: capabilityTargets.map((target, i) => live ? {
          ...target, launch_allowed: i === 0, launch_unavailable_reason: i === 0 ? undefined : 'Plan mode blocks implementation dispatch',
          execution_restriction: i === 0 ? 'research-readonly' : undefined,
        } : target),
      });
    }
    if (url.pathname === '/api/models' && modelDeleted) {
      return fixture.envelope(res, { items: fixture.models.filter((model) => model.model !== 'fixture/model-b') });
    }
    if (url.pathname.includes(`/sessions/${SID}`) && (url.pathname.endsWith('/snapshot') || url.pathname.endsWith('/transcript') || url.pathname.endsWith(`/${SID}`))) {
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
});
const shot = (name) => page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
const ready = async () => {
  await page.locator('textarea[data-composer]').waitFor();
  await page.waitForFunction(() => {
    const input = document.querySelector('textarea[data-composer]');
    return input !== null && !input.disabled && !document.querySelector('[data-selection-diagnostic]');
  });
};
const pick = async (id, value) => {
  await page.locator(`#${id}`).click();
  if (value.startsWith('fixture/')) await page.locator(`#${id}-list [role="option"][title="${value}"]`).click();
  else await page.locator(`#${id}-list [role="option"]`).filter({ hasText: value }).first().click();
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
  await page.getByRole('button', { name: '连续性验证会话', exact: true }).last().click();
  await ready();
  await page.goBack();
  await ready();
  await page.reload();
  await ready();
  await remember('new-back-reload');
  assert.equal(evidence.states.at(-1).storage.newDraft.workspaceId, 'wd_fixture_alpha');
  assert.equal(evidence.states.at(-1).storage.newDraft.modelOverride, 'fixture/model-b');
  assert.equal(evidence.states.at(-1).storage.newDraft.effortOverride, 'high');
  assert.equal(evidence.states.at(-1).storage.newDraft.modelFromProfile, true);
  await page.locator('[data-agent-capabilities] > button').click();
  await page.locator('[data-capability-target="research"]').waitFor();
  assert.equal(await page.locator('[data-capability-context="draft"]').count(), 1);
  assert.equal(await page.getByText('当前允许启动', { exact: true }).count(), 0);
  await shot('01-new-reload-draft-capabilities-zh');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForURL(/\/s\//);
  await ready();
  assert.ok(evidence.payloads.some(({ url, body }) => url === '/api/sessions' && body.agent_config?.profile === 'workspace-main' && body.agent_config?.model === 'fixture/model-b' && body.agent_config?.thinking === 'high'));
  evidence.checks.push('new -> existing -> back -> reload preserves workspace/profile/model/effort and sends create payload');

  await page.goto(`${webUrl}/s/${SID}`);
  await ready();
  await pick('composer-model-select', 'fixture/model-b');
  await page.locator('#composer-model-select').click();
  await page.locator('[data-effort="high"]').click();
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
  await page.locator('[data-session-rail] [data-agent-capabilities] > button').click();
  await page.locator('[data-capability-target="research"]').waitFor();
  await page.getByText('仅限研究 · 只读执行', { exact: true }).waitFor();
  await shot('02-live-capabilities-plan-zh');
  evidence.checks.push('delayed session binding preserves inherited model + local high; actual prompt payload; live Plan restrictions');

  await page.goto(`${webUrl}/new?agent=workspace-main&workspace=wd_fixture_alpha`);
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
  await page.locator('[data-agent-capabilities] > button').click();
  await page.locator('[data-capability-target="research"]').waitFor();
  await shot('06-draft-capabilities-narrow-zh');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  capabilityError = true;
  await page.reload();
  await ready();
  await page.locator('[data-agent-capabilities] > button').click();
  await page.getByText(/capability fixture offline/).waitFor();
  capabilityError = false;
  await page.locator('[data-agent-capabilities]').getByRole('button', { name: '重试', exact: true }).click();
  await page.locator('[data-capability-target="research"]').waitFor();
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

  await page.goto(`${webUrl}/new?agent=workspace-main&workspace=wd_fixture_alpha`);
  await ready();
  await page.locator('[data-hero-workspace] > button').click();
  await pick('new-workspace-select', 'Beta');
  await page.locator('[data-hero-workspace] > button').click();
  await ready();
  await chooseAlternateManually();
  await checkEditedReload({ workspace_id: 'wd_fixture_beta' }, '10-cont04-workspace-profile-reload');

  await page.goto(`${webUrl}/new?agent=workspace-main&workspace=wd_fixture_alpha`);
  await ready();
  await page.locator('[data-hero-workspace] > button').click();
  await page.locator('input[aria-label]').filter({ visible: true }).last().fill('C:/fixture/custom');
  await page.locator('[data-hero-workspace] > button').click();
  await ready();
  await chooseAlternateManually();
  await remember('cont04-stale-draft-before-new-link');
  const oldSource = evidence.states.at(-1).storage.newDraft.prefillSource;
  await page.goto(`${webUrl}/new?workspace=wd_fixture_beta&agent=agent`);
  await ready();
  await remember('cont04-new-different-deep-link');
  const newLink = evidence.states.at(-1).storage.newDraft;
  assert.equal(newLink.workspaceId, 'wd_fixture_beta');
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
  await page.locator('[data-history-line]', { hasText: '问题已忽略' }).first().waitFor();
  await page.getByText('是否继续这项验证？', { exact: true }).waitFor();
  await shot('08-terminal-activity-history-zh');
  assert.match(await page.locator('[data-plan-select] > button').innerText(), /集群/);
  evidence.checks.push('pending question exits activity on terminal status; dismissed fact and swarm marker remain in expandable history; swarm mode stays selectable');
  const task = { taskId: 'task-history-fixture', kind: 'shell', state: 'running', detached: true, description: '任务状态转换验证', outputTail: '', startedAt: '2026-09-06T00:00:00Z' };
  await emit([{ op: 'task.upsert', task }]);
  await page.locator('[data-tasks-scroll]').getByText('任务状态转换验证', { exact: true }).waitFor();
  await emit([{ op: 'task.upsert', task: { ...task, state: 'completed', endedAt: '2026-09-06T00:02:00Z', outputTail: 'fixture completed output' } }]);
  await page.waitForFunction(() => document.querySelector('[data-task-history]')?.textContent.includes('fixture completed output'));
  assert.equal(await page.locator('[data-task-history]').getAttribute('open'), null);
  assert.equal(await page.getByText('任务状态转换验证', { exact: true }).isVisible(), false);
  await page.locator('[data-task-history] > summary').click();
  await page.getByText('fixture completed output', { exact: true }).waitFor();
  evidence.checks.push('completed tasks leave the active rail but their output remains available in task history');
  await page.goto(`${webUrl}/s/${SID}/agent/child-fixture`);
  await page.locator('[data-session-rail] [data-agent-capabilities] > button').click();
  await page.locator('[data-capability-target="research"]').waitFor();
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
