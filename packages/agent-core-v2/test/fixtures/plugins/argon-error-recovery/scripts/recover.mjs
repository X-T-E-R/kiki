import { recoveryFor } from '../lib/recovery.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const output = recoveryFor(JSON.parse(input));
if (output !== undefined) process.stdout.write(JSON.stringify(output));
