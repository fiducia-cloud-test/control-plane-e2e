import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SECRET_PATTERN = /(?:ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

function exactKeys(value, expected, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} contains missing or unknown fields`);
}

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must not contain duplicates`);
}

function stable(value) {
  return JSON.stringify(value, Object.keys(value ?? {}).sort());
}

export function validateContract(contract) {
  exactKeys(contract, ['schemaVersion', 'source', 'expected'], 'contract');
  assert.equal(contract.schemaVersion, 1, 'contract schemaVersion must be 1');

  exactKeys(contract.source, ['repository', 'branch', 'sha', 'path'], 'contract.source');
  assert(REPOSITORY_PATTERN.test(contract.source.repository), 'source repository must be owner/name');
  assert.equal(contract.source.branch, 'main', 'source branch must be main');
  assert(SHA_PATTERN.test(contract.source.sha), 'source SHA must be 40 lowercase hex characters');
  assert(!contract.source.path.startsWith('/'), 'source path must be repository-relative');
  assert(!contract.source.path.split('/').includes('..'), 'source path must not traverse parents');

  const expected = contract.expected;
  exactKeys(
    expected,
    [
      'registrySchemaVersion',
      'bindingCount',
      'workspaceId',
      'linearTeamKey',
      'principalUserIds',
      'principalUserGroupIds',
      'defaultAgentMode',
      'allowedAgentModes',
      'writePolicy',
      'budgetPolicy',
      'rejectedChannelIds',
      'routes',
    ],
    'contract.expected',
  );
  assert(Number.isInteger(expected.bindingCount) && expected.bindingCount > 0, 'bindingCount must be positive');
  assert(Array.isArray(expected.routes) && expected.routes.length > 0, 'at least one expected route is required');
  unique(expected.routes.map((route) => route.channelId), 'expected route channel IDs');
  unique(expected.rejectedChannelIds, 'rejected channel IDs');

  for (const route of expected.routes) {
    exactKeys(
      route,
      ['name', 'channelId', 'linearProjectId', 'defaultRepository', 'repositoryAllowlist'],
      `route ${route.name ?? '<unknown>'}`,
    );
    assert(route.repositoryAllowlist.includes(route.defaultRepository), `${route.name} default repository must be allowlisted`);
    unique(route.repositoryAllowlist, `${route.name} repository allowlist`);
  }

  assert(!SECRET_PATTERN.test(JSON.stringify(contract)), 'contract contains a credential-shaped value');
  return contract;
}

function assertProductionRepository(repository, label) {
  assert(REPOSITORY_PATTERN.test(repository), `${label} must be owner/name`);
  const owner = repository.split('/', 1)[0].toLowerCase();
  assert(!owner.endsWith('-test'), `${label} must not route production work into a test organization`);
}

