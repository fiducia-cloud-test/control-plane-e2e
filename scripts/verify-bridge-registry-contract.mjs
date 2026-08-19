import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseJsonStrict } from './strict-json.mjs';

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISSUE_PATTERN = /^DEN-[1-9]\d*$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SECRET_PATTERN = /(?:ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const BINDING_KEYS = [
  'workspace_id',
  'channel_id',
  'linear_team_id',
  'linear_team_key',
  'linear_project_id',
  'default_repository',
  'repository_allowlist',
  'default_agent_mode',
  'allowed_agent_modes',
  'allowed_user_ids',
  'allowed_user_group_ids',
  'write_policy',
  'budget_policy',
  'updated_by',
  'updated_at',
];
const BUDGET_KEYS = [
  'max_concurrent_runs',
  'max_runtime_secs',
  'max_tokens',
  'max_spend_cents',
  'max_retries',
];

function exactKeys(value, expected, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} contains missing or unknown fields`);
}

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must not contain duplicates`);
}

function positiveInteger(value, label) {
  assert(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`);
}

function nonnegativeInteger(value, label) {
  assert(Number.isSafeInteger(value) && value >= 0, `${label} must be a nonnegative safe integer`);
}

function validateBudgetPolicy(policy, label) {
  exactKeys(policy, BUDGET_KEYS, label);
  positiveInteger(policy.max_concurrent_runs, `${label}.max_concurrent_runs`);
  positiveInteger(policy.max_runtime_secs, `${label}.max_runtime_secs`);
  positiveInteger(policy.max_tokens, `${label}.max_tokens`);
  nonnegativeInteger(policy.max_spend_cents, `${label}.max_spend_cents`);
  nonnegativeInteger(policy.max_retries, `${label}.max_retries`);
}

function assertProductionRepository(repository, label) {
  assert(REPOSITORY_PATTERN.test(repository), `${label} must be owner/name`);
  const owner = repository.split('/', 1)[0].toLowerCase();
  assert(!owner.endsWith('-test'), `${label} must not route production work into a test organization`);
}

export function validateContract(contract) {
  exactKeys(contract, ['schemaVersion', 'source', 'expected'], 'contract');
  assert.equal(contract.schemaVersion, 2, 'contract schemaVersion must be 2');

  exactKeys(contract.source, ['repository', 'branch', 'reviewedSha', 'path', 'blobSha'], 'contract.source');
  assert(REPOSITORY_PATTERN.test(contract.source.repository), 'source repository must be owner/name');
  assert.equal(contract.source.branch, 'main', 'source branch must be main');
  assert(SHA_PATTERN.test(contract.source.reviewedSha), 'reviewed source SHA must be 40 lowercase hex characters');
  assert(SHA_PATTERN.test(contract.source.blobSha), 'source blob SHA must be 40 lowercase hex characters');
  assert(!contract.source.path.startsWith('/'), 'source path must be repository-relative');
  assert(!contract.source.path.split('/').includes('..'), 'source path must not traverse parents');

  const expected = contract.expected;
  exactKeys(
    expected,
    [
      'registrySchemaVersion',
      'bindingCount',
      'workspaceId',
      'linearTeamId',
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
  positiveInteger(expected.bindingCount, 'bindingCount');
  assert(Array.isArray(expected.principalUserIds), 'principalUserIds must be an array');
  assert(Array.isArray(expected.principalUserGroupIds), 'principalUserGroupIds must be an array');
  assert(Array.isArray(expected.allowedAgentModes) && expected.allowedAgentModes.length > 0, 'allowedAgentModes must not be empty');
  assert(Array.isArray(expected.rejectedChannelIds), 'rejectedChannelIds must be an array');
  assert(Array.isArray(expected.routes), 'routes must be an array');
  assert.equal(expected.routes.length, expected.bindingCount, 'every registry binding must have an exact route contract');
  unique(expected.principalUserIds, 'principal user IDs');
  unique(expected.principalUserGroupIds, 'principal user-group IDs');
  unique(expected.allowedAgentModes, 'allowed agent modes');
  unique(expected.rejectedChannelIds, 'rejected channel IDs');
  validateBudgetPolicy(expected.budgetPolicy, 'contract.expected.budgetPolicy');

  unique(expected.routes.map((route) => route.name), 'expected route names');
  unique(expected.routes.map((route) => route.channelId), 'expected route channel IDs');
  unique(expected.routes.map((route) => route.linearProjectId), 'expected route Linear project IDs');
  unique(expected.routes.map((route) => route.defaultRepository), 'expected route default repositories');

  for (const route of expected.routes) {
    exactKeys(
      route,
      ['name', 'channelId', 'linearProjectId', 'defaultRepository', 'repositoryAllowlist'],
      `route ${route.name ?? '<unknown>'}`,
    );
    assert(/^[a-z0-9-]+$/.test(route.name), `route name ${route.name} must be a lowercase slug`);
    assert(!expected.rejectedChannelIds.includes(route.channelId), `${route.name} uses a rejected channel ID`);
    assert(Array.isArray(route.repositoryAllowlist) && route.repositoryAllowlist.length > 0, `${route.name} allowlist is empty`);
    assert(route.repositoryAllowlist.includes(route.defaultRepository), `${route.name} default repository must be allowlisted`);
    unique(route.repositoryAllowlist, `${route.name} repository allowlist`);
    assertProductionRepository(route.defaultRepository, `${route.name} default repository`);
    for (const repository of route.repositoryAllowlist) {
      assertProductionRepository(repository, `${route.name} allowlisted repository`);
    }
  }

  assert(!SECRET_PATTERN.test(JSON.stringify(contract)), 'contract contains a credential-shaped value');
  return contract;
}

export function validateObservedSource(contract, { remoteHead, sourceBlobSha }) {
  validateContract(contract);
  assert(SHA_PATTERN.test(remoteHead ?? ''), 'observed bridge main SHA must be 40 lowercase hex characters');
  assert(SHA_PATTERN.test(sourceBlobSha ?? ''), 'observed registry blob SHA must be 40 lowercase hex characters');
  assert.equal(sourceBlobSha, contract.source.blobSha, 'production registry content changed; refresh and review the full route contract');
  return { remoteHead, sourceBlobSha };
}

export function validateRegistry(contract, registry, rawBytes = Buffer.from(JSON.stringify(registry))) {
  validateContract(contract);
  assert(rawBytes.length > 0, 'registry snapshot is empty');
  assert(rawBytes.length <= MAX_SNAPSHOT_BYTES, 'registry snapshot exceeds 1 MiB');
  exactKeys(registry, ['schema_version', 'bindings'], 'registry');
  assert.equal(registry.schema_version, contract.expected.registrySchemaVersion, 'registry schema version drifted');
  assert(Array.isArray(registry.bindings), 'registry bindings must be an array');
  assert.equal(registry.bindings.length, contract.expected.bindingCount, 'registry binding count drifted');

  const routes = new Map(contract.expected.routes.map((route) => [route.channelId, route]));
  const channelIds = registry.bindings.map((binding) => binding.channel_id);
  unique(channelIds, 'registry channel IDs');

  for (const binding of registry.bindings) {
    exactKeys(binding, BINDING_KEYS, `binding ${binding.channel_id ?? '<unknown>'}`);
    validateBudgetPolicy(binding.budget_policy, `binding ${binding.channel_id}.budget_policy`);
    assert.equal(binding.workspace_id, contract.expected.workspaceId, `${binding.channel_id} workspace drifted`);
    assert.equal(binding.linear_team_id, contract.expected.linearTeamId, `${binding.channel_id} Linear team ID drifted`);
    assert.equal(binding.linear_team_key, contract.expected.linearTeamKey, `${binding.channel_id} Linear team key drifted`);
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
    assert(ISSUE_PATTERN.test(binding.updated_by), `${binding.channel_id} updated_by must be a DEN issue identifier`);
    assert(UTC_TIMESTAMP_PATTERN.test(binding.updated_at) && !Number.isNaN(Date.parse(binding.updated_at)), `${binding.channel_id} updated_at must be a valid UTC timestamp`);

    assert(Array.isArray(binding.repository_allowlist) && binding.repository_allowlist.length > 0, `${binding.channel_id} allowlist is empty`);
    unique(binding.repository_allowlist, `${binding.channel_id} repository allowlist`);
    assert(binding.repository_allowlist.includes(binding.default_repository), `${binding.channel_id} default repository is not allowlisted`);
    assertProductionRepository(binding.default_repository, `${binding.channel_id} default repository`);
    for (const repository of binding.repository_allowlist) {
      assertProductionRepository(repository, `${binding.channel_id} allowlisted repository`);
    }

    const expectedRoute = routes.get(binding.channel_id);
    assert(expectedRoute, `unreviewed route ${binding.channel_id} is present`);
    assert.equal(binding.linear_project_id, expectedRoute.linearProjectId, `${expectedRoute.name} Linear project drifted`);
    assert.equal(binding.default_repository, expectedRoute.defaultRepository, `${expectedRoute.name} default repository drifted`);
    assert.deepEqual(binding.repository_allowlist, expectedRoute.repositoryAllowlist, `${expectedRoute.name} allowlist drifted`);
  }

  for (const rejectedChannelId of contract.expected.rejectedChannelIds) {
    assert(!channelIds.includes(rejectedChannelId), `rejected channel ${rejectedChannelId} reappeared`);
  }

  assert(!SECRET_PATTERN.test(rawBytes.toString('utf8')), 'registry contains a credential-shaped value');

  return {
    schemaVersion: 2,
    sourceRepository: contract.source.repository,
    reviewedSha: contract.source.reviewedSha,
    sourcePath: contract.source.path,
    sourceBlobSha: contract.source.blobSha,
    snapshotSha256: crypto.createHash('sha256').update(rawBytes).digest('hex'),
    bindingCount: registry.bindings.length,
    validatedRoutes: contract.expected.routes.map((route) => route.name),
    principalUserIds: contract.expected.principalUserIds,
    writePolicy: contract.expected.writePolicy,
    budgetPolicy: contract.expected.budgetPolicy,
  };
}

export async function fetchRegistrySnapshot(source, observedHead) {
  assert(SHA_PATTERN.test(observedHead ?? ''), 'observed bridge head must be 40 lowercase hex characters');
  const url = new URL(`https://raw.githubusercontent.com/${source.repository}/${observedHead}/${source.path}`);
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: {
      accept: 'application/json,text/plain;q=0.9',
      'user-agent': 'fiducia-cloud-test-control-plane-e2e',
    },
  });
  assert.equal(response.status, 200, `registry fetch returned HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  assert(/^(?:application\/json|text\/plain)(?:;|$)/i.test(contentType), `unexpected registry content type ${contentType}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length > 0, 'registry snapshot is empty');
  assert(bytes.length <= MAX_SNAPSHOT_BYTES, 'registry snapshot exceeds 1 MiB');
  return bytes;
}

