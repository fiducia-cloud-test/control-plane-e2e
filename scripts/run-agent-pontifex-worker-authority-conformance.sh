#!/usr/bin/env bash
set -euo pipefail

source_repo="${AGENT_PONTIFEX_SOURCE_REPOSITORY:-agent-pontifex/ai-agent-coordinator.rs}"
source_ref="${AGENT_PONTIFEX_SOURCE_REF:-fix/den-3157-worker-authority}"
case "${source_repo}" in
  agent-pontifex/ai-agent-coordinator.rs) ;;
  *)
    printf 'unsupported source repository: %s\n' "${source_repo}" >&2
    exit 2
    ;;
esac
case "${source_ref}" in
  main|fix/den-3157-worker-authority|[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *)
    printf 'unsupported source ref: %s\n' "${source_ref}" >&2
    exit 2
    ;;
esac

api_url="https://api.github.com/repos/${source_repo}/commits/${source_ref}"
revision="$(
  curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    -H 'User-Agent: fiducia-cloud-test-worker-authority-conformance/1' \
    "${api_url}" |
    node -e '
      let source = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { source += chunk; });
      process.stdin.on("end", () => {
        const value = JSON.parse(source);
        if (!value || typeof value.sha !== "string" || !/^[0-9a-f]{40}$/.test(value.sha)) {
          process.exit(2);
        }
        process.stdout.write(value.sha);
      });
    '
)"

workdir="$(mktemp -d)"
cleanup() {
  rm -rf "${workdir}"
}
trap cleanup EXIT HUP INT TERM
mkdir -p "${workdir}/src" "${workdir}/tests"

fetch_source() {
  local path="$1"
  local destination="$2"
  curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 \
    -H 'User-Agent: fiducia-cloud-test-worker-authority-conformance/1' \
    "https://raw.githubusercontent.com/${source_repo}/${revision}/${path}" \
    --output "${destination}"
}

fetch_source 'src/worker_authority.rs' "${workdir}/src/worker_authority.rs"
fetch_source 'src/worker_authority_config.rs' "${workdir}/src/worker_authority_config.rs"
fetch_source 'tests/worker_authority.rs' "${workdir}/tests/worker_authority.rs"
fetch_source 'tests/worker_authority_config.rs' "${workdir}/tests/worker_authority_config.rs"

cat >"${workdir}/Cargo.toml" <<'TOML'
[package]
name = "ai-agent-coordinator"
version = "0.0.0-conformance"
edition = "2021"
publish = false

[lib]
name = "ai_agent_coordinator"
path = "src/lib.rs"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
subtle = "2"
thiserror = "2"
TOML

cat >"${workdir}/src/lib.rs" <<'RS'
pub mod worker_authority;
pub mod worker_authority_config;
RS

for source in \
  "${workdir}/src/worker_authority.rs" \
  "${workdir}/src/worker_authority_config.rs" \
  "${workdir}/tests/worker_authority.rs" \
  "${workdir}/tests/worker_authority_config.rs"
do
  test -s "${source}"
done

grep -Fq 'AdminProtectedTaskDenied' "${workdir}/src/worker_authority.rs"
grep -Fq 'public_key_fingerprint' "${workdir}/src/worker_authority.rs"
grep -Fq 'DD_COORDINATOR_WORKER_AUTHORITIES_FILE' "${workdir}/src/worker_authority_config.rs"
grep -Fq 'DD_COORDINATOR_WORKER_AUTHORITIES_JSON' "${workdir}/src/worker_authority_config.rs"

(
  cd "${workdir}"
  cargo fmt --check
  cargo test --all-targets --quiet
)

printf '%s\n' "$(node -e '
  const result = {
    schema_version: "agent-pontifex.worker-authority-conformance.v1",
    source_repository: process.argv[1],
    source_ref: process.argv[2],
    resolved_revision: process.argv[3],
    credential_mode: "public-read-only",
    provider_credentials_present: false,
    mutation_credentials_present: false,
    cloudflare_credentials_present: false,
    r2_credentials_present: false,
    status: "passed"
  };
  process.stdout.write(JSON.stringify(result));
' "${source_repo}" "${source_ref}" "${revision}")"
