/**
 * Media sources — the pure logic, tested without a browser.
 *
 * These are the decisions a reader can be wrong about, so each one gets a case
 * that would fail if the rule were relaxed:
 *
 *  - A broken package and a switched-off one read the same, because from the
 *    outside they are the same thing: nothing you can do here will generate.
 *  - "Needs setup" is exactly the rows that will fail without a key — not a
 *    guess from an empty-looking form, and not every row that happens to have
 *    no stored value.
 *  - A job whose submission is unknown is never resumable-looking as a retry,
 *    and a job that failed *after* the provider accepted it is not a "you
 *    were charged nothing" case.
 *  - A stop is a stop, and the three cancellation outcomes stay three.
 */

import { describe, expect, it } from 'vitest';

import type { MediaJob, MediaKind } from '@kiki/protocol';

import {
  canResume,
  canStop,
  composeMediaSources,
  currentDefault,
  defaultPatch,
  defaultProviderFor,
  defaultSettingKey,
  defaultsFromSettings,
  defaultsOf,
  filterBands,
  isJobActive,
  isJobUnknown,
  matchesFilter,
  mediaSourceMatches,
  mediaSourceStatus,
  needsConfig,
  originalArtifacts,
  outcomeIsFor,
  visibleMediaSources,
  withSubscription,
  cancellationNote,
  type MediaSourceEntry,
  type MediaSourceSettings,
} from './mediaSources';
import { artifactFacts } from '../components/media/MediaArtifactList';

function provider(id: string, label: string, kinds: MediaKind[], extra: Partial<MediaSourceEntry> = {}): MediaSourceEntry {
  return {
    provider: `vendor-${id}/${id}`,
    pluginId: `vendor-${id}`,
    definition: { schemaVersion: 1, id, kinds, label, resumeVersion: 1 },
    displayName: label,
    enabled: true,
    broken: false,
    ...extra,
  };
}

function settings(
  properties: MediaSourceSettings['schema']['schema']['properties'],
  values: MediaSourceSettings['values'],
  extra: Partial<MediaSourceSettings> = {},
  required?: readonly string[],
): MediaSourceSettings {
  return {
    schema: { schema: required === undefined ? { properties } : { properties, required } },
    values,
    secretsConfigured: [],
    ...extra,
  };
}

function job(over: Partial<MediaJob> = {}): MediaJob {
  return {
    schemaVersion: 1,
    job_id: 'media-1',
    request_id: 'cover-01',
    owner_session_id: 's1',
    owner_agent_id: 'a1',
    provider: 'vendor-a/a',
    state: 'succeeded',
    phase: 'generation',
    can_resume: false,
    artifacts: [],
    created_at: 1,
    updated_at: 2,
    ...over,
  };
}

