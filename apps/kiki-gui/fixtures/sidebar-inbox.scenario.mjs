/**
 * sidebar-inbox — Vibe42 Inbox-Zero [待办 | 会话] dual-view sidebar, multi-space
 * unified stream (local + online remote + quiet offline remote), hover triage
 * controls + snooze popover, zero-jank viewing pin, Inbox-Zero empty state with
 * bottom drawers, 72h cold fold in Sessions view, and NewSessionPage space chip.
 */

import { assistantMsg, sessionRecord, userMsg } from './helpers.mjs';

const WS_CORE = 'wd_inbox_core_000000000001';
const WS_GUI = 'wd_inbox_gui_000000000002';
const WS_ML = 'wd_remote_ml_000000000001';

const REMOTE_GPU_ID = '11111111-1111-4111-8111-111111111111';
const REMOTE_MAC_ID = '22222222-2222-4222-8222-222222222222';

const S_APPROVAL = 'session_inbox_approval';
const S_QUESTION = 'session_inbox_question';
const S_DONE = 'session_inbox_done';
const S_RUNNING = 'session_inbox_running';
const S_RECENT_READ = 'session_inbox_recent_read';
const S_OLD_READ_1 = 'session_inbox_old_read_1';
const S_OLD_READ_2 = 'session_inbox_old_read_2';
const S_OLD_UNREAD = 'session_inbox_old_unread';
const S_REMOTE_DONE = 'session_remote_done';
const S_REMOTE_RUN = 'session_remote_run';

const nowMs = Date.now();
const minsAgoIso = (mins) => new Date(nowMs - mins * 60_000).toISOString();
const daysAgoIso = (days) => new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();

