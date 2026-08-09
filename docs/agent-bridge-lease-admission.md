# Agent Pontifex delivery to Fiducia file-lease admission

Linear: DEN-3059  
Parents and prerequisites: DEN-2359, DEN-2814, DEN-3025  
Related security boundary: DEN-1873, DEN-635

## Purpose

The Agent Pontifex bridge and coordinator deliver authenticated, ordered work. Fiducia file leases provide repository-write authority. These are deliberately different powers.

A bridge message sequence proves delivery order. A coordinator claim proves temporary ownership of a job. Neither may authorize a repository write, commit, or pull-request mutation. The adapter requires both a current Agent Pontifex claim and a committed Fiducia file-lease read that match the exact intent before a side effect begins.

## Three independent inputs

The intent binds one immutable operation to:

- schema version;
- bridge message ID, channel, and server-issued sequence;
- coordinator job ID;
- agent identity;
- canonical `owner/repo` identity;
- sorted, de-duplicated, case-sensitive repository-relative path union;
- operation class;
- SHA-256 payload digest;
- fencing token and exact lease expiry.

The Agent Pontifex claim independently binds the running job ID, claimed agent, repository, and claim expiry.

The Fiducia authority independently binds the committed lease holder, repository, complete union path set, fencing token, exact lease expiry, and a SHA-256 commitment fingerprint. This matches the existing file-lease API: holder, fencing token, expiry, and canonical `git-file/<owner>/<repo>/<path>` keys. The adapter does not invent a lease ID or commit index that the merged API does not expose.

## Product-contract adapters

`claimFromAgentPontifexJob` accepts a bounded running coordinator job envelope and produces the exact claim object. Terminal, queued, unclaimed, oversized, malformed, or impossible-date jobs fail closed.

`authorityFromFileLeaseRead` accepts the actual committed response returned by `FileLeaseClient.raw`, verifies HTTP 200, `committed: true`, `found: true`, exact canonical union keys, holder, token, and expiry, then produces the bounded authority object. Unknown response fields are not copied into the admission receipt.

The test suite starts a loopback HTTP service, exercises the existing `FileLeaseClient`, converts its committed response, converts an Agent Pontifex running-job envelope, and admits the combined intent. This is an executable composition of the two merged test-org contracts rather than a hand-built authority-only fixture.

## Decisions and replay

A first valid intent produces an `admitted` receipt with `side_effect_permitted: true`. The caller may perform one bounded side effect under that receipt.

An exact message replay returns the historical receipt with `replayed: true` and `side_effect_permitted: false`. It never authorizes a second side effect, even after the original claim or file lease has expired or a successor has taken over.

The first validly shaped intent reserves its message ID before claim or authority evaluation. When a claim or authority is temporarily unavailable, that exact same intent may be retried only while it remains the newest observed message on its bridge channel. The same message ID with any changed payload digest, job, agent, repository, paths, operation, token, expiry, channel, or sequence is always a replay conflict, including after an earlier rejection.

A newer validly shaped bridge message advances the channel observation boundary even when its claim or authority is not yet sufficient. Older new messages and older pending retries are then rejected. Bridge sequence therefore preserves delivery order but still cannot mint write authority.

Replay and sequencing state is private and has a configured hard capacity. New message identities fail closed with `admission-capacity-exhausted` at that limit; an already-reserved exact intent may still finish verification. The in-process map is a deterministic test implementation. Production must use a durable, bounded, atomically updated replay store with an explicit retention policy.

## Fencing behavior

The adapter rejects:

- inactive or expired coordinator claims;
- job, claim-agent, or claim-repository mismatch;
- missing or uncommitted file-lease authority;
- repository or union-path mismatch;
- file-lease holder mismatch;
- stale fencing token;
- expired or changed lease expiry;
- malformed or noncanonical file-lease keys.

After takeover, only a successor intent whose claim and committed file-lease authority both match the successor agent and newer token can be admitted. No grace period is inferred from bridge activity or coordinator heartbeat.

## Evidence boundary

Receipts are deterministic, immutable, bounded to 16 KiB, and contain only validated identifiers, canonical paths, numeric authority fields, SHA-256 fingerprints, and decision codes. Unknown fields are rejected rather than copied into evidence. Credential-shaped extension data therefore cannot enter receipts.

The deterministic suite proves the adapter, adapters, replay ordering, and adversarial state machine. It does not certify a deployed production control plane, durable replay database, GitHub mutation, or Cloudflare/R2 environment. Production certification requires a separately protected live lane with immutable deployment identity and no silent fallback to the deterministic authority.

## Integration order

1. Receive an authenticated Agent Pontifex message or claimed coordinator job.
2. Canonicalize and reserve the validly shaped message identity and channel sequence.
3. Convert the current running coordinator job into the bounded claim contract.
4. Read the complete Fiducia union lease through the committed file-lease client.
5. Convert that response into the bounded authority contract.
6. Evaluate the three-way binding.
7. Execute only when the receipt is new, admitted, and explicitly permits one side effect.
8. Persist the admission receipt alongside the downstream mutation receipt.
9. Reconcile completion using both receipts; never infer success from message delivery alone.

## Pull-request safety

The test-org workflow is read-only and credential-free. It uses Node 22, a SHA-pinned checkout action, syntax checks, and the dependency-free adversarial suite. It does not consume GitHub-owner, Linear, Cloudflare, R2, model-provider, or production control-plane credentials.
