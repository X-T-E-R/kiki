import { describe, expect, it } from 'vitest';

import { modelCognitionBodiesSchema, modelEntitySchema, type ModelCognitionBodies } from '@kiki/protocol';

import {
  branchKeyFor, cognitionSlotPatch, initialSlotText, restoreHint, savesAsInlineText, slotView,
} from './modelCognitionBodies';

const bodies = (over: Record<string, unknown> = {}): ModelCognitionBodies => modelCognitionBodiesSchema.parse({
  revision: 'r1',
  branches: {
    common: {
      selection: 'common',
      source_scope: 'common',
      slots: {
        overlay: { channel: 'cognition_overlay', source: 'files', text: 'from file', files: [{ path: 'p.md', text: 'from file' }], writable: false, source_read_only: true },
        steering: { channel: 'cognition_steering', source: 'inline', text: 'steer me', writable: true, source_read_only: false },
        anchor: { channel: 'cognition_anchor', source: 'unset', writable: true, source_read_only: false },
      },
    },
    main: {
      selection: 'custom',
      source_scope: 'main',
      slots: {
        overlay: { channel: 'cognition_overlay', source: 'inline', text: 'main body', writable: true, source_read_only: false },
        steering: { channel: 'cognition_steering', source: 'unset', writable: true, source_read_only: false },
        anchor: { channel: 'cognition_anchor', source: 'unset', writable: true, source_read_only: false },
      },
    },
    independent: {
      selection: 'off',
      source_scope: 'independent',
      slots: {
        overlay: { channel: 'cognition_overlay', source: 'unset', writable: true, source_read_only: false },
        steering: { channel: 'cognition_steering', source: 'unset', writable: true, source_read_only: false },
        anchor: { channel: 'cognition_anchor', source: 'unset', writable: true, source_read_only: false },
      },
    },
  },
  ...over,
});

describe('branchKeyFor', () => {
  it('maps the shared scope onto the common branch', () => {
    expect(branchKeyFor('shared')).toBe('common');
    expect(branchKeyFor('main')).toBe('main');
    expect(branchKeyFor('independent')).toBe('independent');
  });
});

describe('slotView', () => {
  it('reports a file-backed slot as not writable', () => {
    const view = slotView(bodies(), 'shared', 'overlay');
    expect(view?.source).toBe('files');
    expect(view?.writable).toBe(false);
    expect(view?.sourceReadOnly).toBe(true);
  });

  it('returns nothing for an identity switched off, rather than empty prose', () => {
    expect(slotView(bodies(), 'independent', 'overlay')).toBeUndefined();
  });

  it('returns nothing at all when the server sent no projection', () => {
    expect(slotView(undefined, 'shared', 'overlay')).toBeUndefined();
    expect(initialSlotText(undefined)).toBe('');
  });
});

describe('savesAsInlineText', () => {
  it('is true only for a slot backed by files', () => {
    expect(savesAsInlineText(slotView(bodies(), 'shared', 'overlay')!)).toBe(true);
    expect(savesAsInlineText(slotView(bodies(), 'shared', 'steering')!)).toBe(false);
  });
});

describe('restoreHint', () => {
  it('names the original reference so it can be configured back', () => {
    expect(restoreHint(slotView(bodies(), 'shared', 'overlay')!)).toBe('p.md');
    expect(restoreHint(slotView(bodies(), 'shared', 'steering')!)).toBeUndefined();
  });
});

describe('cognitionSlotPatch', () => {
  const entity = () => modelEntitySchema.parse({
    id: 'example/model',
    provider_id: 'example',
    provider_source: 'flat',
    effective_parameters: {},
    parameter_sources: {},
    issues: [],
    revision: 'r1',
    cognition: { overlay: 'p.md', overlay_mode: 'append', steering: 's.md' },
  });

  it('writes inline text into the stored object and keeps the other slots', () => {
    const patch = cognitionSlotPatch(entity(), 'cognition', 'overlay', 'new body');
    const cognition = patch['cognition'] as Record<string, unknown>;
    expect(cognition['overlay']).toEqual({ text: 'new body' });
    expect(cognition['steering']).toBe('s.md');
    expect(cognition['overlay_mode']).toBe('append');
  });

  it('treats an empty string as a real body rather than a removal', () => {
    const patch = cognitionSlotPatch(entity(), 'cognition', 'overlay', '');
    expect((patch['cognition'] as Record<string, unknown>)['overlay']).toEqual({ text: '' });
  });

  it('removes the key only when the caller asks to remove the slot', () => {
    const patch = cognitionSlotPatch(entity(), 'cognition', 'overlay', undefined);
    expect('overlay' in (patch['cognition'] as Record<string, unknown>)).toBe(false);
    expect((patch['cognition'] as Record<string, unknown>)['steering']).toBe('s.md');
  });

  it('does not invent a cognition object when the model has none', () => {
    const bare = modelEntitySchema.parse({
      id: 'example/model', provider_id: 'example', provider_source: 'flat',
      effective_parameters: {}, parameter_sources: {}, issues: [], revision: 'r1',
    });
    expect(cognitionSlotPatch(bare, 'cognition', 'overlay', 'body')).toEqual({ cognition: { overlay: { text: 'body' } } });
  });
});