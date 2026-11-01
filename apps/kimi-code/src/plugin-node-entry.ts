import { installGlobalProxyDispatcher } from '@kiki/node-sdk/proxy';
import { runPluginNodeEntry } from './cli/sub/plugin-run-node';
import { installNativeModuleHook } from './native/module-hook';

installGlobalProxyDispatcher(process.env);
installNativeModuleHook();

void (async () => {
  try {
    const commandIndex = process.argv.indexOf('__plugin_run_node');
    await runPluginNodeEntry(process.argv[commandIndex + 1] ?? '', process.argv.slice(commandIndex + 2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
})();
