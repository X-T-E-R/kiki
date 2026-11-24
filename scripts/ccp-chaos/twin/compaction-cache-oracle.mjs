import { createHash } from 'node:crypto';

export const ANTHROPIC_MAX_BREAKPOINTS = 4;

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function bytesToTokens(bytes) {
  return Math.max(1, Math.ceil(bytes / 4));
}

function readCacheControl(node) {
  if (!isPlainRecord(node)) return null;
  const cc = node.cache_control;
  if (!isPlainRecord(cc) || typeof cc.type !== 'string') return null;
  return {
    type: cc.type,
    ttl: typeof cc.ttl === 'string' ? cc.ttl : '5m',
  };
}

function stripCacheControlTopLevelOnly(block) {
  if (!isPlainRecord(block)) return block;
  if (!Object.hasOwn(block, 'cache_control')) return block;
  const copy = {};
  for (const key of Object.keys(block)) {
    if (key === 'cache_control') continue;
    copy[key] = block[key];
  }
  return copy;
}

/**
 * Inspects Anthropic wire body breakpoints strictly along `tools -> system -> messages -> top_level`.
 * Never counts business keys named `cache_control` nested inside `tool.input_schema` or `tool_use.input`.
 */
export function inspectAnthropicBreakpoints(body) {
  let total = 0;
  let sawFiveMinute = false;
  let ttlOrderValid = true;
  const positions = [];
  const messageBreakpointIndices = new Set();

  const record = (cc, pos, msgBlockKey = null) => {
    if (!cc) return;
    total += 1;
    positions.push({ pos, ttl: cc.ttl });
    if (msgBlockKey !== null) messageBreakpointIndices.add(msgBlockKey);
    if (cc.ttl === '1h' && sawFiveMinute) {
      ttlOrderValid = false;
    } else if (cc.ttl !== '1h') {
      sawFiveMinute = true;
    }
  };

  if (Array.isArray(body.tools)) {
    for (let i = 0; i < body.tools.length; i += 1) {
      record(readCacheControl(body.tools[i]), `tools[${i}]`);
    }
  }
  if (Array.isArray(body.system)) {
    for (let i = 0; i < body.system.length; i += 1) {
      record(readCacheControl(body.system[i]), `system[${i}]`);
    }
  }
  if (Array.isArray(body.messages)) {
    for (let m = 0; m < body.messages.length; m += 1) {
      const msg = body.messages[m];
      if (!isPlainRecord(msg) || !Array.isArray(msg.content)) continue;
      for (let b = 0; b < msg.content.length; b += 1) {
        record(readCacheControl(msg.content[b]), `messages[${m}].content[${b}]`, `${m}:${b}`);
      }
    }
  }
  record(readCacheControl(body), 'top_level');

  return {
    total,
    ttlOrderValid,
    positions,
    messageBreakpointIndices,
    hasTopLevelCacheControl: readCacheControl(body) !== null,
  };
}

/**
 * Validates Anthropic thinking budget constraints against `max_tokens`.
 */
export function validateAnthropicThinkingBudget(body) {
  const thinking = body.thinking;
  if (!isPlainRecord(thinking) || thinking.type !== 'enabled') {
    return { ok: true };
  }
  const budget = thinking.budget_tokens;
  const maxTokens = body.max_tokens;
  if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 1024) {
    return {
      ok: false,
      code: 'invalid_thinking_budget',
      message: `Anthropic thinking.budget_tokens (${String(budget)}) must be an integer >= 1024`,
    };
  }
  if (typeof maxTokens !== 'number' || budget >= maxTokens) {
    return {
      ok: false,
      code: 'thinking_budget_exceeds_max_tokens',
      message: `Anthropic thinking.budget_tokens (${String(budget)}) must be strictly less than max_tokens (${String(maxTokens)})`,
    };
  }
  return { ok: true };
}

/**
 * Builds ordered, wire-faithful KV segments preserving exact JSON key and array order.
 * Never sorts object keys and never strips user/business `cache_control` inside tool inputs/schemas.
 */
