import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  validateContract,
  validateRegistry,
  validateRemoteHead,
} from '../scripts/verify-bridge-registry-contract.mjs';

const contract = JSON.parse(fs.readFileSync(new URL('../bridge-registry-contract.json', import.meta.url), 'utf8'));

function clone(value) {
  return structuredClone(value);
}

function binding({ channelId, projectId, repository, allowlist = [repository] }) {
  return {
    workspace_id: contract.expected.workspaceId,
    channel_id: channelId,
    linear_team_id: 'eb8ab169-5afe-4b6f-9cab-3f2aa3e887dc',
    linear_team_key: contract.expected.linearTeamKey,
    linear_project_id: projectId,
    default_repository: repository,
    repository_allowlist: allowlist,
    default_agent_mode: contract.expected.defaultAgentMode,
    allowed_agent_modes: clone(contract.expected.allowedAgentModes),
    allowed_user_ids: clone(contract.expected.principalUserIds),
    allowed_user_group_ids: clone(contract.expected.principalUserGroupIds),
    write_policy: contract.expected.writePolicy,
    budget_policy: clone(contract.expected.budgetPolicy),
    updated_by: 'DEN-1298',
    updated_at: '2026-08-08T00:00:00Z',
  };
}

function validRegistry() {
  const expected = contract.expected.routes.map((route) =>
    binding({
      channelId: route.channelId,
      projectId: route.linearProjectId,
      repository: route.defaultRepository,
      allowlist: clone(route.repositoryAllowlist),
    }),
  );

  const remaining = Array.from(
    { length: contract.expected.bindingCount - expected.length },
    (_, index) =>
      binding({
        channelId: `C_TEST_${String(index).padStart(2, '0')}`,
        projectId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        repository: `example/service-${index}`,
      }),
  );

  return {
    schema_version: contract.expected.registrySchemaVersion,
    bindings: [...expected, ...remaining],
  };
}

test('accepts the reviewed production policy shape', () => {
  const registry = validRegistry();
  const evidence = validateRegistry(contract, registry);
  assert.equal(evidence.bindingCount, 15);
  assert.deepEqual(evidence.validatedRoutes, ['hypesiege', 'shared-auth', 'oresoftware-control-plane']);
});

test('rejects duplicate channel identities', () => {
  const registry = validRegistry();
  registry.bindings[4].channel_id = registry.bindings[3].channel_id;
  assert.throws(() => validateRegistry(contract, registry), /channel IDs must not contain duplicates/);
});

test('rejects widened Slack principals', () => {
  const registry = validRegistry();
  registry.bindings[0].allowed_user_ids.push('U_UNREVIEWED');
  assert.throws(() => validateRegistry(contract, registry), /user principals widened/);
});

test('rejects a project route that changes repository authority', () => {
  const registry = validRegistry();
  registry.bindings[0].default_repository = 'hypesiege/hypesiege-api-server.rs';
  registry.bindings[0].repository_allowlist = ['hypesiege/hypesiege-api-server.rs'];
  assert.throws(() => validateRegistry(contract, registry), /hypesiege default repository drifted/);
});

test('rejects budget increases', () => {
  const registry = validRegistry();
  registry.bindings[0].budget_policy.max_spend_cents += 1;
  assert.throws(() => validateRegistry(contract, registry), /budget policy drifted/);
});

test('rejects production routing into a test organization', () => {
  const registry = validRegistry();
  registry.bindings[3].default_repository = 'example-test/service';
  registry.bindings[3].repository_allowlist = ['example-test/service'];
  assert.throws(() => validateRegistry(contract, registry), /must not route production work into a test organization/);
});

test('rejects the known Daedalus typo channel', () => {
  const registry = validRegistry();
  registry.bindings[3].channel_id = 'C0BMB9GSSKY';
  assert.throws(() => validateRegistry(contract, registry), /rejected channel C0BMB9GSSKY reappeared/);
});

test('fails closed when bridge main moves', () => {
  assert.throws(
    () => validateRemoteHead(contract, '0000000000000000000000000000000000000000'),
    /bridge main moved/,
  );
});

test('rejects unknown contract fields', () => {
  const mutated = clone(contract);
  mutated.unreviewed = true;
  assert.throws(() => validateContract(mutated), /missing or unknown fields/);
});
