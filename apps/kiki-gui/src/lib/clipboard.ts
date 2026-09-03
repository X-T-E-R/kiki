/**
 * Clipboard write with a document.execCommand fallback for non-secure or
 * permission-denied contexts. Rejects when both channels fail.
 */

import { isVscodeWebview, vscodeHost } from '../host/vscode';

export async function copyTextToClipboard(text: string): Promise<void> {
  if (isVscodeWebview()) {
    await vscodeHost.writeClipboard(text);
    return;
  }
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
    if (!document.execCommand('copy')) {
      throw new Error('Clipboard fallback rejected the copy command.');
    }
  } finally {
    area.remove();
  }
}
