import path from 'node:path';
import { domainDigest } from '../verify/verdict.mjs';

/**
 * Request-only provider workload state machine (Astra v2.3 §§4, 6, 9.3, 10.3).
 *
 * Drives:
 * 1) Strict tool-schema preflight (fails if any required tool is absent from offered schemas).
 * 2) Multi-step native child orchestrator storm (`[S10_STORM:n=8,steps=6]`) dispatching
 *    N concurrent background `AgentRun` children, each running real workspace tools
 *    (Glob/Grep -> Read -> Write/Edit -> CPU-burning Bash `ast-build.mjs` -> MemorySearch/HistorySearch -> TodoList + receipt).
 * 3) Executable mesh node state machine (`Receive -> Incomplete(yield) | Ready -> Forward`).
 */

export const REQUIRED_CHILD_CHAIN_TOOLS = ['Glob', 'Grep', 'Read', 'Write', 'Edit', 'Bash', 'TodoList'];
export const REQUIRED_ORCHESTRATOR_TOOLS = ['AgentRun'];
export const REQUIRED_MESH_TOOLS = ['ThreadSend', 'RoomPost', 'RoomRead', 'HistorySearch'];

export function checkRequiredToolSchemas(declaredToolNames, requiredTools) {
  const missing = requiredTools.filter((name) => !declaredToolNames.has(name));
  return {
    ok: missing.length === 0,
    missing,
  };
}

export function detectS10Directive(promptText) {
  const stormMatch = /\[S10_STORM:([^\]]+)\]/u.exec(promptText ?? '');
  if (stormMatch) {
    const params = {};
    for (const pair of stormMatch[1].split(',')) {
      const [k, v] = pair.split('=');
      if (k && v !== undefined) params[k.trim()] = v.trim();
    }
    return {
      kind: 'orchestrator_storm',
      children: Math.max(1, Number(params.children ?? params.n ?? 8)),
      steps: Math.max(1, Number(params.steps ?? 6)),
      deltasPerStep: Math.max(12, Number(params.deltas ?? 110)),
      cadenceMs: Math.max(5, Number(params.cadenceMs ?? 12)),
      runId: params.runId ?? 's10',
    };
  }

  const childMatch = /\[S10_CHILD:([^\]]+)\]/u.exec(promptText ?? '');
  if (childMatch) {
    const params = {};
    for (const pair of childMatch[1].split(',')) {
      const [k, v] = pair.split('=');
      if (k && v !== undefined) params[k.trim()] = v.trim();
    }
    return {
      kind: 'child_chain',
      childIndex: Number(params.idx ?? 0),
      steps: Math.max(1, Number(params.steps ?? 6)),
      deltasPerStep: Math.max(12, Number(params.deltas ?? 110)),
      cadenceMs: Math.max(5, Number(params.cadenceMs ?? 12)),
      runId: params.runId ?? 's10',
      needle: params.needle ?? 'NEEDLE_0001',
      targetFile: params.targetFile ?? 'README.md',
      astScript: params.astScript ?? '',
      astTargetDir: params.astTargetDir ?? '',
    };
  }

  return null;
}

/**
 * Plans the next step in the 6-stage S10 native child chain purely from the
 * conversation request (step index + previous tool results).
 */
