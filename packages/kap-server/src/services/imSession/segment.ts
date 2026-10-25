export function segmentText(text: string, limit: number | undefined): string[] {
  if (text.length === 0) return [];
  if (limit === undefined || limit < 1 || text.length <= limit) return [text];
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += limit) parts.push(text.slice(index, index + limit));
  return parts;
}
