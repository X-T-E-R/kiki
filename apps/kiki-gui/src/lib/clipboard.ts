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

const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

export function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { resolve(new Uint8Array(reader.result as ArrayBuffer)); };
    reader.onerror = () => { reject(reader.error ?? new Error('Failed to read blob')); };
    reader.readAsArrayBuffer(blob);
  });
}

export async function isPngBlob(blob: Blob): Promise<boolean> {
  if (blob.size < 8) return false;
  const slice = typeof blob.slice === 'function' ? blob.slice(0, 8) : blob;
  const header = (await readBlobBytes(slice)).subarray(0, 8);
  if (header.length < 8) return false;
  return PNG_MAGIC.every((byte, index) => header[index] === byte);
}

export async function copyImageToClipboard(blob: Blob): Promise<void> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard === undefined || typeof clipboard.write !== 'function' || typeof ClipboardItem === 'undefined') {
    throw new Error('Clipboard image write is unavailable');
  }
  if (blob.type !== 'image/png' || !(await isPngBlob(blob))) {
    throw new Error('Clipboard image write requires a valid PNG image');
  }
  await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}
