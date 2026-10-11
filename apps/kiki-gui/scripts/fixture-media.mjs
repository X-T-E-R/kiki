/**
 * Fixture stand-in for the media domain (`pluginMediaService.*`).
 *
 * It answers the same contract the real host serves — the GUI parses nothing
 * differently because of it — and it is deliberately *scenario-seeded*, so a
 * scenario can say exactly which providers exist, which are configured, and
 * what each job did.
 *
 * What the scenarios get, and why each exists:
 *
 *   mediaProviders   — the installed adapters, one per entry, each with the
 *                      modalities and `connectionSetting` its package declares.
 *   mediaSettings    — per-package settings, including secrets reported as
 *                      configured and never as values. A save is a real write
 *                      that a later read reflects.
 *   mediaJobs        — jobs in every state the view has to tell apart:
 *                      succeeded, still running, partial, blocked, stopped with
 *                      a local-only stop, and one whose submission is unknown.
 *   mediaVoices      — a voice page, only ever returned when asked.
 *   mediaSubscriptions — the discovery roster, host-persisted.
 *
 * The honesty rules this fixture exists to keep testable are in the jobs: a
 * job with `submission: 'unknown'` is never given a resumable handle, a
 * `stopped` job with `remote: 'unsupported'` keeps its handle, and artifacts
 * carry a `file_id` and never a path.
 */

/** Same shape the klient dispatcher throws, so one catch site handles both. */
function invalid(message, code = 40001) {
  return Object.assign(new Error(message), { code });
}

/**
 * Session media bytes: `/sessions/:id/media/:fileId` and its `/preview`.
 *
 * These are the routes the artifact list and the audio player read, and they
 * are deliberately NOT the same route. The klient asks for the original on
 * one and a compressed preview on the other, and a fixture that answered both
 * from one blob would prove nothing about the distinction the view draws.
 *
 * Bytes are seeded per scenario as `mediaFiles[fileId] = { base64, mime }`,
 * written by the scenario from real files under `fixtures/media-bytes/`. They
 * are generated locally by a script rather than downloaded, so nothing here
 * requires a vendor account, a network fetch, or a paid call — and they are
 * genuine PNG and WAV containers, so a preview that renders and a player that
 * plays are real observations and not a mocked success.
 */
export function sessionMediaBytes(server, sessionId, fileId, variant) {
  const files = server.scenario?.data.mediaFiles;
  if (files === undefined) {
    throw invalid(`no media files seeded (session ${sessionId}, file ${fileId})`, 40409);
  }
  const file = files[fileId];
  if (file === undefined) {
    throw invalid(`media file not found: ${fileId}`, 40409);
  }
  const bytes = Buffer.from(file.base64, 'base64');
  // The preview is the same picture at a fraction of the size in the real
  // server. Serving identical bytes would make a "Preview" label unfalsifiable,
  // so the fixture downscales the declared size and says so in the MIME type.
  if (variant === 'preview') {
    return { bytes, mime: `${file.mime}; preview`, name: file.name };
  }
  return { bytes, mime: file.mime, name: file.name };
}

function seed(server) {
  server.media ??= {
    providers: structuredClone(server.scenario?.data.mediaProviders ?? []),
    managed: structuredClone(server.scenario?.data.mediaManagedSources ?? []),
    settings: structuredClone(server.scenario?.data.mediaSettings ?? {}),
    jobs: structuredClone(server.scenario?.data.mediaJobs ?? []),
    voices: structuredClone(server.scenario?.data.mediaVoices ?? {}),
    subscriptions: structuredClone(server.scenario?.data.mediaSubscriptions ?? []),
    /** Every capability and voice read is recorded, so a test can prove the
     *  list view asked for none of them. Every managed-source write is
     *  recorded too, so a test can prove a write moved the one source it named
     *  and no sibling from the same package. */
    reads: [],
    writes: [],
  };
  return server.media;
}

