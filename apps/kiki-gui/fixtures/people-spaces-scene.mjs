/**
 * people-spaces-scene — the neutral world for the docs Features series pages
 * `people` and `spaces` (docs/{zh,en}/features/{people,spaces}.md).
 *
 * What this adds over `marketing-campaign-scene.mjs`: it composes the shared
 * builders (buildA18 personas/daily, buildA19 rooms, buildA20 spaces, buildWebAccess)
 * into the exact states the two pages talk about, and it adds the surface the
 * existing people/spaces frames never showed — a persona's memory policy, a room
 * that has actually run out of budget, and the subspace credential dialog.
 *
 * It EDITs nothing shared. Every builder below is imported from
 * marketing-campaign-scene.mjs and re-seeded here, so a change in the shared
 * scene reaches these frames too.
 *
 * Fixture-server wire shapes only (see helpers.mjs, fixture-personas.mjs,
 * fixture-spaces.mjs). No product code is involved, and no provider is called.
 */

import {
  buildA18,
  buildA19,
  buildA20,
  buildWebAccess,
  PROJECT_ROOT,
  ROOM_ID,
} from './marketing-campaign-scene.mjs';
import { sessionRecord, ts } from './helpers.mjs';
import { ROLE_BINDING, SESSION, WORKSPACE_ID } from './marketing-scene.mjs';

const pick = (locale, en, zh) => (locale === 'zh' ? zh : en);

// ---------------------------------------------------------------------------
// PS1 — the persona card, scrolled to what separates a persona from a profile
// ---------------------------------------------------------------------------

/**
 * PS1. The persona card with the identity fields on screen AND the work section
 * open, because the page's central claim is the difference: the persona decides
 * *who* (name/title/responsibility/standing rules), while profile/model/effort
 * decide *how it works*. A frame that stops at the description proves only half
 * of the sentence the page's second paragraph makes, and a card whose profile
 * and model are both blank cannot show that separation at all.
 */
export function buildPeopleSpacesCard(locale) {
  const world = buildA18(locale);
  const [lin, che] = world.personas.map((entry) => entry.definition);
  return {
    ...world,
    personas: [
      {
        definition: {
          ...lin,
          // `profile` is the execution binding the page names. Leaving it unset
          // would show an empty select and make the identity/execution split
          // invisible, which is the one thing this frame exists to show.
          profile: 'agent',
          memory: { shared: ['global', 'workspace'] },
          homeWorkspace: WORKSPACE_ID,
        },
      },
      {
        definition: {
          ...che,
          profile: 'agent',
          // A persona that opts out of the shared scopes keeps only its own
          // memory — the second row of the memory card, so the checkbox pair is
          // a real choice in the frame rather than two identical ticks.
          memory: { shared: [] },
        },
      },
      ...world.personas.slice(2),
    ],
  };
}

// ---------------------------------------------------------------------------
// PS2 — a persona's own memory, in the persona scope
// ---------------------------------------------------------------------------

const memoryEntry = (fields) => ({
  status: 'active',
  pinned: false,
  created: ts(2_000),
  updated: ts(200),
  source: { writer: 'user' },
  reason: '',
  ...fields,
});

/**
 * PS2. The /memory page open in the persona scope for one persona, with that
 * persona's entries listed and one open for reading. The people page has a whole
 * section on persona memory and currently ships no frame for it; this is the
 * surface that section describes.
 *
 * The persona scope only resolves when the persona's daily session and that
 * session's workspace are both in the directory, so the daily sessions are
 * carried over from buildA18 rather than invented again.
 */
