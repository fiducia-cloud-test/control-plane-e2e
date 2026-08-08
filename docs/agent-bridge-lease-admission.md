# Agent Pontifex delivery to Fiducia file-lease admission

Linear: DEN-3059  
Parents and prerequisites: DEN-2359, DEN-2814, DEN-3025  
Related security boundary: DEN-1873, DEN-635

## Purpose

The Agent Pontifex bridge and coordinator deliver authenticated, ordered work. Fiducia file leases provide repository-write authority. These are deliberately different powers.

A bridge message sequence proves delivery order. A coordinator claim proves temporary ownership of a job. Neither may authorize a repository write, commit, or pull-request mutation. The adapter must obtain a current committed Fiducia lease snapshot and bind that authority to the exact intent before a side effect begins.

## Admission envelope

The intent binds one immutable operation to:

- schema version;
- bridge message ID, channel, and server-issued sequence;
- coordinator job ID;
- agent identity;
- canonical `owner/repo` identity;
- sorted, de-duplicated, case-sensitive repository-relative path union;
- operation class;
- SHA-256 payload digest;
- lease ID, fencing token, and expiry.

The authority snapshot independently binds the same agent, repository, path union, lease ID, token, and expiry. It must also prove `committed: true`, `found: true`, and a positive authority revision.

## Decisions

A first valid intent produces an `admitted` receipt with `side_effect_permitted: true`. The caller may perform one bounded side effect under that receipt.

An exact message replay returns the historical receipt with `replayed: true` and `side_effect_permitted: false`. It never authorizes a second side effect, even after the original lease has expired or a successor has taken over.

The first validly shaped intent reserves its message ID before authority evaluation. When the authority snapshot is temporarily missing or uncommitted, the exact same intent may be retried later. The same message ID with any changed payload digest, job, agent, repository, paths, operation, lease, token, expiry, channel, or sequence is always a replay conflict, including after an earlier rejection.

New out-of-order messages on the same bridge channel are rejected. Sequence protects delivery order; it still does not mint authority.

## Fencing behavior

A buffered predecessor is rejected when the authoritative snapshot shows a different holder, lease ID, token, path union, expiry, or repository. After takeover, only a successor intent matching the newer authoritative fencing token can be admitted.

A snapshot at or past expiry is rejected. The adapter does not apply grace periods or infer renewal from bridge activity.

## Evidence boundary

Receipts are deterministic, bounded to 16 KiB, and contain only validated identifiers, canonical paths, numeric authority fields, digests, and decision codes. Unknown fields are rejected rather than copied into evidence. Credential-shaped material therefore cannot enter receipts through extension fields.

The deterministic test suite proves the adapter state machine and adversarial cases. It does not certify a deployed control plane, live database, GitHub mutation, or Cloudflare/R2 environment. Production certification requires a separately protected live lane with immutable deployment identity and no silent fallback to the deterministic authority.

## Integration order

1. Receive an authenticated Agent Pontifex message or claimed coordinator job.
2. Canonicalize the repository and requested union path set.
3. Reserve the validly shaped message identity against changed-payload reuse.
4. Read a committed Fiducia authority snapshot for the complete union.
5. Build and evaluate the admission envelope.
6. Execute only when the receipt is new, admitted, and explicitly permits one side effect.
7. Persist the receipt alongside the downstream mutation receipt.
8. Reconcile completion using both receipts; never infer success from message delivery alone.

## Pull-request safety

The test-org workflow is read-only and credential-free. It uses Node 22, a SHA-pinned checkout action, syntax checks, and the dependency-free adversarial suite. It does not consume the GitHub, Linear, Cloudflare, R2, model-provider, or production control-plane credentials supplied to operators.
