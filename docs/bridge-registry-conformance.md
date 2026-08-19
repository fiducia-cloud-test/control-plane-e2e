# alex-main-agent bridge registry conformance

This test-org lane independently verifies the production `alex-main-agent` routing registry without importing provider credentials, Slack tokens, Linear keys, GitHub write credentials, or private repositories.

## Authority

`bridge-registry-contract.json` records both a reviewed bridge commit and the immutable Git blob identity of:

- repository: `ORESoftware/ai-agent-bridge.rs`
- branch observed: `main`
- path: `config/alex-main-agent.channels.json`

The workflow resolves the current public `main` head, fetches its history without credentials, proves that the reviewed commit remains an ancestor, and derives the registry file's Git blob SHA from the observed head. Unrelated bridge commits may advance without forcing a meaningless registry-pin refresh, but any registry-byte change fails closed and requires a full route review.

## Invariants

The verifier requires:

- duplicate-key-free JSON for both the contract and production registry;
- registry schema version 1 and an exact root/binding/budget field set;
- exactly 15 unique Slack channel bindings;
- an exact route contract for every one of the 15 bindings;
- the reviewed Slack workspace, Linear team ID/key, and single user principal;
- no user-group expansion;
- the reviewed five-mode agent allowlist;
- draft-pull-request write policy;
- bounded concurrency, runtime, token, spend, and retry policy;
- valid DEN change provenance and UTC timestamps;
- every default repository to be included in its exact repository allowlist;
- no production route to target a `*-test` organization;
- the rejected Daedalus typo channel to remain absent.

The route contract covers 3FA, Cliptown, Benefactor, Athleto, MemeBank, Scintilla, Quaestor Ledger, Daedalus Fab, Hypesiege, StreemPilot, Shared Auth, Opto Sync, Voxletra, the ORESoftware control plane, and Fanwaave.

Hostile tests prove rejection of duplicate or escaped duplicate JSON keys, duplicate channels, widened principals, unreviewed replacement routes, route identity drift anywhere in the fleet, budget increases, test-org routing, typo-channel reintroduction, unknown or missing fields, incomplete route contracts, and registry blob drift.

## Evidence

Successful runs upload only metadata:

- reviewed source commit and observed `main` head;
- source path and Git blob SHA;
- SHA-256 digest of the public registry snapshot;
- binding count and exact route count;
- reviewed write and budget policies.

No prompts, Slack message bodies, provider responses, raw credentials, private repository contents, or customer data are fetched or retained.