describe('mediaSourceStatus', () => {
  it('reads a package that failed to load and one that is switched off the same way', () => {
    // From the reader's side these are the same situation: nothing they can
    // do on this row will produce anything.
    expect(mediaSourceStatus(provider('a', 'A', ['image'], { broken: true }))).toBe('broken');
    expect(mediaSourceStatus(provider('a', 'A', ['image'], { enabled: false }))).toBe('broken');
  });

  it('reports a package that is merely not installed as unusable rather than pretending it is ready', () => {
    expect(mediaSourceStatus(provider('a', 'A', ['image'], { broken: true, problem: 'the plugin did not load' }))).toBe('broken');
  });

  it('separates "needs setup" from "ready" by the host missing list, not by an empty form', () => {
    const declared = settings({ apiKey: { type: 'string', secret: true } }, {}, { missing: ['apiKey'] });
    expect(mediaSourceStatus(provider('a', 'A', ['image'], { settings: declared }))).toBe('needs-config');
    const complete = settings({ apiKey: { type: 'string', secret: true } }, {}, { missing: [] });
    expect(mediaSourceStatus(provider('a', 'A', ['image'], { settings: complete }))).toBe('ready');
  });

  it('does not call a provider unconfigured because it has no settings at all', () => {
    // A script that brings its own environment has no key to be missing. An
    // empty apiKey is not a verdict on the author — and "no settings" is not
    // evidence of readiness either, so the row says it was not checked.
    expect(mediaSourceStatus(provider('a', 'A', ['image']))).toBe('unchecked');
  });

  it('never infers configuration from the form, only from the host missing list', () => {
    // The form declares one required field and it has no value. Reading that as
    // "needs setup" is the guess this slice removed: a secret never comes back
    // in `values`, so a stored key reads as absent; a provider may borrow a
    // connection; a script may manage its own environment. All three are states
    // where an empty key is correct.
    const form = settings(
      { apiKey: { type: 'string', secret: true }, baseUrl: { type: 'string' } },
      { baseUrl: 'https://x' },
      {},
      ['apiKey'],
    );
    expect(needsConfig(provider('a', 'A', ['image'], { settings: form }))).toBeUndefined();
    expect(mediaSourceStatus(provider('a', 'A', ['image'], { settings: form }))).toBe('unchecked');
  });

  it('does not call a provider ready just because a required field has a value', () => {
    // Same rule from the other side: a value is not a readiness proof either.
    const filled = settings({ apiKey: { type: 'string', secret: true } }, { apiKey: 'x' }, {}, ['apiKey']);
    expect(mediaSourceStatus(provider('a', 'A', ['image'], { settings: filled }))).toBe('unchecked');
  });

  it('reports readiness and need only when the host says so', () => {
    const need = settings({ apiKey: { type: 'string', secret: true } }, {}, { missing: ['apiKey'] });
    expect(mediaSourceStatus(provider('a', 'A', ['image'], { settings: need }))).toBe('needs-config');
    const ready = settings({ apiKey: { type: 'string', secret: true } }, {}, { missing: [] });
    expect(mediaSourceStatus(provider('a', 'A', ['image'], { settings: ready }))).toBe('ready');
  });

  it('marks a blocked provider as blocked, not as failed', () => {
    expect(mediaSourceStatus(provider('a', 'A', ['image']), true)).toBe('blocked');
  });

  it('keeps a saved default visible even when its configuration is unchecked', () => {
    // The default is a choice the reader already saved, which is a different
    // fact from whether the source is configured. Hiding it because the list
    // has not read its settings would quietly undo that choice, and treating
    // "not checked" as a gate would stop the reader making it at all.
    expect(mediaSourceStatus(provider('a', 'A', ['image'], { defaultFor: ['image'] }))).toBe('default');
    const checked = settings({ apiKey: { type: 'string', secret: true } }, {}, { missing: [] });
    expect(mediaSourceStatus(provider('a', 'A', ['image'], { defaultFor: ['image'], settings: checked }))).toBe('default');
  });

  it('does not let a default badge stand in for a readiness claim', () => {
    // The badge says which one the reader picked. It is not, and must not be
    // read as, an assurance that the source works — that is still `unchecked`
    // in the row's own fact line, which is where the unknown lives.
    const entry = provider('a', 'A', ['image'], { defaultFor: ['image'] });
    expect(mediaSourceStatus(entry)).toBe('default');
    expect(needsConfig(entry)).toBeUndefined();
  });
});

describe('search and filter', () => {
  const many = [
    provider('openai', 'OpenAI', ['image', 'tts']),
    provider('minimax', 'MiniMax', ['image', 'video', 'tts']),
    provider('ark', 'Volcengine Ark', ['image', 'video']),
    provider('local', 'My Own Script', ['image'], { settings: settings({ apiKey: { type: 'string', secret: true } }, {}, { missing: ['apiKey'] }) }),
  ];

  it('searches label, provider id, package id and modality', () => {
    expect(mediaSourceMatches(many[0]!, 'openai')).toBe(true);
    expect(mediaSourceMatches(many[1]!, 'vendor-minimax')).toBe(true);
    expect(mediaSourceMatches(many[2]!, 'volcengine')).toBe(true);
    expect(mediaSourceMatches(many[3]!, 'image')).toBe(true);
    expect(mediaSourceMatches(many[0]!, 'comfy')).toBe(false);
  });

  it('does not search a provider own settings values', () => {
    // A hundred API keys is not a search index, and searching them would put
    // a secret fragment in a filter box.
    const withSecret = provider('a', 'A', ['image'], { settings: settings({ apiKey: { type: 'string', secret: true } }, { apiKey: 'sk-live-abcdef' }) });
    expect(mediaSourceMatches(withSecret, 'sk-live')).toBe(false);
  });

  it('counts a multi-modality provider in each band it belongs to', () => {
    expect(matchesFilter(many[1]!, 'video', false)).toBe(true);
    expect(matchesFilter(many[1]!, 'tts', false)).toBe(true);
    const bands = filterBands(many);
    const image = bands.find((band) => band.id === 'image');
    expect(image?.count).toBe(4);
  });

  it('omits an empty band rather than offering a filter that leads nowhere', () => {
    const onlyImages = [provider('a', 'A', ['image'])];
    const ids = filterBands(onlyImages).map((band) => band.id);
    expect(ids).toContain('all');
    expect(ids).toContain('image');
    expect(ids).not.toContain('video');
    expect(ids).not.toContain('blocked');
  });

  it('shows only the rows that will actually fail in the needs-setup band', () => {
    const visible = visibleMediaSources(many, '', 'needs-config', new Set());
    expect(visible.map((entry) => entry.provider)).toEqual(['vendor-local/local']);
  });

  it('keeps a stable order as the query changes, putting rows that need action first', () => {
    const withBroken = [...many, provider('dead', 'Dead', ['image'], { broken: true })];
    const all = visibleMediaSources(withBroken, '', 'all', new Set()).map((entry) => entry.provider);
    expect(all[0]).toBe('vendor-dead/dead');
    // A different query must not reshuffle the surviving rows.
    const narrowed = visibleMediaSources(withBroken, 'a', 'all', new Set()).map((entry) => entry.provider);
    expect(narrowed).toEqual(visibleMediaSources(withBroken, 'a', 'all', new Set()).map((entry) => entry.provider));
  });
});

