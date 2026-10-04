import { copyFile, mkdtemp, open, rename, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class StreamSave {
  private phase: "writing" | "committing" | "closed" = "writing";
  private busy = false;
  private received = 0;

  private constructor(private readonly file: FileHandle, private readonly temporary: string, private readonly directory: string, private readonly target: string) {}

  static async open(target: string): Promise<StreamSave> {
    const directory = await mkdtemp(join(tmpdir(), "kiki-media-save-"));
    const temporary = join(directory, "original.part");
    try {
      return new StreamSave(await open(temporary, "wx"), temporary, directory, target);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async write(chunk: Uint8Array, expectedOffset: number): Promise<number> {
    if (this.phase !== "writing" || this.busy) throw new Error("The save stream is closed or busy.");
    if (chunk.byteLength > 64 * 1024 || expectedOffset !== this.received) throw new Error("Invalid or out-of-order save chunk.");
    this.busy = true;
    try {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await this.file.write(chunk.subarray(offset));
        if (bytesWritten <= 0) throw new Error("The next download chunk could not be written.");
        offset += bytesWritten;
        this.received += bytesWritten;
      }
      return this.received;
    } finally {
      this.busy = false;
    }
  }

  async close(): Promise<boolean> {
    if (this.phase !== "writing" || this.busy) throw new Error("The save stream is closed or busy.");
    this.phase = "committing";
    try {
      await this.file.close();
      try {
        await rename(this.temporary, this.target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        try { await copyFile(this.temporary, this.target); }
        catch (cause) { throw new Error("Could not finish saving. The selected file may be incomplete.", { cause }); }
      }
      return true;
    } finally {
      this.phase = "closed";
      await rm(this.directory, { recursive: true, force: true });
    }
  }

  async abort(): Promise<void> {
    if (this.phase !== "writing") return;
    this.phase = "closed";
    try { await this.file.close(); }
    finally { await rm(this.directory, { recursive: true, force: true }); }
  }
}
