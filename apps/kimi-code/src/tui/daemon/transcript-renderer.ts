import {
  Container,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type MouseRoutable,
  type SgrMouseEvent,
  type TUI,
} from '@kiki/pi-tui';

import type { MediaRef } from '@kiki/session-core/composer/media';
import {
  effectiveSubagentStatus,
  extractThinkingSummary,
  foldHistory,
  formatThinkingDuration,
  groupBlocks,
  groupHasRunning,
  groupSummary,
  isLiveSubagentStatus,
  isReadStep,
  readSubagentEndings,
  stepObject,
  type AgentForest,
  type DisplayNode,
  type EndingTask,
  type HistoryFold,
  type MediaRun,
  type SubagentGroup,
  type ToolGroup,
} from '@kiki/session-core/session';
import { projectMessageContent } from '@kiki/session-core/session/transcript';
import type {
  Block,
  MessageBlock,
  NoticeBlock,
  ShellBlock,
  SubagentBlock,
  SystemBlock,
  ThinkingBlock,
  ToolBlock,
  UserBlock,
} from '@kiki/session-core/session/transcript/types';

import type { ResolvedBlockContinuationMeta } from './content-continuation';
import { ImageThumbnail } from '#/tui/components/media/image-thumbnail';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import {
  LiveSubagentCardComponent,
  LiveSubagentGroupComponent,
  type LiveSubagentRowData,
} from '#/tui/components/messages/live-subagent-rows';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { UserMessageComponent } from '#/tui/components/messages/user-message';
import { FOLD_COLLAPSED_MARK, FOLD_EXPANDED_MARK } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';
import { parseToolSideChannelNote } from '#/tui/utils/tool-note';
import { parseImageMeta } from '#/utils/image/image-mime';

interface MountedBlock {
  readonly kind: Block['kind'];
  readonly component: Component;
  block: Block;
  metaKey?: string;
}

interface DisclosureScopeState {
  readonly expandedFolds: Set<string>;
  readonly expandedFoldMembers: Set<string>;
  readonly expandedBlocks: Set<string>;
  readonly collapsedLiveGroups: Set<string>;
  readonly thinkingTimings: Map<string, { readonly firstLiveAt: number; settledAt?: number }>;
}

function createDisclosureScope(): DisclosureScopeState {
  return {
    expandedFolds: new Set<string>(),
    expandedFoldMembers: new Set<string>(),
    expandedBlocks: new Set<string>(),
    collapsedLiveGroups: new Set<string>(),
    thinkingTimings: new Map(),
  };
}

export class DaemonTranscriptRenderer {
  private readonly mounted = new Map<string, MountedBlock>();
  /** Client-only notes, each shown after the block that was last when it was added. */
  private readonly notes: { readonly afterBlockId: string | undefined; readonly component: Component }[] = [];
  private lastBlocks: readonly Block[] | undefined;
  private lastSourceBlocks: readonly Block[] | undefined;
  private lastIngress: readonly import('@kiki/protocol').PromptItem[] | undefined;
  private context: TranscriptContext = {};
  private readonly summaries = new Map<string, TranscriptSummary>();
  private readonly liveSubagentGroups = new Map<string, LiveSubagentGroupComponent>();
  private readonly scopeStore = new Map<string, DisclosureScopeState>();
  private scopeKey = 'default';
  private scopeState: DisclosureScopeState = createDisclosureScope();
  private expanded = false;
  private showThinking = true;
  private showTimestamps = false;
  private readonly onInspectSubagent?: (subagentId: string) => void;

  constructor(
    private readonly container: Container,
    private readonly ui?: TUI,
    private readonly workDir?: string,
    options?: {
      readonly showThinking?: boolean;
      readonly showTimestamps?: boolean;
      readonly onInspectSubagent?: (subagentId: string) => void;
    },
  ) {
    this.scopeStore.set(this.scopeKey, this.scopeState);
    if (options?.showThinking !== undefined) {
      this.showThinking = options.showThinking;
    }
    if (options?.showTimestamps !== undefined) {
      this.showTimestamps = options.showTimestamps;
    }
    this.onInspectSubagent = options?.onInspectSubagent;
  }

  /** Switch disclosure and timing scope on session or focused-agent change. */
  setScope(scopeKey: string): void {
    if (this.scopeKey === scopeKey) return;
    this.scopeKey = scopeKey;
    let state = this.scopeStore.get(scopeKey);
    if (state === undefined) {
      state = createDisclosureScope();
      this.scopeStore.set(scopeKey, state);
    }
    this.scopeState = state;
    // Clear stale block references from the previous agent/session so we never
    // prune the new scope's disclosure state against the old agent's blocks.
    this.lastBlocks = undefined;
    this.lastSourceBlocks = undefined;
  }

  /** Compute the rendered line offset of a mounted block in the transcript container. */
  getBlockLineOffset(blockId: string, width: number): number | undefined {
    const mounted = this.mounted.get(blockId);
    if (mounted === undefined) return undefined;
    const renderWidth = Math.max(1, width);
    let offset = 0;
    for (const child of this.container.children) {
      if (child === mounted.component) return offset;
      offset += child.render(renderWidth).length;
    }
    return undefined;
  }

  /** Return the latest complete headline of a currently streaming thinking block, respecting `showThinking`. */
  getActiveThinkingHeadline(): string | undefined {
    if (!this.showThinking || this.lastBlocks === undefined) return undefined;
    for (let i = this.lastBlocks.length - 1; i >= 0; i -= 1) {
      const block = this.lastBlocks[i]!;
      if (block.kind === 'thinking' && block.streaming) {
        return extractThinkingSummary(block.text, { streaming: true });
      }
      if (block.kind === 'assistant' && block.text.trim().length > 0) {
        return undefined;
      }
      if (block.kind === 'user') {
        return undefined;
      }
    }
    return undefined;
  }

  /** Return IDs of blocks locally expanded by user clicks (for continuation loading). */
  getLocallyExpandedBlockIds(): ReadonlySet<string> {
    const ids = new Set<string>(this.scopeState.expandedBlocks);
    for (const id of this.scopeState.expandedFoldMembers) ids.add(id);
    return ids;
  }

  /**
   * Project blocks onto mounted components. session-core returns the same
   * array when nothing changed and keeps unchanged blocks object-identical, so
   * a streamed delta only touches the block that changed. Unchanged components
   * keep their render caches; nothing here invalidates the whole tree — theme
   * switches do that explicitly through `TUI.invalidate()`.
   */
  sync(
    blocks: readonly Block[],
    contextOrIngress: TranscriptContext | readonly import('@kiki/protocol').PromptItem[] = {},
  ): void {
    const context: TranscriptContext = Array.isArray(contextOrIngress)
      ? { ingress: contextOrIngress }
      : (contextOrIngress as TranscriptContext);
    const ingress = context.ingress ?? [];
    if (
      blocks === this.lastSourceBlocks &&
      ingress === this.lastIngress &&
      context.liveTurnId === this.context.liveTurnId &&
      context.tasks === this.context.tasks &&
      context.forest === this.context.forest &&
      context.toolMetaRevision === this.context.toolMetaRevision
    ) {
      return;
    }
    this.lastSourceBlocks = blocks;
    this.lastIngress = ingress;
    this.context = context;
    const receipts: UserBlock[] = ingress.filter((item) =>
      (item.admission === 'failed' || item.admission === 'cancelled' || item.admission === 'held') &&
      !blocks.some((block) => block.kind === 'user' && block.promptId === item.prompt_id),
    ).map((item) => {
      const receipt: UserBlock = {
        kind: 'user',
        id: `ingress-${item.prompt_id}`,
        promptId: item.prompt_id,
        createdAt: item.created_at,
        ...projectMessageContent(item.content),
        sourceOrigin: item.origin,
        steerStatus: item.admission === 'held' ? 'held' : undefined,
        promptOutcome: item.admission === 'held' ? undefined : {
          status: item.admission === 'cancelled' ? 'aborted' : 'failed',
          delivered: false,
          error: item.admission_error?.message,
        },
      };
      return receipt;
    });
    this.lastBlocks = receipts.length === 0 ? blocks : [...blocks, ...receipts];
    this.mountChildren();
    this.ui?.requestRender();
  }

  /**
   * Show client-only output (a command result, a /btw answer) in the
   * transcript after the current last block, where it stays readable instead
   * of in the status line that the next turn clears. Notes belong to the
   * session view: they are dropped by `clearNotes()` on a session switch, and
   * a note whose block is rewritten away (e.g. by /undo) is no longer shown.
   */
  addNote(component: Component): void {
    this.notes.push({ afterBlockId: this.lastBlocks?.at(-1)?.id, component });
    this.mountChildren();
    this.ui?.requestRender();
  }

  clearNotes(): void {
    this.notes.length = 0;
    this.mountChildren();
  }

