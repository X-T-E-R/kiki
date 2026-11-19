import type { ContentRef, ContentSource } from '@kiki/transcript';
import type {
  Block,
  SessionViewState,
  ShellBlock,
  ToolBlock,
} from '@kiki/session-core/session/transcript/types';

import type { ToolContinuationStatus } from '#/tui/types';
import { isAbortError } from '#/utils/errors';

const MAX_RANGE_CONTINUATION_CHARS = 65_536;

export interface ToolLookupEntry {
  readonly status: 'found' | 'not_found' | 'preparing';
  readonly frame?: {
    readonly note?: string;
  };
}

export interface ContentContinuationController {
  beginContentRead(
    agentId: string,
    source: ContentSource,
    roots: readonly string[],
  ): { release(): void; retry(): void };
  contentRefsFor(agentId: string, source: ContentSource): readonly ContentRef[];
  isContentRange(agentId: string, ref: ContentRef): boolean;
  readContentRange(
    agentId: string,
    ref: ContentRef,
    offset: number,
    signal?: AbortSignal,
  ): Promise<string>;
  loadTranscriptDetail(agentId: string, kind: 'task', id: string): Promise<boolean>;
  lookupToolCall(
    agentId: string,
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<ToolLookupEntry>;
  getToolCallDetail(agentId: string, toolCallId: string): ToolLookupEntry | undefined;
  getContentRevision(): number;
}

export interface ResolvedBlockContinuationMeta {
  readonly note?: string;
  readonly rangeSuffix?: string;
  readonly continuationStatus?: ToolContinuationStatus;
}

interface RangeFetchState {
  readonly revision: string;
  loadedEnd: number;
  readonly total: number;
  text: string;
  loading: boolean;
  error?: string;
  controller?: AbortController;
}

export class DaemonContentContinuationManager {
  private controller: ContentContinuationController | undefined;
  private agentId = 'main';
  private expanded = false;
  private readonly leases = new Map<string, { release(): void; retry(): void }>();
  private readonly requestedLookups = new Set<string>();
  private readonly requestedTaskDetails = new Set<string>();
  private readonly rangeStates = new Map<string, RangeFetchState>();
  private localRevision = 0;
  private readonly onLocalChange: (() => void) | undefined;

  constructor(onLocalChange?: () => void) {
    this.onLocalChange = onLocalChange;
  }

  getRevision(): number {
    return (this.controller?.getContentRevision() ?? 0) * 1024 + (this.localRevision % 1024);
  }

  setTarget(controller: ContentContinuationController | undefined, agentId: string): void {
    if (this.controller === controller && this.agentId === agentId) return;
    this.releaseExpansionLeases();
    this.requestedLookups.clear();
    this.requestedTaskDetails.clear();
    this.controller = controller;
    this.agentId = agentId;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    if (!expanded) {
      this.releaseExpansionLeases();
    }
  }

  dispose(): void {
    this.releaseExpansionLeases();
    this.requestedLookups.clear();
    this.controller = undefined;
  }

