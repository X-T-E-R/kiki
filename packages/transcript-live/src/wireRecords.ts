import { readFile } from 'node:fs/promises';

export interface ContextRecord {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface WireRecordsReadResult {
  readonly records: ContextRecord[];
  readonly complete: boolean;
}

export async function readWireRecords(wirePath: string): Promise<ContextRecord[]> {
  return (await readWireRecordsWithCompleteness(wirePath)).records;
}

export async function readWireRecordsWithCompleteness(wirePath: string): Promise<WireRecordsReadResult> {
  const raw = await readFile(wirePath, 'utf8');
  const lines = raw.split('\n');
  const records: ContextRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as ContextRecord);
    } catch (parseError) {
      if (i === lines.length - 1) return { records, complete: false };
      throw new Error(
        `wire.jsonl: corrupted line ${i + 1} in ${wirePath}: ${String(parseError)}`,
        { cause: parseError },
      );
    }
  }
  return { records, complete: true };
}
