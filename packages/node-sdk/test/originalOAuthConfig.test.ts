import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfigString, readConfigFile, writeConfigFile } from '#/config';

it('round trips the original OAuth source through node-sdk config read and write', async () => {
  const root = join(process.cwd(), '.tmp/original-oauth-config');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'fixture-'));
  const config = parseConfigString(`
[providers."managed:openai-codex"]
type = "openai_responses"
[providers."managed:openai-codex".oauth]
storage = "file"
key = "oauth/openai-codex"
[providers."managed:openai-codex".oauth.source]
kind = "local_original"
provider = "openai-codex"
home_dir = "C:/synthetic/codex"
storage_backend = "encrypted"
auth_file = "C:/synthetic/codex/secrets/codex_auth.age"
account_id = "account-a"
user_id = "user-a"
`);
  const source = config.providers['managed:openai-codex']!.oauth!.source;
  expect(source).toMatchObject({ homeDir: 'C:/synthetic/codex', storageBackend: 'encrypted', accountId: 'account-a', userId: 'user-a' });
  const path = join(dir, 'config.toml');
  try {
    await writeConfigFile(path, config);
    expect(readConfigFile(path).providers['managed:openai-codex']!.oauth!.source).toEqual(source);
    const text = await readFile(path, 'utf8');
    expect(text).toContain('home_dir');
    expect(text).not.toContain('homeDir');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
