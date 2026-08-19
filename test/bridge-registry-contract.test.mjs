import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { parseJsonStrict } from '../scripts/strict-json.mjs';
import {
  validateContract,
  validateObservedSource,
  validateRegistry,
} from '../scripts/verify-bridge-registry-contract.mjs';

const contractText = fs.readFileSync(new URL('../bridge-registry-contract.json', import.meta.url), 'utf8');
const contract = validateContract(parseJsonStrict(contractText, 'test bridge registry contract'));

function clone(value) {
  return structuredClone(value);
}

function binding(route) {
  return {
    workspace_id: contract.expected.workspaceId,
    channel_id: route.channelId,
    linear_team_id: contract.expected.linearTeamId,
    linear_team_key: contract.expected.linearTeamKey,
    linear_project_id: route.linearProjectId,
    default_repository: route.defaultRepository,
    repository_allowlist: clone(route.repositoryAllowlist),
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
  return {
    schema_version: contract.expected.registrySchemaVersion,
    bindings: contract.expected.routes.map(binding),
  };
}

test('accepts all 15 exact production routes', () => {
  const registry = validRegistry();
  const evidence = validateRegistry(contract, registry);
  assert.equal(evidence.bindingCount, 15);
  assert.equal(evidence.validatedRoutes.length, 15);
  assert.deepEqual(evidence.validatedRoutes, contract.expected.routes.map((route) => route.name));
});

test('accepts an unrelated bridge head movement when registry content is unchanged', () => {
  const observed = validateObservedSource(contract, {
    remoteHead: '1111111111111111111111111111111111111111',
    sourceBlobSha: contract.source.blobSha,
  });
  assert.equal(observed.sourceBlobSha, contract.source.blobSha);
});

test('rejects registry content drift even when the branch head is valid', () => {
  assert.throws(
    () =>
      validateObservedSource(contract, {
        remoteHead: '1111111111111111111111111111111111111111',
        sourceBlobSha: '2222222222222222222222222222222222222222',
      }),
    /production registry content changed/,
  );
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

test('rejects a route identity change anywhere in the 15-route fleet', () => {
  const registry = validRegistry();
  const memebank = registry.bindings.find((binding_) => binding_.channel_id === 'C0BLYPLKETS');
  memebank.default_repository = 'memebank/mbk-api-v2';
  memebank.repository_allowlist = ['memebank/mbk-api-v2'];
  assert.throws(() => validateRegistry(contract, registry), /memebank default repository drifted/);
});

test('rejects an unreviewed replacement route', () => {
  const registry = validRegistry();
  registry.bindings[0].channel_id = 'C_UNREVIEWED';
  assert.throws(() => validateRegistry(contract, registry), /unreviewed route C_UNREVIEWED is present/);
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
  const daedalus = registry.bindings.find((binding_) => binding_.channel_id === 'C0BKP3DDDPZ');
  daedalus.channel_id = 'C0BMB9GSSKY';
  assert.throws(() => validateRegistry(contract, registry), /rejected channel C0BMB9GSSKY reappeared/);
});

test('rejects unknown or missing production binding fields', () => {
  const withUnknown = validRegistry();
  withUnknown.bindings[0].unreviewed = true;
  assert.throws(() => validateRegistry(contract, withUnknown), /missing or unknown fields/);

  const withMissing = validRegistry();
  delete withMissing.bindings[0].linear_team_id;
  assert.throws(() => validateRegistry(contract, withMissing), /missing or unknown fields/);
});

test('requires an exact route contract for every production binding', () => {
  const mutated = clone(contract);
  mutated.expected.routes.pop();
  assert.throws(() => validateContract(mutated), /every registry binding must have an exact route contract/);
});

test('rejects unknown contract fields', () => {
  const mutated = clone(contract);
  mutated.unreviewed = true;
  assert.throws(() => validateContract(mutated), /missing or unknown fields/);
});

test('strict JSON parsing rejects direct, escaped, and nested duplicate keys', () => {
  assert.throws(() => parseJsonStrict('{"a":1,"a":2}', 'direct duplicate'), /duplicate object key/);
  assert.throws(() => parseJsonStrict('{"a":1,"\\u0061":2}', 'escaped duplicate'), /duplicate object key/);
  assert.throws(() => parseJsonStrict('{"outer":{"a":1,"a":2}}', 'nested duplicate'), /duplicate object key/);
});