export function buildWireSegments({ protocol, body, effectiveMessages = null, effectiveTools = null, effectiveSystem = null, partitionKey = '' }) {
  const segments = [];
  const pushSeg = (section, index, value, isBreakpoint = false, countTokens = true) => {
    const wireJson = JSON.stringify(value);
    const bytes = Buffer.byteLength(wireJson, 'utf8');
    segments.push({
      section,
      index,
      wireJson,
      bytes,
      tokens: countTokens ? bytesToTokens(bytes) : 0,
      digest: sha256(wireJson),
      isBreakpoint,
    });
  };

  if (protocol === 'anthropic') {
    const tools = effectiveTools ?? (Array.isArray(body.tools) ? body.tools : []);
    const system = effectiveSystem ?? body.system ?? null;
    const messages = effectiveMessages ?? (Array.isArray(body.messages) ? body.messages : []);

    pushSeg('header', 0, {
      model: body.model ?? null,
      thinking: body.thinking ?? null,
      tool_choice: body.tool_choice ?? null,
      output_config: body.output_config ?? null,
    }, false, false);

    for (let i = 0; i < tools.length; i += 1) {
      const hasCc = readCacheControl(tools[i]) !== null;
      pushSeg('tools', i, stripCacheControlTopLevelOnly(tools[i]), hasCc, true);
    }

    if (Array.isArray(system)) {
      for (let i = 0; i < system.length; i += 1) {
        const hasCc = readCacheControl(system[i]) !== null;
        pushSeg('system', i, stripCacheControlTopLevelOnly(system[i]), hasCc, true);
      }
    } else if (system !== null && system !== undefined) {
      pushSeg('system', 0, system, false, true);
    }

    for (let m = 0; m < messages.length; m += 1) {
      const msg = messages[m];
      if (isPlainRecord(msg) && Array.isArray(msg.content)) {
        for (let b = 0; b < msg.content.length; b += 1) {
          const blk = msg.content[b];
          const hasCc = readCacheControl(blk) !== null;
          pushSeg(`messages[${m}]`, b, { role: msg.role, block: stripCacheControlTopLevelOnly(blk) }, hasCc, true);
        }
      } else {
        pushSeg(`messages[${m}]`, 0, msg, false, true);
      }
    }

    return {
      protocol,
      partitionKey: `${protocol}|${String(body.model ?? '')}|${partitionKey}`,
      segments,
      hasTopLevelCacheControl: readCacheControl(body) !== null,
    };
  }

  if (protocol === 'openai_responses' || protocol === 'openai_responses_ws') {
    const tools = effectiveTools ?? (Array.isArray(body.tools) ? body.tools : []);
    const inputItems = effectiveMessages ?? (Array.isArray(body.input) ? body.input : body.input !== undefined ? [body.input] : []);
    const cacheKey = body.prompt_cache_key ?? partitionKey ?? '';

    pushSeg('header', 0, {
      model: body.model ?? null,
      tool_choice: body.tool_choice ?? null,
      reasoning: body.reasoning ?? null,
      text: body.text ?? null,
      prompt_cache_key: body.prompt_cache_key ?? null,
    }, false, false);

    if (body.instructions !== undefined) {
      pushSeg('instructions', 0, body.instructions, false, true);
    }
    for (let i = 0; i < tools.length; i += 1) {
      pushSeg('tools', i, tools[i], false, true);
    }
    for (let i = 0; i < inputItems.length; i += 1) {
      pushSeg('input', i, inputItems[i], false, true);
    }

    return {
      protocol,
      partitionKey: `openai_responses|${String(body.model ?? '')}|${String(cacheKey)}`,
      segments,
      hasTopLevelCacheControl: false,
    };
  }

  if (protocol === 'google_genai') {
    const contents = effectiveMessages ?? (Array.isArray(body.contents) ? body.contents : []);
    const tools = effectiveTools ?? (Array.isArray(body.tools) ? body.tools : []);
    const genCfg = isPlainRecord(body.generationConfig) ? body.generationConfig : {};

    pushSeg('header', 0, {
      model: body.model ?? null,
      toolConfig: body.toolConfig ?? null,
      thinkingConfig: genCfg.thinkingConfig ?? null,
    }, false, false);

    if (body.systemInstruction !== undefined) {
      pushSeg('systemInstruction', 0, body.systemInstruction, false, true);
    }
    for (let i = 0; i < tools.length; i += 1) {
      pushSeg('tools', i, tools[i], false, true);
    }
    for (let i = 0; i < contents.length; i += 1) {
      pushSeg('contents', i, contents[i], false, true);
    }

    return {
      protocol,
      partitionKey: `${protocol}|${String(body.model ?? '')}|${partitionKey}`,
      segments,
      hasTopLevelCacheControl: false,
    };
  }

  // openai_chat / deepseek
  const messages = effectiveMessages ?? (Array.isArray(body.messages) ? body.messages : []);
  const tools = effectiveTools ?? (Array.isArray(body.tools) ? body.tools : []);
  const cacheKey = body.prompt_cache_key ?? body.user ?? partitionKey ?? '';

  pushSeg('header', 0, {
    model: body.model ?? null,
    tool_choice: body.tool_choice ?? null,
    response_format: body.response_format ?? null,
    reasoning_effort: body.reasoning_effort ?? null,
    prompt_cache_key: body.prompt_cache_key ?? null,
  }, false, false);

  for (let i = 0; i < tools.length; i += 1) {
    pushSeg('tools', i, tools[i], false, true);
  }
  for (let i = 0; i < messages.length; i += 1) {
    pushSeg('messages', i, messages[i], false, true);
  }

  return {
    protocol,
    partitionKey: `${protocol}|${String(body.model ?? '')}|${String(cacheKey)}`,
    segments,
    hasTopLevelCacheControl: false,
  };
}

