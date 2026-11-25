import type { Session } from '@kiki/protocol';
import type { ConversationListItem } from './conversationList';
import type { SessionGroup, SessionSortOrder, TimeGroupLabels } from './sessionList';

/** Keep each session on its own activity clock without borrowing from creator/fork/child lineages. */
export function projectAttachedConversationGroups(
  groups: readonly SessionGroup<ConversationListItem>[],
  _options: {
    readonly groupBy: 'time' | 'workspace' | 'none';
    readonly order: SessionSortOrder;
    readonly topLevelIds: ReadonlySet<string>;
    /** All loaded relation facts, including rows currently filtered out. */
    readonly sessions: readonly Session[];
    readonly nowMs: number;
    readonly labels?: TimeGroupLabels;
  },
): readonly SessionGroup<ConversationListItem>[] {
  return groups;
}
