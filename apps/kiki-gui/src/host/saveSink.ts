import type { HostSaveSink } from './host';

export function bufferedSaveSink(save: (blob: Blob) => Promise<boolean>): HostSaveSink {
  const chunks: BlobPart[] = [];
  let closed = false;
  return {
    streaming: false,
    async write(chunk) {
      if (closed) throw new Error('The save stream is closed');
      chunks.push(chunk.slice() as BlobPart);
    },
    async close() {
      if (closed) return false;
      closed = true;
      const blob = new Blob(chunks);
      chunks.length = 0;
      return save(blob);
    },
    async abort() { closed = true; chunks.length = 0; },
  };
}

export async function browserSaveSink(filename: string): Promise<HostSaveSink | null> {
  const picker = (globalThis as unknown as { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }> }).showSaveFilePicker;
  if (picker !== undefined) {
    try {
      const handle = await picker({ suggestedName: filename });
      const writer = (await handle.createWritable()).getWriter();
      let closed = false;
      return {
        streaming: true,
        write: (chunk) => writer.write(chunk),
        async close() { if (closed) return false; closed = true; await writer.close(); return true; },
        async abort() { if (closed) return; closed = true; await writer.abort(); },
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      throw error;
    }
  }
  return bufferedSaveSink(async (blob) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  });
}
