/** Per-session composer drafts in localStorage (`kiki.drafts`). */

const KEY = 'kiki.drafts';

function readAll(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function readDraft(sessionId: string): string {
  return readAll()[sessionId] ?? '';
}

export function writeDraft(sessionId: string, text: string): void {
  const all = readAll();
  if (text === '') {
    delete all[sessionId];
  } else {
    all[sessionId] = text;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage full / unavailable — drafts are a convenience, not a guarantee
  }
}