  setExpanded(expanded: boolean): void {
    if (
      this.expanded === expanded &&
      this.scopeState.expandedFolds.size === 0 &&
      this.scopeState.expandedFoldMembers.size === 0 &&
      this.scopeState.expandedBlocks.size === 0
    ) {
      return;
    }
    this.expanded = expanded;
    this.scopeState.expandedFolds.clear();
    this.scopeState.expandedFoldMembers.clear();
    this.scopeState.expandedBlocks.clear();
    this.scopeState.collapsedLiveGroups.clear();
    for (const { component } of this.mounted.values()) {
      if (
        component instanceof ToolCallComponent ||
        component instanceof DaemonUserMessageComponent ||
        component instanceof ThinkingComponent ||
        component instanceof ProcessDetail
      ) {
        component.setExpanded(expanded);
      }
    }
    this.mountChildren();
    this.context.onLocalExpandChanged?.(this.getLocallyExpandedBlockIds());
    this.ui?.requestRender();
  }

  toggleFold(foldId: string, leafIds?: readonly string[]): void {
    const isCurrentlyExpanded =
      this.scopeState.expandedFolds.has(foldId) ||
      (leafIds !== undefined && leafIds.some((id) => this.scopeState.expandedFoldMembers.has(id)));
    if (isCurrentlyExpanded) {
      this.scopeState.expandedFolds.delete(foldId);
      if (leafIds !== undefined) {
        for (const id of leafIds) {
          this.scopeState.expandedFoldMembers.delete(id);
          this.scopeState.expandedBlocks.delete(id);
        }
      }
    } else {
      this.scopeState.expandedFolds.add(foldId);
      if (leafIds !== undefined) {
        for (const id of leafIds) this.scopeState.expandedFoldMembers.add(id);
      }
    }
    this.mountChildren();
    this.context.onLocalExpandChanged?.(this.getLocallyExpandedBlockIds());
    this.ui?.requestRender();
  }

  isFoldExpanded(foldId: string, leafIds?: readonly string[]): boolean {
    if (this.expanded) return true;
    if (this.scopeState.expandedFolds.has(foldId)) return true;
    if (leafIds !== undefined && leafIds.some((id) => this.scopeState.expandedFoldMembers.has(id))) {
      return true;
    }
    return false;
  }

  private setBlockExpanded(blockId: string, expanded: boolean): void {
    if (expanded) {
      this.scopeState.expandedBlocks.add(blockId);
    } else {
      this.scopeState.expandedBlocks.delete(blockId);
    }
    this.context.onLocalExpandChanged?.(this.getLocallyExpandedBlockIds());
    this.mountChildren();
    this.ui?.requestRender();
  }

  private observeThinkingTimings(blocks: readonly Block[]): void {
    const now = Date.now();
    const presentIds = new Set<string>();
    for (const block of blocks) {
      presentIds.add(block.id);
      if (block.kind !== 'thinking') continue;
      const existing = this.scopeState.thinkingTimings.get(block.id);
      if (block.streaming) {
        if (existing === undefined) {
          this.scopeState.thinkingTimings.set(block.id, { firstLiveAt: now });
        }
      } else if (existing !== undefined && existing.settledAt === undefined) {
        existing.settledAt = now;
      }
    }
    // Prune dead disclosure IDs after authoritative history removal (e.g. /undo)
    for (const id of this.scopeState.expandedBlocks) {
      if (!presentIds.has(id)) this.scopeState.expandedBlocks.delete(id);
    }
    for (const id of this.scopeState.expandedFoldMembers) {
      if (!presentIds.has(id)) this.scopeState.expandedFoldMembers.delete(id);
    }
  }

  private getThinkingDurationMs(block: ThinkingBlock): number | undefined {
    const timing = this.scopeState.thinkingTimings.get(block.id);
    if (timing === undefined) return undefined;
    if (block.streaming) return Math.max(0, Date.now() - timing.firstLiveAt);
    if (timing.settledAt !== undefined) return Math.max(0, timing.settledAt - timing.firstLiveAt);
    return undefined;
  }

  setShowThinking(showThinking: boolean): void {
    if (this.showThinking === showThinking) return;
    this.showThinking = showThinking;
    this.mountChildren();
    this.container.invalidate();
    this.ui?.requestRender(true);
  }

  setShowTimestamps(showTimestamps: boolean): void {
    if (this.showTimestamps === showTimestamps) return;
    this.showTimestamps = showTimestamps;
    for (const mounted of this.mounted.values()) {
      if (mounted.kind === 'user') {
        (mounted.component as DaemonUserMessageComponent).setShowTimestamp(showTimestamps);
      }
    }
    this.container.invalidate();
    this.ui?.requestRender(true);
  }

  dispose(): void {
    for (const mounted of this.mounted.values()) disposeComponent(mounted.component);
    this.mounted.clear();
    this.summaries.clear();
    this.liveSubagentGroups.clear();
    this.scopeStore.clear();
    this.scopeState = createDisclosureScope();
    this.scopeStore.set(this.scopeKey, this.scopeState);
    this.notes.length = 0;
    this.lastBlocks = undefined;
    this.lastSourceBlocks = undefined;
    this.lastIngress = undefined;
    this.container.clear();
  }

  private buildProtectedBlockIds(
    blocks: readonly Block[],
    latestCardIdByAgent: ReadonlyMap<string, string>,
  ): ReadonlySet<string> {
    const protectedIds = new Set<string>();
    const pendingApprovalToolCallIds = new Set<string>();
    for (const block of blocks) {
      if (block.kind === 'approval' && block.resolution === undefined) {
        const toolCallId = block.request.tool_call_id;
        if (typeof toolCallId === 'string' && toolCallId.length > 0) {
          pendingApprovalToolCallIds.add(toolCallId);
        }
      }
    }
    const liveTurnId = this.context.liveTurnId;
    for (const block of blocks) {
      if (block.kind === 'thinking') {
        if (block.streaming || this.scopeState.expandedBlocks.has(block.id)) {
          protectedIds.add(block.id);
        }
        continue;
      }
      if (block.kind === 'tool') {
        const matchesPendingApproval = pendingApprovalToolCallIds.has(block.toolCallId);
        const isLiveMutating =
          liveTurnId !== undefined && block.turnId === liveTurnId && !isReadStep(block);
        if (
          block.status === 'running' ||
          matchesPendingApproval ||
          isLiveMutating ||
          this.scopeState.expandedBlocks.has(block.id)
        ) {
          protectedIds.add(block.id);
        }
        continue;
      }
      if (block.kind === 'shell') {
        const isLiveShell = liveTurnId !== undefined && block.turnId === liveTurnId;
        if (!block.done || isLiveShell || this.scopeState.expandedBlocks.has(block.id)) {
          protectedIds.add(block.id);
        }
        continue;
      }
      if (block.kind === 'subagent') {
        const status = effectiveSubagentStatus(block, this.context.forest, latestCardIdByAgent);
        if (isLiveSubagentStatus(status)) {
          protectedIds.add(block.id);
        }
      }
    }
    return protectedIds;
  }

  private buildSubagentRowData(
    block: SubagentBlock,
    latestCardIdByAgent: ReadonlyMap<string, string>,
  ): LiveSubagentRowData {
    const status = effectiveSubagentStatus(block, this.context.forest, latestCardIdByAgent);
    const isLatestRun = latestCardIdByAgent.get(block.subagentId) === block.id;
    const forestNode = isLatestRun ? this.context.forest?.byId[block.subagentId] : undefined;
    const error = forestNode?.error ?? block.error;
    const activity = isLiveSubagentStatus(status)
      ? (forestNode?.status ?? status)
      : undefined;
    return {
      blockId: block.id,
      subagentId: block.subagentId,
      name: block.name,
      description: block.description,
      summary: block.summary,
      status,
      isLive: isLiveSubagentStatus(status),
      activity,
      error,
      expanded: this.expanded || this.scopeState.expandedBlocks.has(block.id),
    };
  }

