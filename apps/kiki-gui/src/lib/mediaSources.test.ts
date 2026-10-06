/**
 * Media sources — the pure logic, tested without a browser.
 *
 * These are the decisions a reader can be wrong about, so each one gets a case
 * that would fail if the rule were relaxed:
 *
 *  - A source the reader switched off and one they removed are neither of them
 *    a fault, and neither borrows the danger tone a package that failed to load
 *    uses — because a red row is a claim about the machine, and these two are
 *    claims about the reader's own choice.
 *  - "Needs setup" is exactly the rows the host says are missing a required
 *    setting — not a guess from an empty-looking form, and not every row that
 *    happens to have no stored value.
 *  - One package holding many sources must compose to many rows, and a switch
 *    on one must not be readable as a switch on the package.
 *  - A job whose submission is unknown is never resumable-looking as a retry,
 *    and a job that failed *after* the provider accepted it is not a "you
 *    were charged nothing" case.
 *  - A stop is a stop, and the three cancellation outcomes stay three.
 */

import { describe, expect, it } from 'vitest';

import type { MediaJob, MediaKind, MediaManagedSource } from '@kiki/protocol';

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

const HEALTHY = { enabled: true, broken: false };

/** A host answer, shaped as the media package's own source groups report one. */
function managed(id: string, label: string, kinds: MediaKind[], over: Partial<MediaManagedSource> = {}): MediaManagedSource {
  return {
    provider: `kiki-media/${id}`,
    sourceId: id,
    pluginId: 'kiki-media',
    label,
    custom: false,
    enabled: true,
    removed: false,
    definitions: [{ schemaVersion: 1, id, kinds, label, resumeVersion: 1 }],
    schema: { schemaVersion: 1, schema: { type: 'object', properties: {} } },
    values: {},
    secretsConfigured: [],
    missing: [],
    ...over,
  };
}

function source(id: string, label: string, kinds: MediaKind[], over: Partial<MediaManagedSource> = {}): MediaSourceEntry {
  return composeMediaSources([managed(id, label, kinds, over)], () => HEALTHY, { image: undefined, video: undefined, tts: undefined })[0]!;
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
  it('reads a package that failed to load as the one fault it is', () => {
    // The package behind the source is the only thing on this row the reader
    // cannot fix from here, so it is the only thing drawn as a failure.
    const broken = composeMediaSources(
      [managed('a', 'A', ['image'])],
      () => ({ enabled: false, broken: true, problem: 'the plugin did not load' }),
      { image: undefined, video: undefined, tts: undefined },
    )[0]!;
    expect(mediaSourceStatus(broken)).toBe('broken');
    expect(broken.problem).toBe('the plugin did not load');
  });

  it('reads a switched-off source and a removed one as the reader own choices, not faults', () => {
    // Both keep everything; neither is the machine misbehaving, and a red row
    // is a claim about the machine. This is why `off` and `removed` exist as
    // their own statuses instead of being folded into `broken`.
    expect(mediaSourceStatus(source('a', 'A', ['image'], { enabled: false }))).toBe('off');
    expect(mediaSourceStatus(source('a', 'A', ['image'], { removed: true }))).toBe('removed');
    // Removed outranks disabled in the copy: it is the stronger, reversible
    // choice, and the configuration and history are still there.
    expect(mediaSourceStatus(source('a', 'A', ['image'], { removed: true, enabled: false }))).toBe('removed');
  });

  it('separates "needs setup" from "ready" by the host own missing list, not by an empty form', () => {
    expect(mediaSourceStatus(source('a', 'A', ['image'], { missing: ['apiKey'] }))).toBe('needs-config');
    expect(mediaSourceStatus(source('a', 'A', ['image'], { missing: [] }))).toBe('ready');
  });

  it('does not call a source unconfigured because it declares no settings at all', () => {
    // A script that brings its own environment has no key to be missing. An
    // empty apiKey is not a verdict on the author — and with the whole list in
    // one host answer, "never checked" is no longer a state the list reaches.
    const scripted = source('mine', 'Mine', ['image'], {
      custom: true,
      definitions: [{ schemaVersion: 1, id: 'script-mine', kinds: ['image'], label: 'Mine', resumeVersion: 1 }],
    });
    expect(mediaSourceStatus(scripted)).toBe('ready');
  });

  it('never infers configuration from the form, only from the host missing list', () => {
    // The form declares one required field and it has no value. Reading that as
    // "needs setup" is the guess this slice removed: a secret never comes back
    // in `values`, so a stored key reads as absent; a source may borrow a
    // connection; a script may manage its own environment. All three are states
    // where an empty key is correct.
    const declaredRequired = source('a', 'A', ['image'], {
      schema: { schemaVersion: 1, schema: { type: 'object', properties: { apiKey: { type: 'string', secret: true } }, required: ['apiKey'] } },
      missing: [],
    });
    expect(declaredRequired.settings?.schema.schema.required).toEqual(['apiKey']);
    expect(mediaSourceStatus(declaredRequired)).toBe('ready');
  });

  it('marks a blocked source as blocked, not as failed', () => {
    expect(mediaSourceStatus(source('a', 'A', ['image']), true)).toBe('blocked');
  });

  it('keeps a saved default visible even when its configuration is not met', () => {
    // The default is a choice the reader already saved, which is a different
    // fact from whether the source is configured. Hiding it would quietly undo
    // that choice, and treating an unmet source as a gate would stop the reader
    // making it at all.
    const unmet = source('a', 'A', ['image'], { missing: ['apiKey'] });
    const asDefault = composeMediaSources(
      [managed('a', 'A', ['image'], { missing: ['apiKey'] })],
      () => HEALTHY,
      { image: 'kiki-media/a', video: undefined, tts: undefined },
    )[0]!;
    expect(mediaSourceStatus(asDefault)).toBe('default');
    expect(mediaSourceStatus(unmet)).toBe('needs-config');
  });
});

