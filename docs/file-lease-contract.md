# Control-plane file-lease E2E contract

Linear: DEN-2814  
Parent: DEN-2359  
Related: DEN-869, DEN-865, DEN-635, DEN-203

## Purpose

This repository independently exercises the internal file-lease API used by concurrent engineering agents. It verifies the public HTTP contract and failure semantics without importing production source or sharing mutable state with the product repository.

The production authority remains `fiducia-ai-agent-control-plane` plus `fiducia-node`. This harness cannot mint authority, and its deterministic in-process server is not production evidence.

## Routes

The client targets the existing routes:

- `POST /v1/file-leases/acquire`
- `POST /v1/file-leases/renew`
- `POST /v1/file-leases/release`
- `GET /v1/file-leases`

Every request carries `x-internal-auth`. The client never prints that value and redacts it if a faulty upstream echoes it in an error response.

## Pull-request lane

The ordinary workflow uses Node 22 and only standard-library modules. It runs syntax checks plus deterministic tests against an in-process protocol server with the same bounded request and response shapes.

Covered invariants:

- canonical `owner/repo` case folding;
- case-sensitive repository-relative file paths;
- path sorting and de-duplication;
- all-or-none union acquisition;
- disjoint-path concurrency;
- exact union renewal;
- whole-union release;
- expiry and successor takeover;
- strictly increasing fencing tokens;
- stale-holder renewal and release rejection;
- authenticated internal access;
- malformed-success-envelope rejection;
- timeout classification;
- secret-safe errors.

This lane proves the client and scenario logic. It does not claim that a deployed control plane, PostgreSQL, or Fiducia node was exercised.

## Live lane

A live run requires both:

```text
CONTROL_PLANE_BASE_URL
FIDUCIA_CONTROL_PLANE_SECRET
```

Run:

```bash
node scripts/run-file-lease-contract.mjs --require-live
```

`--require-live` is fail-closed: missing configuration exits non-zero rather than silently substituting the mock or reporting a skip as success.

The live runner creates randomized repository-relative paths under `.e2e/<uuid>/`, uses bounded TTLs, verifies overlap exclusion and disjoint concurrency, waits for one lease to expire, requires a strictly greater successor fencing token, proves the stale holder cannot renew or release, performs an authoritative read, and attempts cleanup in reverse acquisition order.

A scheduled or release workflow should enable the live job only through an environment/repository variable and provide the URL as a non-secret variable plus the internal secret through the environment secret store. Do not place either value in source, fixtures, issue comments, PR descriptions, or workflow artifacts.

## Non-goals

This slice does not modify production lease code, infer path-prefix conflicts that the exact-file API does not represent, test GitHub push/merge authority, or certify kill-switch, PostgreSQL, bridge, model-provider, or EC2-runner behavior. Those remain separate E2E lanes under DEN-2359 and DEN-869.
