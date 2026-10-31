import { enableIndependentWorkerHeaps, removeInjectedHeapOption } from '@kiki/node-sdk/worker-heap-policy';

removeInjectedHeapOption(process.env);
enableIndependentWorkerHeaps();