/**
 * Compares two wire segment lists byte-for-byte without reordering keys or normalizing content.
 * Returns exact match counts and `firstDiff` for root-cause attribution.
 */
export function compareWireSegments(baselineSegments, candidateSegments) {
  const limit = Math.min(baselineSegments.length, candidateSegments.length);
  let matchedCount = 0;
  let matchedBytes = 0;
  let matchedTokens = 0;
  let firstDiff = null;

  for (let i = 0; i < limit; i += 1) {
    const a = baselineSegments[i];
    const b = candidateSegments[i];
    if (a.section === b.section && a.wireJson === b.wireJson) {
      matchedCount += 1;
      matchedBytes += a.bytes;
      matchedTokens += a.tokens;
    } else {
      firstDiff = {
        segmentIndex: i,
        section: b.section,
        expectedSection: a.section,
        index: b.index,
        baselineDigest: a.digest.slice(0, 16),
        candidateDigest: b.digest.slice(0, 16),
        baselinePreview: a.wireJson.slice(0, 180),
        candidatePreview: b.wireJson.slice(0, 180),
      };
      break;
    }
  }

  if (firstDiff === null && candidateSegments.length < baselineSegments.length) {
    const missing = baselineSegments[candidateSegments.length];
    firstDiff = {
      segmentIndex: candidateSegments.length,
      section: missing.section,
      expectedSection: missing.section,
      index: missing.index,
      baselineDigest: missing.digest.slice(0, 16),
      candidateDigest: '<missing>',
      baselinePreview: missing.wireJson.slice(0, 180),
      candidatePreview: '<missing>',
    };
  }

  let baselineTotalBytes = 0;
  let baselineTotalTokens = 0;
  for (const seg of baselineSegments) {
    baselineTotalBytes += seg.bytes;
    baselineTotalTokens += seg.tokens;
  }

  return {
    exactPrefixMatched: matchedCount === baselineSegments.length,
    matchedCount,
    baselineSegmentCount: baselineSegments.length,
    matchedBytes,
    baselineTotalBytes,
    matchedTokens,
    baselineTotalTokens,
    byteMatchRatio: baselineTotalBytes > 0 ? matchedBytes / baselineTotalBytes : 1,
    firstDiff,
  };
}

/**
 * Real wire-level KV prefix cache oracle supporting Anthropic, OpenAI Chat, OpenAI Responses (HTTP/WS),
 * Gemini, and DeepSeek. Tracks stored KV entries per partition, computes exact byte-matched cache hits,
 * emits provider-native usage fields, and records wire audit logs for S20 verification.
 */
export class CompactionCacheOracle {
  constructor() {
    this.partitions = new Map();
    this.auditLog = [];
    this.seq = 0;
  }

  reset() {
    this.partitions.clear();
    this.auditLog.length = 0;
    this.seq = 0;
  }

  getAuditLog() {
    return [...this.auditLog];
  }