export function planS10ChildStep({ directive, stepIndex, toolResults, declaredToolNames, workspaceDir, seq }) {
  const idPrefix = `s10_c${directive.childIndex}_s${stepIndex}_${seq}`;
  const safeIdx = String(directive.childIndex).padStart(3, '0');
  const artifactRel = `s10-artifacts/child-${safeIdx}.txt`;
  const artifactAbs = workspaceDir ? path.join(workspaceDir, artifactRel) : artifactRel;

  if (stepIndex === 0) {
    const calls = [];
    if (declaredToolNames.has('Glob')) {
      calls.push({ id: `${idPrefix}_glob`, name: 'Glob', input: { pattern: '**/*.ts' } });
    }
    if (declaredToolNames.has('Grep')) {
      calls.push({ id: `${idPrefix}_grep`, name: 'Grep', input: { pattern: directive.needle, output_mode: 'files_with_matches' } });
    }
    return {
      calls,
      thinking: `Stage 1 discover for child ${safeIdx}: locating seeded files and needle ${directive.needle} across workspace.`,
    };
  }

  if (stepIndex === 1 && stepIndex < directive.steps) {
    const targetPath = workspaceDir ? path.join(workspaceDir, directive.targetFile) : directive.targetFile;
    return {
      calls: declaredToolNames.has('Read')
        ? [{ id: `${idPrefix}_read`, name: 'Read', input: { path: targetPath, line_offset: 1, n_lines: 60 } }]
        : [],
      thinking: `Stage 2 read for child ${safeIdx}: reading target file ${directive.targetFile} to extract seeded constant.`,
    };
  }

  if (stepIndex === 2 && stepIndex < directive.steps) {
    const extracted = extractTextSnippet(toolResults, 120);
    const body = `run=${directive.runId}\nchild=${safeIdx}\nneedle=${directive.needle}\nextract=${extracted}\nstatus=pending\n`;
    return {
      calls: declaredToolNames.has('Write')
        ? [{ id: `${idPrefix}_write`, name: 'Write', input: { path: artifactAbs, content: body } }]
        : [],
      thinking: `Stage 3 write for child ${safeIdx}: persisting derived artifact ${artifactRel} before in-place edit.`,
    };
  }

  if (stepIndex === 3 && stepIndex < directive.steps) {
    const calls = [];
    if (declaredToolNames.has('Edit')) {
      calls.push({
        id: `${idPrefix}_edit`,
        name: 'Edit',
        input: { path: artifactAbs, old_string: 'status=pending', new_string: `status=verified_${safeIdx}` },
      });
    }
    if (declaredToolNames.has('Bash')) {
      const cmd = directive.astScript && directive.astTargetDir
        ? `node "${directive.astScript}" --dir "${directive.astTargetDir}" --challenge "${directive.runId}_${safeIdx}" --needle "${directive.needle}" --passes 2 --partitions 2`
        : `node -e "const c=require('node:crypto');let h='${directive.runId}:${safeIdx}';for(let i=0;i<6000;i++)h=c.createHash('sha256').update(h).digest('hex');console.log('S10_HASH='+h);console.log('PAD_'.repeat(9000));"`;
      calls.push({
        id: `${idPrefix}_bash`,
        name: 'Bash',
        input: { command: cmd, description: `Run deterministic workload build for child ${safeIdx}` },
      });
    }
    return {
      calls,
      thinking: `Stage 4 build for child ${safeIdx}: editing artifact and running CPU-bound deterministic build emitting >=32 KiB log.`,
    };
  }

  if (stepIndex === 4 && stepIndex < directive.steps) {
    const calls = [];
    if (declaredToolNames.has('HistorySearch')) {
      calls.push({ id: `${idPrefix}_hsearch`, name: 'HistorySearch', input: { query: directive.needle, limit: 5 } });
    }
    if (declaredToolNames.has('MemorySearch')) {
      calls.push({ id: `${idPrefix}_msearch`, name: 'MemorySearch', input: { query: 'S10' } });
    }
    if (calls.length === 0 && declaredToolNames.has('Read')) {
      calls.push({ id: `${idPrefix}_reread`, name: 'Read', input: { path: artifactAbs, line_offset: 1, n_lines: 30 } });
    }
    return {
      calls,
      thinking: `Stage 5 recover for child ${safeIdx}: querying history/memory and verifying persisted artifact.`,
    };
  }

  if (stepIndex === 5 && stepIndex < directive.steps) {
    return {
      calls: declaredToolNames.has('TodoList')
        ? [
            {
              id: `${idPrefix}_todo`,
              name: 'TodoList',
              input: {
                todos: [
                  { title: `S10 child ${safeIdx} 6-stage chain`, status: 'done' },
                ],
              },
            },
          ]
        : [],
      thinking: `Stage 6 account for child ${safeIdx}: recording completed TodoList state before final receipt.`,
    };
  }

  const receiptDigest = domainDigest('s10-child-receipt/v2', [directive.runId, safeIdx, String(stepIndex)]);
  return {
    calls: [],
    thinking: `Child ${safeIdx} completed all ${directive.steps} stages cleanly.`,
    replyText: `S10_CHILD_RECEIPT child=${safeIdx} run=${directive.runId} steps=${stepIndex} digest=${receiptDigest}`,
  };
}