  syncBlocks(
    blocks: readonly Block[],
    detailLoads: SessionViewState['detailLoads'] = {},
  ): void {
    const controller = this.controller;
    if (controller === undefined) return;
    const agentId = this.agentId;

    for (const block of blocks) {
      if (block.kind === 'tool' && block.status !== 'running') {
        const lookupKey = `${agentId}/${block.toolCallId}:${block.status}`;
        if (!this.requestedLookups.has(lookupKey)) {
          this.requestedLookups.add(lookupKey);
          void controller.lookupToolCall(agentId, block.toolCallId).catch((error: unknown) => {
            if (this.controller === controller && !isAbortError(error)) {
              this.requestedLookups.delete(lookupKey);
            }
          });
        }
      } else if (block.kind === 'shell' && block.done) {
        const lookupKey = `${agentId}/${block.commandId}:done`;
        if (!this.requestedLookups.has(lookupKey)) {
          this.requestedLookups.add(lookupKey);
          void controller.lookupToolCall(agentId, block.commandId).catch((error: unknown) => {
            if (this.controller === controller && !isAbortError(error)) {
              this.requestedLookups.delete(lookupKey);
            }
          });
        }
      }
    }

    if (!this.expanded) {
      if (this.leases.size > 0 || this.rangeStates.size > 0 || this.requestedTaskDetails.size > 0) {
        this.releaseExpansionLeases();
      }
      return;
    }

    const retainKeys = new Set<string>();
    const retainRanges = new Set<string>();

    for (const block of blocks) {
      if (block.kind === 'tool' && block.frameId !== undefined) {
        const source = frameSource(block.frameId, block.turnId, block.stepId);
        const key = sourceLeaseKey(agentId, source, 'tool');
        const refs = controller.contentRefsFor(agentId, source);
        if (block.outputPending === true || refs.length > 0 || this.leases.has(key)) {
          retainKeys.add(key);
          this.acquireLease(controller, agentId, key, source, ['output', 'error', 'note']);
        }
        const rangeRef = refs.find(
          (ref) =>
            (ref.path[0] === 'output' || ref.path[0] === 'error') &&
            controller.isContentRange(agentId, ref),
        );
        if (rangeRef !== undefined) {
          const rKey = rangeStateKey(agentId, rangeRef);
          retainRanges.add(rKey);
          this.ensureRangeRead(controller, agentId, rKey, rangeRef);
        }
      } else if (block.kind === 'shell') {
        if (block.frameId !== undefined) {
          const source = frameSource(block.frameId, block.turnId, block.stepId);
          const key = sourceLeaseKey(agentId, source, 'shell');
          const refs = controller.contentRefsFor(agentId, source);
          if (refs.length > 0 || this.leases.has(key)) {
            retainKeys.add(key);
            this.acquireLease(controller, agentId, key, source, ['output', 'error', 'note']);
          }
          const rangeRef = refs.find(
            (ref) => ref.path[0] === 'output' && controller.isContentRange(agentId, ref),
          );
          if (rangeRef !== undefined) {
            const rKey = rangeStateKey(agentId, rangeRef);
            retainRanges.add(rKey);
            this.ensureRangeRead(controller, agentId, rKey, rangeRef);
          }
        }
        if (block.outputTaskId !== undefined) {
          const taskSource: ContentSource = { kind: 'task', id: block.outputTaskId };
          const key = sourceLeaseKey(agentId, taskSource, 'taskTail');
          const refs = controller.contentRefsFor(agentId, taskSource);
          if (refs.length > 0 || this.leases.has(key)) {
            retainKeys.add(key);
            this.acquireLease(controller, agentId, key, taskSource, ['outputTail']);
          }
        }
        if (block.outputDetail !== undefined) {
          const detailKey = `task:${block.outputDetail.taskId}`;
          const loadState = detailLoads[detailKey];
          const triggerKey = `${block.outputDetail.agentId}/${detailKey}`;
          if (!this.requestedTaskDetails.has(triggerKey) && loadState?.status !== 'loading') {
            this.requestedTaskDetails.add(triggerKey);
            void controller
              .loadTranscriptDetail(block.outputDetail.agentId, 'task', block.outputDetail.taskId)
              .catch((error: unknown) => {
                if (this.controller === controller && !isAbortError(error)) {
                  this.requestedTaskDetails.delete(triggerKey);
                }
              });
          }
        }
      } else if (block.kind === 'thinking' && block.frameId !== undefined) {
        const source = frameSource(block.frameId, block.turnId, block.stepId);
        const key = sourceLeaseKey(agentId, source, 'thinking');
        const refs = controller.contentRefsFor(agentId, source);
        if (refs.length > 0 || this.leases.has(key)) {
          retainKeys.add(key);
          this.acquireLease(controller, agentId, key, source, ['text']);
        }
      }
    }

    for (const [key, lease] of this.leases) {
      if (retainKeys.has(key)) continue;
      lease.release();
      this.leases.delete(key);
    }
    for (const [rKey, state] of this.rangeStates) {
      if (retainRanges.has(rKey)) continue;
      state.controller?.abort();
      this.rangeStates.delete(rKey);
    }
  }

