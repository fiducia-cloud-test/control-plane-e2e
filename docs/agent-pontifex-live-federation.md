# Agent Pontifex four-provider live federation

This lane proves that four independently registered agent identities can exchange
one causally linked conversation through the Rust servers in `agent-pontifex`:

- `agent-pontifex/ai-agent-bridge.rs` supplies authenticated REST, live SSE fan-out,
  channel membership, monotonic per-channel sequences, and durable history;
- `agent-pontifex/ai-agent-coordinator.rs` supplies explicit model routing,
  provider authentication, secret scanning, request budgets, and usage records;
- this repository is an independent consumer and pins both servers by full commit
  SHA so neither implementation can silently move underneath a certification run.

The credential-free lane runs on every relevant pull request. A separate protected
manual lane exercises the same protocol against real provider APIs. One conformance
driver hosts four separately registered adapter identities; every identity owns an
independent bridge SSE subscription, while all provider HTTP calls remain behind the
Rust coordinator.

## What the ring proves

```mermaid
sequenceDiagram
    participant C as Test controller
    participant B as Rust bridge (REST + SSE)
    participant R as Rust coordinator
    participant X as Grok 4.6 adapter
    participant G as Gemini Pro adapter
    participant A as Claude Opus 5 adapter
    participant O as GPT-5.6 Sol adapter

    C->>B: Create channel, join five identities, open four SSE streams
    C->>B: Seed message (seq 1)
    B-->>X: Live seed event
    B-->>G: Live seed event
    B-->>A: Live seed event
    B-->>O: Live seed event
    C->>R: Explicit xAI route with seq/hash 1
    R->>X: OpenAI-compatible chat completion
    X-->>R: Exact acknowledgement
    C->>B: Grok acknowledgement (seq 2, hash link to 1)
    C->>R: Explicit Google route with seq/hash 2
    R->>G: OpenAI-compatible chat completion
    G-->>R: Exact acknowledgement
    C->>B: Gemini acknowledgement (seq 3, hash link to 2)
    C->>R: Explicit Anthropic route with seq/hash 3
    R->>A: OpenAI-compatible chat completion
    A-->>R: Exact acknowledgement
    C->>B: Claude acknowledgement (seq 4, hash link to 3)
    C->>R: Explicit OpenAI route with seq/hash 4
    R->>O: OpenAI-compatible chat completion
    O-->>R: Exact acknowledgement
    C->>B: GPT acknowledgement (seq 5, hash link to 4)
    B-->>X: Every completed turn over SSE
    B-->>G: Every completed turn over SSE
    B-->>A: Every completed turn over SSE
    B-->>O: Every completed turn over SSE
```

A run passes only when all of the following are true:

1. the coordinator advertises all four configured routes and reports each as
   enabled;
2. each provider receives the exact upstream model selected in the manifest;
3. each completion preserves the exact run ID, previous sequence, and SHA-256
   link requested by the prior turn;
4. the bridge issues five strictly increasing message sequences;
5. all four simultaneous SSE observers receive the same ordered five sequences; and
6. bridge history contains the same five messages after the live stream completes.

This is a conversation-chain test, not four unrelated health checks.

## Model resolution observed on September 1, 2026

The names in the original request do not all correspond one-to-one with public
API model IDs. The manifest records both the requested label and the concrete
upstream model so substitutions cannot be hidden.

| Requested identity | Provider route | Concrete upstream model | Resolution |
|---|---|---|---|
| Grok 4.6 | `xai-grok-4.6` | `grok-4.6` | Exact public model |
| Gemini 3.6 Pro | `google-gemini-pro-current` | `gemini-3.1-pro-preview` | No public `gemini-3.6-pro` model is listed; preserve the requested Pro tier by using the current Pro preview rather than substituting 3.6 Flash |
| Claude Opus 5 | `anthropic-claude-opus-5` | `claude-opus-5` | Exact public model |
| ChatGPT Sol 4.6 | `openai-gpt-5.6-sol` | `gpt-5.6-sol` | No API model named `ChatGPT Sol 4.6` is listed; resolve to the current GPT-5.6 Sol API model |

Primary provider references:

- xAI model and OpenAI-compatible inference:
  <https://docs.x.ai/developers/grok-4-6> and
  <https://docs.x.ai/developers/rest-api-reference/inference>
- Gemini model catalog and OpenAI compatibility:
  <https://ai.google.dev/gemini-api/docs/models> and
  <https://ai.google.dev/gemini-api/docs/openai>
- Claude model catalog and OpenAI SDK compatibility:
  <https://platform.claude.com/docs/en/models/overview> and
  <https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk>
- GPT-5.6 Sol model and supported endpoints:
  <https://developers.openai.com/api/docs/models/gpt-5.6-sol>

Provider catalogs are time-sensitive. Changing a concrete model requires an
explicit manifest update and pull request; the live lane fails closed when a
provider removes or rejects a configured model.

