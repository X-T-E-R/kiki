export function googleGenAIRejectsTrailingModelTurn(modelName: string): boolean {
  const leaf = modelName.split('/').pop()?.trim().toLowerCase() ?? '';
  if (!leaf.startsWith('gemini-')) return false;
  if (leaf.startsWith('gemini-3.5-flash-lite')) return true;
  const match = /^gemini-(\d+)(?:\.(\d+))?/.exec(leaf);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  if (major > 3) return true;
  return major === 3 && minor >= 6;
}

export function googleGenAINestsFunctionResponseMedia(modelName: string): boolean {
  const leaf = modelName.split('/').pop()?.trim().toLowerCase() ?? '';
  const match = /^gemini-(\d+)/.exec(leaf);
  if (match === null) return false;
  const major = Number(match[1]);
  return Number.isInteger(major) && major >= 3;
}
