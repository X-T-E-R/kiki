/**
 * Clipboard write with a document.execCommand fallback for non-secure or
 * permission-denied contexts. Resolves regardless of which path succeeded;
 * throws only when neither channel exists.
 */

export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // clipboard API denied (permissions policy, insecure context) — fall back.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    document.execCommand('copy');
  } finally {
    area.remove();
  }
}
