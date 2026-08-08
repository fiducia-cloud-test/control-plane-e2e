import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
  ReconciliationAttestationError,
  TRUST_POLICY_SCHEMA_VERSION,
  verifyIndependentAttestationSet
} from '../fixtures/project-registry/reconciliation-attestation.mjs';

const SUBJECT = Object.freeze({
  kind: 'linear_issue',
  id: 'DEN-3132',
  revision_digest: 'a'.repeat(64)
});
const POLICY_DIGEST = 'b'.repeat(64);
const NOW = new Date('2026-08-08T20:00:00.000Z');

function ed25519() {
  return generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
}

function rsa() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
}

function policy(keys) {
  return {
    schema_version: TRUST_POLICY_SCHEMA_VERSION,
    required_roles: ['chatgpt', 'claude'],
    keys,
    distinct_producer_fields: [
      'key_id',
      'trust_domain',
      'worker_id',
      'job_id',
      'task_type'
    ]
  };
}

function key(publicKeyPem, role, provider, trustDomain, taskType) {
  return {
    public_key_pem: publicKeyPem,
    roles: [role],
    provider,
    trust_domain: trustDomain,
    task_types: [taskType]
  };
}

function verify(trustPolicy) {
  return verifyIndependentAttestationSet([], {
    trustPolicy,
    expectedSubject: SUBJECT,
    expectedPolicyDigest: POLICY_DIGEST,
    now: NOW
  });
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ReconciliationAttestationError);
    assert.equal(error.code, code);
    return true;
  });
}

test('two key IDs cannot alias the same canonical Ed25519 public key', () => {
  const shared = ed25519();
  expectCode(() => verify(policy({
    chatgpt: key(shared.publicKey, 'chatgpt', 'openai', 'openai-worker', 'chatgpt-task'),
    claude: key(shared.publicKey, 'claude', 'anthropic', 'claude-worker', 'claude-task')
  })), 'key_alias');
});

test('PEM whitespace and line-ending variants cannot bypass key-alias detection', () => {
  const shared = ed25519();
  const windowsPem = shared.publicKey.replace(/\n/g, '\r\n');
  expectCode(() => verify(policy({
    chatgpt: key(shared.publicKey, 'chatgpt', 'openai', 'openai-worker', 'chatgpt-task'),
    claude: key(windowsPem, 'claude', 'anthropic', 'claude-worker', 'claude-task')
  })), 'key_alias');
});

test('private-key material is rejected before role or signature evaluation', () => {
  const chatgpt = ed25519();
  const claude = ed25519();
  expectCode(() => verify(policy({
    chatgpt: key(chatgpt.privateKey, 'chatgpt', 'openai', 'openai-worker', 'chatgpt-task'),
    claude: key(claude.publicKey, 'claude', 'anthropic', 'claude-worker', 'claude-task')
  })), 'private_key_material');
});

test('unsupported and malformed trust keys fail closed', () => {
  const unsupported = rsa();
  const claude = ed25519();
  expectCode(() => verify(policy({
    chatgpt: key(unsupported.publicKey, 'chatgpt', 'openai', 'openai-worker', 'chatgpt-task'),
    claude: key(claude.publicKey, 'claude', 'anthropic', 'claude-worker', 'claude-task')
  })), 'unsupported_trust_key');

  expectCode(() => verify(policy({
    chatgpt: key('not a key', 'chatgpt', 'openai', 'openai-worker', 'chatgpt-task'),
    claude: key(claude.publicKey, 'claude', 'anthropic', 'claude-worker', 'claude-task')
  })), 'invalid_trust_key');
});
