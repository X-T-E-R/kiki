export async function previewThumbnail(bytes: Uint8Array, mime: string, width = 768): Promise<string | undefined> {
  if (!mime.startsWith('image/') || mime === 'image/svg+xml' ||
      typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return undefined;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    const scale = Math.min(1, width / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    const context = canvas.getContext('2d');
    if (context === null) return undefined;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const thumbnail = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
    return URL.createObjectURL(thumbnail);
  } catch {
    return undefined;
  } finally {
    bitmap?.close();
  }
}
