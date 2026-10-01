import { describe, expect, it } from 'vitest';
import { NestedFoldStore } from './nestedFold';

describe('NestedFoldStore', () => {
  it('folds settled subagents (completed, cancelled) at first sight', () => {
    const store = new NestedFoldStore();
    store.see('agent-completed', 'completed');
    store.see('agent-cancelled', 'cancelled');

    expect(store.folded('agent-completed', 'completed')).toBe(true);
    expect(store.folded('agent-cancelled', 'cancelled')).toBe(true);
  });

  it('never folds live or failed subagents at first sight', () => {
    const store = new NestedFoldStore();
    store.see('agent-running', 'running');
    store.see('agent-background', 'background');
    store.see('agent-suspended', 'suspended');
    store.see('agent-failed', 'failed');
    store.see('agent-unknown', 'unknown');

    expect(store.folded('agent-running', 'running')).toBe(false);
    expect(store.folded('agent-background', 'background')).toBe(false);
    expect(store.folded('agent-suspended', 'suspended')).toBe(false);
    expect(store.folded('agent-failed', 'failed')).toBe(false);
    expect(store.folded('agent-unknown', 'unknown')).toBe(false);
  });

  it('keeps a subagent expanded if it was running when first seen and finished later', () => {
    const store = new NestedFoldStore();
    // First sight: subagent is running
    store.see('agent-live', 'running');
    expect(store.folded('agent-live', 'running')).toBe(false);

    // Later: subagent completes while the view is still open
    store.see('agent-live', 'completed'); // subsequent see() calls are ignored
    expect(store.folded('agent-live', 'completed')).toBe(false);
  });

  it('does not re-fold a historical agent that resumes and completes in this view', () => {
    const store = new NestedFoldStore();
    store.see('resumed', 'completed');
    expect(store.folded('resumed', 'completed')).toBe(true);
    store.see('resumed', 'running');
    expect(store.folded('resumed', 'running')).toBe(false);
    store.see('resumed', 'completed');
    expect(store.folded('resumed', 'completed')).toBe(false);
  });

  it('permanently unfolds when open() is called', () => {
    const store = new NestedFoldStore();
    store.see('agent-done', 'completed');
    expect(store.folded('agent-done', 'completed')).toBe(true);

    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });

    store.open('agent-done');
    expect(notified).toBe(1);
    expect(store.folded('agent-done', 'completed')).toBe(false);

    // Idempotent
    store.open('agent-done');
    expect(notified).toBe(1);

    unsubscribe();
  });
});
