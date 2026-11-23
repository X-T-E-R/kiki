import { renderNotificationXml } from '#/agent/task/notificationXml';
import { ErrorCodes, isError2 } from '#/errors';
import type { ReadThreadResult, ThreadActivity, ThreadRef } from './threadCommunication';

const THREAD_MESSAGE_PROTOCOL_MAX_CHARS = 100_000;
const TRUNCATED_SUFFIX = '\n... [truncated to thread message limit]';

const UNRECOVERABLE_ERROR_CODES = new Set<string>([
  ErrorCodes.THREAD_DISABLED,
  ErrorCodes.THREAD_NOT_FOUND,
  ErrorCodes.THREAD_ARCHIVED,
  ErrorCodes.THREAD_CROSS_HOST,
  ErrorCodes.REQUEST_INVALID,
]);

const UNRECOVERABLE_REASON_TOKENS = [
  'bridge_revoked',
  'bridge_operation_denied',
  'bridge_not_authorized',
  'bridge_expired',
  'bridge_identity_mismatch',
  'bridge_source_scope',
  'bridge_target_scope',
  'inbound_disabled',
  'workspace_disabled',
  'thread_not_found',
  'thread_archived',
  'connection_not_approved',
  'identity_changed',
] as const;

export function extractTerminalPreview(readResult: ReadThreadResult): string | undefined {
  let raw = '';
  if (readResult.turns.length > 0) {
    raw = readResult.turns.at(-1)!.output.trim();
  } else {
    const items = readResult.view?.transcript?.items;
    if (Array.isArray(items)) {
      const lastTurn = items.findLast((item) => item.kind === 'turn');
      if (lastTurn !== undefined && lastTurn.kind === 'turn') {
        const parts: string[] = [];
        for (const step of lastTurn.steps) {
          for (const frame of step.frames) {
            if (frame.kind === 'text' && frame.role === 'assistant' && frame.text.length > 0) {
              parts.push(frame.text);
            }
          }
        }
        raw = parts.join('\n').trim();
        if (raw.length === 0 && typeof lastTurn.error === 'string' && lastTurn.error.trim().length > 0) {
          raw = `Error: ${lastTurn.error.trim()}`;
        }
      }
    }
  }
  return raw.length > 0 ? raw : undefined;
}

export function formatTerminalWatchMessage(
  target: ThreadRef,
  activities: readonly ThreadActivity[],
  preview?: string,
  previewError?: string,
  options?: { readonly notificationId?: string; readonly agentId?: string },
): string {
  const primary =
    activities.findLast((entry) => entry.kind === 'terminal') ??
    activities.findLast((entry) => entry.kind === 'lifecycle' && (entry.reason === 'deleted' || entry.reason === 'archived')) ??
    activities.findLast((entry) => entry.kind === 'attention') ??
    activities.at(-1)!;
  const scopeParts = [
    `session=${target.sessionId}`,
    `host=${target.hostId}`,
    `workspace=${target.workspaceId}`,
  ];
  if (target.bridgeId !== undefined) scopeParts.push(`bridge=${target.bridgeId}`);
  const header = `[Thread watch] Target thread (${scopeParts.join(', ')}) emitted ${primary.kind} (${primary.reason}).`;
  const lines = [header];
  if (primary.kind === 'attention') {
    lines.push('The target thread is waiting for attention (approval or question) and requires follow-up.');
  }
  if (preview !== undefined && preview.length > 0) {
    lines.push('', 'Latest output:', preview);
  } else if (previewError !== undefined && previewError.length > 0) {
    lines.push('', `Latest output unavailable: ${previewError}`);
  }
  const type = primary.kind === 'attention' ? 'thread.attention' : 'thread.terminal';
  const severity =
    primary.kind === 'attention' || primary.reason === 'failed' || primary.reason === 'cancelled' || primary.reason === 'deleted'
      ? 'warning'
      : 'info';
  const title =
    primary.kind === 'attention'
      ? `Thread needs attention (${target.sessionId})`
      : `Thread ${primary.reason} (${target.sessionId})`;
  const render = (body: string): string =>
    renderNotificationXml({
      id: options?.notificationId ?? `thread-watch:${target.sessionId}:${primary.seq}`,
      category: 'thread',
      type,
      source_kind: 'thread',
      source_id: target.sessionId,
      agent_id: options?.agentId,
      title,
      severity,
      body,
    });
  const fullBody = lines.join('\n');
  const full = render(fullBody);
  if (full.length <= THREAD_MESSAGE_PROTOCOL_MAX_CHARS) return full;
  const overhead = render('').length + TRUNCATED_SUFFIX.length;
  const allowedBodyChars = Math.max(0, THREAD_MESSAGE_PROTOCOL_MAX_CHARS - overhead);
  return render(`${fullBody.slice(0, allowedBodyChars)}${TRUNCATED_SUFFIX}`);
}

export function formatWatchStoppedMessage(
  target: ThreadRef,
  reason: string,
  options?: { readonly notificationId?: string; readonly agentId?: string },
): string {
  return renderNotificationXml({
    id: options?.notificationId ?? `thread-watch-stop:${target.sessionId}`,
    category: 'thread',
    type: 'thread.watch_stopped',
    source_kind: 'thread',
    source_id: target.sessionId,
    agent_id: options?.agentId,
    title: `Thread watch stopped (${target.sessionId})`,
    severity: 'warning',
    body: `[Thread watch] Stopped watching target thread (session=${target.sessionId}, host=${target.hostId}, workspace=${target.workspaceId}): ${reason}`,
  });
}

export function isUnrecoverableWatchError(error: unknown): boolean {
  if (isError2(error) && UNRECOVERABLE_ERROR_CODES.has(error.code)) {
    return true;
  }
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 400 || status === 401 || status === 403 || status === 404 || status === 410) {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return UNRECOVERABLE_REASON_TOKENS.some((token) => message.includes(token));
}

export function isCursorInvalidWatchError(error: unknown): boolean {
  if (isError2(error) && error.code === ErrorCodes.THREAD_CURSOR_INVALID) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Activity cursor') || message.includes('cursor');
}

export function extractResyncCursor(error: unknown): string | undefined {
  if (!isError2(error) || error.code !== ErrorCodes.THREAD_CURSOR_INVALID) return undefined;
  const details = error.details;
  if (details !== null && typeof details === 'object' && 'resyncCursor' in details) {
    const candidate = (details as { resyncCursor?: unknown }).resyncCursor;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}