  /** Re-mount children only when the component sequence actually changed. */
  private mountChildren(): void {
    this.observeThinkingTimings(this.lastBlocks ?? []);
    const {
      displayBlocks: blocks,
      leadingSuppressedIds,
      suppressedAfterVisibleId,
    } = prepareDisplayBlocks(this.lastBlocks ?? [], {
      expanded: this.expanded,
      showThinking: this.showThinking,
    });
    const components = this.notes
      .filter(
        (note) =>
          note.afterBlockId === undefined || leadingSuppressedIds.has(note.afterBlockId),
      )
      .map((note) => note.component);
    const latestCardIdByAgent = new Map<string, string>();
    for (const block of blocks) {
      if (block.kind === 'subagent') latestCardIdByAgent.set(block.subagentId, block.id);
    }
    const protectedBlockIds = this.expanded
      ? undefined
      : this.buildProtectedBlockIds(blocks, latestCardIdByAgent);
    const nodes = this.expanded
      ? blocks
      : foldHistory(
          readSubagentEndings(
            groupBlocks(blocks, { protectedBlockIds }),
            this.context.tasks ?? [],
          ),
          this.context.liveTurnId,
          {
            forest: this.context.forest,
            foldSingleProcess: true,
            protectedBlockIds,
          },
        );
    const visible = new Set<string>();
    const summaries = new Set<string>();
    const liveGroups = new Set<string>();
    const appendNotes = (ids: ReadonlySet<string>) => {
      if (ids.size === 0) return;
      const matchIds = new Set(ids);
      for (const id of ids) {
        for (const suppressedId of suppressedAfterVisibleId.get(id) ?? []) {
          matchIds.add(suppressedId);
        }
      }
      for (const note of this.notes) {
        if (note.afterBlockId !== undefined && matchIds.has(note.afterBlockId)) {
          components.push(note.component);
        }
      }
    };
    const mountLeaf = (block: Block, forceExpandInner = false): void => {
      visible.add(block.id);
      const mounted = this.updateOrCreate(block, forceExpandInner, latestCardIdByAgent);
      components.push(mounted.component);
      appendNotes(new Set([block.id]));
    };
    const mountSummary = (node: DisplayNode, expanded: boolean): void => {
      summaries.add(node.id);
      const leafIds = memberIds(node);
      let summary = this.summaries.get(node.id);
      if (summary === undefined) {
        summary = new TranscriptSummary(() => this.toggleFold(node.id, leafIds));
        this.summaries.set(node.id, summary);
      } else {
        summary.setOnToggle(() => this.toggleFold(node.id, leafIds));
      }
      summary.setSummary(
        summarizeNode(node, this.context.forest, latestCardIdByAgent, (b) =>
          this.getThinkingDurationMs(b),
        ),
        expanded,
      );
      components.push(summary);
    };
    const mountFoldMembers = (node: DisplayNode, forceExpandInner: boolean): void => {
      if (node.kind === 'history-fold' || node.kind === 'tool-group' || node.kind === 'subagent-group' || node.kind === 'media-run') {
        for (const member of node.members) {
          mountFoldMembers(member, forceExpandInner);
        }
        return;
      }
      if (node.kind === 'subagent-ended') {
        mountLeaf(node.note, true);
        return;
      }
      mountLeaf(node, forceExpandInner);
    };
    const mountCompactGroup = (node: HistoryFold | ToolGroup | SubagentGroup | MediaRun): void => {
      const leafIds = memberIds(node);
      const individuallyExpanded = this.isFoldExpanded(node.id, leafIds);
      if (individuallyExpanded) {
        mountSummary(node, true);
        const expandThoughtOnly =
          node.kind === 'history-fold' &&
          node.steps === 0 &&
          node.agents === 0 &&
          node.agentsDone === 0 &&
          node.notes === 0;
        mountFoldMembers(node, expandThoughtOnly);
        return;
      }
      const allLeaves = collectLeafBlocks(node);
      const surfaced = allLeaves.filter((block) => this.isSurfacedInCompact(block, latestCardIdByAgent));
      if (surfaced.length > 0 && surfaced.length === allLeaves.length) {
        for (const block of surfaced) mountLeaf(block);
        return;
      }
      mountSummary(node, false);
      const surfacedIds = new Set(surfaced.map((block) => block.id));
      const hiddenIds = new Set(leafIds.filter((id) => !surfacedIds.has(id)));
      appendNotes(hiddenIds);
      for (const block of surfaced) mountLeaf(block);
    };
    const mountLiveSubagentGroup = (node: SubagentGroup): void => {
      liveGroups.add(node.id);
      const rows = node.members.map((member) => this.buildSubagentRowData(member, latestCardIdByAgent));
      const groupExpanded = !this.scopeState.collapsedLiveGroups.has(node.id);
      let group = this.liveSubagentGroups.get(node.id);
      if (group === undefined) {
        group = new LiveSubagentGroupComponent(
          rows,
          groupExpanded,
          () => {
            if (this.scopeState.collapsedLiveGroups.has(node.id)) {
              this.scopeState.collapsedLiveGroups.delete(node.id);
            } else {
              this.scopeState.collapsedLiveGroups.add(node.id);
            }
            this.mountChildren();
            this.ui?.requestRender();
          },
          (blockId, nextExpanded) => this.setBlockExpanded(blockId, nextExpanded),
          this.context.onInspectAgent ?? this.onInspectSubagent,
        );
        this.liveSubagentGroups.set(node.id, group);
      } else {
        group.update(rows, groupExpanded);
      }
      components.push(group);
      appendNotes(new Set(memberIds(node)));
    };
    const append = (node: DisplayNode): void => {
      switch (node.kind) {
        case 'history-fold':
          mountCompactGroup(node);
          return;
        case 'tool-group':
          if (groupHasRunning(node)) {
            node.members.forEach(append);
            return;
          }
          mountCompactGroup(node);
          return;
        case 'subagent-group': {
          const hasLiveChild = node.members.some((member) =>
            isLiveSubagentStatus(
              effectiveSubagentStatus(member, this.context.forest, latestCardIdByAgent),
            ),
          );
          if (hasLiveChild) {
            mountLiveSubagentGroup(node);
            return;
          }
          mountCompactGroup(node);
          return;
        }
        case 'media-run':
          if (node.latest) {
            node.members.forEach(append);
            return;
          }
          mountCompactGroup(node);
          return;
        case 'subagent-ended': {
          const leafIds = memberIds(node);
          if (this.expanded) {
            mountLeaf(node.note, true);
            return;
          }
          if (this.isFoldExpanded(node.id, leafIds)) {
            mountSummary(node, true);
            mountLeaf(node.note, true);
            return;
          }
          mountSummary(node, false);
          appendNotes(new Set(leafIds));
          return;
        }
        default:
          mountLeaf(node);
          return;
      }
    };
    nodes.forEach(append);
    for (const [id, mounted] of this.mounted) {
      if (visible.has(id)) continue;
      disposeComponent(mounted.component);
      this.mounted.delete(id);
    }
    for (const id of this.summaries.keys()) if (!summaries.has(id)) this.summaries.delete(id);
    for (const id of this.liveSubagentGroups.keys()) {
      if (!liveGroups.has(id)) this.liveSubagentGroups.delete(id);
    }
    const children = this.container.children;
    if (
      components.length === children.length &&
      components.every((component, index) => component === children[index])
    ) {
      return;
    }
    this.container.clear();
    for (const component of components) this.container.addChild(component);
  }

  private blockHasActionableNote(block: ToolBlock | ShellBlock): boolean {
    const meta = this.context.resolveBlockMeta?.(block);
    return meta?.note !== undefined && parseToolSideChannelNote(meta.note).actionableLines.length > 0;
  }

  private isSurfacedInCompact(block: Block, latestCardIdByAgent: ReadonlyMap<string, string>): boolean {
    if (block.kind === 'tool') {
      return (
        block.status === 'running' ||
        block.status === 'error' ||
        block.isError === true ||
        this.blockHasActionableNote(block)
      );
    }
    if (block.kind === 'shell') {
      return !block.done || block.isError === true || this.blockHasActionableNote(block);
    }
    if (block.kind === 'subagent') {
      const status = effectiveSubagentStatus(block, this.context.forest, latestCardIdByAgent);
      if (status === 'failed' || status === 'lost') return true;
      const isLatestRun = latestCardIdByAgent.get(block.subagentId) === block.id;
      const error = (isLatestRun ? this.context.forest?.byId[block.subagentId]?.error : undefined) ?? block.error;
      return error !== undefined && error !== '';
    }
    return false;
  }

  private updateOrCreate(
    block: Block,
    forceExpandInner = false,
    latestCardIdByAgent: ReadonlyMap<string, string> = new Map(),
  ): MountedBlock {
    const mounted = this.mounted.get(block.id);
    const effectiveExpanded =
      this.expanded || forceExpandInner || this.scopeState.expandedBlocks.has(block.id);
    const meta =
      block.kind === 'tool' || block.kind === 'shell'
        ? this.context.resolveBlockMeta?.(block)
        : undefined;
    const subagentRow =
      block.kind === 'subagent'
        ? this.buildSubagentRowData(block, latestCardIdByAgent)
        : undefined;
    const nextMetaKey =
      subagentRow !== undefined
        ? JSON.stringify([
            subagentRow.status,
            subagentRow.isLive,
            subagentRow.activity,
            subagentRow.error,
            subagentRow.expanded,
          ])
        : serializeMetaKey(meta, effectiveExpanded);
    if (mounted?.block === block && mounted.metaKey === nextMetaKey) {
      if (mounted.component instanceof ThinkingComponent) {
        mounted.component.setDurationMs(this.getThinkingDurationMs(block as ThinkingBlock));
        if (forceExpandInner) mounted.component.setExpanded(true);
      } else if (mounted.component instanceof ProcessDetail && forceExpandInner) {
        mounted.component.setExpanded(true);
      }
      return mounted;
    }
    if (
      mounted !== undefined &&
      mounted.kind === block.kind &&
      !requiresReplacement(mounted.block, block, mounted.metaKey, nextMetaKey) &&
      !(block.kind === 'subagent' && subagentRow !== undefined && subagentRow.isLive !== (mounted.component instanceof LiveSubagentCardComponent))
    ) {
      if (mounted.component instanceof LiveSubagentCardComponent && subagentRow !== undefined) {
        mounted.component.update(subagentRow);
      } else {
        updateMountedBlock(
          mounted.component,
          block,
          meta,
          block.kind === 'thinking' ? this.getThinkingDurationMs(block) : undefined,
        );
      }
      if (
        mounted.component instanceof ThinkingComponent ||
        mounted.component instanceof ProcessDetail ||
        mounted.component instanceof ToolCallComponent
      ) {
        mounted.component.setExpanded(effectiveExpanded);
      }
      mounted.block = block;
      mounted.metaKey = nextMetaKey;
      return mounted;
    }
    if (mounted !== undefined) disposeComponent(mounted.component);
    const component =
      block.kind === 'subagent' && subagentRow !== undefined && subagentRow.isLive
        ? new LiveSubagentCardComponent(
            subagentRow,
            (blockId, nextExpanded) => this.setBlockExpanded(blockId, nextExpanded),
            this.context.onInspectAgent ?? this.onInspectSubagent,
          )
        : createBlockComponent(
            block,
            this.ui,
            this.workDir,
            meta,
            effectiveExpanded,
            block.kind === 'thinking' ? this.getThinkingDurationMs(block) : undefined,
          );
    if (component instanceof ThinkingComponent) {
      component.setExpanded(effectiveExpanded);
      component.setOnToggleExpanded((nextExpanded) => this.setBlockExpanded(block.id, nextExpanded));
    } else if (component instanceof ToolCallComponent) {
      component.setExpanded(effectiveExpanded);
      component.setOnToggleExpanded((nextExpanded) => this.setBlockExpanded(block.id, nextExpanded));
    } else if (component instanceof ProcessDetail) {
      component.setExpanded(effectiveExpanded);
      component.setOnToggleExpanded((nextExpanded) => this.setBlockExpanded(block.id, nextExpanded));
    } else if (component instanceof DaemonUserMessageComponent) {
      component.setExpanded(effectiveExpanded);
      component.setShowTimestamp(this.showTimestamps);
    }
    const next: MountedBlock = {
      kind: block.kind,
      component,
      block,
      metaKey: nextMetaKey,
    };
    this.mounted.set(block.id, next);
    return next;
  }
}

