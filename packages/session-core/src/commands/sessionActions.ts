/**
 * Session actions shared by the sidebar context menu and the session header
 * overflow menu: fork / undo / export / compact. Each one is a real
 * kap-server route — see `packages/protocol/src/rest/session.ts` and
 * kap-server `routes/sessionExport.ts`.
 */

import type { Session } from '@moonshot-ai/protocol';

import { translate, type I18nKey, type Locale } from '../i18n/locale';
import { API_CODES, ApiError } from '../transport';

export interface SessionActionClient {
  forkSession(sessionId: string, body: Record<string, never>): Promise<Session>;
  undoSession(sessionId: string, body: { readonly count: number }): Promise<unknown>;
  compactSession(sessionId: string, body: Record<string, never>): Promise<unknown>;
  exportSession(sessionId: string): Promise<{ blob: Blob; filename: string }>;
}

export interface SessionActionHost {
  saveBlob?: (blob: Blob, filename: string) => Promise<boolean>;
}

export interface SessionActionContext {
  client: SessionActionClient;
  host: SessionActionHost;
  refreshSessions: () => void;
  navigate: (path: string) => void;
}

/**
 * Dispatched after an action rewrote a session's history (undo). The open
 * SessionView resyncs its controller so the transcript matches the server.
 */
export const SESSION_REWRITTEN_EVENT = 'kiki:session-rewritten';

export function notifySessionRewritten(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(SESSION_REWRITTEN_EVENT, { detail: { sessionId } }));
}

/** Fork → open the copy. The sidebar list catches up via invalidation. */
export async function forkSession(ctx: SessionActionContext, session: Session): Promise<void> {
  const fork = await ctx.client.forkSession(session.id, {});
  ctx.refreshSessions();
  ctx.navigate(`/s/${fork.id}`);
}

/** Undo the last turn (user message + agent reply). Server: 40911 when empty. */
export async function undoLastTurn(ctx: SessionActionContext, session: Session): Promise<void> {
  await ctx.client.undoSession(session.id, { count: 1 });
  ctx.refreshSessions();
  notifySessionRewritten(session.id);
}

/**
 * Compact older context into a summary. The transcript itself is unchanged
 * (compaction is context-level), so no resync is triggered.
 */
export async function compactSessionContext(
  ctx: SessionActionContext,
  session: Session,
): Promise<void> {
  await ctx.client.compactSession(session.id, {});
  ctx.refreshSessions();
}

/**
 * Export the diagnostic archive. The desktop build asks for a destination via
 * the native save dialog and writes through tauri-plugin-fs; the browser build
 * keeps the blob download. Resolves `true` when the archive was saved, `false`
 * when the user cancelled the save dialog.
 */
export async function exportSessionArchive(
  ctx: SessionActionContext,
  session: Session,
): Promise<boolean> {
  const { blob, filename } = await ctx.client.exportSession(session.id);
  if (ctx.host.saveBlob !== undefined) {
    return ctx.host.saveBlob(blob, filename);
  }
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Defer revocation so the download stack has materialized the blob.
    setTimeout(() => { URL.revokeObjectURL(url); }, 10_000);
  }
  return true;
}

/** Maps wire error codes to dictionary keys; null when there is no local copy. */
export function sessionActionErrorKey(error: unknown): I18nKey | null {
  if (error instanceof ApiError) {
    switch (error.code) {
      case API_CODES.SESSION_UNDO_UNAVAILABLE:
        return 'error.nothingToUndo';
      case API_CODES.COMPACTION_UNABLE:
        return 'error.nothingToCompact';
      case API_CODES.SESSION_BUSY:
        return 'error.sessionBusy';
      case API_CODES.MESSAGE_ACTION_UNAVAILABLE:
        return 'error.messageActionUnavailable';
      case API_CODES.SESSION_CURSOR_MISMATCH:
        return 'error.sessionCursorMismatch';
      default:
        return null;
    }
  }
  return null;
}

/** Maps wire error codes to plain copy; falls back to the envelope message. */
export function sessionActionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case API_CODES.SESSION_UNDO_UNAVAILABLE:
        return 'Nothing to undo — there is no earlier turn to roll back to.';
      case API_CODES.COMPACTION_UNABLE:
        return 'Nothing to compact yet — the history is too short.';
      case API_CODES.SESSION_BUSY:
        return 'The session is busy — try again when the current turn finishes.';
      case API_CODES.MESSAGE_ACTION_UNAVAILABLE:
        return 'This message can no longer be edited or rerun.';
      case API_CODES.SESSION_CURSOR_MISMATCH:
        return 'This session was updated elsewhere — review the latest state, then try again.';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** Localized detail for an action failure: dictionary copy, else the raw message. */
export function sessionActionErrorText(locale: Locale, error: unknown): string {
  const key = sessionActionErrorKey(error);
  return key === null ? sessionActionErrorMessage(error) : translate(locale, key);
}
