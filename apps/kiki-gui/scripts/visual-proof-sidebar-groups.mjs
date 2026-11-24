import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server.mjs';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const GUI_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(GUI_ROOT, '..', '..');
const DIST_DIR = join(GUI_ROOT, 'dist');
const OUT_DIR = join(REPO_ROOT, '.tmp', 'sidebar-groups-proof');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function startStaticServer(rootDir) {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer((req, res) => {
      const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
      const clean = normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
      let filePath = join(rootDir, clean === '/' || clean === '\\' ? 'index.html' : clean);
      if (!filePath.startsWith(rootDir + sep) && filePath !== rootDir) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        filePath = join(rootDir, 'index.html');
      }
      const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      createReadStream(filePath).pipe(res);
    });
    server.on('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolveServer({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function createSidebarDataset() {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const iso = (ms) => new Date(ms).toISOString();

  const row = (id, title, updatedMs, extra = {}) => {
    const { createdMs, ...rest } = extra;
    return {
      id,
      workspace_id: rest.workspace_id ?? 'wd_easyagent_000000000001',
      cwd: rest.cwd ?? 'E:/EasyAgent',
      title,
      created_at: iso(createdMs ?? updatedMs - 600_000),
      updated_at: iso(updatedMs),
      own_updated_at: iso(updatedMs),
      archived: false,
      private: false,
      pinned: rest.pinned ?? false,
      busy: rest.busy ?? false,
      executing: rest.executing ?? false,
      last_seq: rest.last_seq ?? 3,
      cleanup_pending: false,
      ...rest,
    };
  };

  const pinnedOldGroup = {
    kind: 'group',
    id: 'grp_pinned_release',
    opener_id: 's_pin_open',
    title: 'Q4 架构基线与发版清单',
    primary_workspace_id: 'wd_kiki_000000000002',
    sort_at: Math.floor(now - 40 * DAY),
    has_pinned: true,
    member_count: 3,
    members: [
      row('s_pin_child', '核心回归项核验（已置顶）', now - 40 * DAY, {
        group_id: 'grp_pinned_release',
        workspace_id: 'wd_kiki_000000000002',
        cwd: 'E:/kiki',
        pinned: true,
        created_by_session_id: 's_pin_open',
      }),
      row('s_pin_open', 'Q4 架构基线与发版清单', now - 70 * DAY, {
        group_id: 'grp_pinned_release',
        workspace_id: 'wd_kiki_000000000002',
        cwd: 'E:/kiki',
      }),
      row('s_pin_notes', '回滚预案与监控告警阈值', now - 75 * DAY, {
        group_id: 'grp_pinned_release',
        workspace_id: 'wd_kiki_000000000002',
        cwd: 'E:/kiki',
        created_by_session_id: 's_pin_open',
      }),
    ],
  };

  const releaseAuditGroup = {
    kind: 'group',
    id: 'grp_release_audit',
    opener_id: 's_audit_open',
    title: '侧栏自动会话组与无限滚动审查',
    primary_workspace_id: 'wd_easyagent_000000000001',
    sort_at: Math.floor(now - 2 * 60_000),
    has_pinned: false,
    member_count: 3,
    members: [
      row('s_audit_open', '侧栏自动会话组与无限滚动审查', now - 2 * 60_000, {
        group_id: 'grp_release_audit',
        busy: false,
      }),
      row('s_audit_api', '协议契约与游标分页校验', now - 18 * 60_000, {
        group_id: 'grp_release_audit',
        created_by_session_id: 's_audit_open',
      }),
      row('s_90d_child', '90 天前历史子线程：初版分组设计', now - 90 * DAY, {
        group_id: 'grp_release_audit',
        createdMs: now - 90 * DAY,
        created_by_session_id: 's_audit_open',
      }),
    ],
  };

  const megaMembersAll = Array.from({ length: 54 }, (_, idx) => {
    const num = idx + 1;
    const ts = now - (10 + idx * 4) * 60_000;
    return row(`s_mega_${num}`, num === 1 ? '大规模压测任务簇（54 条成员）' : `压测切片 #${num} · 吞吐与延迟采样`, ts, {
      group_id: 'grp_mega_54',
      workspace_id: 'wd_kiki_000000000002',
      cwd: 'E:/kiki',
      pinned: num === 2,
      ...(num > 1 ? { created_by_session_id: 's_mega_1' } : {}),
    });
  });

  const megaGroup = {
    kind: 'group',
    id: 'grp_mega_54',
    opener_id: 's_mega_1',
    title: '大规模压测任务簇（54 条成员）',
    primary_workspace_id: 'wd_kiki_000000000002',
    sort_at: Math.floor(now - 10 * 60_000),
    has_pinned: false,
    member_count: 54,
    members: megaMembersAll.slice(0, 50),
    members_next_cursor: 'mcur_50',
  };

  const p2PromoGroup = {
    kind: 'group',
    id: 'grp_p2_promo',
    opener_id: 's_p2_open',
    title: '跨主机 GPU 集群故障切换演练',
    primary_workspace_id: 'wd_research_000000000003',
    sort_at: Math.floor(now - 26 * 3600_000),
    has_pinned: false,
    member_count: 2,
    members: [
      row('s_p2_open', '跨主机 GPU 集群故障切换演练', now - 26 * 3600_000, {
        group_id: 'grp_p2_promo',
        workspace_id: 'wd_research_000000000003',
        cwd: 'E:/research',
      }),
      row('s_p2_child', '节点心跳超时与重连验证', now - 27 * 3600_000, {
        group_id: 'grp_p2_promo',
        workspace_id: 'wd_research_000000000003',
        cwd: 'E:/research',
        created_by_session_id: 's_p2_open',
      }),
    ],
  };

  const units = [];
  units.push({
    kind: 'session',
    id: 's_lead_today',
    sort_at: now - 30_000,
    row: row('s_lead_today', 'UI 细节打磨与视觉回归验收', now - 30_000),
  });
  units.push(releaseAuditGroup);
  units.push(megaGroup);
  units.push({
    kind: 'session',
    id: 's_running_ws',
    sort_at: now - 15 * 60_000,
    row: row('s_running_ws', '夜间 CI 基准与内存画像', now - 15 * 60_000, {
      busy: true,
      executing: true,
      main_turn_active: true,
      workspace_id: 'wd_kiki_000000000002',
      cwd: 'E:/kiki',
    }),
  });

  // Fill remaining 1,996 units so total = 2,000 units across 40 pages of 50.
  for (let i = 0; i < 1996; i += 1) {
    if (i === 52) {
      units.push(p2PromoGroup);
      continue;
    }
    const id = `s_bulk_${String(i + 1).padStart(4, '0')}`;
    const ageMs = i < 12
      ? (25 + i * 20) * 60_000
      : i < 40
        ? (18 + i) * 3600_000
        : i < 120
          ? (3 + Math.floor(i / 20)) * DAY
          : (15 + Math.floor(i / 15)) * DAY;
    const ts = now - ageMs;
    const wsId = i % 3 === 0 ? 'wd_easyagent_000000000001' : i % 3 === 1 ? 'wd_kiki_000000000002' : 'wd_research_000000000003';
    units.push({
      kind: 'session',
      id,
      sort_at: ts,
      row: row(id, `历史工程记录 #${i + 1} · 性能与稳定性排查`, ts, {
        workspace_id: wsId,
        cwd: wsId === 'wd_easyagent_000000000001' ? 'E:/EasyAgent' : wsId === 'wd_kiki_000000000002' ? 'E:/kiki' : 'E:/research',
      }),
    });
  }

  let revision = 100;
  let promoted = false;
  const detachCalls = [];
  const archiveCalls = [];
  const pageRequests = [];

  const getActiveUnits = () => {
    if (!promoted) return units;
    const promoAt = Math.floor(Date.now());
    const updatedPromo = {
      ...p2PromoGroup,
      sort_at: promoAt,
      members: [
        { ...p2PromoGroup.members[1], updated_at: iso(promoAt), own_updated_at: iso(promoAt), last_seq: 9 },
        p2PromoGroup.members[0],
      ],
    };
    return [updatedPromo, ...units.filter((u) => u.id !== 'grp_p2_promo')];
  };

  return {
    workspaces: [
      { id: 'wd_easyagent_000000000001', name: 'EasyAgent', root: 'E:/EasyAgent', created_at: iso(now - 90 * DAY), last_opened_at: iso(now), pinned: true },
      { id: 'wd_kiki_000000000002', name: 'Kiki Core', root: 'E:/kiki', created_at: iso(now - 90 * DAY), last_opened_at: iso(now - 3600_000), pinned: false },
      { id: 'wd_research_000000000003', name: 'Research', root: 'E:/research', created_at: iso(now - 90 * DAY), last_opened_at: iso(now - 7200_000), pinned: false },
    ],
    pinnedOldGroup,
    megaMembersTail: megaMembersAll.slice(50),
    detachCalls,
    archiveCalls,
    pageRequests,
    promoteP2Group() {
      promoted = true;
      revision += 1;
      const promoAt = Math.floor(Date.now());
      return {
        revision,
        generation: 1,
        units: [{
          ...p2PromoGroup,
          sort_at: promoAt,
          members: [
            { ...p2PromoGroup.members[1], updated_at: iso(promoAt), own_updated_at: iso(promoAt), last_seq: 9 },
            p2PromoGroup.members[0],
          ],
        }],
        missing_session_ids: [],
        missing_group_ids: [],
      };
    },
    listPage(url) {
      const pinned = url.searchParams.get('pinned') === 'true';
      const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('page_size') ?? 50) || 50));
      const cursor = url.searchParams.get('cursor');
      pageRequests.push({ pinned, cursor, pageSize });
      if (pinned) {
        return { revision, generation: 1, units: [pinnedOldGroup], has_more: false };
      }
      const all = getActiveUnits();
      const offset = cursor && cursor.startsWith('p_') ? Number(cursor.slice(2)) || 0 : 0;
      const slice = all.slice(offset, offset + pageSize);
      const nextOffset = offset + slice.length;
      const hasMore = nextOffset < all.length;
      return {
        revision,
        generation: 1,
        units: slice,
        has_more: hasMore,
        ...(hasMore ? { next_cursor: `p_${nextOffset}` } : {}),
      };
    },
    resolveUnits(body) {
      revision += 1;
      const requestedSessions = new Set(body?.session_ids ?? []);
      const requestedGroups = new Set(body?.group_ids ?? []);
      const out = [];
      if (requestedSessions.has('s_p2_child') || requestedGroups.has('grp_p2_promo')) {
        return this.promoteP2Group();
      }
      if (requestedSessions.has('s_audit_api')) {
        out.push({
          kind: 'session',
          id: 's_audit_api',
          sort_at: now - 60_000,
          row: row('s_audit_api', '协议契约与游标分页校验', now - 60_000, { group_detached: true }),
        });
        out.push({
          ...releaseAuditGroup,
          member_count: 2,
          members: releaseAuditGroup.members.filter((m) => m.id !== 's_audit_api'),
        });
      }
      return {
        revision,
        generation: 1,
        units: out,
        missing_session_ids: [],
        missing_group_ids: [],
      };
    },
    groupMembers(groupId) {
      revision += 1;
      if (groupId === 'grp_mega_54') {
        return {
          revision,
          generation: 1,
          group_id: groupId,
          member_count: 54,
          members: megaMembersAll.slice(50),
          has_more: false,
        };
      }
      return { revision, generation: 1, group_id: groupId, member_count: 0, members: [], has_more: false };
    },
  };
}