describe('search and filter', () => {
  const many = [
    source('openai', 'OpenAI', ['image', 'tts']),
    source('minimax', 'MiniMax', ['image', 'video', 'tts']),
    source('ark', 'Volcengine Ark', ['image', 'video']),
    source('local', 'My Own Script', ['image'], { missing: ['apiKey'] }),
  ];

  it('searches label, source id, package id and modality', () => {
    expect(mediaSourceMatches(many[0]!, 'openai')).toBe(true);
    expect(mediaSourceMatches(many[1]!, 'kiki-media/minimax')).toBe(true);
    expect(mediaSourceMatches(many[2]!, 'volcengine')).toBe(true);
    expect(mediaSourceMatches(many[3]!, 'image')).toBe(true);
    expect(mediaSourceMatches(many[0]!, 'comfy')).toBe(false);
  });

  it('does not search a source own settings values', () => {
    // A thousand API keys is not a search index, and searching them would put
    // a secret fragment in a filter box.
    const withSecret = source('a', 'A', ['image'], { values: { apiKey: 'sk-live-abcdef' } });
    expect(mediaSourceMatches(withSecret, 'sk-live')).toBe(false);
  });

  it('counts a multi-modality source in each band it belongs to', () => {
    expect(matchesFilter(many[1]!, 'video', false)).toBe(true);
    expect(matchesFilter(many[1]!, 'tts', false)).toBe(true);
    const bands = filterBands(many);
    const image = bands.find((band) => band.id === 'image');
    expect(image?.count).toBe(4);
  });

  it('omits an empty band rather than offering a filter that leads nowhere', () => {
    const onlyImages = [source('a', 'A', ['image'])];
    const ids = filterBands(onlyImages).map((band) => band.id);
    expect(ids).toContain('all');
    expect(ids).toContain('image');
    expect(ids).not.toContain('video');
    expect(ids).not.toContain('blocked');
  });

  it('shows only the rows that will actually fail in the needs-setup band', () => {
    const visible = visibleMediaSources(many, '', 'needs-config', new Set());
    expect(visible.map((entry) => entry.provider)).toEqual(['kiki-media/local']);
  });

  it('keeps a stable order as the query changes, putting rows that need action first', () => {
    const brokenRows = composeMediaSources(
      [managed('dead', 'Dead', ['image'])],
      () => ({ enabled: false, broken: true }),
      { image: undefined, video: undefined, tts: undefined },
    );
    const base = [...brokenRows, ...many];
    expect(visibleMediaSources(base, '', 'all', new Set())[0]?.provider).toBe('kiki-media/dead');
    // A different query must not reshuffle the surviving rows.
    const narrowed = visibleMediaSources(base, 'a', 'all', new Set()).map((entry) => entry.provider);
    expect(narrowed).toEqual(visibleMediaSources(base, 'a', 'all', new Set()).map((entry) => entry.provider));
  });

  it('sinks a source the reader took out of use below the working ones', () => {
    // Kept, not urgent. A list where every removal outranks every working
    // source cannot be scanned.
    const mixed = [source('off', 'Off', ['image'], { enabled: false }), source('ok', 'Ok', ['image'])];
    const order = visibleMediaSources(mixed, '', 'all', new Set()).map((entry) => entry.sourceId);
    expect(order).toEqual(['ok', 'off']);
  });

  it('finds one source inside a thousand, and one that needs setup, from a single array', () => {
    // The scale this list has to survive: one host answer, a search over it,
    // a narrow result. Nothing here is per-row work.
    const thousand = Array.from({ length: 1000 }, (_, index) =>
      source(`s${index}`, `Source ${index}`, ['image'], index === 617 ? { missing: ['apiKey'] } : {}));
    expect(visibleMediaSources(thousand, 'Source 617', 'all', new Set()).map((entry) => entry.sourceId)).toEqual(['s617']);
    expect(visibleMediaSources(thousand, '', 'needs-config', new Set()).map((entry) => entry.sourceId)).toEqual(['s617']);
    expect(filterBands(thousand).find((band) => band.id === 'ready')?.count).toBe(999);
  });
});

