---
title: Cross-host session boundaries
description: Why GUI and Codex-delegated sessions remain isolated, and the constraints for any future controlled bridge.
outline: [2, 3]
---

# Cross-host session boundaries

GUI sessions and Codex-delegated sessions intentionally live in separate Kimi home directories. They do not discover each other through session or thread APIs, and the current thread-communication contract rejects cross-host references. This page records that decision and the minimum constraints for any future controlled bridge.

::: warning Note
The supported design is isolation, not shared storage. Do not point the GUI and Codex delegation runtimes at one writable home directory, copy session directories between them, or copy a `device_id` to make two homes appear to be one host.
:::

## What a host means here

A thread reference is the tuple `hostId` + `workspaceId` + `sessionId`. The `hostId` is not a DNS name or the physical machine name; `ThreadCommunicationService` obtains it from the stable Kimi device ID stored under that server's `homeDir`.

The home directory is also the root of the server's file storage. Session metadata, wire records, session indexes, thread mailboxes, server instance records, and the device ID therefore belong to the same local authority and persistence boundary.

Two runtimes on one physical computer are different thread hosts when they use independent homes with independent device IDs.

## Current topology

The supported GUI and Codex paths deliberately construct different storage and authority domains.

### GUI-side sessions

The GUI connects to a `kap-server` instance and sees the sessions stored under that server's home directory. Local GUI development discovers a server under `KIKI_HOME`, falling back to `~/.kiki`, and reads that home's instance registry and bearer token.

The GUI is a client of this server. It does not scan arbitrary Kimi homes and does not merge session indexes from other servers.

### Codex external delegation

The Codex MCP launcher provisions one signed workspace binding per workspace. Each binding contains a dedicated `kap-home` directory, and the launcher starts the workspace KAP process with `KIKI_HOME` set to that directory.

The dedicated server may read a separately pinned configuration path and Agent-profile home, but its writable session state, server token, instance registry, device ID, and delegated Session remain rooted in the binding's `kap-home`. The launcher also verifies that the process, port, Session, workspace, model binding, and authority records match the signed workspace binding.

### Consequence

The two paths are mutually invisible by construction:

- Each server's `ISessionIndex` reads only the sessions under its own home.
- `listThreads` is built from that local session index, so it cannot list Sessions stored under another home.
- Thread references include the local `hostId`.
- `readThread`, `sendMessage`, peer sends, and `waitThreads` call the local-host guard; a mismatched `hostId` fails with `thread.cross_host` and the message `Cross-host thread communication is not supported.`

Using the same workspace path does not make the Sessions peers. Workspace identity is only one part of a thread reference, and the storage/host boundary still differs.

## Decision: maintain isolation

The current decision is to keep this behavior rather than make the homes shared or implicitly bridged.

### Usability reasons

- The GUI session list remains a record of GUI-side work instead of mixing in operator-provisioned Codex delegation Sessions.
- Each Codex workspace gets one stable delegated Session and authority contract, so launcher diagnostics and recovery can name the exact owner.
- Stopping or reprovisioning a delegated workspace does not disturb the GUI's ordinary server lifecycle.
- A user cannot accidentally send a local thread message to a similarly named Session in another authority domain.

### Isolation reasons

- Session data, mailbox state, bearer tokens, instance records, and device identity remain scoped to the process family that owns them.
- The Codex launcher can enforce a dedicated home, read-only shared configuration, a signed workspace binding, an exclusive port, and a narrowly admitted external-delegation Session.
- A compromised or stale client cannot claim peer provenance merely by submitting a `source` field. Existing REST and Klient sends are target-only and are recorded as user-origin input.
- Failures, cleanup, and data retention stay local. One host does not need to understand or repair the other host's on-disk state.

The cost of this decision is explicit: built-in thread communication cannot coordinate a GUI Session with a Codex-delegated Session.

## What is not a bridge

The following approaches violate the current boundary and must not be used as shortcuts:

- Pointing both servers at the same writable `KIKI_HOME`.
- Copying or synchronizing `sessions/`, thread mailbox data, `server.token`, or `device_id` between homes.
- Rewriting a foreign `ThreadRef` to use the local `hostId`.
- Adding a client-controlled `source` field to the existing REST or Klient send contract.
- Treating the external-delegation API as general thread transport. It is a narrow, operator-provisioned authority for one admitted Session, not a cross-host peer bus.
- Treating a common workspace path as proof that two Sessions share an owner or trust domain.

## Constraints for a controlled bridge

If cross-host coordination becomes a product requirement, it must be introduced as an explicit bridge between two intact hosts. It must not weaken the local thread contract or merge homes.

### Authority and consent