/** The settings a source declares, minus the lifecycle keys the host owns. */
const LIFECYCLE_KEYS = new Set(['enabled', 'removed', 'cleared']);

function sourceSchemaOf(source) {
  return {
    schemaVersion: 1,
    schema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(source.schema.schema.properties).filter(([key]) => !LIFECYCLE_KEYS.has(key))),
      ...(source.schema.schema.required === undefined ? {} : { required: source.schema.schema.required }),
    },
  };
}

/**
 * The one source a read or write named, or `undefined`.
 *
 * Addressing is by `provider` and by a source's own id, exactly as the real
 * host accepts it — a source group answers to any of its adapter ids. It is
 * deliberately *not* keyed by `pluginId`: one package carries many sources,
 * and a fixture that resolved a write by package would make a bug that moved
 * every vendor's settings at once look correct here.
 */
function findManaged(state, provider) {
  return state.managed.find((item) => item.provider === provider
    || item.definitions.some((definition) => `${item.pluginId}/${definition.id}` === provider));
}

/**
 * The keys a source is actually missing, recomputed after a write.
 *
 * A fixture that returned a fixed list would report a source as unconfigured
 * after the reader saved the very key it named, which is the one thing this
 * page must never do. A required field is met by a stored value or a stored
 * secret, and `connectionId` covers the key and the endpoint — the same rule
 * the real host applies.
 */
function missingOf(source) {
  const effective = new Map();
  for (const [key, property] of Object.entries(source.schema.schema.properties)) {
    if (property.default !== undefined) effective.set(key, property.default);
  }
  for (const [key, value] of Object.entries(source.values)) effective.set(key, value);
  for (const key of source.secretsConfigured) effective.set(key, 'stored');
  return (source.schema.schema.required ?? []).filter((key) => {
    const value = effective.get(key);
    const borrowed = typeof effective.get('connectionId') === 'string' && effective.get('connectionId') !== '';
    return !value && !(borrowed && (key === 'apiKey' || key === 'baseUrl'));
  });
}

/**
 * A deferred envelope, for a call that should arrive late.
 *
 * The dispatcher is synchronous, so the delay belongs on the RESPONSE rather
 * than on the handler: the route returns immediately and the answer is written
 * when the timer fires. That is what makes an in-flight write real — the
 * browser has an open request, and any GET issued meanwhile answers at once,
 * which is precisely the situation a read-back-as-proof cannot survive.
 */
function deferred(envelope, ms) {
  setTimeout(envelope, Math.min(ms, 2_000));
}

function requireMedia(server) {
  const state = seed(server);
  if (state.providers === undefined) throw invalid('media domain unavailable', 40401);
  return state;
}

/**
 * The eight global procedures. Each is a case rather than a table because the
 * answers are genuinely different shapes, and a table would hide which
 * question is being answered.
 */