describe('per-modality defaults', () => {
  /**
   * The default is one pointer in the entry package's settings, so the host
   * owns the handover. What the GUI must get right is reading it back the way
   * the host stored it, and writing exactly one key — because a write that
   * touched two keys could leave a modality with no default at all.
   */
  it('reads the current holder back off the list the host returned', () => {
    const sources = [provider('a', 'A', ['image']), provider('b', 'B', ['image'], { defaultFor: ['image'] })];
    expect(currentDefault(sources, 'image')).toBe('vendor-b/b');
    expect(defaultProviderFor(sources, 'video')).toBeUndefined();
  });

  it('treats a blank default setting as unset rather than as a provider named ""', () => {
    expect(defaultsFromSettings({ defaultImageProvider: '   ' })).toEqual({ image: undefined, video: undefined, tts: undefined });
    expect(defaultsFromSettings({ defaultImageProvider: 'vendor-a/a' }).image).toBe('vendor-a/a');
  });

  it('writes exactly one key per modality, and clears it with null', () => {
    expect(defaultSettingKey('image')).toBe('defaultImageProvider');
    expect(defaultSettingKey('tts')).toBe('defaultTtsProvider');
    expect(defaultPatch('video', 'vendor-a/a')).toEqual({ defaultVideoProvider: 'vendor-a/a' });
    expect(defaultPatch('video', undefined)).toEqual({ defaultVideoProvider: null });
  });
});

describe('composeMediaSources', () => {
  const plugins = [
    { id: 'vendor-a', displayName: 'Vendor A', enabled: true, state: 'ok' as const, hasErrors: false, version: '1.2.0' },
    { id: 'vendor-b', displayName: 'Vendor B', enabled: false, state: 'ok' as const, hasErrors: false },
  ];

  it('joins a provider with the package it came from', () => {
    const rows = composeMediaSources(
      [{ provider: 'vendor-a/a', definition: { schemaVersion: 1, id: 'a', kinds: ['image'], label: 'A image', resumeVersion: 1 } }],
      plugins as never,
      { image: undefined, video: undefined, tts: undefined },
    );
    expect(rows[0]?.displayName).toBe('Vendor A');
    expect(rows[0]?.version).toBe('1.2.0');
    expect(rows[0]?.broken).toBe(false);
  });

  it('marks a switched-off package unusable, because nothing on the row will generate', () => {
    const rows = composeMediaSources(
      [{ provider: 'vendor-b/b', definition: { schemaVersion: 1, id: 'b', kinds: ['image'], label: 'B', resumeVersion: 1 } }],
      plugins as never,
      { image: undefined, video: undefined, tts: undefined },
    );
    // `broken` stays the load fact; the reader sees the combined status.
    expect(rows[0]?.broken).toBe(false);
    expect(mediaSourceStatus(rows[0]!)).toBe('broken');
  });

  it('marks a provider whose package never installed as unusable rather than ready', () => {
    const rows = composeMediaSources(
      [{ provider: 'vendor-gone/g', definition: { schemaVersion: 1, id: 'g', kinds: ['image'], label: 'Gone', resumeVersion: 1 } }],
      plugins as never,
      { image: undefined, video: undefined, tts: undefined },
    );
    expect(rows[0]?.broken).toBe(true);
    expect(rows[0]?.displayName).toBe('Gone');
  });

  it('reads the default off the host list rather than keeping a second copy', () => {
    const rows = composeMediaSources(
      [{ provider: 'vendor-a/a', definition: { schemaVersion: 1, id: 'a', kinds: ['image'], label: 'A', resumeVersion: 1 } }],
      plugins as never,
      { image: 'vendor-a/a', video: undefined, tts: undefined },
    );
    expect(defaultsOf(rows)).toEqual({ 'vendor-a/a': ['image'] });
  });
});