export function createBlockComponent(
  block: Block,
  ui?: TUI,
  workDir?: string,
  meta?: ResolvedBlockContinuationMeta,
  expanded = false,
  thinkingDurationMs?: number,
): Component {
  switch (block.kind) {
    case 'user':
      return new DaemonUserMessageComponent(block);
    case 'assistant':
      return new DaemonAssistantMessageComponent(block.text, block.streaming, block.media);
    case 'thinking': {
      const comp = new ThinkingComponent(block.text, true, block.streaming ? 'live' : 'finalized', ui);
      comp.setDurationMs(thinkingDurationMs);
      return comp;
    }
    case 'tool':
      return createToolComponent(block, ui, workDir, meta);
    case 'message':
      return new DaemonMessageComponent(block);
    case 'subagent':
      return new ProcessDetail(formatSubagent(block), [formatSubagent(block), block.summary, block.error].filter(Boolean).join('\n'), 'text', ui);
    case 'subagent-event':
      return new ProcessDetail(`${block.name} · ${block.event}`, [block.name, block.event, block.message, block.error].filter(Boolean).join('\n'), block.error ? 'error' : 'textDim', ui);
    case 'approval':
      return new Text(
        block.resolution === undefined
          ? currentTheme.fg('warning', `Approval required · ${block.request.action}`)
          : currentTheme.dim(`Approval ${block.resolution.decision} · ${block.request.action}`),
        2,
        0,
      );
    case 'question':
      return new Text(
        block.outcome === undefined
          ? currentTheme.fg('warning', block.request.questions[0]?.question ?? 'Question required')
          : currentTheme.dim(block.request.questions[0]?.question ?? 'Question answered'),
        2,
        0,
      );
    case 'shell': {
      return renderShellBlockComponent(block, meta, expanded, ui);
    }
    case 'skill':
      return new Text(currentTheme.dim(`/${block.name}${block.args === undefined ? '' : ` ${block.args}`}`), 2, 0);
    case 'system': {
      const info = classifySystemBlock(block);
      const body = info.kind === 'other' ? block.text : `${info.summary}\n${block.text}`;
      return new ProcessDetail(info.summary, body, 'textDim', ui);
    }
    case 'system-reminder': {
      const label = block.variant === 'steer' ? 'Steer' : 'Reminder';
      const category = block.category?.kind;
      const heading = category === undefined ? label : `${label} · ${category}`;
      return new ProcessDetail(heading, `${heading}\n${block.text}`, 'textDim', ui);
    }
    case 'notice': {
      const text = formatNoticeText(block);
      return new Text(
        block.tone === 'danger' ? currentTheme.fg('error', text) : currentTheme.dim(text),
        2,
        0,
      );
    }
  }
}

export interface TranscriptContext {
  readonly liveTurnId?: string;
  readonly forest?: AgentForest;
  readonly tasks?: readonly EndingTask[];
  readonly ingress?: readonly import('@kiki/protocol').PromptItem[];
  readonly toolMetaRevision?: number;
  readonly resolveBlockMeta?: (block: ToolBlock | ShellBlock) => ResolvedBlockContinuationMeta | undefined;
  readonly onInspectAgent?: (subagentId: string) => void;
  readonly onLocalExpandChanged?: (expandedBlockIds: ReadonlySet<string>) => void;
}

interface SummaryDisplay {
  readonly lead: string;
  readonly errorBadge?: string;
  readonly detail?: string;
  readonly errorTone?: boolean;
}

class TranscriptSummary implements Component, MouseRoutable {
  private display: SummaryDisplay = { lead: '' };
  private expanded = false;

  constructor(private onToggle: () => void) {}

  setOnToggle(onToggle: () => void): void {
    this.onToggle = onToggle;
  }

  setSummary(display: SummaryDisplay, expanded: boolean): void {
    this.display = display;
    this.expanded = expanded;
  }

  invalidate(): void {}

  routeMouse(event: SgrMouseEvent, line: number, _col: number): boolean {
    if (!event.leftClick || line !== 0) return false;
    this.onToggle();
    return true;
  }

  render(width: number): string[] {
    const marker = this.expanded
      ? currentTheme.fg('primary', FOLD_EXPANDED_MARK)
      : currentTheme.fg('textMuted', FOLD_COLLAPSED_MARK);
    const lead = this.display.errorTone
      ? currentTheme.fg('error', this.display.lead)
      : currentTheme.dim(this.display.lead);
    const badge =
      this.display.errorBadge === undefined
        ? ''
        : `${currentTheme.dim(' · ')}${currentTheme.fg('error', this.display.errorBadge)}`;
    const detail =
      this.display.detail === undefined || this.display.detail.length === 0
        ? ''
        : currentTheme.dim(` · ${this.display.detail}`);
    return [truncateToWidth(`  ${marker} ${lead}${badge}${detail}`, width, '…')];
  }
}

function collectLeafBlocks(node: DisplayNode): Block[] {
  if (
    node.kind === 'history-fold' ||
    node.kind === 'tool-group' ||
    node.kind === 'subagent-group' ||
    node.kind === 'media-run'
  ) {
    return node.members.flatMap(collectLeafBlocks);
  }
  if (node.kind === 'subagent-ended') return [node.note];
  return [node];
}

function memberIds(node: DisplayNode): string[] {
  if (node.kind === 'history-fold' || node.kind === 'tool-group' || node.kind === 'subagent-group' || node.kind === 'media-run') {
    return node.members.flatMap(memberIds);
  }
  return [node.kind === 'subagent-ended' ? node.note.id : node.id];
}

function summarizeFoldActions(fold: HistoryFold, maxTargets = 3): string | undefined {
  const parts: { verb: string; targets: string[]; more: number }[] = [];
  const push = (verb: string, target: string | undefined) => {
    let part = parts.at(-1);
    if (part?.verb !== verb) {
      part = { verb, targets: [], more: 0 };
      parts.push(part);
    }
    if (target === undefined || target.length === 0 || part.targets.includes(target)) return;
    if (part.targets.length < maxTargets) part.targets.push(target);
    else part.more += 1;
  };
  const visit = (node: DisplayNode) => {
    if (node.kind === 'tool-group') {
      for (const tool of node.tools) {
        const obj = stepObject(tool);
        push(obj.verb, obj.target);
      }
      return;
    }
    if (node.kind === 'tool') {
      const obj = stepObject(node);
      push(obj.verb, obj.target);
      return;
    }
    if (node.kind === 'shell') {
      const firstLine = (node.command ?? '').split(/\r?\n/u, 1)[0]?.trim();
      push('run', firstLine && firstLine.length > 0 ? firstLine : undefined);
    }
  };
  for (const member of fold.members) visit(member);
  const formatted = parts
    .map((part) => [part.verb, part.targets.join(', '), part.more > 0 ? `+${part.more}` : ''].filter(Boolean).join(' '))
    .filter((entry) => entry.length > 0 && entry !== 'other');
  if (formatted.length === 0) return undefined;
  return formatted.slice(0, 3).join(' · ');
}

function summarizeSubagentGroup(
  node: SubagentGroup,
  forest?: AgentForest,
  latestCardIdByAgent?: ReadonlyMap<string, string>,
): SummaryDisplay {
  let done = 0;
  let failed = 0;
  const names: string[] = [];
  for (const member of node.members) {
    const status = effectiveSubagentStatus(member, forest, latestCardIdByAgent);
    if (!isLiveSubagentStatus(status)) done += 1;
    const isLatestRun =
      latestCardIdByAgent === undefined || latestCardIdByAgent.get(member.subagentId) === member.id;
    const error = (isLatestRun ? forest?.byId[member.subagentId]?.error : undefined) ?? member.error;
    if (status === 'failed' || status === 'lost' || (error !== undefined && error !== '')) {
      failed += 1;
    }
    if (names.length < 3) names.push(member.name);
  }
  const extra = node.members.length > names.length ? ` +${node.members.length - names.length}` : '';
  return {
    lead: `Agents · ${done}/${node.members.length} done`,
    errorBadge: failed > 0 ? `${failed} failed` : undefined,
    detail: names.length > 0 ? `${names.join(', ')}${extra}` : undefined,
  };
}

