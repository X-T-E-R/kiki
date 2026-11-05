import { access, appendFile, readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('./kimi.plugin.json', import.meta.url), 'utf8'));
const leases = new Map();
let nextId = 0;
const audit = (context, value) => appendFile(context.settings.audit, JSON.stringify({ ...value, pid: process.pid, home: context.kikiHome, aborted: context.signal.aborted }) + '\n');

export function register(api) {
  api.registerHarnessAccountSource(manifest['x-kiki'].harnessAccountSources[0], {
    async list(input, context) {
      await audit(context, { action: 'list', engine: input.engineId });
      return [
        { id: 'account-a', label: 'Account A', status: 'ready', oauthToken: 'private-oauth-material' },
        { id: 'signed-out', label: 'Account B', status: 'signed_out' },
        { id: 'disabled', label: 'Account C', status: 'disabled' },
      ];
    },
    async prepare(input, context) {
      await audit(context, { action: 'prepare', input });
      if (input.accountId === 'signed-out') throw new Error('Selected account is signed out');
      if (input.accountId === 'slow') {
        while (await access(context.settings.gate).then(() => false, () => true)) {
          if (!context.settings.ignoreCancel) context.signal.throwIfAborted();
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const leaseId = `private-lease-${++nextId}`;
      leases.set(leaseId, input);
      const protocol = input.engineId === 'codex' ? 'openai-responses' : 'gemini-v1beta';
      if (input.accountId === 'exit') setTimeout(() => process.exit(9), 100);
      return {
        leaseId,
        oauthToken: 'private-oauth-material',
        connection: {
          protocol: input.accountId === 'invalid' ? 'private-invalid-protocol' : protocol,
          baseUrl: 'http://127.0.0.1:12345/v1', apiKey: 'short-lived-fixture-key', modelIds: ['fixture-model'],
          refreshToken: 'private-oauth-material',
        },
      };
    },
    async release({ leaseId }, context) {
      const input = leases.get(leaseId);
      leases.delete(leaseId);
      await audit(context, { action: 'release', input });
    },
  });
}
