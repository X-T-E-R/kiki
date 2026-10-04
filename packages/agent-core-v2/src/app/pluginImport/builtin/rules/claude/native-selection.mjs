export function activeConversation(records) {
  const candidates = records.filter((record) => ['user', 'assistant'].includes(record.type) && record.hasMessage && !record.isMeta && !record.isSidechain);
  const byUuid = new Map();
  for (const record of records) {
    if (!record.uuid) continue;
    if (byUuid.has(record.uuid)) throw new Error('Claude transcript contains a duplicate record UUID');
    byUuid.set(record.uuid, record);
  }
  const leaf = records.findLast((record) => record.type === 'last-prompt' && record.leafUuid)?.leafUuid ?? candidates.at(-1)?.uuid;
  if (!leaf) return candidates;
  if (!byUuid.has(leaf)) throw new Error('Claude last-prompt references a missing leaf UUID');
  const chain = []; const seen = new Set(); let cursor = leaf;
  while (cursor) {
    if (seen.has(cursor)) throw new Error('Claude active graph contains an ancestry cycle');
    seen.add(cursor);
    const record = byUuid.get(cursor);
    if (!record) throw new Error('Claude active graph references a missing parent UUID');
    chain.push(record);
    if (record.parentUuid) { cursor = record.parentUuid; continue; }
    const logicalParent = record.type === 'system' && record.subtype === 'compact_boundary' ? record.logicalParentUuid : undefined;
    if (logicalParent && seen.has(logicalParent)) {
      if (validPreservedBackEdge(record, logicalParent, seen, byUuid)) break;
      throw new Error('Claude active graph contains an ancestry cycle');
    }
    cursor = logicalParent;
  }
  const eligible = new Set(candidates);
  const selected = chain.reverse().filter((record) => eligible.has(record));
  const sessionIds = new Set(selected.map((record) => record.sessionId).filter(Boolean));
  if (sessionIds.size > 1) throw new Error('Claude active graph contains mixed sessionId values');
  return selected;
}
function validPreservedBackEdge(boundary, parent, seen, byUuid) {
  const segment = boundary.compactMetadata?.preservedSegment;
  const messages = boundary.compactMetadata?.preservedMessages;
  if (!segment || !messages) return false;
  const { anchorUuid: anchor, headUuid: head, tailUuid: tail } = segment;
  if (!anchor || !head || !tail || parent !== tail) return false;
  const anchorRecord = byUuid.get(anchor);
  if (!anchorRecord?.isCompactSummary || anchorRecord.parentUuid !== boundary.uuid) return false;
  const declared = messages.allUuids ?? messages.uuids;
  if (!Array.isArray(declared) || !declared.length || !declared.includes(head) || !declared.includes(tail) || declared.some((id) => !seen.has(id))) return false;
  let cursor = tail; const path = new Set();
  while (cursor && cursor !== anchor) {
    if (path.has(cursor) || !seen.has(cursor)) return false;
    path.add(cursor); cursor = byUuid.get(cursor)?.parentUuid;
  }
  return cursor === anchor && path.has(head);
}