function summarizeMediaRun(node: MediaRun): SummaryDisplay {
  const targets: string[] = [];
  let failed = 0;
  for (const member of node.members) {
    if (member.status === 'error' || member.isError === true) failed += 1;
    const target = stepObject(member).target;
    if (target !== undefined && !targets.includes(target) && targets.length < 3) {
      targets.push(target);
    }
  }
  const count = node.members.length;
  return {
    lead: `Viewed · ${count} ${count === 1 ? 'image' : 'images'}`,
    errorBadge: failed > 0 ? `${failed} failed` : undefined,
    detail: targets.length > 0 ? targets.join(', ') : undefined,
  };
}

function latestThoughtSummary(
  node: HistoryFold,
  resolveDurationMs?: (block: ThinkingBlock) => number | undefined,
  headingOnly = false,
): { readonly headline?: string; readonly duration?: string } {
  let latest: ThinkingBlock | undefined;
  for (const member of collectLeafBlocks(node)) {
    if (member.kind === 'thinking') latest = member;
  }
  if (latest === undefined) return {};
  const headline = extractThinkingSummary(latest.text, {
    streaming: headingOnly ? true : latest.streaming,
  });
  const duration = formatThinkingDuration(resolveDurationMs?.(latest));
  return { headline, duration };
}

function summarizeNode(
  node: DisplayNode,
  forest?: AgentForest,
  latestCardIdByAgent?: ReadonlyMap<string, string>,
  resolveThinkingDurationMs?: (block: ThinkingBlock) => number | undefined,
): SummaryDisplay {
  if (node.kind === 'history-fold') {
    const sentCount = node.sentMessages?.reduce((sum, item) => sum + item.count, 0) ?? 0;
    if (
      node.steps === 0 &&
      node.agents === 0 &&
      node.agentsDone === 0 &&
      node.notes === 0 &&
      sentCount === 0 &&
      node.thoughts > 0
    ) {
      const thought = latestThoughtSummary(node, resolveThinkingDurationMs);
      const leadParts: string[] = [
        thought.headline !== undefined
          ? `Thought: ${thought.headline}`
          : node.thoughts === 1
            ? 'Thought'
            : `Thought · ${node.thoughts} thoughts`,
      ];
      if (thought.headline !== undefined && node.thoughts > 1) {
        leadParts.push(`${String(node.thoughts)} thoughts`);
      }
      if (thought.duration !== undefined) {
        leadParts.push(thought.duration);
      }
      return {
        lead: leadParts.join(' · '),
      };
    }
    const parts = ['Worked'];
    if (node.steps > 0) parts.push(`${node.steps} ${node.steps === 1 ? 'step' : 'steps'}`);
    if (node.thoughts > 0) parts.push(`${node.thoughts} ${node.thoughts === 1 ? 'thought' : 'thoughts'}`);
    if (node.agents > 0) parts.push(`${node.agents} ${node.agents === 1 ? 'agent' : 'agents'}`);
    if (node.agentsDone > 0) parts.push(`${node.agentsDone} completed`);
    if (sentCount > 0) {
      const names = node.sentMessages!.slice(0, 2).map((item) => item.name).join(', ');
      parts.push(`messaged ${names}`);
    }
    if (node.notes > 0) parts.push(`${node.notes} ${node.notes === 1 ? 'note' : 'notes'}`);
    const actionDetail = summarizeFoldActions(node);
    const thoughtInfo =
      node.thoughts > 0 ? latestThoughtSummary(node, resolveThinkingDurationMs, true) : undefined;
    const thoughtDetail =
      thoughtInfo?.headline !== undefined
        ? thoughtInfo.duration !== undefined
          ? `thought: ${thoughtInfo.headline} (${thoughtInfo.duration})`
          : `thought: ${thoughtInfo.headline}`
        : undefined;
    const detail = [actionDetail, thoughtDetail].filter((part): part is string => part !== undefined).join(' · ');
    return {
      lead: parts.join(' · '),
      errorBadge: node.failed > 0 ? `${node.failed} failed` : undefined,
      detail: detail.length > 0 ? detail : undefined,
    };
  }
  if (node.kind === 'tool-group') {
    const failed = node.tools.filter((tool) => tool.status === 'error' || tool.isError === true).length;
    const objects = groupSummary(node).map((part) => [part.verb, part.targets.join(', '), part.more > 0 ? `+${part.more}` : ''].filter(Boolean).join(' '));
    return {
      lead: `Read · ${node.count} steps`,
      errorBadge: failed > 0 ? `${failed} failed` : undefined,
      detail: objects.join(' · '),
    };
  }
  if (node.kind === 'subagent-group') return summarizeSubagentGroup(node, forest, latestCardIdByAgent);
  if (node.kind === 'media-run') return summarizeMediaRun(node);
  if (node.kind === 'subagent-ended') {
    const isErr = node.outcome === 'failed' || node.outcome === 'timedOut';
    return {
      lead: `Agent ${node.agentId} · ${node.outcome}`,
      errorTone: isErr,
    };
  }
  return { lead: '' };
}

class ProcessDetail implements Component, MouseRoutable {
  private expanded = false;
  private onToggleExpanded: ((expanded: boolean) => void) | undefined;
  private readonly detail = new Text('', 2, 0);

  constructor(
    private readonly summary: string,
    private readonly body: string,
    private readonly tone: 'text' | 'textDim' | 'error' = 'textDim',
    private readonly ui?: TUI,
  ) {}

  setOnToggleExpanded(listener: ((expanded: boolean) => void) | undefined): void {
    this.onToggleExpanded = listener;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    if (expanded) this.invalidate();
  }

  invalidate(): void {
    if (this.expanded) this.detail.setText(currentTheme.fg(this.tone, this.body));
  }

  routeMouse(event: SgrMouseEvent, line: number, _col: number): boolean {
    if (!event.leftClick || this.body === this.summary || line !== 0) return false;
    this.setExpanded(!this.expanded);
    this.onToggleExpanded?.(this.expanded);
    this.ui?.requestRender();
    return true;
  }

  render(width: number): string[] {
    const expandable = this.body !== this.summary;
    if (this.expanded) {
      if (!expandable) return this.detail.render(width);
      const header = truncateToWidth(
        `  ${currentTheme.fg('primary', FOLD_EXPANDED_MARK)} ${currentTheme.fg(this.tone, this.summary)}`,
        Math.max(1, width),
        '…',
      );
      const bodyLines = this.detail.render(width);
      // Avoid repeating the summary line when body starts with it verbatim.
      const rest = bodyLines.length > 0 && this.body.startsWith(`${this.summary}\n`) ? bodyLines.slice(1) : bodyLines;
      return [header, ...rest];
    }
    const prefix = expandable ? `  ${currentTheme.fg('textMuted', FOLD_COLLAPSED_MARK)} ` : '  ';
    return [truncateToWidth(`${prefix}${currentTheme.fg(this.tone, this.summary)}`, width, '…')];
  }
}

/**
 * Client-only output in the transcript: a command result, or a /btw question
 * with its Markdown answer. Starts with a blank line like every block.
 */
export class TranscriptNoteComponent implements Component {
  private answer: AssistantMessageComponent | undefined;
  private textCache: { width: number; lines: string[] } | undefined;
  private renderCache: { width: number; parts: string[][]; lines: string[] } | undefined;

  constructor(private message: string) {}

  /** Replace the note text, optionally followed by a Markdown answer. */
  update(message: string, answer?: string): void {
    this.message = message;
    if (answer !== undefined) {
      this.answer ??= new AssistantMessageComponent();
      this.answer.updateContent(answer);
    }
    this.textCache = undefined;
    this.renderCache = undefined;
  }

  invalidate(): void {
    this.answer?.invalidate();
    this.textCache = undefined;
    this.renderCache = undefined;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const textLines =
      this.textCache?.width === safeWidth
        ? this.textCache.lines
        : renderTranscriptNoteLines(this.message, safeWidth);
    this.textCache = { width: safeWidth, lines: textLines };
    const parts = [
      textLines,
      ...(this.answer === undefined ? [] : [this.answer.render(safeWidth)]),
    ];
    const cache = this.renderCache;
    if (
      cache?.width === safeWidth &&
      cache.parts.length === parts.length &&
      parts.every((lines, index) => lines === cache.parts[index])
    ) {
      return cache.lines;
    }
    const lines = ['', ...parts.flat()];
    this.renderCache = { width: safeWidth, parts, lines };
    return lines;
  }
}

// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is required to match ANSI SGR escape sequences
const NOTE_ANSI_SGR = /\u001B\[[0-9;]*m/g;
const NOTE_KV_PREFIX = /^(\s*[A-Za-z][A-Za-z0-9 _-]{0,22}:\s+)(?=\S)/u;
const NOTE_TABLE_PREFIX = /^(\s{2}[A-Za-z][A-Za-z0-9 _-]{1,18}\s{2,})(?=\S)/u;

function renderTranscriptNoteLines(message: string, width: number): string[] {
  const rawLines = message.replaceAll('\r', '').split('\n');
  const out: string[] = [];
  for (const rawLine of rawLines) {
    const plain = rawLine.replaceAll(NOTE_ANSI_SGR, '');
    if (plain.length === 0) {
      out.push('  ');
      continue;
    }
    const styledFull = currentTheme.fg('textDim', `  ${rawLine}`);
    if (visibleWidth(styledFull) <= width) {
      out.push(styledFull);
      continue;
    }
    const kvMatch = NOTE_KV_PREFIX.exec(plain) ?? NOTE_TABLE_PREFIX.exec(plain);
    const baseLeadMatch = /^(\s*)/u.exec(plain);
    const baseIndentCols = 2 + (baseLeadMatch?.[1]?.length ?? 0);
    const hangingCols = kvMatch !== null ? 2 + kvMatch[1]!.length : baseIndentCols;
    const effectiveIndentCols = width - hangingCols >= 14 ? hangingCols : Math.min(baseIndentCols, Math.max(0, width - 4));
    if (kvMatch !== null && effectiveIndentCols === hangingCols && plain === rawLine) {
      const labelPart = rawLine.slice(0, kvMatch[1]!.length);
      const valuePart = rawLine.slice(kvMatch[1]!.length);
      const wrappedValue = wrapTextWithAnsi(valuePart, Math.max(1, width - hangingCols));
      out.push(currentTheme.fg('textDim', `  ${labelPart}${wrappedValue[0] ?? ''}`));
      const contIndent = ' '.repeat(hangingCols);
      for (let i = 1; i < wrappedValue.length; i++) {
        out.push(currentTheme.fg('textDim', `${contIndent}${wrappedValue[i] ?? ''}`));
      }
      continue;
    }
    const firstWrapped = wrapTextWithAnsi(styledFull, width);
    if (firstWrapped.length <= 1 || effectiveIndentCols <= 0 || width <= effectiveIndentCols + 2) {
      out.push(...firstWrapped);
      continue;
    }
    // Re-wrap with hanging continuation indent for styled multi-line rows
    const trimmedContent = `  ${rawLine}`.slice(Math.min(effectiveIndentCols, 2));
    const rewrapped = wrapTextWithAnsi(
      currentTheme.fg('textDim', trimmedContent),
      Math.max(1, width - effectiveIndentCols),
    );
    const firstPad = ' '.repeat(Math.min(effectiveIndentCols, 2));
    const contPad = ' '.repeat(effectiveIndentCols);
    out.push(`${firstPad}${rewrapped[0] ?? ''}`);
    for (let i = 1; i < rewrapped.length; i++) {
      out.push(`${contPad}${rewrapped[i] ?? ''}`);
    }
  }
  return out;
}

/**
 * Container that returns the same line array while none of its children
 * re-rendered, so `GutterContainer` can reuse its prefixed lines instead of
 * rebuilding every message's lines on each frame.
 */
class RenderCachedContainer extends Container {
  private renderCache: { width: number; childLines: string[][]; lines: string[] } | undefined;

  override invalidate(): void {
    this.renderCache = undefined;
    super.invalidate();
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const childLines = this.children.map((child) => child.render(safeWidth));
    const cache = this.renderCache;
    if (
      isRenderCacheEnabled() &&
      cache?.width === safeWidth &&
      cache.childLines.length === childLines.length &&
      childLines.every((lines, index) => lines === cache.childLines[index])
    ) {
      return cache.lines;
    }
    const lines = childLines.flat();
    this.renderCache = { width: safeWidth, childLines, lines };
    return lines;
  }
}

class DaemonUserMessageComponent extends RenderCachedContainer {
  private message: UserMessageComponent;
  private readonly status = new Text('', 2, 0);
  private statusText: string | undefined;
  private expanded = false;
  private showTimestamp = false;

  constructor(private block: UserBlock) {
    super();
    this.message = new UserMessageComponent(
      block.text,
      undefined,
      undefined,
      undefined,
      readViaClient(block),
    );
    this.addChild(this.message);
    addMediaLabels(this, block.media);
    this.addChild(this.status);
    this.syncStatus();
  }

  update(block: UserBlock): void {
    this.block = block;
    this.message.updateContent(block.text);
    this.message.setSourceLabel(
      this.showTimestamp ? formatPromptTimestamp(block.createdAt) : undefined,
    );
    this.message.setViaClient(readViaClient(block));
    this.syncStatus();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.syncStatus();
  }

  setShowTimestamp(showTimestamp: boolean): void {
    if (this.showTimestamp === showTimestamp) return;
    this.showTimestamp = showTimestamp;
    this.message.setSourceLabel(
      showTimestamp ? formatPromptTimestamp(this.block.createdAt) : undefined,
    );
    this.invalidate();
  }

  override invalidate(): void {
    super.invalidate();
    this.syncStatus();
  }

  private syncStatus(): void {
    // Text drops its cache on every setText, so only touch it on a real change.
    const status = formatUserPromptStatus(this.block, this.expanded) ?? '';
    if (status !== this.statusText) {
      this.statusText = status;
      this.status.setText(status);
    }
  }
}

function formatPromptTimestamp(createdAt: string | number | undefined): string | undefined {
  if (createdAt === undefined) return undefined;
  const ms = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt);
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatUserPromptStatus(block: UserBlock, expanded = false): string | undefined {
  const outcome = block.promptOutcome;
  if (outcome !== undefined) {
    const label = outcome.status === 'aborted'
      ? outcome.delivered ? 'Prompt aborted' : 'Prompt aborted before delivery'
      : outcome.delivered ? 'Reply failed' : 'Prompt failed before delivery';
    const rawDetail = expanded ? (outcome.errorDetails ?? outcome.error) : outcome.error;
    const detail = rawDetail === undefined ? '' : ` · ${rawDetail}`;
    return currentTheme.fg(outcome.status === 'failed' ? 'error' : 'warning', `${label}${detail}`);
  }
  if (block.promptStatus === 'queued') return currentTheme.dim('Queued');
  if (block.promptStatus === 'blocked') return currentTheme.fg('warning', 'Blocked');
  if (block.steerStatus === 'sending') return currentTheme.dim('Sending…');
  if (block.steerStatus === 'preparing') return currentTheme.dim('Preparing delivery…');
  if (block.steerStatus === 'waiting') return currentTheme.dim('Waiting for delivery');
  if (block.steerStatus === 'unconfirmed') return currentTheme.fg('warning', 'Delivery unconfirmed · check the queue before retrying');
  if (block.steerStatus === 'held') return currentTheme.fg('warning', 'Prompt held · check the saved prompt before retrying');
  if (block.branchFold !== undefined) {
    const label = block.branchFold.done !== false ? 'Merged from branch' : 'Folded from branch';
    return currentTheme.dim(`${label} ${block.branchFold.branchTitle ?? block.branchFold.branchId}`);
  }
  return undefined;
}

class DaemonAssistantMessageComponent extends RenderCachedContainer {
  private readonly message = new AssistantMessageComponent();

  constructor(text: string, streaming: boolean, media: readonly MediaRef[] | undefined) {
    super();
    this.message.updateContent(text, { transient: streaming });
    this.addChild(this.message);
    addMediaLabels(this, media);
  }

  updateContent(text: string, options: { readonly transient: boolean }): void {
    this.message.updateContent(text, options);
  }
}

class DaemonMessageComponent extends RenderCachedContainer {
  constructor(block: MessageBlock) {
    super();
    this.addChild(new Text(formatMessageBlock(block), 2, 0));
    for (const attachment of block.attachments) {
      const label = attachment.title ?? attachment.path;
      this.addChild(new Text(currentTheme.dim(`[attachment: ${label}]`), 2, 0));
    }
  }
}

function formatMessageBlock(block: MessageBlock): string {
  const target = block.handoff?.targetName ?? block.to;
  const targetLabel = target === undefined ? '' : ` → ${target}`;
  const sender = block.senderName === undefined
    ? targetLabel === '' ? '' : `${targetLabel}: `
    : `${block.senderName}${targetLabel}: `;
  const text = `${sender}${block.text}`;
  switch (block.status) {
    case 'sent':
      return text;
    case 'sending':
      return currentTheme.dim(`Sending${targetLabel}: ${block.text}`);
    case 'pending':
      return currentTheme.fg('warning', `Delivery not confirmed${targetLabel}: ${block.text}`);
    case 'failed':
      return currentTheme.fg('error', `Message not sent (failed)${targetLabel}: ${block.text}`);
    case 'cancelled':
      return currentTheme.fg('warning', `Message not sent (cancelled)${targetLabel}: ${block.text}`);
  }
}

function addMediaLabels(container: Container, media: readonly MediaRef[] | undefined): void {
  for (const item of media ?? []) {
    const thumbnail = item.kind === 'image' ? imageThumbnail(item) : undefined;
    if (thumbnail !== undefined) {
      container.addChild(thumbnail);
      continue;
    }
    const urlLabel = item.url?.startsWith('data:') === true ? (item.mime ?? 'inline') : item.url;
    const label = item.name ?? item.path ?? item.fileId ?? urlLabel ?? item.kind;
    container.addChild(new Text(currentTheme.fg('accent', `[${item.kind}: ${label}]`), 2, 0));
  }
}

function imageThumbnail(item: MediaRef): ImageThumbnail | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/su.exec(item.url ?? '');
  if (match === null) return undefined;
  const bytes = Buffer.from(match[2]!, 'base64');
  const dimensions = parseImageMeta(bytes);
  if (dimensions === null) return undefined;
  const attachment: ImageAttachment = {
    id: 0,
    kind: 'image',
    bytes,
    mime: match[1]!,
    width: dimensions.width,
    height: dimensions.height,
    placeholder: `[image (${String(dimensions.width)}×${String(dimensions.height)})]`,
  };
  return new ImageThumbnail(attachment);
}