export function validateRegistry(contract, registry, rawBytes = Buffer.from(JSON.stringify(registry))) {
  validateContract(contract);
  assert(rawBytes.length <= MAX_SNAPSHOT_BYTES, 'registry snapshot exceeds 1 MiB');
  assert(registry && typeof registry === 'object' && !Array.isArray(registry), 'registry must be an object');
  assert.equal(registry.schema_version, contract.expected.registrySchemaVersion, 'registry schema version drifted');
  assert(Array.isArray(registry.bindings), 'registry bindings must be an array');
  assert.equal(registry.bindings.length, contract.expected.bindingCount, 'registry binding count drifted');

  const channelIds = registry.bindings.map((binding) => binding.channel_id);
  unique(channelIds, 'registry channel IDs');

  for (const binding of registry.bindings) {
    assert.equal(binding.workspace_id, contract.expected.workspaceId, `${binding.channel_id} workspace drifted`);
    assert.equal(binding.linear_team_key, contract.expected.linearTeamKey, `${binding.channel_id} Linear team drifted`);
    assert.deepEqual(binding.allowed_user_ids, contract.expected.principalUserIds, `${binding.channel_id} user principals widened`);
    assert.deepEqual(
      binding.allowed_user_group_ids,
      contract.expected.principalUserGroupIds,
      `${binding.channel_id} user-group principals widened`,
    );
    assert.equal(binding.default_agent_mode, contract.expected.defaultAgentMode, `${binding.channel_id} default agent mode drifted`);
    assert.deepEqual(binding.allowed_agent_modes, contract.expected.allowedAgentModes, `${binding.channel_id} allowed agent modes drifted`);
    assert.equal(binding.write_policy, contract.expected.writePolicy, `${binding.channel_id} write policy drifted`);
    assert.deepEqual(binding.budget_policy, contract.expected.budgetPolicy, `${binding.channel_id} budget policy drifted`);

    assert(Array.isArray(binding.repository_allowlist) && binding.repository_allowlist.length > 0, `${binding.channel_id} allowlist is empty`);
    unique(binding.repository_allowlist, `${binding.channel_id} repository allowlist`);
    assert(binding.repository_allowlist.includes(binding.default_repository), `${binding.channel_id} default repository is not allowlisted`);
    assertProductionRepository(binding.default_repository, `${binding.channel_id} default repository`);
    for (const repository of binding.repository_allowlist) {
      assertProductionRepository(repository, `${binding.channel_id} allowlisted repository`);
    }
  }

  for (const rejectedChannelId of contract.expected.rejectedChannelIds) {
    assert(!channelIds.includes(rejectedChannelId), `rejected channel ${rejectedChannelId} reappeared`);
  }

  for (const expectedRoute of contract.expected.routes) {
    const binding = registry.bindings.find((candidate) => candidate.channel_id === expectedRoute.channelId);
    assert(binding, `${expectedRoute.name} route is missing`);
    assert.equal(binding.linear_project_id, expectedRoute.linearProjectId, `${expectedRoute.name} Linear project drifted`);
    assert.equal(binding.default_repository, expectedRoute.defaultRepository, `${expectedRoute.name} default repository drifted`);
    assert.deepEqual(binding.repository_allowlist, expectedRoute.repositoryAllowlist, `${expectedRoute.name} allowlist drifted`);
  }

  assert(!SECRET_PATTERN.test(rawBytes.toString('utf8')), 'registry contains a credential-shaped value');

  return {
    schemaVersion: 1,
    sourceRepository: contract.source.repository,
    sourceSha: contract.source.sha,
    sourcePath: contract.source.path,
    snapshotSha256: crypto.createHash('sha256').update(rawBytes).digest('hex'),
    bindingCount: registry.bindings.length,
    validatedRoutes: contract.expected.routes.map((route) => route.name),
    principalUserIds: contract.expected.principalUserIds,
    writePolicy: contract.expected.writePolicy,
    budgetPolicy: contract.expected.budgetPolicy,
  };
}

export function validateRemoteHead(contract, remoteHead) {
  assert(SHA_PATTERN.test(remoteHead ?? ''), 'remote main SHA must be 40 lowercase hex characters');
  assert.equal(remoteHead, contract.source.sha, 'bridge main moved; refresh and review the immutable source pin');
}

export async function fetchRegistrySnapshot(source) {
  const url = new URL(`https://raw.githubusercontent.com/${source.repository}/${source.sha}/${source.path}`);
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: {
      accept: 'application/json,text/plain;q=0.9',
      'user-agent': 'fiducia-cloud-test-control-plane-e2e',
    },
  });
  assert.equal(response.status, 200, `registry fetch returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length > 0, 'registry snapshot is empty');
  assert(bytes.length <= MAX_SNAPSHOT_BYTES, 'registry snapshot exceeds 1 MiB');
  return bytes;
}

async function main() {
  const contractPath = process.argv[2] ?? 'bridge-registry-contract.json';
  const contract = validateContract(JSON.parse(fs.readFileSync(contractPath, 'utf8')));
  validateRemoteHead(contract, process.env.BRIDGE_REMOTE_SHA);

  const rawBytes = await fetchRegistrySnapshot(contract.source);
  const registry = JSON.parse(rawBytes.toString('utf8'));
  const evidence = validateRegistry(contract, registry, rawBytes);

  const evidencePath = process.env.BRIDGE_REGISTRY_EVIDENCE ?? 'test-results/bridge-registry-evidence.json';
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## alex-main-agent bridge registry conformance\n\n- Source: \`${evidence.sourceRepository}@${evidence.sourceSha}\`\n- Bindings: ${evidence.bindingCount}\n- Snapshot SHA-256: \`${evidence.snapshotSha256}\`\n- Routes: ${evidence.validatedRoutes.map((route) => `\`${route}\``).join(', ')}\n`,
    );
  }

  console.log(JSON.stringify(evidence));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