export function callMediaService(server, method, args) {
  const state = requireMedia(server);
  switch (method) {
    case 'sources':
      return structuredClone(state.subscriptions);

    case 'setSources': {
      const input = args[0];
      if (input === undefined || !Array.isArray(input?.sources)) throw invalid('setSources expects a source list', 40001);
      // The roster is the host's, and a write is a real write: the next read
      // returns what was stored, not what the caller hoped.
      state.subscriptions = structuredClone(input.sources);
      return structuredClone(state.subscriptions);
    }

    case 'catalog': {
      const id = args[0]?.id;
      const source = state.subscriptions.find((item) => item.id === id);
      if (source === undefined) throw invalid(`media catalog not found: ${id}`, 40409);
      const catalog = server.scenario?.data.mediaCatalogs?.[id];
      if (catalog === undefined) throw invalid(`media catalog is unreachable: ${source.url}`, 50001);
      state.reads.push({ method: 'catalog', id });
      return structuredClone(catalog);
    }

    case 'providers':
      return structuredClone(state.providers);

    // The one read that answers for the whole list: every source in every
    // package, with the settings form it declares, the values stored against
    // it, which secrets are stored, and which required settings are missing.
    // A fixture that answered this from `providers` plus a settings join would
    // be re-implementing the host, so the scenario seeds the answers instead.
    case 'managedSources':
      state.reads.push({ method: 'managedSources', count: state.managed.length });
      return structuredClone(state.managed);

    case 'sourceSettings': {
      const provider = args[0]?.provider;
      const source = findManaged(state, provider);
      if (source === undefined) throw invalid(`media source not found: ${provider}`, 40409);
      state.reads.push({ method: 'sourceSettings', provider });
      return structuredClone(source);
    }

    // A write is a real write against the one source it named, and the
    // answer is the host's own re-read — never the caller's optimism. A
    // `null` value removes a stored key; an absent one keeps it.
    case 'updateSource': {
      const input = args[0] ?? {};
      const source = findManaged(state, input.provider);
      if (source === undefined) throw invalid(`media source not found: ${input.provider}`, 40409);
      state.writes.push({ method: 'updateSource', provider: source.provider, values: structuredClone(input.values ?? {}), enabled: input.enabled, removed: input.removed });
      // Per-source behaviour, so a scenario can make ONE source refuse, or
      // answer late, while the rest of the page still works.
      const behaviour = server.scenario?.data.mediaWriteBehaviour?.[source.sourceId];
      if (behaviour?.refuseWrites === true) {
        throw invalid(`the host refused this write for ${source.label}`, 40001);
      }
      for (const [key, value] of Object.entries(input.values ?? {})) {
        const property = source.schema.schema.properties[key];
        if (property === undefined) throw invalid(`unknown media source setting ${key}`, 40001);
        if (value === null) {
          delete source.values[key];
          source.secretsConfigured = source.secretsConfigured.filter((item) => item !== key);
        } else if (property.secret === true) {
          // A secret is write-only: stored, reported as configured, never
          // echoed. An empty secret is not a removal, so a value that was
          // stored stays stored.
          if (value !== '') source.secretsConfigured = [...new Set([...source.secretsConfigured, key])];
        } else {
          source.values[key] = value;
        }
      }
      if (input.enabled !== undefined) source.enabled = input.enabled;
      if (input.removed !== undefined) source.removed = input.removed;
      source.schema = sourceSchemaOf(source);
      source.missing = missingOf(source);
      const settled = structuredClone(source);
      const delayMs = behaviour?.delayMs;
      if (delayMs === undefined) return settled;
      return { __deferred: true, settled, delayMs };
    }

    // A reader's own script source: a new row in the same package, with the
    // command line and protocol the reader typed. Nothing here installs
    // anything, and a duplicate id is refused rather than silently replacing
    // a source whose jobs and handles are kept.
    case 'addScriptSource': {
      const input = args[0] ?? {};
      state.writes.push({ method: 'addScriptSource', id: input.id, protocol: input.protocol, kinds: structuredClone(input.kinds ?? []) });
      if (state.managed.some((item) => item.sourceId === input.id)) {
        throw invalid('Script source id already exists; restore a removed source rather than replacing its saved handles', 40001);
      }
      const created = {
        provider: `kiki-media/script-${input.id}`,
        sourceId: input.id,
        pluginId: 'kiki-media',
        label: input.label,
        custom: true,
        enabled: true,
        removed: false,
        definitions: [{ schemaVersion: 1, id: `script-${input.id}`, kinds: structuredClone(input.kinds ?? ['image']), label: input.label, resumeVersion: 1 }],
        schema: { schemaVersion: 1, schema: { type: 'object', properties: { environment: { type: 'string', title: 'Environment variables (JSON)', secret: true } } } },
        values: {
          command: input.command,
          args: JSON.stringify(input.args ?? []),
          cwd: input.cwd ?? '',
          protocol: input.protocol ?? 'file',
          format: input.format ?? '',
          mime: input.mime ?? '',
        },
        // A script's environment is stored as a secret and never read back,
        // so the answer says "configured" and nothing else.
        secretsConfigured: input.environment === undefined ? [] : ['environment'],
        missing: [],
      };
      state.managed = [...state.managed, created];
      return structuredClone(created);
    }

    case 'capabilities': {
      const query = args[0] ?? {};
      state.reads.push({ method: 'capabilities', provider: query.provider, kind: query.kind });
      if (query.provider === undefined) return { providers: structuredClone(state.providers) };
      const entry = state.providers.find((item) => item.provider === query.provider);
      if (entry === undefined) {
        // The contract's other answer: "here is who you could use" rather
        // than a failure, which is what an unknown provider gets.
        return { providers: structuredClone(state.providers) };
      }
      const page = server.scenario?.data.mediaCapabilities?.[query.provider];
      if (page === undefined) return { models: [] };
      return structuredClone(page);
    }

    case 'voices': {
      const query = args[0] ?? {};
      state.reads.push({ method: 'voices', provider: query.provider, language: query.language });
      const page = state.voices[query.provider];
      if (page === undefined) return { voices: [] };
      if (query.language === undefined) return structuredClone(page);
      const wanted = String(query.language).toLowerCase();
      const voices = page.voices.filter((voice) =>
        voice.languages === undefined || voice.languages.some((tag) => tag.toLowerCase() === wanted));
      return { voices: structuredClone(voices), cursor: null };
    }

    case 'jobs': {
      const query = args[0] ?? {};
      const all = state.jobs
        .filter((job) => query.session_id === undefined || job.owner_session_id === query.session_id)
        .toSorted((a, b) => b.created_at - a.created_at);
      const offset = query.offset ?? 0;
      const limit = query.limit ?? all.length;
      return structuredClone(all.slice(offset, offset + limit));
    }

    case 'job': {
      const id = args[0];
      const job = state.jobs.find((item) => item.job_id === id);
      if (job === undefined) throw invalid(`media job not found: ${id}`, 40409);
      return structuredClone(job);
    }

    default:
      throw invalid(`Unsupported fixture media procedure: ${method}`, 40401);
  }
}