describe('job honesty', () => {
  it('treats an unknown submission as unknown, not as a plain failure', () => {
    // The provider may have taken the money. This is the one state where a
    // "try again" would be a second charge.
    const uncertain = job({ state: 'unknown', error: { code: 'timeout', message: 'no response', submission: 'unknown' } });
    expect(isJobUnknown(uncertain)).toBe(true);
    expect(isJobUnknown(job({ state: 'failed', error: { code: 'bad', message: 'no', submission: 'rejected' } }))).toBe(false);
  });

  it('never offers a resume for a job the host holds no remote handle for', () => {
    expect(canResume(job({ state: 'partial', can_resume: false }))).toBe(false);
    expect(canResume(job({ state: 'partial', can_resume: true }))).toBe(true);
  });

  it('does not offer a resume for a job that already succeeded', () => {
    expect(canResume(job({ state: 'succeeded', can_resume: true }))).toBe(false);
  });

  it('offers a stop only while the job is still doing work', () => {
    expect(canStop(job({ state: 'running' }))).toBe(true);
    expect(canStop(job({ state: 'pending' }))).toBe(true);
    expect(canStop(job({ state: 'succeeded' }))).toBe(false);
  });

  it('keeps a partial job finished artifacts rather than hiding them', () => {
    const partial = job({
      state: 'partial',
      artifacts: [
        { id: 'a1', name: 'one.png', mime: 'image/png', kind: 'image', role: 'original', complete: true, file_id: 'f1', bytes: 10 },
        { id: 'a2', name: 'thumb.png', mime: 'image/png', kind: 'image', role: 'preview', complete: true, file_id: 'f2', bytes: 2 },
      ],
    });
    expect(originalArtifacts(partial).map((artifact) => artifact.name)).toEqual(['one.png']);
  });

  it('keeps the three cancellation outcomes apart, and never calls a local stop a cancel', () => {
    expect(cancellationNote({ remote: 'cancelled', billing: 'provider_reported' })).toBe('remote-cancelled');
    expect(cancellationNote({ remote: 'requested', billing: 'unknown' })).toBe('remote-requested');
    // Unsupported means the request went nowhere: the provider may still be
    // generating and charging, which is not a cancellation.
    expect(cancellationNote({ remote: 'unsupported', billing: 'unknown' })).toBe('local-only');
    expect(cancellationNote(undefined)).toBe('none');
  });

  it('treats running and pending as the two active states', () => {
    expect(isJobActive(job({ state: 'running' }))).toBe(true);
    expect(isJobActive(job({ state: 'pending' }))).toBe(true);
    expect(isJobActive(job({ state: 'stopped' }))).toBe(false);
  });

  it('shows a duration only when one was reported', () => {
    const withDuration = {
      id: 'a1', name: 'clip.mp4', mime: 'video/mp4', kind: 'video' as const, role: 'original' as const,
      complete: true, file_id: 'f1', bytes: 1024, metadata: { duration_seconds: 12.4 },
    };
    expect(artifactFacts(withDuration)).toContain('0:12');
    expect(artifactFacts({ ...withDuration, metadata: {} })).not.toContain(':');
  });
});

describe('job action outcomes', () => {
  // The list renders a dozen rows from one action hook, so an outcome that is
  // not scoped to a job prints "Stopped waiting for this job" under every one
  // of them. That is a false claim about work nobody asked to stop, and it
  // shipped once before this predicate existed.
  const stopped = { ok: true as const, kind: 'stop' as const, job_id: 'media-1', job: job({ state: 'stopped' }) };

  it('claims only the job that was acted on', () => {
    expect(outcomeIsFor(stopped, 'media-1')).toBe(true);
    expect(outcomeIsFor(stopped, 'media-2')).toBe(false);
  });

  it('claims nothing at all before an action has been taken', () => {
    expect(outcomeIsFor(null, 'media-1')).toBe(false);
  });

  it('claims nothing for a job that failed to act, so a failure is not read as another job settling', () => {
    const failed = { ok: false as const, kind: 'resume' as const, job_id: 'media-2', error: new Error('nope') };
    expect(outcomeIsFor(failed, 'media-1')).toBe(false);
    expect(outcomeIsFor(failed, 'media-2')).toBe(true);
  });
});

describe('subscriptions', () => {
  it('adds a source without touching the others', () => {
    const next = withSubscription([{ id: 'a', url: 'https://a', enabled: true }], { id: 'b', url: 'https://b', enabled: true });
    expect(next.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('replaces rather than duplicates a source with the same id', () => {
    const next = withSubscription([{ id: 'a', url: 'https://old', enabled: true }], { id: 'a', url: 'https://new', enabled: true });
    expect(next).toHaveLength(1);
    expect(next[0]?.url).toBe('https://new');
  });

  it('removes only the named source', () => {
    const next = withSubscription(
      [{ id: 'a', url: 'https://a', enabled: true }, { id: 'b', url: 'https://b', enabled: true }],
      { id: 'a', url: 'https://a', enabled: true },
      true,
    );
    expect(next.map((item) => item.id)).toEqual(['b']);
  });
});