describe('per-modality defaults', () => {
  /**
   * The default is one pointer in the media package's settings, so the host
   * owns the handover. What the GUI must get right is reading it back the way
   * the host stored it, and writing exactly one key — because a write that
   * touched two keys could leave a modality with no default at all.
   */
  it('reads the current holder back off the list the host returned', () => {
    const sources = composeMediaSources(
      [managed('a', 'A', ['image']), managed('b', 'B', ['image'])],
      () => HEALTHY,
      { image: 'kiki-media/b', video: undefined, tts: undefined },
    );
    expect(currentDefault(sources, 'image')).toBe('kiki-media/b');
    expect(defaultProviderFor(sources, 'video')).toBeUndefined();
  });

  it('treats a blank default setting as unset rather than as a source named ""', () => {
    expect(defaultsFromSettings({ defaultImageProvider: '   ' })).toEqual({ image: undefined, video: undefined, tts: undefined });
    expect(defaultsFromSettings({ defaultImageProvider: 'kiki-media/a' }).image).toBe('kiki-media/a');
  });

  it('writes exactly one key per modality, and clears it with null', () => {
    expect(defaultSettingKey('image')).toBe('defaultImageProvider');
    expect(defaultSettingKey('tts')).toBe('defaultTtsProvider');
    expect(defaultPatch('video', 'kiki-media/a')).toEqual({ defaultVideoProvider: 'kiki-media/a' });
    expect(defaultPatch('video', undefined)).toEqual({ defaultVideoProvider: null });
  });
});