function requiresReplacement(
  previous: Block,
  next: Block,
  previousMetaKey?: string,
  nextMetaKey?: string,
): boolean {
  if (previous === next && previousMetaKey === nextMetaKey) return false;
  if (
    (previous.kind === 'user' || previous.kind === 'assistant') &&
    previous.kind === next.kind &&
    mediaKey(previous.media) !== mediaKey(next.media)
  ) {
    return true;
  }
  return (
    next.kind === 'message' ||
    next.kind === 'subagent' ||
    next.kind === 'subagent-event' ||
    next.kind === 'approval' ||
    next.kind === 'question' ||
    next.kind === 'system' ||
    next.kind === 'system-reminder' ||
    next.kind === 'shell'
  );
}

function serializeMetaKey(
  meta: ResolvedBlockContinuationMeta | undefined,
  expanded: boolean,
): string | undefined {
  if (meta === undefined) return undefined;
  return JSON.stringify([
    meta.note,
    expanded ? meta.rangeSuffix : undefined,
    expanded ? meta.continuationStatus : undefined,
  ]);
}

function renderShellBlockComponent(
  block: ShellBlock,
  meta?: ResolvedBlockContinuationMeta,
  expanded = false,
  ui?: TUI,
): Component {
  const fullOutput = `${block.output}${meta?.rangeSuffix ?? ''}`;
  const command = block.command ?? fullOutput;
  const output = block.command === undefined || fullOutput === '' ? '' : `\n${fullOutput}`;
  const noteInfo = parseToolSideChannelNote(meta?.note);
  const extraLines: string[] = [...noteInfo.actionableLines];
  if (expanded) {
    extraLines.push(...noteInfo.systemLines);
    const status = meta?.continuationStatus;
    if (status?.state === 'loading') {
      extraLines.push('Loading full output…');
    } else if (status?.state === 'error') {
      extraLines.push(`Could not load full output: ${status.message} (toggle Ctrl+O to retry)`);
    } else if (status?.state === 'partial') {
      extraLines.push(`Showing ${String(status.loaded)} of ${String(status.total)} characters`);
    }
  }
  const suffix = extraLines.length === 0 ? '' : `\n${extraLines.join('\n')}`;
  const body = `${block.done ? '$' : '…'} ${command}${output}${suffix}`;
  if (!block.done || block.isError) {
    return new Text(currentTheme.fg(block.isError ? 'error' : 'text', body), 2, 0);
  }
  const firstLine = command.split(/\r?\n/u, 1)[0] ?? '';
  const summaryNote =
    noteInfo.actionableLines.length > 0 ? ` · ${noteInfo.actionableLines[0]}` : '';
  return new ProcessDetail(`$ ${firstLine}${summaryNote}`, body, 'text', ui);
}

function mediaKey(media: readonly MediaRef[] | undefined): string {
  return JSON.stringify(media ?? []);
}

function updateMountedBlock(
  component: Component,
  block: Block,
  meta?: ResolvedBlockContinuationMeta,
  thinkingDurationMs?: number,
): void {
  switch (block.kind) {
    case 'assistant':
      (component as DaemonAssistantMessageComponent).updateContent(block.text, {
        transient: block.streaming,
      });
      return;
    case 'thinking': {
      const thinking = component as ThinkingComponent;
      thinking.setText(block.text);
      thinking.setDurationMs(thinkingDurationMs);
      if (!block.streaming) thinking.finalize();
      return;
    }
    case 'tool': {
      const tool = component as ToolCallComponent;
      tool.updateToolCall(toolCallData(block, meta));
      tool.setProgressSnapshot(block.status === 'running' ? block.progressText : undefined);
      const result = toolResultData(block, meta);
      if (result !== undefined) tool.setResult(result);
      return;
    }
    case 'user':
      (component as DaemonUserMessageComponent).update(block);
      return;
    case 'skill':
      (component as Text).setText(currentTheme.dim(`/${block.name}${block.args === undefined ? '' : ` ${block.args}`}`));
      return;
    case 'notice': {
      const text = formatNoticeText(block);
      (component as Text).setText(
        block.tone === 'danger' ? currentTheme.fg('error', text) : currentTheme.dim(text),
      );
      return;
    }
    case 'system':
    case 'system-reminder':
    case 'message':
    case 'subagent':
    case 'subagent-event':
    case 'approval':
    case 'question':
    case 'shell':
      return;
  }
}

function createToolComponent(
  block: ToolBlock,
  ui?: TUI,
  workDir?: string,
  meta?: ResolvedBlockContinuationMeta,
): ToolCallComponent {
  const result = toolResultData(block, meta);
  const component = new ToolCallComponent(toolCallData(block, meta), result, ui, workDir);
  if (block.status === 'running' && typeof block.progressText === 'string' && block.progressText.length > 0) {
    component.setProgressSnapshot(block.progressText);
  }
  return component;
}

function toolCallData(
  block: ToolBlock,
  meta?: ResolvedBlockContinuationMeta,
): ToolCallBlockData {
  const rawArgsText = typeof block.argsText === 'string' ? block.argsText : '';
  const args = asRecord(block.args, rawArgsText);
  const streamingArguments =
    block.status === 'running' && rawArgsText.length > 0 ? rawArgsText : undefined;
  return {
    id: block.toolCallId,
    name: block.name,
    args,
    description: block.description,
    display: block.display,
    streamingArguments,
    result: toolResultData(block, meta),
    turnId: block.turnId,
  };
}

function toolResultData(
  block: ToolBlock,
  meta?: ResolvedBlockContinuationMeta,
): ToolResultBlockData | undefined {
  if (block.status === 'running') return undefined;
  const baseOutput = block.output === undefined ? '' : displayValue(block.output);
  return {
    tool_call_id: block.toolCallId,
    output: meta?.rangeSuffix === undefined ? baseOutput : `${baseOutput}${meta.rangeSuffix}`,
    is_error: block.status === 'error' || block.isError === true,
    note: meta?.note,
    continuationStatus: meta?.continuationStatus,
  };
}

function asRecord(value: unknown, argsText: string): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : argsText === ''
      ? {}
      : { input: argsText };
}

function displayValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, undefined, 2);
}

function formatSubagent(block: Extract<Block, { kind: 'subagent' }>): string {
  const status =
    block.status === 'completed'
      ? currentTheme.fg('success', '✓')
      : block.status === 'failed' || block.status === 'cancelled'
        ? currentTheme.fg('error', '✗')
        : currentTheme.fg('primary', '●');
  const detail = block.description ?? block.summary;
  return `${status} ${currentTheme.boldFg('primary', block.name)}${detail === undefined ? '' : currentTheme.dim(` · ${detail}`)}`;
}

function disposeComponent(component: Component): void {
  const disposable = component as Component & { dispose?: () => void };
  disposable.dispose?.();
}

function extractViaClientField(via: unknown): string | undefined {
  if (typeof via !== 'object' || via === null) return undefined;
  const client = (via as { readonly client?: unknown }).client;
  return typeof client === 'string' && client.length > 0 ? client : undefined;
}

function extractViaClientFromOrigin(origin: unknown): string | undefined {
  if (typeof origin !== 'object' || origin === null) return undefined;
  return extractViaClientField((origin as { readonly via?: unknown }).via);
}

function readViaClient(block: UserBlock): string | undefined {
  return (
    extractViaClientField(block.via) ??
    extractViaClientFromOrigin(block.sourceOrigin)
  );
}

function readBlockTurnId(block: Block): string | undefined {
  return 'turnId' in block && typeof block.turnId === 'string' ? block.turnId : undefined;
}

interface PreparedDisplayBlocks {
  readonly displayBlocks: Block[];
  readonly leadingSuppressedIds: Set<string>;
  readonly suppressedAfterVisibleId: Map<string, string[]>;
}

