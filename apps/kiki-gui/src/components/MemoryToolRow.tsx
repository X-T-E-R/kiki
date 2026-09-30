/**
 * Memory in the timeline — one quiet line, never a card.
 *
 * A `MemoryWrite` result reads `Remembered · <title> · View · Undo`: the verb
 * says what happened, View opens the entry on /memory, and Undo replays the
 * journal's before-image through `POST /memory/{scope}/undo`. Reads and
 * searches use the same line with their own verb and no actions. The row
 * expands to the write's reason (and the raw payload for a read), because the
 * reason is the only part a user may want to check without leaving the turn.
 *
 * Undoing a workspace-scoped write needs the session's workspace id, which is
 * resolved on click (`getSession`) rather than threaded through the transcript.
 */

import { useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';
import { isMemoryToolName } from '@kiki/session-core/session';
import type { ToolBlock } from '@kiki/session-core/session';

import { useI18n } from '../i18n';
import { ApiError, MEMORY_REVISION_CONFLICT, type MemoryScopeKind } from '../lib/client';
import { pushToast } from '../lib/toasts';
import { useOptionalConnection } from '../state/connection';
import { DisclosureChevron, Icon } from './icons';
import { useGuardedNavigate } from './dirtyGuard';
import { useMediaPreview } from './mediaPreviewContext';

// The tool-name predicate lives with the grouping rule that exempts these
// tools from step folding, so the two can never disagree.
export { isMemoryToolName } from '@kiki/session-core/session';

interface MemoryWriteResult {
  readonly id: string;
  readonly title: string;
  readonly scope: MemoryScopeKind;
  readonly status: string;
  readonly revision: string;
  readonly operation_id: string;
}

/** `MemoryWrite`'s JSON result, or undefined when the call has not landed. */
export function parseMemoryWriteResult(output: unknown): MemoryWriteResult | undefined {
  if (typeof output !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const value = parsed as Record<string, unknown>;
  if (typeof value['id'] !== 'string' || typeof value['title'] !== 'string') return undefined;
  if (value['scope'] !== 'global' && value['scope'] !== 'workspace') return undefined;
  return {
    id: value['id'],
    title: value['title'],
    scope: value['scope'],
    status: typeof value['status'] === 'string' ? value['status'] : 'active',
    revision: typeof value['revision'] === 'string' ? value['revision'] : '',
    operation_id: typeof value['operation_id'] === 'string' ? value['operation_id'] : '',
  };
}

/** How many hits a `MemorySearch` / `MemoryRead` result carries. */
function resultCount(output: unknown): number | undefined {
  if (typeof output !== 'string') return undefined;
  try {
    const parsed = JSON.parse(output) as unknown;
    return Array.isArray(parsed) ? parsed.length : undefined;
  } catch {
    return undefined;
  }
}

const ROW =
  'group/step -mx-2 flex min-h-7 w-[calc(100%+1rem)] min-w-0 items-center gap-2 rounded-md px-2 py-0.5 text-left transition-colors duration-[var(--kiki-motion-quick)] hover:bg-panel';

export function MemoryToolRow({ block }: { readonly block: ToolBlock }) {
  const { t, tp, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const connection = useOptionalConnection();
  const sessionId = useMediaPreview()?.sessionId;
  const [expanded, setExpanded] = useState(false);
  const [undone, setUndone] = useState(false);
  const [undoing, setUndoing] = useState(false);

  const write = block.name === 'MemoryWrite' ? parseMemoryWriteResult(block.output) : undefined;
  const failed = block.status === 'error' || block.isError === true;
  const running = block.status === 'running';
  const args = (block.args ?? {}) as Record<string, unknown>;
  const reason = typeof args['reason'] === 'string' ? args['reason'] : undefined;

  // The verb carries the whole meaning of the line, so it is the one thing
  // that changes per action and state.
  const verb = failed
    ? block.name
    : running
      ? t(block.name === 'MemoryWrite' ? 'memory.tool.writing' : 'memory.tool.read')
      : block.name === 'MemoryWrite'
        ? write?.status === 'pending'
          ? t('memory.tool.pending')
          : t(
              args['action'] === 'archive' ? 'memory.tool.archived'
              : args['action'] === 'supersede' ? 'memory.tool.replaced'
              : args['action'] === 'update' ? 'memory.tool.updated'
              : 'memory.tool.remembered',
            )
        : block.name === 'MemoryRead'
          ? t('memory.tool.read')
          : t('memory.tool.searched');

  const hits = block.name === 'MemoryWrite' ? undefined : resultCount(block.output);
  const detail = failed
    ? typeof block.output === 'string' ? block.output.split('\n', 1)[0] : undefined
    : write?.title
      ?? (typeof args['query'] === 'string' ? args['query'] : undefined)
      ?? (hits !== undefined ? tp('memory.tool.hits', hits) : undefined);

  const scopeTarget = write === undefined
    ? undefined
    : write.scope === 'global'
      ? { scope: 'global' as const }
      : undefined;

  /** Workspace-scoped rows need the session's workspace id; resolve on demand. */
  const resolveWorkspaceId = async (): Promise<string | undefined> => {
    if (connection === null || sessionId === undefined) return undefined;
    return (await connection.client.getSession(sessionId)).workspace_id;
  };

  const openEntry = () => {
    if (write === undefined) return;
    if (write.scope === 'global') {
      navigate('/memory');
      return;
    }
    void resolveWorkspaceId()
      .then((workspaceId) => {
        navigate(workspaceId === undefined ? '/memory' : `/memory?workspace=${encodeURIComponent(workspaceId)}`);
      })
      .catch(() => { navigate('/memory'); });
  };

  const runUndo = async () => {
    if (write === undefined || connection === null) return;
    setUndoing(true);
    try {
      let target = scopeTarget as { scope: MemoryScopeKind; workspaceId?: string } | undefined;
      if (target === undefined) {
        const workspaceId = await resolveWorkspaceId();
        if (workspaceId === undefined) throw new Error(t('memory.scopeTag.workspace'));
        target = { scope: 'workspace', workspaceId };
      }
      await connection.client.undoMemory(target, write.operation_id);
      setUndone(true);
    } catch (error) {
      pushToast({
        tone: 'error',
        text: error instanceof ApiError && error.code === MEMORY_REVISION_CONFLICT
          ? t('memory.tool.undoConflict')
          : t('memory.tool.undoFailed', { detail: errorText(locale, error) }),
      });
    } finally {
      setUndoing(false);
    }
  };

  return (
    <div data-tool data-memory-tool={block.name} data-tool-id={block.toolCallId} className="anim-enter">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          data-memory-tool-toggle
          onClick={() => { setExpanded((value) => !value); }}
          aria-expanded={expanded}
          className={ROW}
        >
          {/* Same 18px glyph column as every activity row, so the spark lands
              on the timeline's one icon axis. */}
          <span aria-hidden className={`flex h-4 w-[18px] shrink-0 items-center justify-center ${failed ? 'text-danger' : 'text-ink-faint'}`}>
            <Icon name="memory" />
          </span>
          <span className={`shrink-0 text-[13px] font-medium ${failed ? 'text-danger' : 'text-ink'}`}>{verb}</span>
          {detail !== undefined ? (
            <span className={`min-w-0 flex-1 truncate text-[12px] ${failed ? 'text-danger' : 'text-ink-soft'}`}>{detail}</span>
          ) : (
            <span className="flex-1" />
          )}
          {write !== undefined ? (
            <span data-memory-tool-scope className="shrink-0 text-[12px] text-ink-faint">
              {t(write.scope === 'global' ? 'memory.scopeTag.global' : 'memory.scopeTag.workspace')}
            </span>
          ) : null}
          <DisclosureChevron
            open={expanded}
            className={`text-ink-faint ${expanded ? '' : 'opacity-0 group-hover/step:opacity-100 group-focus-visible/step:opacity-100'}`}
          />
        </button>
        {write !== undefined && !failed ? (
          <span className="flex shrink-0 items-center gap-2 text-[12px]">
            <button
              type="button"
              data-memory-tool-view
              onClick={openEntry}
              className="text-ink-soft underline underline-offset-2 transition-colors hover:text-ink"
            >
              {t('memory.tool.view')}
            </button>
            {undone ? (
              <span data-memory-tool-undone role="status" className="text-ink-faint">{t('memory.tool.undone')}</span>
            ) : write.operation_id !== '' ? (
              <button
                type="button"
                data-memory-tool-undo
                disabled={undoing}
                onClick={() => { void runUndo(); }}
                className="text-ink-soft underline underline-offset-2 transition-colors hover:text-ink disabled:opacity-60"
              >
                {t('memory.tool.undo')}
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      {expanded ? (
        <div className="space-y-1 pt-0.5 pb-1.5 pl-6 text-[12px] leading-relaxed">
          {reason !== undefined ? (
            <p className="text-ink-soft">
              <span className="text-ink-faint">{t('memory.tool.reason')}: </span>
              {reason}
            </p>
          ) : null}
          {typeof args['body'] === 'string' ? (
            <p className="text-ink-soft">{args['body']}</p>
          ) : null}
          {block.name !== 'MemoryWrite' && typeof block.output === 'string' && block.output !== '' ? (
            <pre className="max-h-40 overflow-auto rounded-md bg-panel px-3 py-1.5 font-mono text-[12px] whitespace-pre-wrap text-ink-soft">
              {block.output.slice(0, 2_000)}
            </pre>
          ) : null}
          {failed && typeof block.output === 'string' ? (
            <p className="text-danger">{block.output}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
