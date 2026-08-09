# AI agent bridge published-image smoke

This lane validates the exact bridge OCI artifact published by `ORESoftware/ai-agent-bridge.rs`, rather than rebuilding source in the test organization. The immutable source revision, publication run, evidence artifact, image digest, runtime identity, and entrypoint are recorded in `ai-agent-bridge-image-contract.json`.

The smoke pulls the digest-addressed image anonymously from GHCR, verifies its source-revision label and repository digest, and starts it with a read-only root filesystem, every Linux capability dropped, `no-new-privileges`, and a small writable in-memory state mount owned by the image's non-root user. It then exercises the public health/readiness boundary and authenticated HTTP, Server-Sent Events, and TCP behavior.

The HTTP sequence proves missing and invalid bearer denial, agent registration, topic resolution, message write/read, context write/read, live SSE delivery, request-body limits, and reserved-context denial. The TCP sequence proves that unauthenticated connections can ping but cannot read bridge state, invalid authentication fails closed, valid operator authentication permits data operations, HTTP and TCP share state, and reserved namespaces remain protected. Captured responses and container logs are scanned to ensure the synthetic bearer values are not reflected.

All credentials are synthetic and committed solely as non-secret test fixtures. The workflow receives no ChatGPT, Claude, Slack, Linear, Kubernetes, Cloudflare, R2, identity-provider, GitHub-write, or production credential and performs no provider call or production mutation. A green result certifies only the pinned image and the bounded black-box properties above; it is not evidence that ArgoCD has reconciled that digest, that live ExternalSecrets are ready, or that model-provider canaries have passed.

The workflow runs on pull requests and relevant pushes, can be invoked manually, and repeats weekly so package visibility, immutable digest availability, and the black-box runtime contract cannot silently decay.
