import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKlient } from '../src/transports/http/index';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');

function collectRuntimeImports(entryFile: string): Set<string> {
  const visited = new Set<string>();
  const externalImports = new Set<string>();
  const queue = [entryFile];
  const importRe = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const content = readFileSync(file, 'utf-8');
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(content)) !== null) {
      const specifier = match[1]!;
      if (specifier.startsWith('.')) {
        const base = resolve(dirname(file), specifier);
        const candidates = [
          base,
          `${base}.ts`,
          `${base}.tsx`,
          join(base, 'index.ts'),
        ];
        for (const candidate of candidates) {
          try {
            readFileSync(candidate);
            queue.push(candidate);
            break;
          } catch {
          }
        }
      } else {
        externalImports.add(specifier);
      }
    }
  }
  return externalImports;
}

describe('@kiki/klient/http engine-free import boundary & raw substrate facade', () => {
  it('has zero runtime imports of @kiki/agent-core-v2 in the @kiki/klient/http module graph', () => {
    const entry = join(PACKAGE_ROOT, 'src', 'transports', 'http', 'index.ts');
    const externals = collectRuntimeImports(entry);
    const engineImports = [...externals].filter(
      (spec) => spec === '@kiki/agent-core-v2' || spec.startsWith('@kiki/agent-core-v2/'),
    );
    expect(engineImports).toEqual([]);
  });

  it('exposes typed klient.rest.raw methods for R1-R4(c)', async () => {
    const klient = createKlient({
      endpoint: 'http://127.0.0.1:1',
      token: 'test-token',
    });
    expect(klient.rest).toBeDefined();
    const raw = klient.rest!.raw;
    expect(typeof raw.createSession).toBe('function');
    expect(typeof raw.submitPrompt).toBe('function');
    expect(typeof raw.streamSessionEvents).toBe('function');
    expect(typeof raw.streamGlobalEvents).toBe('function');
    expect(typeof raw.llmComplete).toBe('function');
    expect(typeof raw.llmCompleteStream).toBe('function');
    expect(typeof raw.respondInteraction).toBe('function');
    await klient.close();
  });
});
