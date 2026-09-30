/**
 * btw — one session with a short exchange whose main turn is still streaming,
 * so a `/btw` side question can be shown answering beside it without
 * interrupting. `btwReply` is what the fixture's side agent streams back.
 */

import { assistantMsg, sessionRecord, streamSteps, turnStart, userMsg, workChanged } from './helpers.mjs';

const SID = 'session_fixture_btw';

const LONG_RUN = '正在逐个检查 packages/ 下的 lockfile 与 workspace 声明，先对齐 pnpm 版本，再跑一次离线安装确认没有漂移。'.repeat(6);

export default {
  sessions: [sessionRecord(SID, { title: '依赖升级：对齐 pnpm 工作区' })],
  snapshots: {
    [SID]: {
      messages: [
        userMsg(SID, '把整个工作区的依赖升级到最新补丁版本，保持 lockfile 可离线复现。', 6),
        assistantMsg(SID, [('好的。我会先盘点每个包的依赖，再逐个升级补丁版本，最后用 `pnpm install --offline --frozen-lockfile` 验证。')], 5),
      ],
      has_more: false,
    },
  },
  // The main turn keeps streaming for a while: the side question must not stop it.
  onPrompt: [
    turnStart(2),
    workChanged(true),
    { frame: { type: 'turn.step.started', payload: { turnId: 2, step: 1 } } },
    ...streamSteps('assistant.delta', 2, LONG_RUN, { per: 12, delay: 400 }),
  ],
  btwReply:
    '`--frozen-lockfile` 让安装严格按 lockfile 进行：如果 package.json 与 lockfile 不一致，安装直接失败，而不是悄悄改写 lockfile。配合 `--offline` 就只用本地缓存，适合验证可复现性。',
};
