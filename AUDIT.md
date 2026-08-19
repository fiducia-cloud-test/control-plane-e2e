# Registry conformance security audit

Date: 2026-08-19  
Scope: `bridge-registry-contract.json`, its verifier, hostile tests, and GitHub Actions execution boundary.

## Findings addressed

1. **Partial route authority coverage.** The prior contract named only 3 of 15 routes while describing itself as a full registry certification. A change to any of the other 12 Linear projects or repository allowlists could remain green. The contract now pins all 15 routes exactly.
2. **False failures on unrelated bridge commits.** The prior gate compared the complete bridge repository head to one SHA. Dependency-only changes made the registry test red even when the registry blob was byte-identical. The gate now proves reviewed-commit ancestry and pins the registry Git blob itself.
3. **Duplicate JSON key ambiguity.** Native `JSON.parse` accepts the last occurrence of a duplicate key. Contracts and snapshots now pass through a strict recursive scanner that rejects direct, escaped-equivalent, and nested duplicate keys before parsing.
4. **Permissive production schemas.** The prior verifier accepted unknown binding fields and did not require every route identity to be represented. Root, binding, budget, source, expected-policy, and route field sets are now exact.
5. **Incomplete team authority.** The Linear team key was checked but the team UUID was not. Both are now fixed.
6. **Weak change provenance validation.** `updated_by` and `updated_at` existed but were not validated. The gate now requires a DEN issue identifier and a valid UTC timestamp.
7. **Unbounded Git network operations.** Source discovery now uses terminal-prompt suppression and explicit timeouts, verifies exactly one `main` ref, validates ancestry, and derives the observed blob from Git rather than trusting a branch label.

## Residual boundary

This lane certifies the public routing document and its authorization policy. It does not prove live Slack signatures, provider dispatch, GitHub/Linear writes, or Kubernetes rollout health; those remain separate production and integration gates.
