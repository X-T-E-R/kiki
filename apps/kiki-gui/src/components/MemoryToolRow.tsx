/**
 * Memory in the timeline — one quiet line, never a card.
 *
 * A `MemoryWrite` result reads `Remembered · <title> · View · Undo`: the verb
 * says what happened, View opens the entry on /memory, and Undo replays the
 * journal's before-image through `POST /memory/{scope}/undo`. Reads and
 * searches use the same line with their own verb and no actions. One expansion
 * reads the recorded input and receipt through the shared frame reader; View
 * remains a separate action for the entry's current state.
 *
 * Three outcomes read differently, because they are different facts: a write
 * that stored something, a proposal waiting in the inbox, and a write whose
 * content already matched. Undo requires a real operation ID; an unchanged
 * write or a repeated pending proposal has nothing new to replay. View follows
 * the receipt's own owning scope and entry ID. Only old workspace receipts
 * without an owner ID resolve the session's workspace on click.
 */

import { useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';
import { isMemoryToolName } from '@kiki/session-core/session';
import type { ToolBlock } from '@kiki/session-core/session';

import { useI18n } from '../i18n';
import { ApiError, MEMORY_REVISION_CONFLICT, type MemoryTarget } from '../lib/client';
import { pushToast } from '../lib/toasts';
import { useOptionalConnection } from '../state/connection';
import { DisclosureChevron, Icon } from './icons';
import { useGuardedNavigate } from './dirtyGuard';
import { useMediaPreview } from './mediaPreviewContext';
import { frameContentSource, OUTPUT_ROOTS } from './ContentContinuation';
import { useContentContinuation } from './transcriptDetail';
import { ToolRecordField } from './timeline/ToolRecordField';
import { useFindReveal } from './timeline/findReveal';
import { useMemoryWriteReceipt } from './memory/useMemoryWriteReceipt';
import {
  parseMemoryReadResult,
  parseMemorySearchSummary,
  type MemoryOwnerScope,
} from './memory/memoryReceipt';

// The tool-name predicate lives with the grouping rule that exempts these
// tools from step folding, so the two can never disagree.
export { isMemoryToolName } from '@kiki/session-core/session';

/**
 * Re-exported so the transcript's own tests and any other reader of a write
 * result share this one parser. Old receipts without `outcome` still parse.
 */
export { parseMemoryWriteResult, parseMemorySearchSummary, parseMemoryReadResult } from './memory/memoryReceipt';

const ROW =
  'group/step -mx-2 flex min-h-7 w-[calc(100%+1rem)] min-w-0 items-center gap-2 rounded-md px-2 py-0.5 text-left transition-colors duration-[var(--kiki-motion-quick)] hover:bg-panel';

/** What a read or search line says about its own result. */
function resultSummary(output: unknown, name: string | undefined): { readonly text: string; readonly partial: boolean; readonly hasMore: boolean } | undefined {
  if (name === 'MemorySearch') {
    const summary = parseMemorySearchSummary(output);
    if (summary === undefined) return undefined;
    return { text: String(summary.count), partial: summary.partial, hasMore: summary.hasMore };
  }
  const read = parseMemoryReadResult(output);
  if (read === undefined) return undefined;
  return { text: String(read.items.length), partial: !read.complete, hasMore: false };
}

export function MemoryToolRow({ block, agentId = 'main' }: { readonly block: ToolBlock; readonly agentId?: string }) {
  const { t, tp, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const connection = useOptionalConnection();
  const sessionId = useMediaPreview()?.sessionId;
  const [expanded, setExpanded] = useState(false);
  useFindReveal(block.id, expanded, setExpanded);
  const [undone, setUndone] = useState(false);
  const [undoing, setUndoing] = useState(false);

  const { receipt: write, failed: receiptFailed, retry: retryReceipt } = useMemoryWriteReceipt(block, agentId, expanded);
  const failed = block.status === 'error' || block.isError === true;
  const running = block.status === 'running';
  const args = (block.args ?? {}) as Record<string, unknown>;

  // The verb carries the whole meaning of the line, so it is the one thing
  // that changes per action and state.
  const verb = failed
    ? block.name
    : running
      ? t(block.name === 'MemoryWrite' ? 'memory.tool.writing' : 'memory.tool.read')
      : block.name === 'MemoryWrite'
        ? write?.outcome === 'pending'
          ? t('memory.tool.pending')
          : write?.outcome === 'unchanged'
            ? t('memory.tool.unchanged')
            : t(
                args['action'] === 'archive' ? 'memory.tool.archived'
                : args['action'] === 'supersede' ? 'memory.tool.replaced'
                : args['action'] === 'update' ? 'memory.tool.updated'
                : 'memory.tool.remembered',
              )
        : block.name === 'MemoryRead'
          ? t('memory.tool.read')
          : t('memory.tool.searched');

  const { pending } = useContentContinuation(frameContentSource(block), OUTPUT_ROOTS, agentId);
  const summary = write === undefined && !failed && !running && pending.length === 0 ? resultSummary(block.output, block.name) : undefined;
  const hits = summary === undefined
    ? undefined
    : summary.partial ? t('memory.tool.hitsPartial', { count: summary.text })
      : summary.hasMore ? t('memory.tool.hitsMore', { count: summary.text }) : tp('memory.tool.hits', Number(summary.text));
  // A read or search answers a question with a result, not with the question:
  // the count (and whether more pages remain) is the fact the turn turns on, so
  // it takes the line and the query goes to the expanded disclosure.
  const detail = failed
    ? typeof block.output === 'string' ? block.output.split('\n', 1)[0] : undefined
    : write?.title ?? hits;

  /** Only old workspace receipts can borrow the session's workspace. */
  const resolveTarget = async (owner: MemoryOwnerScope): Promise<MemoryTarget | undefined> => {
    if (owner.scope === 'global') return { scope: 'global' };
    if (owner.scope === 'persona') return owner.personaId === undefined ? undefined : { scope: 'persona', personaId: owner.personaId };
    if (owner.scope === 'persona_workspace') return owner.personaId === undefined || owner.workspaceId === undefined
      ? undefined : { scope: 'persona_workspace', workspaceId: owner.workspaceId, personaId: owner.personaId };
    if (owner.workspaceId !== undefined) return { scope: 'workspace', workspaceId: owner.workspaceId };
    if (connection === null || sessionId === undefined) return undefined;
    return { scope: 'workspace', workspaceId: (await connection.client.getSession(sessionId)).workspace_id };
  };

  /** Scope plus ID distinguishes copied entries in shared-memory lists. */
  const openEntry = () => {
    if (write === undefined) return;
    void resolveTarget(write.owner_scope)
      .then((target) => {
        if (target === undefined) throw new Error(t('memory.locationMissing'));
        const params = new URLSearchParams({ entry: write.target.id });
        if (target.workspaceId !== undefined) params.set('workspace', target.workspaceId);
        if (target.personaId !== undefined) params.set('persona', target.personaId);
        if (write.outcome === 'pending') params.set('tab', 'inbox');
        if (write.status === 'archived' || write.status === 'superseded') params.set('inactive', 'true');
        navigate(`/memory?${params}`);
      })
      .catch((error: unknown) => { pushToast({ tone: 'error', text: t('memory.actionFailed', { detail: errorText(locale, error) }) }); });
  };

  const runUndo = async () => {
    if (write === undefined || connection === null || write.operation_id === null) return;
    setUndoing(true);
    try {
      const target = await resolveTarget(write.owner_scope);
      if (target === undefined) throw new Error(t('memory.locationMissing'));
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

  const undoable = write !== undefined && write.outcome !== 'unchanged' && write.operation_id !== null;
  const scopeTag = write === undefined
    ? undefined
    : write.owner_scope.scope === 'global'
      ? t('memory.scopeTag.global')
      : write.owner_scope.scope === 'workspace'
        ? t('memory.scopeTag.workspace')
        : write.owner_scope.scope === 'persona'
          ? t('memory.scopeTag.persona')
          : t('memory.scopeTag.personaWorkspace');

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
          {scopeTag !== undefined ? (
            <span data-memory-tool-scope data-memory-scope-kind={write?.owner_scope.scope} className="shrink-0 text-[12px] text-ink-faint">
              {scopeTag}
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
            ) : undoable ? (
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
        <div className="space-y-2 pt-0.5 pb-1.5 pl-6 text-[12px] leading-relaxed">
          {write !== undefined && write.warnings.length > 0 ? (
            <ul data-memory-tool-warnings className="space-y-0.5 text-amber-ink">
              {write.warnings.map((warning) => (<li key={warning} className="break-words">{warning}</li>))}
            </ul>
          ) : null}
          {write?.outcome === 'unchanged' ? (
            <p data-memory-tool-unchanged className="text-ink-faint">{t('memory.tool.unchangedNote')}</p>
          ) : write?.outcome === 'pending' ? (
            <p data-memory-tool-pending className="text-ink-faint">
              {write.proposed_target === undefined
                ? t('memory.tool.pendingCreate')
                : t('memory.tool.pendingUpdate')}
            </p>
          ) : null}
          {receiptFailed ? <p data-memory-receipt-error role="status" className="text-danger">{t('transcript.content.failed')}<button type="button" onClick={retryReceipt} className="ml-2 underline">{t('common.retry')}</button></p> : null}
          <ToolRecordField block={block} agentId={agentId} field="input" />
          <ToolRecordField block={block} agentId={agentId} field="output" />
        </div>
      ) : null}
    </div>
  );
}
