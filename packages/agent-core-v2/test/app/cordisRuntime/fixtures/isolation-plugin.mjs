import { threadId } from 'node:worker_threads';

export const slots = {
  echo(payload) {
    return { payload, threadId };
  },
  async wait(payload) {
    await new Promise((resolve) => setTimeout(resolve, payload.delayMs));
    return { payload, threadId };
  },
  spin() {
    while (true) {}
  },
};
