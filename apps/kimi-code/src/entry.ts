import './native/worker-heap';
import { initializeMainHeap } from './native/main-heap';

if (!initializeMainHeap()) {
  void import('./main').catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
