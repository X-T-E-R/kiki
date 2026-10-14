import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SOURCE_OWNED_ADAPTER_ENTRY,
  SOURCE_OWNED_ADAPTER_FILES,
  SOURCE_OWNED_ADAPTER_SUPPORTS_MCP,
  SOURCE_OWNED_ADAPTER_VERSION,
} from './production-manifest.mjs';

test('production manifest lists only the three shipped adapter files', async () => {
  assert.deepEqual([...SOURCE_OWNED_ADAPTER_FILES], [
    'agy-cli-acp.mjs',
    'agy-hook-registration.mjs',
    'agy-permission-hook.mjs',
  ]);
  assert.equal(SOURCE_OWNED_ADAPTER_ENTRY, 'agy-cli-acp.mjs');
  assert.equal(SOURCE_OWNED_ADAPTER_SUPPORTS_MCP, true);
  const cli = JSON.parse(await readFile(new URL('../../apps/kimi-code/package.json', import.meta.url), 'utf8'));
  assert.equal(SOURCE_OWNED_ADAPTER_VERSION, cli.version);
  const entry = await readFile(new URL(`./${SOURCE_OWNED_ADAPTER_ENTRY}`, import.meta.url), 'utf8');
  assert.match(entry, /registerMcpAgent/);
  assert.match(entry, /--mcp-stdio/);
  for (const name of SOURCE_OWNED_ADAPTER_FILES) {
    const bytes = await readFile(new URL(`./${name}`, import.meta.url));
    assert.ok(bytes.byteLength > 0);
  }
  assert.equal(SOURCE_OWNED_ADAPTER_FILES.includes('fixture-cli.mjs'), false);
  assert.equal(SOURCE_OWNED_ADAPTER_FILES.includes('agy-cli-audit-acp.mjs'), false);
});