## Real-time boundary

“Live” here means message/turn delivery through four long-lived bridge SSE
subscriptions. Every completed model turn is posted immediately to the shared
channel and observed by every other identity without polling.

The pinned coordinator currently rejects `stream: true`, so this lane does **not**
claim token-by-token provider streaming. Token streaming is a separate coordinator
capability: it requires safe upstream stream parsing, budget accounting for partial
responses, disconnect cancellation, and a bridge event contract for deltas. Until
that exists, completed-turn SSE is the honest real-time boundary.

## Pull-request lane: no provider credentials

The pull-request job starts one local OpenAI-compatible mock server with four
provider-specific paths. The mock validates that the Rust coordinator rewrites the
route alias to the expected upstream model, then returns the exact bounded
acknowledgement requested by the driver. It does not log request bodies or bearer
values.

The test then starts the pinned Rust bridge and coordinator, applies the pinned
coordinator PostgreSQL schema fixture, and executes the complete ring. No xAI,
Google, Anthropic, or OpenAI credential is injected into this job.

The mock path deliberately exercises the same HTTP and bridge logic as the live
path; only the provider base URLs and credential environment-variable names differ.

## Protected live-provider lane

Live execution is available only through `workflow_dispatch` with `mode=live`.
Admission requires all of the following:

- the workflow runs from `refs/heads/main`;
- the repository variable `AGENT_PROVIDER_E2E_ENABLED` equals `true`;
- the `agent-provider-e2e` GitHub environment permits the run;
- the operator enters `I_ACCEPT_PROVIDER_COSTS_AND_DATA_EGRESS`; and
- the environment supplies `XAI_API_KEY`, `GEMINI_API_KEY`,
  `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY`.

The synthetic prompt contains only a run ID, bridge sequence, digest, and bounded
acknowledgement template. It is explicitly labeled `public`. The coordinator's
conservative accounting guard uses $100/M input and $200/M output—not as a claim
about vendor pricing, but to keep budget enforcement active if catalogs change.
Each request is capped at 256 output tokens and a $0.10 coordinator estimate; the
run-level coordinator budget is $0.50.

Actual vendor billing remains governed by each provider account. Environment
approval and the explicit cost/data-egress phrase are therefore mandatory even
though the test payload is small.

## Evidence and secrecy

`schemas/agent-pontifex-live-federation-evidence.schema.json` describes the
redacted evidence envelope. Evidence contains:

- run and channel identifiers;
- bridge message sequences;
- selected route, provider, and upstream model;
- previous-message and raw-provider-response SHA-256 digests;
- per-turn latency; and
- sequences observed by each SSE subscriber.

It does not retain prompts, bridge message content, raw provider completions,
HTTP headers, or credential values. The generated evidence file is mode `0600`.
Only a redacted table is written to the GitHub Actions job summary.

## Running the credential-free lane locally

Check out the pinned source revisions at `sources/bridge` and
`sources/coordinator`, start PostgreSQL 17 on loopback port 5432, and set test-only
runtime values:

```bash
export BRIDGE_BEARER='test-only-bridge-bearer'
export COORDINATOR_BEARER='test-only-coordinator-bearer'
export MOCK_PROVIDER_API_KEY='test-only-provider-key'
export GITHUB_WEBHOOK_SECRET='test-only-webhook-secret'
export AI_AGENT_COORDINATOR_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/coordinator'

bash scripts/run-agent-pontifex-live-federation.sh \
  mock \
  /tmp/agent-pontifex-live-evidence.json
```

The helper never enables GitHub repository administration, Linear delivery,
telemetry automation, or email attention workflows.

## Destination in `agent-pontifex-test`

The `agent-pontifex-test` organization exists and the GitHub app can read it, but
it currently exposes no repositories. Repository creation is not performed by
this workflow: it is an organization-admin operation, and the main coordinator's
repository-administration policy explicitly excludes agent-created repositories.

The intended test-organization layout is:

| Repository | Responsibility |
|---|---|
| `agent-pontifex-test/.github` | Organization-wide test policy, contribution guidance, and reusable workflow contracts |
| `agent-pontifex-test/agent-federation-e2e` | This four-provider live ring and future multi-agent end-to-end scenarios |
| `agent-pontifex-test/bridge-protocol-conformance` | REST/SSE/TCP parity, resume/lag behavior, leases, persistence, and chaos tests |
| `agent-pontifex-test/provider-adapter-conformance` | Provider compatibility, model-catalog drift, redaction, budget, retry, and failure-shape tests |

Until an administrator creates the destination repositories, this lane remains in
the already independent `fiducia-cloud-test/control-plane-e2e` boundary. After
`agent-pontifex-test/agent-federation-e2e` exists, migrate these files in one
history-preserving pull request and update the JSON Schema `$id`; do not maintain
two authoritative copies.
