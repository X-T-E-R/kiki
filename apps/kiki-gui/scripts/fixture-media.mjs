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
    settings: structuredClone(server.scenario?.data.mediaSettings ?? {}),
    jobs: structuredClone(server.scenario?.data.mediaJobs ?? []),
    voices: structuredClone(server.scenario?.data.mediaVoices ?? {}),
    subscriptions: structuredClone(server.scenario?.data.mediaSubscriptions ?? []),
    /** Every capability and voice read is recorded, so a test can prove the
     *  list view asked for none of them. */
    reads: [],
  };
  return server.media;
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
