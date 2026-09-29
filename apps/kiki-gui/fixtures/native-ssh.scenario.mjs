/**
 * native-ssh — the SSH slice against the wired REST shapes:
 *
 *   Settings › SSH hosts: three Kiki hosts (one hidden from the agent, one
 *   overriding a ~/.ssh/config alias, one connected), four config aliases
 *   (one failed), both connection switches.
 *   Composer: a session with two joined hosts and one temporary target.
 *   Tray: one session per SSH approval kind — connect with password, key
 *   file + passphrase, keyboard-interactive in two rounds (the second round
 *   arrives after the first answer), first-seen host key — and a session
 *   whose tool call failed because the host key changed (the engine refuses
 *   without a card).
 *
 * `ssh` approvals mirror agent-core sshConnectionGateService: generic display
 * plus the non-secret top-level `ssh` field.
 */

import { assistantMsg, sessionRecord, toolResultMsg, userMsg } from './helpers.mjs';

const WS = 'wd_fixture_000000000000';
const created = new Date().toISOString();
const expires = new Date(Date.now() + 23 * 3600_000).toISOString();

const S = {
  hosts: 'session_ssh_hosts',
  password: 'session_ssh_password',
  key: 'session_ssh_key',
  otp: 'session_ssh_otp',
  hostKey: 'session_ssh_hostkey',
  changed: 'session_ssh_changed',
};

function connect(sid, id, { name, host, hostname, user, port, proxyJump, tool = 'Bash' }) {
  const action = `Connect SSH host ${name} (${host})`;
  return {
    approval_id: id,
    session_id: sid,
    turn_id: 1,
    tool_call_id: `call_${id}`,
    tool_name: tool,
    action,
    tool_input_display: { kind: 'generic', summary: action, detail: { host, hostname, user, port, proxyJump } },
    ssh: { kind: 'login', hostname, user, port, ...(proxyJump === undefined ? {} : { proxyJump }) },
    created_at: created,
    expires_at: expires,
  };
}

function prompts(sid, id, host, target, list) {
  const action = `SSH authentication for ${host}`;
  return {
    approval_id: id,
    session_id: sid,
    turn_id: 1,
    tool_call_id: `call_${id}`,
    tool_name: 'Bash',
    action,
    tool_input_display: { kind: 'generic', summary: action, detail: { host, hostname: target.hostname, prompts: list } },
    ssh: { kind: 'login', ...target, prompts: list },
    created_at: created,
    expires_at: expires,
  };
}

/** A changed host key has no card: the tool call fails with the engine's reason. */
function toolFailure(sid, text) {
  return [
    userMsg(sid, 'Check disk usage on gpu-box.', 3),
    assistantMsg(sid, [{ toolUse: { id: 'call_changed', name: 'Bash', input: { host: 'gpu-box', command: 'df -h' } } }], 2),
    toolResultMsg(sid, 'call_changed', text, 2, true),
    assistantMsg(sid, ['gpu-box presented a different host key than the one in known_hosts, so Kiki refused to connect. Confirm the new fingerprint with whoever runs that machine, then remove the old line from ~/.ssh/known_hosts.'], 1),
  ];
}

const OTP_TARGET = { hostname: 'staging.example.com', user: 'deploy', port: 22 };

export default {
  experimentalFlags: { native_ssh: true },
  workspaces: [{ id: WS, name: 'workshop', root: 'C:/fixture/workshop', pinned: false }],
  ssh: {
    hosts: [
      { id: 'staging', name: 'Staging', hostname: 'staging.example.com', user: 'deploy', port: 22, roots: ['/srv/app'], description: 'Staging web + worker', agentAccess: 'offered' },
      { id: 'gpu-box', name: 'GPU box', hostname: 'gpu.lab.example.com', user: 'ubuntu', port: 2222, identityFile: '~/.ssh/id_ed25519', roots: ['/home/ubuntu/train', '/data/checkpoints'], agentAccess: 'offered' },
      { id: 'prod-db', name: 'Production database', hostname: 'db-01.internal.example.com', user: 'readonly', agentAccess: 'hidden' },
      { id: 'dev', name: 'Dev (pinned roots)', roots: ['/home/dev/project'], agentAccess: 'offered' },
    ],
    config: ['dev', 'bastion', 'build-runner', 'pi-lab'],
    status: { 'gpu-box': 'ready', 'build-runner': 'failed', staging: 'idle' },
    session: { [S.hosts]: ['gpu-box', 'staging', 'ubuntu@10.0.0.9'] },
    temporary: { [S.hosts]: [{ id: 'ubuntu@10.0.0.9', name: 'ubuntu@10.0.0.9', hostname: '10.0.0.9', user: 'ubuntu', port: 22 }] },
  },
  sessions: [
    sessionRecord(S.hosts, { title: 'Fixture: SSH hosts in session' }),
    sessionRecord(S.password, { title: 'Fixture: SSH password sign-in', busy: true, pending_interaction: 'approval' }),
    sessionRecord(S.key, { title: 'Fixture: SSH key sign-in', busy: true, pending_interaction: 'approval' }),
    sessionRecord(S.otp, { title: 'Fixture: SSH two-step sign-in', busy: true, pending_interaction: 'approval' }),
    sessionRecord(S.hostKey, { title: 'Fixture: SSH new host key', busy: true, pending_interaction: 'approval' }),
    sessionRecord(S.changed, { title: 'Fixture: SSH changed host key' }),
  ],
  snapshots: {
    [S.hosts]: { messages: [] },
    [S.password]: {
      messages: [],
      pending_approvals: [connect(S.password, 'approval_ssh_pw', { name: 'ubuntu@10.0.0.9', host: 'ubuntu@10.0.0.9', hostname: '10.0.0.9', user: 'ubuntu', port: 22 })],
    },
    [S.key]: {
      messages: [],
      pending_approvals: [connect(S.key, 'approval_ssh_key', { name: 'GPU box', host: 'gpu-box', hostname: 'gpu.lab.example.com', user: 'ubuntu', port: 2222, proxyJump: 'bastion' })],
    },
    [S.otp]: {
      messages: [],
      pending_approvals: [prompts(S.otp, 'approval_ssh_otp1', 'staging', OTP_TARGET, [{ prompt: 'Password: ', echo: false }])],
    },
    [S.hostKey]: {
      messages: [],
      pending_approvals: [{
        approval_id: 'approval_ssh_hostkey',
        session_id: S.hostKey,
        turn_id: 1,
        tool_call_id: 'call_hostkey',
        tool_name: 'Bash',
        action: 'Trust SSH host key pi-lab',
        tool_input_display: { kind: 'generic', summary: 'Trust SSH host key pi-lab', detail: { host: 'pi-lab', hostname: 'pi-lab.local', algorithm: 'ssh-ed25519', fingerprint: 'SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8' } },
        ssh: { kind: 'host_key', hostname: 'pi-lab.local', user: 'pi', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8' },
        created_at: created,
        expires_at: expires,
      }],
    },
    [S.changed]: {
      messages: toolFailure(S.changed, 'SSH host key changed for [gpu.lab.example.com]:2222; verify it out of band before editing known_hosts'),
    },
  },
  // Keyboard-interactive: answering round 1 raises round 2.
  sshFollowUps: {
    approval_ssh_otp1: prompts(S.otp, 'approval_ssh_otp2', 'staging', OTP_TARGET, [{ prompt: 'Verification code: ', echo: true }]),
  },
};