/**
 * The two agent-scoped procedures. They exist here so the fixture can prove
 * the GUI reaches them through the job's *owner*, and not through a global
 * shortcut that would act on another conversation's job.
 */
export function callAgentMediaService(server, method, args, sessionId, agentId) {
  const state = requireMedia(server);
  const job = state.jobs.find((item) => item.job_id === args[0]);
  if (job === undefined) throw invalid(`media job not found: ${args[0]}`, 40409);
  // The owner's own scope check. A job belongs to exactly one session and
  // agent, and the host refuses anything else.
  if (sessionId !== undefined && job.owner_session_id !== sessionId) {
    throw invalid('this job belongs to another session', 40301);
  }
  if (agentId !== undefined && job.owner_agent_id !== agentId) {
    throw invalid('this job belongs to another agent', 40301);
  }
  if (method === 'cancel') {
    // A provider with no cancel path stops the *local wait* only. The handle
    // survives, the state is `stopped`, and the cancellation record says
    // `unsupported` — the view must not read that as a refund.
    job.state = 'stopped';
    job.cancellation = job.cancellation ?? { remote: 'unsupported', billing: 'unknown' };
    job.updated_at = job.updated_at + 1;
    return structuredClone(job);
  }
  if (method === 'resume') {
    if (!job.can_resume) throw invalid('this job has no remote handle to continue', 40001);
    const settled = server.scenario?.data.mediaResumeOutcome?.[job.job_id];
    Object.assign(job, structuredClone(settled ?? { state: 'succeeded', phase: 'download' }));
    job.updated_at = job.updated_at + 1;
    return structuredClone(job);
  }
  throw invalid(`Unsupported fixture agent media procedure: ${method}`, 40401);
}