export default {
  spaces: {
    mainPath: 'C:/Users/fixture/.kiki',
    items: [
      { id: 'h-nia', name: 'Nia Whisper Tavern', color: '#945439', path: 'C:/Users/fixture/.kiki-spaces/nia' },
    ],
  },
  workspaces: [
    { id: WS_CORE, root: 'C:/work/kiki-core', name: 'kiki-core', created_at: daysAgoIso(30), last_opened_at: minsAgoIso(4), session_count: 4, pinned: false },
    { id: WS_GUI, root: 'C:/work/kiki-gui', name: 'kiki-gui', created_at: daysAgoIso(25), last_opened_at: minsAgoIso(1), session_count: 4, pinned: false },
  ],
  sessions: [
    sessionRecord(S_APPROVAL, {
      workspace_id: WS_CORE,
      title: 'Deploy staging migration',
      pending_interaction: 'approval',
      last_seq: 6,
      updated_at: minsAgoIso(4),
      metadata: { cwd: 'C:/work/kiki-core' },
    }),
    sessionRecord(S_QUESTION, {
      workspace_id: WS_CORE,
      title: 'Confirm OAuth callback URL',
      pending_interaction: 'question',
      last_seq: 5,
      updated_at: minsAgoIso(11),
      metadata: { cwd: 'C:/work/kiki-core' },
    }),
    sessionRecord(S_DONE, {
      workspace_id: WS_GUI,
      title: 'Refactor sidebar keyline',
      last_turn_reason: 'completed',
      last_seq: 12,
      updated_at: minsAgoIso(18),
      metadata: { cwd: 'C:/work/kiki-gui' },
    }),
    sessionRecord(S_RUNNING, {
      workspace_id: WS_GUI,
      title: 'Run full visual matrix',
      busy: true,
      executing: true,
      main_turn_active: true,
      last_seq: 3,
      updated_at: minsAgoIso(1),
      metadata: { cwd: 'C:/work/kiki-gui' },
    }),
    sessionRecord(S_RECENT_READ, {
      workspace_id: WS_GUI,
      title: 'Update i18n dictionary',
      last_seq: 0,
      updated_at: minsAgoIso(160),
      metadata: { cwd: 'C:/work/kiki-gui' },
    }),
    sessionRecord(S_OLD_UNREAD, {
      workspace_id: WS_CORE,
      title: 'Audit build cache',
      last_turn_reason: 'completed',
      last_seq: 5,
      updated_at: daysAgoIso(5),
      metadata: { cwd: 'C:/work/kiki-core' },
    }),
    sessionRecord(S_OLD_READ_1, {
      workspace_id: WS_CORE,
      title: 'Archive Q3 benchmarks',
      last_seq: 0,
      updated_at: daysAgoIso(6),
      metadata: { cwd: 'C:/work/kiki-core' },
    }),
    sessionRecord(S_OLD_READ_2, {
      workspace_id: WS_GUI,
      title: 'Verify WebView2 focus hook',
      last_seq: 0,
      updated_at: daysAgoIso(11),
      metadata: { cwd: 'C:/work/kiki-gui' },
    }),
  ],
  snapshots: {
    [S_DONE]: {
      messages: [
        userMsg(S_DONE, 'Align the sidebar header and mode switch on the 18px keyline.', 22),
        assistantMsg(S_DONE, ['Aligned SpaceScopeControl, New Session, PrimaryNav, and the Inbox/Sessions mode switch onto the 18px Zone 1 keyline.'], 18),
      ],
    },
    [S_RECENT_READ]: {
      messages: [
        userMsg(S_RECENT_READ, 'Sync bilingual sidebar copy.', 165),
        assistantMsg(S_RECENT_READ, ['Added the zh and en sidebar inbox keys and rebuilt @kiki/session-core.'], 160),
      ],
    },
  },
  remoteConnections: {
    inbound: { enabled: false, configuredEnabled: false, grants: [] },
    connections: [
      {
        id: REMOTE_GPU_ID,
        label: 'GPU Workstation',
        endpoint: 'https://gpu.example.test',
        target: { homeId: REMOTE_GPU_ID, hostId: 'host-gpu', protocol: 1 },
        credentialRef: REMOTE_GPU_ID,
        enabled: true,
        purposes: ['gui'],
        backgroundSummary: true,
        state: 'online',
        activeLeases: 1,
        rttMs: 14,
        summary: {
          value: { online: true, busy_sessions: 1, needs_you_sessions: 0, revision: 'r4', as_of: nowMs, platform: 'linux' },
          lastSeen: nowMs,
          stale: false,
        },
      },
      {
        id: REMOTE_MAC_ID,
        label: 'Studio Mac',
        endpoint: 'https://studio.example.test',
        target: { homeId: REMOTE_MAC_ID, hostId: 'host-mac', protocol: 1 },
        credentialRef: REMOTE_MAC_ID,
        enabled: true,
        purposes: ['gui'],
        backgroundSummary: true,
        state: 'offline',
        activeLeases: 0,
        rttMs: 28,
        summary: {
          value: { online: false, busy_sessions: 0, needs_you_sessions: 0, revision: 'r2', as_of: nowMs - 180_000, platform: 'darwin' },
          lastSeen: nowMs - 180_000,
          stale: true,
        },
      },
    ],
  },
  remoteSpaces: {
    [REMOTE_GPU_ID]: {
      homeId: REMOTE_GPU_ID,
      platform: 'linux',
      workspaces: [
        { id: WS_ML, root: '/srv/ml-lab', name: 'ml-lab', created_at: daysAgoIso(20), last_opened_at: minsAgoIso(2), session_count: 2, pinned: false },
      ],
      sessions: [
        sessionRecord(S_REMOTE_DONE, {
          workspace_id: WS_ML,
          title: 'Train LoRA checkpoint v4',
          last_turn_reason: 'completed',
          last_seq: 9,
          updated_at: minsAgoIso(6),
          metadata: { cwd: '/srv/ml-lab' },
        }),
        sessionRecord(S_REMOTE_RUN, {
          workspace_id: WS_ML,
          title: 'Benchmark FP8 throughput',
          busy: true,
          executing: true,
          main_turn_active: true,
          last_seq: 4,
          updated_at: minsAgoIso(2),
          metadata: { cwd: '/srv/ml-lab' },
        }),
      ],
      rooms: [],
      snapshots: {
        [S_REMOTE_DONE]: {
          messages: [
            userMsg(S_REMOTE_DONE, 'Train LoRA checkpoint v4 on the 3090 rig and report eval loss.', 14),
            assistantMsg(S_REMOTE_DONE, ['LoRA v4 finished 1,200 steps on GPU Workstation (eval loss 0.412, checkpoint saved to /srv/ml-lab/checkpoints/lora-v4.safetensors).'], 6),
          ],
        },
      },
    },
  },
};