- The bridge must be disabled by default and explicitly enabled for each participating host or workspace.
- Both sides must authenticate the bridge with dedicated, revocable credentials. Reusing a GUI bearer token, an external-delegation token, or a model credential as a general bridge credential is not acceptable.
- Authorization must constrain source host, target host, workspace, Session, direction, and allowed operations. Possession of an endpoint alone must grant no routing authority.
- User or operator consent must identify which Sessions may exchange messages. Wildcard access across every Session in a home requires a separate, stronger policy.

### Identity and provenance

- The bridge must preserve the full source and target host-qualified references; it must never replace a remote `hostId` with a local one.
- Peer attribution may be recorded only after the destination verifies a bridge-issued, integrity-protected source assertion. Arbitrary client-supplied provenance remains forbidden.
- When provenance cannot be verified, the destination must record the input as external/user-origin rather than peer-origin.
- Bridge messages need their own protocol version, bridge identity, message ID, and optional hop metadata so loops and replay paths can be detected.

### Delivery semantics

- Acceptance must be idempotent. Retrying the same bridge message cannot create duplicate turns, while reusing an idempotency key with different content must fail.
- The destination remains authoritative for validating that the target Session exists, belongs to the addressed workspace, is not archived, and permits thread communication.
- Receipts must distinguish accepted, delivered, pending, rejected, and permanently undeliverable outcomes. A network success alone is not proof of Session delivery.
- Per-target ordering and retry behavior must be defined. The bridge must not silently reorder messages around the destination mailbox's sequence.
- Timeouts, bounded payload sizes, rate limits, backpressure, and maximum retry windows are mandatory. A bridge cannot create unbounded queues in either home.

### Preserve data isolation

- Only explicit protocol messages may cross the boundary. Session directories, indexes, tokens, configuration files, model credentials, and device IDs remain local.
- Message content must be treated as potentially sensitive prompt data. Encryption in transit, log redaction, retention limits, and operator-visible audit policy are required.
- The bridge must not expose remote filesystem access, tools, or model credentials merely because it can deliver a message to a Session.
- Source and destination policy evaluation must be independent. A permissive source cannot override a disabled destination workspace or host.

### Operations and failure handling

- Each side needs a kill switch and credential-revocation path that does not require deleting Session data.
- The bridge must fail closed when identity, policy, protocol version, or target validation is unavailable. It must not fall back to shared-home access or unverified peer attribution.
- Audit records should capture bridge identity, source and target references, message ID, policy decision, timestamps, and delivery outcome without logging message content by default.
- Health reporting must distinguish local thread health from bridge transport health so operators do not misdiagnose a remote outage as local Session corruption.
- Capability negotiation is required before either side sends peer-attributed traffic; mixed versions must degrade to an explicitly defined safe behavior.

## Acceptance gates for a future bridge

A bridge design is not ready for implementation until it includes:

1. A threat model covering credential theft, source spoofing, replay, loops, confused-deputy routing, prompt-data exposure, and destination compromise.
2. A protocol specification with versioning, authentication, authorization, idempotency, ordering, receipts, retry limits, and provenance rules.
3. End-to-end tests using two different temporary homes and device IDs, including duplicates, restarts, stale Sessions, archived Sessions, disabled workspaces, revoked credentials, and unreachable destinations.
4. User-visible disclosure of the remote source and delivery state, with no UI that makes remote input indistinguishable from a verified local peer.
5. A rollout and rollback plan that leaves the existing local-only `ThreadCommunicationService` behavior unchanged when the bridge is off.

Until all gates are met, the correct integration assumption is that GUI and Codex-delegated Sessions cannot communicate through thread APIs.

## Source map

The current boundary is anchored in these repository paths:

- **Server storage root**: `packages/kap-server/src/start.ts`
- **GUI local-home discovery**: `apps/kiki-gui/vite/localServer.ts`
- **Codex per-workspace dedicated home**: `packages/kap-server/scripts/codex-kiki-mcp.ps1`
- **External delegation authority**: `packages/kap-server/src/mcp/externalDelegationAuthority.ts`
- **Host-qualified thread contract**: `packages/agent-core-v2/src/app/threadCommunication/threadCommunication.ts`
- **Host ID and cross-host rejection**: `packages/agent-core-v2/src/app/threadCommunication/threadCommunicationService.ts`
- **Device ID storage**: `packages/oauth/src/identity.ts`

## Next steps

- [Kiki runtime boundary](./kiki-runtime.md#integrate-peer-thread-communication) — current local thread tools, REST routes, and Klient surface.
- [Sessions and context](./sessions.md#session-storage) — ordinary Kiki session storage under one home directory.
- [Local server and API](./server.md) — how clients connect to a `kap-server` instance.