  evaluate({
    protocol,
    body,
    effectiveMessages = null,
    effectiveTools = null,
    effectiveSystem = null,
    partitionKey = '',
    incrementalTransport = null,
    requestMeta = {},
    recordIntoCache = true,
  }) {
    this.seq += 1;
    const built = buildWireSegments({
      protocol,
      body,
      effectiveMessages,
      effectiveTools,
      effectiveSystem,
      partitionKey,
    });
    const totalTokens = built.segments.reduce((sum, s) => sum + s.tokens, 0);
    const totalBytes = built.segments.reduce((sum, s) => sum + s.bytes, 0);
    const existingEntries = this.partitions.get(built.partitionKey) ?? [];

    let bestMatch = null;
    let bestCachedTokens = 0;
    let bestCachedBytes = 0;
    let bestEntry = null;

    if (protocol === 'anthropic') {
      for (const entry of existingEntries) {
        const cmp = compareWireSegments(entry.segments, built.segments);
        let eligibleMatchedTokens = 0;
        let eligibleMatchedBytes = 0;
        if (incrementalTransport === 'anthropic_thread_continue' || built.hasTopLevelCacheControl) {
          eligibleMatchedTokens = cmp.matchedTokens;
          eligibleMatchedBytes = cmp.matchedBytes;
        } else {
          // Anthropic explicit cache_control matches only up to the last matched breakpoint segment
          let runningTokens = 0;
          let runningBytes = 0;
          for (let i = 0; i < cmp.matchedCount; i += 1) {
            const seg = built.segments[i];
            const prevSeg = entry.segments[i];
            runningTokens += seg.tokens;
            runningBytes += seg.bytes;
            if (seg.isBreakpoint && prevSeg.isBreakpoint) {
              eligibleMatchedTokens = runningTokens;
              eligibleMatchedBytes = runningBytes;
            }
          }
        }
        if (
          bestMatch === null ||
          eligibleMatchedTokens > bestCachedTokens ||
          (eligibleMatchedTokens === bestCachedTokens && cmp.matchedBytes > bestMatch.matchedBytes)
        ) {
          bestMatch = cmp;
          bestCachedTokens = eligibleMatchedTokens;
          bestCachedBytes = eligibleMatchedBytes;
          bestEntry = entry;
        }
      }
    } else {
      for (const entry of existingEntries) {
        const cmp = compareWireSegments(entry.segments, built.segments);
        if (
          bestMatch === null ||
          cmp.matchedTokens > bestCachedTokens ||
          (cmp.matchedTokens === bestCachedTokens && cmp.matchedBytes > bestMatch.matchedBytes)
        ) {
          bestMatch = cmp;
          bestCachedTokens = cmp.matchedTokens;
          bestCachedBytes = cmp.matchedBytes;
          bestEntry = entry;
        }
      }
    }

    const cachedTokens = Math.min(bestCachedTokens, totalTokens);
    const uncachedTokens = Math.max(0, totalTokens - cachedTokens);
    const hitRatio = totalTokens > 0 ? cachedTokens / totalTokens : 0;

    let providerUsage;
    if (protocol === 'anthropic') {
      const hasAnyBreakpoint =
        built.hasTopLevelCacheControl || built.segments.some((s) => s.isBreakpoint);
      const cacheCreation = hasAnyBreakpoint ? uncachedTokens : 0;
      const inputTokens = hasAnyBreakpoint ? 0 : uncachedTokens;
      providerUsage = {
        input_tokens: inputTokens,
        cache_read_input_tokens: cachedTokens,
        cache_creation_input_tokens: cacheCreation,
        output_tokens: 32,
      };
    } else if (protocol === 'openai_responses' || protocol === 'openai_responses_ws') {
      providerUsage = {
        input_tokens: totalTokens,
        output_tokens: 32,
        total_tokens: totalTokens + 32,
        input_tokens_details: { cached_tokens: cachedTokens },
      };
    } else if (protocol === 'deepseek') {
      providerUsage = {
        prompt_tokens: totalTokens,
        completion_tokens: 32,
        total_tokens: totalTokens + 32,
        prompt_cache_hit_tokens: cachedTokens,
        prompt_cache_miss_tokens: uncachedTokens,
      };
    } else if (protocol === 'google_genai') {
      providerUsage = {
        promptTokenCount: totalTokens,
        cachedContentTokenCount: cachedTokens,
        candidatesTokenCount: 32,
        totalTokenCount: totalTokens + 32,
      };
    } else {
      providerUsage = {
        prompt_tokens: totalTokens,
        completion_tokens: 32,
        total_tokens: totalTokens + 32,
        prompt_tokens_details: { cached_tokens: cachedTokens },
      };
    }

    const entryRecord = {
      seq: this.seq,
      protocol,
      partitionKey: built.partitionKey,
      segments: built.segments,
      totalTokens,
      totalBytes,
    };

    if (recordIntoCache) {
      let bucket = this.partitions.get(built.partitionKey);
      if (!bucket) {
        bucket = [];
        this.partitions.set(built.partitionKey, bucket);
      }
      bucket.push(entryRecord);
      if (bucket.length > 64) bucket.shift();
    }

    const auditEntry = {
      seq: this.seq,
      protocol,
      partitionKey: built.partitionKey,
      incrementalTransport,
      totalBytes,
      totalTokens,
      cachedBytes: bestCachedBytes,
      cachedTokens,
      uncachedTokens,
      hitRatio,
      matchedEntrySeq: bestEntry?.seq ?? null,
      exactPrefixMatched: bestMatch?.exactPrefixMatched ?? false,
      byteMatchRatio: bestMatch?.byteMatchRatio ?? 0,
      firstDiff: bestMatch?.firstDiff ?? null,
      providerUsage,
      ...requestMeta,
    };
    this.auditLog.push(auditEntry);
    if (this.auditLog.length > 4096) this.auditLog.shift();

    return auditEntry;
  }
}