function readJsonBody(req) {
  return new Promise((resolveBody) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolveBody({});
      }
    });
  });
}

function writeEnvelope(res, data) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-request-id, x-kiki-client-id',
    'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  });
  res.end(JSON.stringify({ code: 0, msg: 'ok', data }));
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  if (!existsSync(join(DIST_DIR, 'index.html'))) {
    throw new Error(`Missing GUI build at ${DIST_DIR}. Run pnpm --filter @kiki/gui build first.`);
  }

  const staticSrv = await startStaticServer(DIST_DIR);
  const fixture = await startFixtureServer({ port: 0, scenario: 'basic-stream' });
  const dataset = createSidebarDataset();

  const seenUrls = [];
  const origHandleHttp = fixture.handleHttp.bind(fixture);
  fixture.handleHttp = async (req, res) => {
    const url = new URL(req.url ?? '/', fixture.origin);
    seenUrls.push(`${req.method} ${url.pathname}`);
    if (req.method === 'OPTIONS') {
      const requested = req.headers['access-control-request-headers'] ?? 'authorization, content-type, x-request-id';
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': requested,
        'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      });
      res.end();
      return;
    }
    if (url.pathname === '/api/meta' && req.method === 'GET') {
      writeEnvelope(res, {
        server_version: '0.6.0-proof',
        server_id: 'proof-server',
        server_home_id: 'home_proof_main',
        current_space_id: 'main',
        started_at: new Date().toISOString(),
        capabilities: {
          websocket: true,
          file_upload: true,
          fs_query: true,
          mcp: true,
          tasks: true,
          terminal: true,
          thread_communication: true,
          transcript: true,
          sidebar_groups: true,
        },
        open_in_apps: [],
      });
      return;
    }
    if (url.pathname === '/api/workspaces' && req.method === 'GET') {
      writeEnvelope(res, { items: dataset.workspaces });
      return;
    }
    if (url.pathname === '/api/sidebar/sessions' && req.method === 'GET') {
      writeEnvelope(res, dataset.listPage(url));
      return;
    }
    if (url.pathname === '/api/sidebar/units:resolve' && req.method === 'POST') {
      const body = await readJsonBody(req);
      writeEnvelope(res, dataset.resolveUnits(body));
      return;
    }
    const membersMatch = /^\/api\/sidebar\/groups\/([^/]+)\/members$/.exec(url.pathname);
    if (membersMatch && req.method === 'GET') {
      writeEnvelope(res, dataset.groupMembers(decodeURIComponent(membersMatch[1])));
      return;
    }
    const detachMatch = /^\/api\/sessions\/([^/:]+):detach-group$/.exec(url.pathname);
    if (detachMatch && req.method === 'POST') {
      const sessionId = decodeURIComponent(detachMatch[1]);
      dataset.detachCalls.push(sessionId);
      writeEnvelope(res, { detached: true, session_id: sessionId, previous_group_id: 'grp_release_audit' });
      return;
    }
    const archiveMatch = /^\/api\/sessions\/([^/:]+):archive$/.exec(url.pathname);
    if (archiveMatch && req.method === 'POST') {
      const sessionId = decodeURIComponent(archiveMatch[1]);
      const body = await readJsonBody(req);
      dataset.archiveCalls.push({ sessionId, body });
      writeEnvelope(res, { archived: true, outcomes: [{ id: sessionId, ok: true }] });
      return;
    }
    return origHandleHttp(req, res);
  };

  const browser = await chromium.launch({ headless: true });
  const metrics = {
    shots: [],
    errors: [],
  };

  const openConfiguredPage = async ({ width, height, locale, theme, groupBy = 'time' }) => {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      colorScheme: theme,
      locale: locale === 'zh' ? 'zh-CN' : 'en-US',
    });
    await context.addInitScript(({ loc, th, gb }) => {
      localStorage.setItem('kiki.locale', loc);
      localStorage.setItem('kiki.theme', th);
      localStorage.setItem('kiki.layout', JSON.stringify({
        groupBy: gb,
        sortBy: 'updated-desc',
        sidebarMode: 'sessions',
      }));
      localStorage.removeItem('kiki.sidebar.workspaceGroups');
    }, { loc: locale, th: theme, gb: groupBy });

    const page = await context.newPage();
    page.on('pageerror', (err) => metrics.errors.push(`pageerror(${locale}/${theme}/${width}): ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('404')) metrics.errors.push(`console.error(${locale}/${theme}/${width}): ${text}`);
      }
    });
    const appUrl = `${staticSrv.url}/new?server=${encodeURIComponent(fixture.origin)}&token=${FIXTURE_TOKEN}`;
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForSelector('[data-sidebar-unit-group="grp_release_audit"]', { timeout: 10_000 });
    } catch (err) {
      const htmlSnippet = await page.evaluate(() => document.body.innerText.slice(0, 600));
      console.error('DEBUG seenUrls:', seenUrls.slice(0, 30));
      console.error('DEBUG errors:', metrics.errors);
      console.error('DEBUG body text:', htmlSnippet);
      throw err;
    }
    await page.waitForTimeout(350);
    return { context, page };
  };

  const saveShot = async (page, filename, clip = undefined) => {
    const fullPath = join(OUT_DIR, filename);
    await page.screenshot({ path: fullPath, clip });
    metrics.shots.push(filename);
  };

  try {
    // 1. Desktop 1440x900 Light ZH: collapsed -> expanded (90d child + 54-member load-more) -> scroll & promotion -> WS churn -> detach & single archive
    {
      const { context, page } = await openConfiguredPage({ width: 1440, height: 900, locale: 'zh', theme: 'light' });
      const initialStats = await page.evaluate(() => {
        const list = document.querySelector('[data-session-list]');
        const rows = document.querySelectorAll('[data-session-row], [data-sidebar-unit-group]');
        const relationNotes = document.querySelectorAll('[data-session-relation-note]');
        const overflow = list ? Math.max(0, list.scrollWidth - list.clientWidth) : -1;
        return {
          mountedRows: rows.length,
          fromParentSubtitles: relationNotes.length,
          horizontalOverflowPx: overflow,
          pinnedGroupVisible: document.querySelector('[data-session-group-key="pinned"] [data-sidebar-unit-group="grp_pinned_release"]') !== null,
        };
      });
      metrics.desktopLightZhInitial = initialStats;
      await saveShot(page, 'desktop-1440-light-zh-collapsed.png');

      // Expand grp_pinned_release (pinned member inside group) & grp_release_audit (reveals 90-day-old child)
      await page.click('[data-sidebar-unit-group-toggle="grp_pinned_release"]');
      await page.click('[data-sidebar-unit-group-toggle="grp_release_audit"]');
      await page.waitForSelector('[data-session-row="s_90d_child"]', { timeout: 5_000 });
      await page.mouse.move(720, 420);
      await page.waitForTimeout(220);

      await saveShot(page, 'desktop-1440-light-zh-expanded.png');
      const sidebarBox = await page.locator('#app-sidebar').boundingBox();
      if (sidebarBox) {
        await saveShot(page, 'sidebar-crop-light-zh.png', {
          x: Math.max(0, sidebarBox.x),
          y: Math.max(0, sidebarBox.y),
          width: Math.min(340, sidebarBox.width),
          height: Math.min(900, sidebarBox.height),
        });
      }

      // Expand grp_mega_54 (>50 members), scroll to "加载更多成员", capture 1:1 crop, then click it
      await page.click('[data-sidebar-unit-group-toggle="grp_mega_54"]');
      await page.waitForTimeout(220);
      const foundMoreBtn = await page.evaluate(async () => {
        const list = document.querySelector('[data-session-list]');
        if (!list) return false;
        for (let y = 0; y <= 2600; y += 220) {
          list.scrollTop = y;
          await new Promise((r) => setTimeout(r, 40));
          const btn = document.querySelector('[data-sidebar-unit-group-more="grp_mega_54"]');
          if (btn) {
            btn.scrollIntoView({ block: 'center' });
            await new Promise((r) => setTimeout(r, 80));
            return true;
          }
        }
        return false;
      });
      if (foundMoreBtn && sidebarBox) {
        await page.mouse.move(720, 420);
        await page.waitForTimeout(120);
        await saveShot(page, 'sidebar-crop-mega-load-more.png', {
          x: Math.max(0, sidebarBox.x),
          y: Math.max(0, sidebarBox.y),
          width: Math.min(340, sidebarBox.width),
          height: Math.min(900, sidebarBox.height),
        });
        await page.click('[data-sidebar-unit-group-more="grp_mega_54"]');
      }
      await page.waitForTimeout(350);
      metrics.megaGroupLoadMoreTriggered = foundMoreBtn;
      metrics.megaGroupTailRendered = await page.evaluate(async () => {
        const list = document.querySelector('[data-session-list]');
        if (!list) return false;
        list.scrollTop = 1950;
        await new Promise((r) => setTimeout(r, 80));
        return document.querySelector('[data-session-row="s_mega_54"]') !== null
          || document.querySelector('[data-sidebar-unit-group-more="grp_mega_54"]') === null;
      });

      // Collapse mega group back and scroll to top to test infinite scroll + zero remount + live promotion anchor preservation
      await page.evaluate(async () => {
        const list = document.querySelector('[data-session-list]');
        if (list) list.scrollTop = 0;
      });
      await page.waitForTimeout(150);
      await page.click('[data-sidebar-unit-group-toggle="grp_mega_54"]');
      await page.waitForTimeout(150);

      // Mark virtual container DOM node identity to prove ZERO remount across page-2 append
      await page.evaluate(() => {
        const container = document.querySelector('[data-session-list-virtualized="true"]');
        window.__kikiVirtualContainerRef = container;
      });

      // Scroll downward incrementally to trigger page 2 & page 3 infinite demand
      const pagesBeforeScroll = dataset.pageRequests.filter((r) => !r.pinned).length;
      const scrollTelemetry = await page.evaluate(async () => {
        const list = document.querySelector('[data-session-list]');
        let maxJump = 0;
        let prevTop = list.scrollTop;
        for (let step = 0; step < 18; step += 1) {
          const target = prevTop + 260;
          list.scrollTop = target;
          await new Promise((r) => setTimeout(r, 70));
          const after = list.scrollTop;
          const jump = Math.abs(after - target);
          if (jump > maxJump) maxJump = jump;
          prevTop = after;
        }
        const sameContainer = document.querySelector('[data-session-list-virtualized="true"]') === window.__kikiVirtualContainerRef;
        const mountedRows = document.querySelectorAll('[data-session-row], [data-sidebar-unit-group]').length;
        return { sameContainer, mountedRows, scrollTop: list.scrollTop, maxJump };
      });
      await page.waitForTimeout(350);
      const pagesAfterScroll = dataset.pageRequests.filter((r) => !r.pinned).length;
      metrics.infiniteScroll = {
        pagesBeforeScroll,
        pagesAfterScroll,
        ...scrollTelemetry,
      };

      // Capture visible anchor row before live WS promotion of grp_p2_promo
      const anchorBefore = await page.evaluate(() => {
        const list = document.querySelector('[data-session-list]');
        const listRect = list.getBoundingClientRect();
        const rows = [...list.querySelectorAll('[data-session-row]')];
        for (const el of rows) {
          const r = el.getBoundingClientRect();
          if (r.top >= listRect.top + 8 && r.bottom <= listRect.bottom - 8) {
            return { id: el.getAttribute('data-session-row'), relTop: Math.round(r.top - listRect.top) };
          }
        }
        return null;
      });

      // Trigger live WS session.meta.updated promoting grp_p2_promo to head!
      dataset.promoteP2Group();
      fixture.klient.emitGlobal('session.meta.updated', {
        agentId: 'main',
        sessionId: 's_p2_child',
        patch: { title: '节点心跳超时与重连验证' },
      });
      await page.waitForTimeout(450);

      const anchorAfter = await page.evaluate((anchorId) => {
        const list = document.querySelector('[data-session-list]');
        const listRect = list.getBoundingClientRect();
        const el = anchorId ? list.querySelector(`[data-session-row="${anchorId}"]`) : null;
        const r = el?.getBoundingClientRect();
        return {
          found: el !== null,
          relTop: r ? Math.round(r.top - listRect.top) : null,
          promoCountInDom: document.querySelectorAll('[data-sidebar-unit-group="grp_p2_promo"]').length,
        };
      }, anchorBefore?.id ?? null);

      metrics.livePromotion = {
        anchorBefore,
        anchorAfter,
        anchorDriftPx: (anchorBefore && anchorAfter.relTop !== null)
          ? Math.abs(anchorAfter.relTop - anchorBefore.relTop)
          : null,
      };
      await saveShot(page, 'desktop-1440-light-zh-scrolled-promoted.png');

      // Scroll back to top and verify grp_p2_promo appears ONCE at head
      await page.evaluate(() => {
        const list = document.querySelector('[data-session-list]');
        if (list) list.scrollTop = 0;
      });
      await page.waitForTimeout(200);
      metrics.livePromotion.promoVisibleAtTopOnce = await page.evaluate(() =>
        document.querySelectorAll('[data-sidebar-unit-group="grp_p2_promo"]').length,
      );

      // WS churn burst: 50 rapid event.session.work_changed frames; measure frame commit latency & DOM stability
      await page.evaluate(() => {
        window.__kikiFrames = [];
        window.__kikiStopPerf = false;
        let last = performance.now();
        const tick = (now) => {
          window.__kikiFrames.push(now - last);
          last = now;
          if (!window.__kikiStopPerf) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      for (let i = 0; i < 50; i += 1) {
        fixture.klient.emitGlobal('event.session.work_changed', {
          sessionId: 's_running_ws',
          busy: true,
          executing: i % 2 === 0,
          main_turn_active: true,
          pending_interaction: 'none',
          attention_cursor: { epoch: 'proof', seq: 10 + i },
        });
        if (i % 5 === 0) await page.waitForTimeout(12);
      }
      await page.waitForTimeout(250);
      const wsChurnStats = await page.evaluate(() => {
        window.__kikiStopPerf = true;
        const frames = (window.__kikiFrames || []).slice(1).sort((a, b) => a - b);
        const p95 = frames.length > 0 ? frames[Math.floor(frames.length * 0.95)] : 0;
        const max = frames.length > 0 ? frames[frames.length - 1] : 0;
        const median = frames.length > 0 ? frames[Math.floor(frames.length * 0.5)] : 0;
        return {
          framesSampled: frames.length,
          medianFrameMs: Number(median.toFixed(2)),
          p95FrameMs: Number(p95.toFixed(2)),
          maxFrameMs: Number(max.toFixed(2)),
          mountedRowsDuringChurn: document.querySelectorAll('[data-session-row], [data-sidebar-unit-group]').length,
        };
      });
      metrics.wsChurn50Frames = wsChurnStats;

      // Verify context menu detach-group & single-member archive (include_attached: false)
      await page.locator('[data-session-row="s_audit_api"]').click({ button: 'right' });
      await page.waitForSelector('[data-menu-item="detach-group"]', { timeout: 5_000 });
      const hasLegacyThreadDisplay = (await page.locator('[data-menu-item="thread-display"]').count()) > 0;
      await page.click('[data-menu-item="detach-group"]');
      await page.waitForTimeout(300);

      await page.locator('[data-session-row="s_90d_child"]').click({ button: 'right' });
      await page.waitForSelector('[data-menu-item="archive"]', { timeout: 5_000 });
      await page.click('[data-menu-item="archive"]');
      await page.waitForTimeout(300);

      metrics.mutations = {
        hasLegacyThreadDisplay,
        detachCalls: [...dataset.detachCalls],
        archiveCalls: [...dataset.archiveCalls],
      };

      await context.close();
    }

    // 2. Desktop 1440x900 Dark ZH (expanded groups + pinned member + 1:1 sidebar crop)
    {
      const { context, page } = await openConfiguredPage({ width: 1440, height: 900, locale: 'zh', theme: 'dark' });
      await page.click('[data-sidebar-unit-group-toggle="grp_pinned_release"]');
      await page.click('[data-sidebar-unit-group-toggle="grp_release_audit"]');
      await page.waitForSelector('[data-session-row="s_90d_child"]', { timeout: 5_000 });
      await page.mouse.move(720, 420);
      await page.waitForTimeout(200);
      await saveShot(page, 'desktop-1440-dark-zh-expanded.png');
      const sidebarBox = await page.locator('#app-sidebar').boundingBox();
      if (sidebarBox) {
        await saveShot(page, 'sidebar-crop-dark-zh.png', {
          x: Math.max(0, sidebarBox.x),
          y: Math.max(0, sidebarBox.y),
          width: Math.min(340, sidebarBox.width),
          height: Math.min(900, sidebarBox.height),
        });
      }
      await context.close();
    }

    // 3. Desktop 1440x900 Light EN (expanded groups + 1:1 sidebar crop)
    {
      const { context, page } = await openConfiguredPage({ width: 1440, height: 900, locale: 'en', theme: 'light' });
      await page.click('[data-sidebar-unit-group-toggle="grp_pinned_release"]');
      await page.click('[data-sidebar-unit-group-toggle="grp_release_audit"]');
      await page.waitForSelector('[data-session-row="s_90d_child"]', { timeout: 5_000 });
      await page.mouse.move(720, 420);
      await page.waitForTimeout(200);
      await saveShot(page, 'desktop-1440-light-en-expanded.png');
      const sidebarBox = await page.locator('#app-sidebar').boundingBox();
      if (sidebarBox) {
        await saveShot(page, 'sidebar-crop-light-en.png', {
          x: Math.max(0, sidebarBox.x),
          y: Math.max(0, sidebarBox.y),
          width: Math.min(340, sidebarBox.width),
          height: Math.min(900, sidebarBox.height),
        });
      }
      await context.close();
    }

    // 4. Mobile 390x844 Light ZH drawer open
    {
      const { context, page } = await openConfiguredPage({ width: 390, height: 844, locale: 'zh', theme: 'light' });
      const drawerBtn = page.locator('button[aria-controls="app-sidebar"]');
      if (await drawerBtn.isVisible()) {
        await drawerBtn.click();
        await page.waitForTimeout(300);
      }
      await page.click('[data-sidebar-unit-group-toggle="grp_release_audit"]');
      await page.waitForSelector('[data-session-row="s_90d_child"]', { timeout: 5_000 });
      await page.waitForTimeout(250);
      metrics.mobileLightZh = await page.evaluate(() => {
        const list = document.querySelector('[data-session-list]');
        return {
          horizontalOverflowPx: list ? Math.max(0, list.scrollWidth - list.clientWidth) : -1,
          fromParentSubtitles: document.querySelectorAll('[data-session-relation-note]').length,
          mountedRows: document.querySelectorAll('[data-session-row], [data-sidebar-unit-group]').length,
        };
      });
      await saveShot(page, 'mobile-390-light-zh-drawer.png');
      await context.close();
    }

    // 5. Mobile 390x844 Dark EN drawer open
    {
      const { context, page } = await openConfiguredPage({ width: 390, height: 844, locale: 'en', theme: 'dark' });
      const drawerBtn = page.locator('button[aria-controls="app-sidebar"]');
      if (await drawerBtn.isVisible()) {
        await drawerBtn.click();
        await page.waitForTimeout(300);
      }
      await page.click('[data-sidebar-unit-group-toggle="grp_release_audit"]');
      await page.waitForSelector('[data-session-row="s_90d_child"]', { timeout: 5_000 });
      await page.waitForTimeout(250);
      await saveShot(page, 'mobile-390-dark-en-drawer.png');
      await context.close();
    }

    writeFileSync(join(OUT_DIR, 'metrics.json'), JSON.stringify(metrics, null, 2));
    console.log(JSON.stringify(metrics, null, 2));
  } finally {
    await browser.close();
    await fixture.stop();
    await new Promise((r) => staticSrv.server.close(r));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
