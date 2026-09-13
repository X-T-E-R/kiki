import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ sea: false, install: vi.fn(), run: vi.fn(() => new Promise<boolean>(() => {})) }));
vi.mock('node:sea', () => ({ isSea: () => state.sea }));
vi.mock('@kiki/node-sdk', () => ({ installNbSearchWorkerHost: state.install, runNbSearchWorkerCommand: state.run, NB_SEARCH_WORKER_COMMAND: '--internal-nb-search-worker' }));
import { initializeNbSearchWorkerEntry } from '../../src/native/nb-search-worker';
const argv = process.argv;
afterEach(() => { process.argv = argv; vi.clearAllMocks(); });
describe('nb-search executable dispatch', () => {
  it('uses the SEA executable without a Node script argument', () => {
    state.sea = true; process.argv = ['kiki-server.exe', 'kiki-server.exe', 'serve'];
    expect(initializeNbSearchWorkerEntry()).toBe(false);
    expect(state.install).toHaveBeenCalledWith({ executable: process.execPath, entryArgs: [] });
  });
  it('keeps the Node entry script in ordinary npm mode', () => {
    state.sea = false; process.argv = [process.execPath, '/fixture/main.mjs', 'serve'];
    initializeNbSearchWorkerEntry();
    expect(state.install).toHaveBeenCalledWith({ executable: process.execPath, entryArgs: [...process.execArgv, '/fixture/main.mjs'] });
  });
  it('dispatches the fixed internal worker before ordinary CLI startup', () => {
    process.argv = ['exe', 'exe', '--internal-nb-search-worker', 'job', '/fixture/jobs'];
    expect(initializeNbSearchWorkerEntry()).toBe(true);
    expect(state.run).toHaveBeenCalledWith(['--internal-nb-search-worker', 'job', '/fixture/jobs']);
    expect(state.install).not.toHaveBeenCalled();
  });
});