function extractTextSnippet(toolResults, maxLen) {
  if (!Array.isArray(toolResults) || toolResults.length === 0) return 'none';
  const raw = typeof toolResults[0]?.content === 'string'
    ? toolResults[0].content
    : JSON.stringify(toolResults[0]?.content ?? '');
  return raw.replaceAll(/[\r\n]+/gu, ' ').slice(0, maxLen);
}

/**
 * Executable mesh node state machine (Astra v2.3 Part II §4 & §10.3).
 *
 * Pure deterministic reducer:
 *   state = { epoch, nodeId, expectedUpstreamIds[], receivedById: Map<id, { digest, origin }>, forwarded: boolean }
 *
 * Transitions:
 *   - Receive(edgeInput): validate authorized origin + digest; record contribution.
 *   - If receivedById.size < expectedUpstreamIds.length -> status = 'Incomplete' (MUST yield turn, NEVER busy-wait).
 *   - When receivedById.size === expectedUpstreamIds.length -> status = 'Ready', compute canonical combined digest
 *     and return outbound intents for durable outbox commit + Forward.
 */
export class MeshNodeStateMachine {
  constructor({ runId, epoch, nodeId, expectedUpstreamIds, outboundEdges = [] }) {
    this.runId = runId;
    this.epoch = epoch;
    this.nodeId = nodeId;
    this.expectedUpstreamIds = [...expectedUpstreamIds].sort();
    this.outboundEdges = outboundEdges;
    this.received = new Map();
    this.outboxCommitted = false;
    this.forwardedKeys = new Set();
  }

  receive({ sourceId, payloadDigest, origin }) {
    if (!this.expectedUpstreamIds.includes(sourceId)) {
      return { accepted: false, reason: 'unexpected_upstream', status: this.getStatus() };
    }
    if (!origin || (origin.kind !== 'peer_thread' && origin.kind !== 'room_message')) {
      return { accepted: false, reason: 'missing_structured_origin', status: this.getStatus() };
    }
    if (origin.kind === 'room_message' && origin.targeted !== true) {
      return { accepted: false, reason: 'untargeted_room_message', status: this.getStatus() };
    }
    if (this.received.has(sourceId)) {
      const prev = this.received.get(sourceId);
      return {
        accepted: prev.payloadDigest === payloadDigest,
        duplicate: true,
        reason: prev.payloadDigest === payloadDigest ? 'idempotent_duplicate' : 'conflicting_duplicate',
        status: this.getStatus(),
      };
    }
    this.received.set(sourceId, { sourceId, payloadDigest, origin });
    return { accepted: true, duplicate: false, status: this.getStatus() };
  }

  getStatus() {
    if (this.received.size < this.expectedUpstreamIds.length) return 'Incomplete';
    if (this.outboundEdges.length > 0 && this.forwardedKeys.size >= this.outboundEdges.length) return 'Forwarded';
    return 'Ready';
  }

  computeCombinedDigest() {
    if (this.received.size < this.expectedUpstreamIds.length) {
      throw new Error(`Node ${this.nodeId} is Incomplete (${this.received.size}/${this.expectedUpstreamIds.length})`);
    }
    const ordered = this.expectedUpstreamIds.map((id) => `${id}=${this.received.get(id).payloadDigest}`);
    return domainDigest('mesh-node-combined/v2.3', [this.runId, String(this.epoch), this.nodeId, ...ordered]);
  }

  buildOutboxIntents() {
    const digest = this.computeCombinedDigest();
    this.outboxCommitted = true;
    return this.outboundEdges.map((edge) => ({
      idempotencyKey: `mesh_${this.runId}_e${this.epoch}_${this.nodeId}_to_${edge.to}_${edge.kind}`,
      epoch: this.epoch,
      from: this.nodeId,
      to: edge.to,
      kind: edge.kind,
      roomId: edge.roomId ?? null,
      payloadDigest: digest,
    }));
  }

  markForwarded(idempotencyKey) {
    this.forwardedKeys.add(idempotencyKey);
  }
}
