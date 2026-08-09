# Agent Pontifex and Fiducia agent conformance

This lane is an independent consumer of the public Agent Pontifex protocol. It
runs in `fiducia-cloud-test`, not in either product repository, so a product
cannot make its own incompatible contract appear green by changing its tests in
the same commit.

## Sources

`agent-pontifex-sources.json` pins full commit SHAs for:

- `agent-pontifex/agent-sdk.rs`;
- `agent-pontifex/ai-agent-bridge.rs`;
- `agent-pontifex/ai-agent-coordinator.rs`.

The workflow never follows a floating branch. Updating a source requires an
explicit pull request in this test repository.

## Static contract

The verifier loads all four canonical discovery profiles from the SDK:

- community bridge;
- community coordinator;
- Fiducia bridge;
- Fiducia coordinator.

It fails closed when protocol major 1 is unsupported, capabilities are unsorted
or duplicated, extension namespaces drift, public descriptors contain
credential-shaped fields, or service/protocol identities no longer match.

The Fiducia profile has additional non-negotiable checks:

- the coordinator may not advertise `coordinator.jobs.*` until a translation
  adapter is implemented;
- `community_job_adapter` remains `required`;
- direct job-wire compatibility remains false;
- translation must preserve fencing;
- the bridge advertises monotonic file-lease fencing.

## Live bridge exercise

The pull-request workflow starts the pinned community bridge on loopback with
application authentication enabled. The test then:

1. reads discovery without credentials;
2. proves an application route rejects an unauthenticated request;
3. registers `conformance-producer` and `conformance-observer`;
4. resolves a semantic release-certification topic;
5. publishes a message from the producer;
6. reads the channel as an independent observer;
7. checks that the observed message carries a server-issued monotonic sequence.

This is also the executable AI-agent-bridge coordination path for the test suite:
the agents communicate through the same HTTP contract that external tools use.
The bearer is a test-only workflow value and is never printed by the verifier.

## Live coordinator exercise

The workflow starts PostgreSQL 17, verifies the pinned canonical schema fixture
by SHA-256, applies only that schema, and starts the pinned community coordinator
with every optional external integration disabled. No model endpoint is called.
The test then:

1. reads coordinator discovery without credentials;
2. proves a job route rejects an unauthenticated request;
3. enqueues a job with an idempotency key;
4. repeats the enqueue and proves the original job identity is returned;
5. proves an unrelated organization filter cannot claim the job;
6. claims the job with a bounded lease and checks its attempt counter;
7. rejects heartbeat and completion from a different worker;
8. renews the lease from the owning worker;
9. completes the job successfully and clears lease ownership;
10. reads back the exact terminal result;
11. proves an idempotent replay preserves the completed job;
12. proves completed work cannot be claimed again.

The job envelope is checked as an exact key set on every transition. This catches
wire drift even when the database transition itself remains valid.

## Deliberate boundaries

This lane does not deploy Cloudflare Workers, DNS, R2, or production services.
Those credentials are unnecessary for protocol certification and must not be
introduced into pull-request workflows.

Private Fiducia runtime certification remains gated by the existing
`TEST_FLEET_READ_TOKEN` integration path. Public conformance fixtures still
validate the private implementation boundary without requiring private source
credentials on untrusted pull requests.

The preferred future public home is an `agent-pontifex-test` organization. That
organization does not currently exist, so `fiducia-cloud-test` is the temporary
independent execution boundary rather than allowing the absence of an
organization to block testing.
