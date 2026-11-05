import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { consumeAccountEnvironment, runBridge } from '../../../../scripts/external-harness/agy-cli-acp.mjs';

const args = process.argv.slice(2);
if (args[0] === '--version' || args[0] === '--kiki-harness-account-version') {
  console.log('agy-cli-acp 0.2.0');
} else {
  const account = args.at(-1) === '--kiki-harness-account' ? consumeAccountEnvironment() : undefined;
  const require = createRequire(new URL('../../../acp-client/package.json', import.meta.url));
  await runBridge({ cliPath: process.execPath, cliPrefix: [fileURLToPath(new URL('./plugin-account-agy-vendor.mjs', import.meta.url))],
    sdkPath: require.resolve('@agentclientprotocol/sdk'), auditDir: process.env.AGY_BRIDGE_AUDIT_DIR,
    model: args[0] === '--model' ? args[1] : undefined, account });
}
