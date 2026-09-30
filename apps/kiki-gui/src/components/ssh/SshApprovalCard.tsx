/**
 * Tray strip for an SSH approval (`request.ssh` present). Same chrome as the
 * generic ApprovalCard (one accent rule, provenance line), but the answer is
 * POSTed to `/sessions/{id}/ssh/approvals/{approval_id}` via
 * `klient.rest.ssh.submitApproval`. The card never carries
 * `[data-approval-id]`, so the session-wide y/n shortcut (generic route)
 * cannot target it.
 */

import { useEffect, useRef, useState } from 'react';
import { useMatch } from 'react-router-dom';

import type { SshApprovalSubmit } from '@kiki/protocol';
import type { ApprovalBlock } from '@kiki/session-core/session';

import { useI18n } from '../../i18n';
import { sshApi } from '../../lib/ssh';
import { useConnection } from '../../state/connection';

import { SshApprovalBody, sshTitleKey, type SshApprovalInfo } from './SshApprovalBody';

export function SshApprovalCard({ block, ssh, originAgentName }: {
  block: ApprovalBlock;
  ssh: SshApprovalInfo;
  originAgentName?: string;
}) {
  const { client } = useConnection();
  const { t, time } = useI18n();
  // Live-projected requests can arrive without `session_id`; the open session route owns the card.
  const routeSessionId = useMatch('/s/:id/*')?.params.id;
  const [busy, setBusy] = useState<SshApprovalSubmit['decision'] | null>(null);
  const [failed, setFailed] = useState(false);
  const [answered, setAnswered] = useState<SshApprovalSubmit['decision'] | null>(null);
  const epochRef = useRef(0);
  const approvalId = block.request.approval_id;
  useEffect(() => {
    epochRef.current += 1;
    setBusy(null);
    setFailed(false);
    setAnswered(null);
  }, [approvalId]);
  useEffect(() => () => { epochRef.current += 1; }, []);

  const submit = (body: SshApprovalSubmit) => {
    if (busy !== null || answered !== null) return;
    const epoch = epochRef.current;
    setBusy(body.decision);
    setFailed(false);
    const sessionId = block.request.session_id !== '' ? block.request.session_id : routeSessionId;
    if (sessionId === undefined) { setBusy(null); setFailed(true); return; }
    void sshApi(client).submitApproval(sessionId, approvalId, body)
      .then(() => { if (epochRef.current === epoch) setAnswered(body.decision); })
      .catch(() => { if (epochRef.current === epoch) setFailed(true); })
      .finally(() => { if (epochRef.current === epoch) setBusy(null); });
  };

  return (
    <div data-ssh-approval-id={approvalId} className="anim-enter border-l-2 border-accent py-2 pr-3 pl-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
        <span className="font-medium text-accent-ink">{t(sshTitleKey(ssh))}</span>
        {originAgentName !== undefined ? (
          <span className="text-ink-faint">· {t('ia.fromSubagent', { name: originAgentName })}</span>
        ) : null}
        {expiresSoon(block.request.expires_at) ? (
          <span className="ml-auto text-ink-faint tabular-nums">{time.timeUntil(block.request.expires_at)}</span>
        ) : null}
      </div>
      {answered === null ? (
        <SshApprovalBody
          ssh={ssh}
          action={block.request.action}
          toolName={block.request.tool_name}
          busy={busy}
          failed={failed}
          onSubmit={submit}
        />
      ) : (
        <p role="status" data-ssh-answered={answered} className={`mt-2 text-[13px] font-medium ${answered === 'approved' ? 'text-ink-soft' : 'text-danger'}`}>
          {answered === 'approved' ? t('ia.ssh.sent') : t('ia.resolution.rejected')}
          {t('ia.sentToKikiSuffix')}
        </p>
      )}
    </div>
  );
}

/** Same ten-minute rule as the generic card: a far-off deadline is noise. */
function expiresSoon(expiresAt: string): boolean {
  const left = new Date(expiresAt).getTime() - Date.now();
  return Number.isFinite(left) && left > 0 && left < 10 * 60_000;
}