  resolveBlockMeta(
    block: ToolBlock | ShellBlock,
    detailLoads: SessionViewState['detailLoads'] = {},
  ): ResolvedBlockContinuationMeta | undefined {
    const controller = this.controller;
    if (controller === undefined) return undefined;
    const agentId = this.agentId;
    const toolCallId = block.kind === 'tool' ? block.toolCallId : block.commandId;
    const detail = controller.getToolCallDetail(agentId, toolCallId);
    const note = detail?.status === 'found' ? detail.frame?.note : undefined;

    if (!this.expanded) {
      return note === undefined ? undefined : { note };
    }

    let rangeSuffix: string | undefined;
    let continuationStatus: ToolContinuationStatus | undefined;

    if (block.frameId !== undefined) {
      const source = frameSource(block.frameId, block.turnId, block.stepId);
      const refs = controller.contentRefsFor(agentId, source).filter(
        (ref) => ref.path[0] === 'output' || ref.path[0] === 'error' || ref.path[0] === 'note',
      );
      for (const ref of refs) {
        const load = detailLoads[`content:${JSON.stringify(ref)}`];
        if (load?.status === 'error') {
          continuationStatus = { state: 'error', message: load.message };
          break;
        }
        if (controller.isContentRange(agentId, ref)) {
          const rState = this.rangeStates.get(rangeStateKey(agentId, ref));
          if (rState !== undefined) {
            if (rState.text.length > 0) rangeSuffix = rState.text;
            if (rState.error !== undefined) {
              continuationStatus = { state: 'error', message: rState.error };
            } else if (rState.loading) {
              continuationStatus = { state: 'loading' };
            } else if (rState.loadedEnd < rState.total) {
              continuationStatus = {
                state: 'partial',
                loaded: rState.loadedEnd,
                total: rState.total,
              };
            }
          } else {
            continuationStatus = { state: 'loading' };
          }
          continue;
        }
        continuationStatus ??= { state: 'loading' };
      }
    }

    if (continuationStatus === undefined && block.kind === 'tool' && block.outputPending === true) {
      continuationStatus = { state: 'loading' };
    }

    if (continuationStatus === undefined && block.kind === 'shell' && block.outputDetail !== undefined) {
      const load = detailLoads[`task:${block.outputDetail.taskId}`];
      if (load?.status === 'error') {
        continuationStatus = { state: 'error', message: load.message };
      } else if (load?.status === 'loading') {
        continuationStatus = { state: 'loading' };
      }
    }

    if (note === undefined && rangeSuffix === undefined && continuationStatus === undefined) {
      return undefined;
    }
    return { note, rangeSuffix, continuationStatus };
  }

  private acquireLease(
    controller: ContentContinuationController,
    agentId: string,
    key: string,
    source: ContentSource,
    roots: readonly string[],
  ): void {
    if (this.leases.has(key)) return;
    this.leases.set(key, controller.beginContentRead(agentId, source, roots));
  }

  private ensureRangeRead(
    controller: ContentContinuationController,
    agentId: string,
    key: string,
    ref: ContentRef,
  ): void {
    const existing = this.rangeStates.get(key);
    if (existing !== undefined && existing.revision === ref.revision) return;
    existing?.controller?.abort();
    const abortController = new AbortController();
    const state: RangeFetchState = {
      revision: ref.revision,
      loadedEnd: ref.offset,
      total: ref.total,
      text: '',
      loading: true,
      controller: abortController,
    };
    this.rangeStates.set(key, state);
    void (async () => {
      try {
        let offset = ref.offset;
        const limit = Math.min(ref.total, ref.offset + MAX_RANGE_CONTINUATION_CHARS);
        while (offset < limit && !abortController.signal.aborted) {
          const chunk = await controller.readContentRange(
            agentId,
            ref,
            offset,
            abortController.signal,
          );
          if (abortController.signal.aborted) return;
          if (chunk.length === 0) break;
          state.text += chunk;
          offset += chunk.length;
        }
        state.loadedEnd = offset;
        state.loading = false;
      } catch (error) {
        if (abortController.signal.aborted) return;
        state.loading = false;
        state.error = error instanceof Error ? error.message : 'Could not load output range.';
      }
      this.bumpLocalRevision();
    })();
  }

  private releaseExpansionLeases(): void {
    for (const lease of this.leases.values()) {
      lease.release();
    }
    this.leases.clear();
    for (const state of this.rangeStates.values()) {
      state.controller?.abort();
    }
    this.rangeStates.clear();
    this.requestedTaskDetails.clear();
  }

  private bumpLocalRevision(): void {
    this.localRevision += 1;
    this.onLocalChange?.();
  }
}

function frameSource(frameId: string, turnId?: string, stepId?: string): ContentSource {
  return {
    kind: 'frame',
    id: frameId,
    turnId,
    stepId,
  };
}

function sourceLeaseKey(agentId: string, source: ContentSource, tag: string): string {
  if (source.kind === 'frame') {
    return `${agentId}:${tag}:frame:${source.turnId ?? ''}:${source.stepId ?? ''}:${source.id}`;
  }
  return `${agentId}:${tag}:${source.kind}:${source.id}`;
}

function rangeStateKey(agentId: string, ref: ContentRef): string {
  return JSON.stringify([agentId, ref.source, ref.path]);
}
