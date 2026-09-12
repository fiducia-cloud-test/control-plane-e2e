# Reconciliation attestation authority conformance

Linear: DEN-2877  
Related: DEN-2876, DEN-801, DEN-174

This test-org lane independently executes the exact immutable
`ORESoftware/project-registry` reconciliation-attestation verifier before any
nightly Linear or GitHub mutation path can be activated.

## Boundary under test

Model workers and mutators are separate authorities:

- ChatGPT/OpenAI and Claude/Anthropic opinion workers may call their own model
  provider and sign only their own role; they have no Linear write credential.
- PR readiness and critic workers sign their own evaluations; they have no merge
  credential.
- The finalizer has the minimum Linear or GitHub mutation permission, but no model
  credential and no opinion/readiness signing key.
- The finalizer owns the trusted public-key registry. An artifact cannot introduce
  or select its own trust root.

Every required role must have a distinct key ID, trust domain, worker ID, job ID,
and task type. The signed envelope binds the exact issue or pull-request identity,
current revision digest, policy digest, exact PR head where applicable, timestamps,
payload hash, and bounded payload.

## Credential-free test-org execution

The workflow downloads one file from an exact public project-registry commit and
verifies its committed SHA-256 before execution. It then generates ephemeral
Ed25519 keys in memory and runs synthetic positive and adversarial cases.

The workflow does not receive or use:

- model-provider credentials;
- Linear credentials;
- GitHub write or organization-owner credentials;
- Cloudflare, DNS, R2, or S3 credentials;
- private-source credentials.

The checkout token is not persisted and workflow permissions are read-only.

## Required cases

The conformance suite proves:

- independent ChatGPT and Claude exact-revision opinions verify;
- one key or trust domain cannot satisfy both roles;
- payload tampering, provider swapping, and artifact-supplied key material fail;
- stale revision, expired artifact, and untrusted key fail;
- PR merge authority requires the exact same head and dependency graph;
- exactly `0.995` is insufficient because the threshold is strictly greater;
- less than 55 continuous-open hours is insufficient;
- any blocker prevents authorization.

This lane proves the artifact and finalizer contract only. It does not claim that
a production bridge has separate service identities, protected keys, or mutation
credentials until the deployment and disposable canary provide that evidence.