function prepareDisplayBlocks(
  blocks: readonly Block[],
  options: { readonly expanded: boolean; readonly showThinking: boolean },
): PreparedDisplayBlocks {
  const displayBlocks: Block[] = [];
  const leadingSuppressedIds = new Set<string>();
  const suppressedAfterVisibleId = new Map<string, string[]>();
  const seenRecipes = new Set<string>();
  let lastVisibleId: string | undefined;
  let currentTurnId: string | undefined;
  let activeTurnFailure: { readonly turnId: string; readonly normError: string } | undefined;
  let pendingFrameDanger: { readonly turnId: string; readonly normError: string } | undefined;

  const recordSuppressed = (id: string): void => {
    if (lastVisibleId === undefined) {
      leadingSuppressedIds.add(id);
      return;
    }
    let list = suppressedAfterVisibleId.get(lastVisibleId);
    if (list === undefined) {
      list = [];
      suppressedAfterVisibleId.set(lastVisibleId, list);
    }
    list.push(id);
  };

  for (const block of blocks) {
    const turnId = readBlockTurnId(block);
    if (turnId !== undefined && currentTurnId !== undefined && turnId !== currentTurnId) {
      activeTurnFailure = undefined;
      pendingFrameDanger = undefined;
    }
    if (turnId !== undefined) {
      currentTurnId = turnId;
    }

    if (block.kind === 'user') {
      pendingFrameDanger = undefined;
      const outcome = block.promptOutcome;
      if (
        turnId !== undefined &&
        outcome !== undefined &&
        (outcome.status === 'failed' || outcome.status === 'aborted') &&
        outcome.error !== undefined
      ) {
        const normError = normalizeFailureText(outcome.error);
        activeTurnFailure = normError.length > 0 ? { turnId, normError } : undefined;
      } else {
        activeTurnFailure = undefined;
      }
    } else if (block.kind === 'assistant') {
      pendingFrameDanger = undefined;
    }

    if (!options.showThinking && block.kind === 'thinking') {
      recordSuppressed(block.id);
      continue;
    }

    if (!options.expanded && block.kind === 'system-reminder' && block.variant !== 'steer') {
      recordSuppressed(block.id);
      continue;
    }

    if (block.kind === 'system') {
      const info = classifySystemBlock(block);
      if (!options.expanded) {
        if (info.kind === 'internal') {
          recordSuppressed(block.id);
          continue;
        }
        if (info.kind === 'recipe') {
          const recipeKey = `${info.summary}\u0000${block.text}`;
          if (seenRecipes.has(recipeKey)) {
            recordSuppressed(block.id);
            continue;
          }
          seenRecipes.add(recipeKey);
        }
      }
    }

    if (block.kind === 'notice') {
      if (isStructuredDomainNotice(block)) {
        pendingFrameDanger = undefined;
      }
      if (!options.expanded && isPlumbingNotice(block)) {
        recordSuppressed(block.id);
        continue;
      }
      if (!options.expanded && isTurnFailureNotice(block)) {
        const normNotice = normalizeFailureText(formatNoticeText(block));
        if (normNotice.length > 0) {
          const explicitOutcome = isExplicitTurnOutcomeNotice(block);
          if (
            turnId !== undefined &&
            activeTurnFailure !== undefined &&
            turnId === activeTurnFailure.turnId &&
            normNotice === activeTurnFailure.normError
          ) {
            recordSuppressed(block.id);
            continue;
          }

          if (
            explicitOutcome &&
            turnId !== undefined &&
            pendingFrameDanger !== undefined &&
            turnId === pendingFrameDanger.turnId &&
            normNotice === pendingFrameDanger.normError
          ) {
            pendingFrameDanger = undefined;
            recordSuppressed(block.id);
            continue;
          }
          if (!explicitOutcome && turnId !== undefined) {
            pendingFrameDanger = { turnId, normError: normNotice };
          } else {
            pendingFrameDanger = undefined;
          }
        }
      }
    }

    displayBlocks.push(block);
    lastVisibleId = block.id;
  }

  return { displayBlocks, leadingSuppressedIds, suppressedAfterVisibleId };
}

function classifySystemBlock(
  block: SystemBlock,
): { readonly kind: 'recipe' | 'internal' | 'other'; readonly summary: string } {
  const recipeName = extractRecipeName(block);
  const source = block.source ?? '';
  const isRecipe =
    recipeName !== undefined ||
    source === 'model_steering' ||
    source === 'recipe' ||
    /^(?:recipe|model_steering)(?:[:/]|$)/iu.test(source);
  if (isRecipe) {
    return {
      kind: 'recipe',
      summary: recipeName !== undefined ? `Recipe · ${recipeName}` : 'Recipe',
    };
  }

  const trimmed = block.text.trimStart();
  const isInternalTag =
    trimmed.startsWith('<system-reminder>') ||
    trimmed.startsWith('<tools_added>') ||
    trimmed.startsWith('<tools_removed>') ||
    trimmed.startsWith('<memory-workset') ||
    trimmed.startsWith('<cognition') ||
    trimmed.startsWith('<skill-loaded');
  if (isInternalTag || block.variant === 'injection') {
    const label = trimmed.startsWith('<system-reminder>')
      ? 'Reminder'
      : source.length > 0
        ? `System · ${source}`
        : 'System injection';
    return { kind: 'internal', summary: label };
  }

  const first = block.text.split(/\r?\n/u, 1)[0]!.trim() || 'System';
  return { kind: 'other', summary: first };
}

function extractRecipeName(block: SystemBlock): string | undefined {
  const extra = block as SystemBlock & {
    readonly recipeName?: unknown;
    readonly recipe?: { readonly name?: unknown };
  };
  if (typeof extra.recipe?.name === 'string' && extra.recipe.name.trim().length > 0) {
    return extra.recipe.name.trim();
  }
  if (typeof extra.recipeName === 'string' && extra.recipeName.trim().length > 0) {
    return extra.recipeName.trim();
  }
  if (typeof block.source === 'string') {
    const sourceMatch = /^(?:recipe|model_steering)[:/](.+)$/iu.exec(block.source.trim());
    if (sourceMatch?.[1]?.trim()) return sourceMatch[1].trim();
  }
  const tagMatch = /^\s*<recipe(?:\s+[^>]*?)?\s+name=["']([^"'\r\n]+)["']/iu.exec(block.text);
  if (tagMatch?.[1]?.trim()) return tagMatch[1].trim();
  const bracketMatch = /^\s*\[recipe:\s*([^\r\n\]]+)\]/iu.exec(block.text);
  if (bracketMatch?.[1]?.trim()) return bracketMatch[1].trim();
  const firstLine = block.text.split(/\r?\n/u, 1)[0]?.trim() ?? '';
  const headingMatch = /^(?:#+\s*)?recipe\s*[:·—-]\s*([A-Za-z0-9._/-][^\r\n:]{0,39})$/iu.exec(
    firstLine,
  );
  if (headingMatch?.[1] && !/[.!?。！？，；]/u.test(headingMatch[1])) {
    return headingMatch[1].trim();
  }
  return undefined;
}

function isPlumbingNotice(block: NoticeBlock): boolean {
  const key = block.i18n?.key;
  if (
    key === 'transcript.marker.interruption' ||
    key === 'transcript.marker.hook' ||
    key === 'transcript.marker.skill'
  ) {
    return true;
  }
  if (block.tone === 'neutral') {
    const trimmed = block.text.trim();
    return trimmed === 'interruption' || trimmed === 'hook' || trimmed === 'skill';
  }
  return false;
}

function isStructuredDomainNotice(block: NoticeBlock): boolean {
  return (
    block.compactionPhase !== undefined ||
    block.modelSwitch !== undefined ||
    block.goalChange !== undefined ||
    block.branchBase !== undefined ||
    block.executor !== undefined ||
    block.externalText !== undefined
  );
}

function isExplicitTurnOutcomeNotice(block: NoticeBlock): boolean {
  const key = block.i18n?.key;
  return (
    key === 'notice.turnFailedDetail' ||
    key === 'notice.turnCancelledDetail' ||
    block.id.startsWith('agent-turn-outcome-')
  );
}

function isTurnFailureNotice(block: NoticeBlock): boolean {
  if (isStructuredDomainNotice(block)) return false;
  return block.tone === 'danger' || isExplicitTurnOutcomeNotice(block);
}

function formatNoticeText(block: NoticeBlock): string {
  const trimmed = block.text.trim();
  if (block.compactionPhase !== undefined && trimmed === 'compaction') {
    if (block.compactionPhase === 'failed' && block.compactionFailure) {
      return `Context compaction failed · ${block.compactionFailure}`;
    }
    const summaryLine = block.summary?.split(/\r?\n/u, 1)[0]?.trim();
    return summaryLine ? `Context compacted · ${summaryLine}` : `Context compaction · ${block.compactionPhase}`;
  }
  if (block.modelSwitch !== undefined && trimmed === 'model.switch') {
    return block.modelSwitch.to ? `Model switched · ${block.modelSwitch.to}` : 'Model switched';
  }
  if (block.goalChange !== undefined && trimmed === 'goal') {
    return 'Goal updated';
  }
  if (block.branchBase !== undefined && trimmed === 'branch.base') {
    return `Branched from ${block.branchBase.sourceAgentId}`;
  }
  if (trimmed === 'interruption') return 'Interrupted';
  return block.text;
}

function normalizeFailureText(text: string): string {
  return text
    .trim()
    .replace(
      /^(?:reply failed|prompt failed(?: before delivery)?|prompt aborted(?: before delivery)?|turn failed|error)\s*[·:—-]\s*/iu,
      '',
    )
    .replaceAll(/\s+/gu, ' ')
    .toLowerCase();
}