describe('composeMediaSources', () => {
  it('turns one package holding many sources into many rows', () => {
    // The whole point of the change: the package is not the row. One answer
    // carries every vendor, and the list draws one line for each.
    const rows = composeMediaSources(
      [
        managed('openai', 'OpenAI Media', ['image'], {
          definitions: [
            { schemaVersion: 1, id: 'openai-image', kinds: ['image'], label: 'OpenAI images', resumeVersion: 1 },
            { schemaVersion: 1, id: 'openai-speech', kinds: ['tts'], label: 'OpenAI speech', resumeVersion: 1, connectionSetting: 'connectionId' },
          ],
        }),
        managed('comfyui', 'ComfyUI Workflow', ['image']),
      ],
      () => HEALTHY,
      { image: undefined, video: undefined, tts: undefined },
    );
    expect(rows.map((entry) => entry.displayName)).toEqual(['OpenAI Media', 'ComfyUI Workflow']);
    // One row, both modalities, both adapters — drawn from one package.
    expect(rows[0]!.kinds).toEqual(['image', 'tts']);
    expect(rows[0]!.definitions.map((definition) => definition.id)).toEqual(['openai-image', 'openai-speech']);
    expect(rows[0]!.pluginId).toBe('kiki-media');
  });

  it('keys a row by its own provider id, never by its package', () => {
    // A write is addressed by `provider`. If a row were keyed by `pluginId`,
    // two rows from one package would be the same row.
    const rows = composeMediaSources(
      [managed('openai', 'OpenAI Media', ['image']), managed('comfyui', 'ComfyUI Workflow', ['image'])],
      () => HEALTHY,
      { image: undefined, video: undefined, tts: undefined },
    );
    expect(rows.map((entry) => entry.provider)).toEqual(['kiki-media/openai', 'kiki-media/comfyui']);
    expect(new Set(rows.map((entry) => entry.pluginId)).size).toBe(1);
    expect(new Set(rows.map((entry) => entry.provider)).size).toBe(2);
  });

  it('carries the host own secrets and missing lists without ever seeing a value', () => {
    const rows = composeMediaSources(
      [managed('openai', 'OpenAI Media', ['image'], {
        values: { baseUrl: 'https://api.example.com/v1' },
        secretsConfigured: ['apiKey'],
        missing: ['apiKey'],
      })],
      () => HEALTHY,
      { image: undefined, video: undefined, tts: undefined },
    );
    expect(rows[0]!.settings?.secretsConfigured).toEqual(['apiKey']);
    expect(rows[0]!.settings?.missing).toEqual(['apiKey']);
    // The value itself is not in the answer, so it cannot be in the row.
    expect(Object.values(rows[0]!.source.values)).not.toContain('apiKey');
  });

  it('reports a source whose package never installed as unusable rather than ready', () => {
    const rows = composeMediaSources(
      [managed('gone', 'Gone', ['image'])],
      () => undefined,
      { image: undefined, video: undefined, tts: undefined },
    );
    expect(rows[0]!.broken).toBe(true);
    expect(mediaSourceStatus(rows[0]!)).toBe('broken');
  });

  it('marks a source switched off at the package level as broken, because nothing will generate', () => {
    const rows = composeMediaSources(
      [managed('a', 'A', ['image'])],
      () => ({ enabled: false, broken: false }),
      { image: undefined, video: undefined, tts: undefined },
    );
    expect(mediaSourceStatus(rows[0]!)).toBe('broken');
  });

  it('reads the default off the host list rather than keeping a second copy', () => {
    const rows = composeMediaSources(
      [managed('a', 'A', ['image'])],
      () => HEALTHY,
      { image: 'kiki-media/a', video: undefined, tts: undefined },
    );
    expect(defaultsOf(rows)).toEqual({ 'kiki-media/a': ['image'] });
  });

  it('keeps a reader own script marked as one, whatever it runs', () => {
    const rows = composeMediaSources(
      [managed('mine', 'My renderer', ['image'], {
        custom: true,
        values: { command: 'python', args: '["render.py"]', cwd: '', protocol: 'file', format: 'png', mime: '' },
      })],
      () => HEALTHY,
      { image: undefined, video: undefined, tts: undefined },
    );
    expect(rows[0]!.custom).toBe(true);
    expect(rows[0]!.source.values['command']).toBe('python');
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
