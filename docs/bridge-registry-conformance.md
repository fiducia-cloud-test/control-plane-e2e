# alex-main-agent bridge registry conformance

This test-org lane independently verifies the production `alex-main-agent` routing registry without importing provider credentials, Slack tokens, Linear keys, GitHub write credentials, or private repositories.

## Authority

The source of truth is pinned by full commit SHA in `bridge-registry-contract.json`:

- repository: `ORESoftware/ai-agent-bridge.rs`
- branch observed: `main`
- path: `config/alex-main-agent.channels.json`

The workflow first resolves the current public `main` head with `git ls-remote`. It fails closed if the branch has moved beyond the reviewed pin, requiring a fresh diff and explicit pin update.

## Invariants

The verifier requires:

- registry schema version 1;
- exactly 15 unique Slack channel bindings;
- the reviewed Slack workspace and Linear team;
- the single reviewed user principal and no user-group expansion;
- the reviewed five-mode agent allowlist;
- draft-pull-request write policy;
- bounded concurrency, runtime, token, spend, and retry policy;
- every default repository to be included in its repository allowlist;
- no production route to target a `*-test` organization;
- the rejected Daedalus typo channel to remain absent;
- exact Hypesiege, Shared Auth, and ORESoftware control-plane routes.

The test suite mutates each of the highest-risk boundaries and proves that duplicate channels, widened principals, repository drift, budget increases, test-org routing, typo-channel reintroduction, unknown contract fields, and stale source heads are rejected.

## Evidence

Successful runs upload only metadata:

- source repository, path, and immutable commit SHA;
- SHA-256 digest of the public registry snapshot;
- binding count;
- names of the explicitly validated routes;
- reviewed write and budget policies.

No prompts, Slack message bodies, provider responses, raw credentials, private repository contents, or customer data are fetched or retained.
