/**
 * Clipboard write with a document.execCommand fallback for non-secure or
 * permission-denied contexts. Rejects when both channels fail.
 */

import { isVscodeWebview, vscodeHost } from '../host/vscode';
import { androidBridge, hasAndroidBridge } from './androidBridge';

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
  if (hasAndroidBridge() && (await androidBridge.writeClipboard(text))) {
    return;
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

export async function copyImageToClipboard(source: Blob | Promise<Blob>): Promise<void> {
  let preparationError: unknown;
  const png = Promise.resolve(source).then(async (blob) => {
    if (blob.type !== 'image/png' || !(await isPngBlob(blob))) {
      throw new Error('Clipboard image write requires a valid PNG image');
    }
    return blob;
  });
  // A denied write can finish before decoding does; always observe both promises.
  void png.catch((error: unknown) => { preparationError = error; });
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard === undefined || typeof clipboard.write !== 'function' || typeof ClipboardItem === 'undefined') {
    throw new Error('Clipboard image write is unavailable');
  }
  try {
    // Start during the click, not after fetch/decode/toBlob has spent activation.
    await clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } catch (error) {
    if (preparationError !== undefined) {
      const preparationFailure = preparationError instanceof Error
        ? preparationError
        : new Error('Clipboard image preparation failed', { cause: preparationError });
      throw preparationFailure;
    }
    // Older engines accept Blob values but reject promised ClipboardItem data.
    if (!(error instanceof TypeError)) throw error;
    const blob = await png;
    await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }
}