async function main() {
  const contractPath = process.argv[2] ?? 'bridge-registry-contract.json';
  const contractText = fs.readFileSync(contractPath, 'utf8');
  const contract = validateContract(parseJsonStrict(contractText, 'bridge registry contract'));
  const observed = validateObservedSource(contract, {
    remoteHead: process.env.BRIDGE_REMOTE_SHA,
    sourceBlobSha: process.env.BRIDGE_REGISTRY_BLOB_SHA,
  });

  const rawBytes = await fetchRegistrySnapshot(contract.source, observed.remoteHead);
  const registry = parseJsonStrict(rawBytes.toString('utf8'), 'production bridge registry');
  const evidence = {
    ...validateRegistry(contract, registry, rawBytes),
    observedHead: observed.remoteHead,
  };

  const evidencePath = process.env.BRIDGE_REGISTRY_EVIDENCE ?? 'test-results/bridge-registry-evidence.json';
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## alex-main-agent bridge registry conformance\n\n- Reviewed source: \`${evidence.sourceRepository}@${evidence.reviewedSha}\`\n- Observed main: \`${evidence.observedHead}\`\n- Registry blob: \`${evidence.sourceBlobSha}\`\n- Bindings: ${evidence.bindingCount}\n- Snapshot SHA-256: \`${evidence.snapshotSha256}\`\n- Exact routes: ${evidence.validatedRoutes.length}\n`,
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
