export function computeFuzzyScore(name: string, queryLower: string): number {
  if (queryLower.length === 0) return 0;
  const nameLower = name.toLowerCase();
  let nameIdx = 0;
  let matched = 0;
  for (const ch of queryLower) {
    const found = nameLower.indexOf(ch, nameIdx);
    if (found < 0) return 0;
    matched++;
    nameIdx = found + 1;
  }
  if (matched <= 0) return 0;
  let score = matched / queryLower.length;
  if (nameLower.startsWith(queryLower)) score = Math.min(1, score + 0.2);
  return Math.min(1, Math.max(0, score));
}