export function buildPeopleSpacesMemory(locale) {
  const world = buildA18(locale);
  const [lin] = world.personas.map((entry) => entry.definition);
  return {
    ...world,
    memory: { enabled: true, approval: 'auto', budget: 2_000, workspaces: { [WORKSPACE_ID]: true } },
    memoryEntries: {
      global: [
        memoryEntry({
          id: 'mem_ps_lang',
          type: 'user',
          title: pick(locale, 'Answer in Chinese, keep code comments in English', '回答用中文，代码注释保持英文'),
          body: pick(locale, 'Prose in Chinese; code, commit messages, and identifiers in English.', '正文用中文；代码、提交信息和标识符用英文。'),
          updated: ts(600),
        }),
      ],
      [`workspace:${WORKSPACE_ID}`]: [
        memoryEntry({
          id: 'mem_ps_release_day',
          type: 'project',
          title: pick(locale, 'Release day is Friday; the freeze starts Thursday noon', '发布日是周五；周四中午开始冻结'),
          body: pick(locale, 'Anything merged after the freeze waits for the next release.', '冻结之后合并的内容等下个版本。'),
          updated: ts(120),
        }),
      ],
      [`persona:${lin.id}`]: [
        memoryEntry({
          id: 'mem_ps_checklist',
          type: 'feedback',
          title: pick(locale, 'Show the checklist before any release action', '发布动作前先给清单'),
          body: pick(
            locale,
            `${lin.name} waits for the operator to see and confirm the release checklist before any release action runs.`,
            `${lin.name} 要求操作者在执行任何发布动作前先看到并确认发布清单。`,
          ),
          pinned: true,
          updated: ts(25),
        }),
        memoryEntry({
          id: 'mem_ps_conclusion',
          type: 'user',
          title: pick(locale, 'Conclusion first, then at most four reasons', '先给结论，再给不超过四条理由'),
          body: pick(locale, 'Keep answers short enough to read on a phone.', '回答要短到手机上能一眼读完。'),
          updated: ts(900),
        }),
        memoryEntry({
          id: 'mem_ps_blockers',
          type: 'project',
          title: pick(locale, 'Two blockers are open for 0.4', '0.4 还剩两个阻塞'),
          body: pick(
            locale,
            'The changelog entries still being drafted, and the signing certificate renewal.',
            '还在起草的 changelog 条目，以及签名证书续期。',
          ),
          updated: ts(45),
        }),
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// PS3 — a room that has run out of budget
// ---------------------------------------------------------------------------

const msg = (id, minutesAgo, from, text, extra = {}) => ({
  id, at: ts(minutesAgo), kind: 'message', from, text, mentions: [], ...extra,
});
const sys = (id, minutesAgo, event, text, data) => ({
  id, at: ts(minutesAgo), kind: 'system', from: 'system', event, text, ...(data !== undefined ? { data } : {}),
});

/**
 * PS3. The same three-member room as the existing people-room frame, but with
 * the budget spent and the room paused by it — which is the state the page's
 * third bullet is about ("when it runs out the discussion pauses, and Continue
 * resets the budget"). The existing frame shows 6 of 12 used and a running room,
 * so the pause/continue affordance exists only as a code path no shipped frame
 * shows.
 *
 * This is not an error state: the log ends with the product's own
 * `budget_exhausted` line and a Continue action, which is what the product does.
 */
export function buildPeopleSpacesRoomPaused(locale) {
  const world = buildA19(locale);
  const [seed] = world.rooms;
  const { room } = seed;
  const names = world.personas.map((entry) => entry.definition);
  const [lin, che, xiao] = names;
  const log = [
    msg('ps-1', 41, 'user', pick(
      locale,
      'Draft the 0.4 release notes and tell me what is still open. @Lin Lan',
      '起草 0.4 发布说明，并告诉我还剩什么没解决。@林岚',
    ), { mentions: [lin.id] }),
    msg('ps-2', 40, lin.id, pick(
      locale,
      `I will own the checklist. @${che.name} — the changelog entries. @${xiao.name} — the certificate renewal.`,
      `我管清单。@${che.name} —— changelog 条目。@${xiao.name} —— 证书续期。`,
    ), { mentions: [che.id, xiao.id] }),
    msg('ps-3', 38, che.id, pick(
      locale,
      'Entries #812, #815 and #820 are still open. I can have the draft in CHANGELOG.md within the hour.',
      '#812、#815、#820 还没写。一小时内我把草稿放进 CHANGELOG.md。',
    )),
    msg('ps-4', 36, xiao.id, pick(
      locale,
      'The provider accepts the renewal request this afternoon, but it takes one to two business days to issue.',
      '供应商今天下午能受理续期申请，但出证书要一到两个工作日。',
    )),
    msg('ps-5', 34, che.id, pick(
      locale,
      'Draft is in CHANGELOG.md. @Lin Lan it needs your read before anything ships.',
      '草稿已经写进 CHANGELOG.md。@林岚 发之前需要你过一遍。',
    ), { mentions: [lin.id] }),
    msg('ps-6', 31, lin.id, pick(
      locale,
      'Read. Two blockers are left, so this goes out after the certificate lands — Friday.',
      '看过了。还剩两个阻塞，所以等证书下来再发——周五。',
    )),
    sys('ps-7', 29, 'budget_exhausted', pick(
      locale,
      'This turn reached its 12-message budget, so the discussion is paused.',
      '这一轮用满了 12 条发言的预算，讨论已暂停。',
    ), { budget: 12 }),
  ];
  return {
    ...world,
    rooms: [{
      ...seed,
      room: {
        ...room,
        // The paused state and the spent counter are what put Continue on
        // screen; the members, host and roster are unchanged from A19.
        paused: true,
        pauseReason: 'budget',
        budgetUsed: 12,
      },
      log,
    }],
  };
}

// ---------------------------------------------------------------------------
// PS4 — a room with an existing thread seated alongside the personas
// ---------------------------------------------------------------------------

/**
 * PS4. The room page with one EXISTING THREAD seated next to the two personas.
 * The page says members can be threads that keep their own sessions, workspace
 * and permissions, and every shipped room frame has three personas — so the
 * thread-member row, its own status line and its link to its conversation are
 * a documented behavior with no image behind it.
 */
export function buildPeopleSpacesRoomThreads(locale) {
  const world = buildA19(locale);
  const [seed] = world.rooms;
  const { room } = seed;
  const [lin, che] = world.personas.map((entry) => entry.definition);
  const threadSessionId = 'sess_sample_thread_backend';
  const threadSession = sessionRecord(threadSessionId, {
    title: pick(locale, 'Backend upgrade notes', '后端升级说明'),
    workspace_id: WORKSPACE_ID,
    metadata: { cwd: PROJECT_ROOT },
    updated_at: ts(70),
    created_at: ts(1_400),
  });
  const log = [
    msg('pt-1', 28, 'user', pick(
      locale,
      `Is the 0.4 backend upgrade safe to ship with the release? @${lin.name}`,
      `0.4 的后端升级能和发布一起上吗？@${lin.name}`,
    ), { mentions: [lin.id] }),
    msg('pt-2', 27, lin.id, pick(
      locale,
      `I will check the checklist. @${che.name} — the client side. The backend thread already knows the upgrade.`,
      `我来对清单。@${che.name} —— 客户端这块。后端升级那条线程已经清楚了。`,
    ), { mentions: [che.id] }),
    msg('pt-3', 25, threadSessionId, pick(
      locale,
      'Server side is done: the migration runs on deploy and needs no manual step. I left the rollback note in the thread.',
      '服务端完成了：迁移在部署时自动跑，不需要手工操作。回滚说明留在那条线程里。',
    )),
    msg('pt-4', 22, che.id, pick(
      locale,
      'Client side still needs one retry path. Give me an hour and it matches the release checklist.',
      '客户端还差一条重试路径。给我一小时就和发布清单对齐了。',
    )),
  ];
  return {
    ...world,
    sessions: [...world.sessions, threadSession],
    rooms: [{
      ...seed,
      room: {
        ...room,
        members: [
          { kind: 'persona', personaId: lin.id, sessionId: `session_campaign_room_${lin.id}`, muted: false },
          { kind: 'persona', personaId: che.id, sessionId: `session_campaign_room_${che.id}`, muted: false },
          // The discriminated thread member the room page resolves against:
          // its own session id, not a persona id.
          { kind: 'thread', sessionId: threadSessionId, muted: false },
        ],
      },
      log,
    }],
    personaSessions: [
      ...(world.personaSessions ?? []),
      threadSessionId,
    ],
  };
}

// ---------------------------------------------------------------------------
// PS5 — the spaces list, clean
// ---------------------------------------------------------------------------

/**
 * PS5. The spaces list itself. This is the replacement for the shipped
 * spaces-spaces-list frame, which carries two visible failures: the remote and
 * inbound cards below it have no fixture route, so they render
 * "The local control connection is not ready." and "session.not_found (40401)".
 *
 * The fix for those is in the runner (it answers /api/remote-connections for
 * this run). The list itself is seeded here so a space carries a real running
 * state and its own credential scope.
 */
export function buildPeopleSpacesSpacesList(locale) {
  const world = buildA20(locale);
  return {
    ...world,
    spaces: {
      ...world.spaces,
      items: world.spaces.items.map((item) => (
        item.id === 'h-campaign000000002'
          // The second space runs, so the row shows what "running" looks like
          // next to the main space rather than an all-idle list.
          ? { ...item, live: true, selections: { 'pref:theme': { mode: 'follow', reason: 'inherited' }, 'group:config': { mode: 'follow' } } }
          : item
      )),
    },
  };
}

// ---------------------------------------------------------------------------
// PS6 — the subspace credential dialog
// ---------------------------------------------------------------------------

/**
 * PS6. The credentials dialog for a subspace that currently SHARES the main
 * space's accounts, so the dialog offers the move to isolated and lists the SSH
 * hosts whose passwords can be copied across with it. The spaces page's second
 * paragraph is entirely about this choice ("shared" vs "its own accounts") and
 * the shipped spaces-list frame only shows the two-character label on a row.
 */
export function buildPeopleSpacesCredentials(locale) {
  const world = buildA20(locale);
  return {
    ...world,
    spaces: {
      ...world.spaces,
      // Two candidate hosts so the "copy SSH here" list has a select-all and
      // per-host rows — a one-row list cannot show the choice the dialog makes.
      sshCandidates: [
        { hostId: 'build-box', name: pick(locale, 'Build box', '构建机'), credential_kinds: ['password'] },
        { hostId: 'docs-box', name: pick(locale, 'Docs box', '文档机'), credential_kinds: ['passphrase'] },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// PS7 — a space's settings detail: followed vs fixed
// ---------------------------------------------------------------------------

/**
 * PS7. A subspace's own settings dialog, which is where "you can see whether a
 * value is inherited or pinned" is actually shown — each domain row reads
 * Follow or Fixed. The page claims this in prose with no image behind it, and it
 * is the only place a reader can see that a subspace inherits most of its
 * settings from the main space.
 */
export function buildPeopleSpacesSpaceDetail(locale) {
  const world = buildA20(locale);
  const item = world.spaces.items.find((entry) => entry.id === 'h-campaign000000001');
  return {
    ...world,
    spaces: {
      ...world.spaces,
      items: world.spaces.items.map((entry) => (
        // The subspace has its own prefs (so it is not primary), follows the
        // config group, and fixes its own theme — so the detail dialog shows one
        // domain followed and one fixed rather than a uniform column.
        entry.id === item.id
          ? {
            ...entry,
            prefs: { theme: 'light', defaultAppendTiming: 'subagents_done' },
            selections: {
              'group:config': { mode: 'follow' },
              'group:appearance': { mode: 'fixed' },
              'pref:theme': { mode: 'fixed', reason: 'edited' },
            },
          }
          : entry
      )),
    },
  };
}

// ---------------------------------------------------------------------------
// PS8 — web access, temporary entry with its address expanded
// ---------------------------------------------------------------------------

/**
 * PS8. Web access turned on as a TEMPORARY entry with the address disclosure
 * open, so the frame shows the link, the eight-hour countdown and the "not
 * encrypted on a plain LAN" warning — the three facts the page's Web-access
 * section is actually about. The shipped web-access frame shows a persistent
 * entry with the address folded away, and carries the two fixture failures
 * above it.
 */
export function buildPeopleSpacesWebAccess(locale) {
  const world = buildWebAccess(locale);
  return {
    ...world,
    webAccess: {
      ...world.webAccess,
      enabled: true,
      mode: 'temporary',
      // Eight hours from the fixture clock, matching `kiki web --temporary`.
      expiresInMs: 8 * 3_600_000,
      url: 'http://192.168.1.20:8614/',
      host: '192.168.1.20',
      port: 8614,
      insecure: true,
      sessions: [
        { id: '11111111-2222-4333-8444-555555555555', label: 'Pixel · Chrome', createdAgoMs: 3_600_000, lastUsedAgoMs: 45_000, expiresInMs: 4 * 3_600_000 },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// PS9 — in-session SSH, joined hosts
// ---------------------------------------------------------------------------

/**
 * PS9. A live session with the composer Session-SSH strip open and two hosts
 * joined. The spaces page's last section is entirely about this control — added
 * from the + menu, listed above the input box, removed with X, a session
 * resource rather than something each message carries — and no shipped frame
 * shows it.
 */
export function buildPeopleSpacesSessionSsh(locale) {
  const world = buildA18(locale);
  const sid = SESSION.release;
  const box = pick(locale, 'Build box', '构建机');
  const docsBox = pick(locale, 'Docs box', '文档机');
  return {
    ...world,
    // The composer only draws the Session-SSH control when the flag is on, so a
    // frame without this seed would show no control at all.
    experimentalFlags: { native_ssh: true },
    ssh: {
      hosts: [
        { id: 'build-box', name: box, hostname: 'build.example.com', user: 'deploy', agentAccess: 'offered' },
        { id: 'docs-box', name: docsBox, hostname: 'docs.example.com', user: 'docs', agentAccess: 'offered' },
      ],
      status: { 'build-box': 'ready', 'docs-box': 'idle' },
      // The joined list is the session's own resource, keyed by session id and
      // holding host ids — `SshSessionHostsResponse` resolves them against the
      // host list above.
      session: { [sid]: ['build-box', 'docs-box'] },
    },
    snapshots: {
      ...world.snapshots,
      [sid]: {
        messages: [
          { id: 'msg_ps_ssh_u1', session_id: sid, role: 'user', content: [{ type: 'text', text: pick(locale, 'Run the release check on the build box and tell me what fails.', '在构建机上跑一遍发布检查，告诉我哪里失败。') }], created_at: ts(9) },
          { id: 'msg_ps_ssh_a1', session_id: sid, role: 'assistant', content: [{ type: 'text', text: pick(locale, 'The release check is queued on the build box. Two steps still fail and I am reading their output now.', '发布检查已在构建机上排队。还有两步失败，我正在读它们的输出。') }], created_at: ts(8) },
        ],
        has_more: false,
      },
    },
  };
}

export const PEOPLE_SPACES_BUILDERS = {
  card: buildPeopleSpacesCard,
  memory: buildPeopleSpacesMemory,
  roomPaused: buildPeopleSpacesRoomPaused,
  roomThreads: buildPeopleSpacesRoomThreads,
  spacesList: buildPeopleSpacesSpacesList,
  credentials: buildPeopleSpacesCredentials,
  spaceDetail: buildPeopleSpacesSpaceDetail,
  webAccess: buildPeopleSpacesWebAccess,
  sessionSsh: buildPeopleSpacesSessionSsh,
};

export { ROOM_ID, ROLE_BINDING, SESSION, WORKSPACE_ID };
