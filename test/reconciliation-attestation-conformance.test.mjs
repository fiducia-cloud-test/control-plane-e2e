import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const modulePath = resolve(
  process.env.RECONCILIATION_ATTESTATION_MODULE ??
    '.artifacts/project-registry/reconciliation-attestation.mjs'
);
const {
  ReconciliationAttestationError,
  TRUST_POLICY_SCHEMA_VERSION,
  createSignedAttestation,
  evaluatePullRequestMergeAttestations,
  verifyIndependentAttestationSet,
  verifyLinearOpinionAttestations
} = await import(pathToFileURL(modulePath).href);

const NOW = new Date('2026-08-08T19:00:00.000Z');
const POLICY_DIGEST = '1'.repeat(64);
const LINEAR_SUBJECT = Object.freeze({
  kind: 'linear_issue',
  id: 'DEN-2877',
  revision_digest: '2'.repeat(64)
});
const PR_SUBJECT = Object.freeze({
  kind: 'github_pull_request',
  id: 'zed-pkg-test/java-lib#1',
  revision_digest: '3'.repeat(64)
});
const PR_HEAD = '4'.repeat(40);
const GRAPH_DIGEST = '5'.repeat(64);

function keyPair() {
  return generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
}

const keys = Object.freeze({
  chatgpt: keyPair(),
  claude: keyPair(),
  readiness: keyPair(),
  critic: keyPair(),
  attacker: keyPair()
});

function policy(requiredRoles, definitions, distinct = [
  'key_id',
  'trust_domain',
  'worker_id',
  'job_id',
  'task_type'
]) {
  return {
    schema_version: TRUST_POLICY_SCHEMA_VERSION,
    required_roles: requiredRoles,
    keys: definitions,
    distinct_producer_fields: distinct
  };
}

const linearPolicy = policy(['chatgpt', 'claude'], {
  'chatgpt-test-key': {
    public_key_pem: keys.chatgpt.publicKey,
    roles: ['chatgpt'],
    provider: 'openai',
    trust_domain: 'test/openai-opinion',
    task_types: ['linear_opinion_chatgpt']
  },
  'claude-test-key': {
    public_key_pem: keys.claude.publicKey,
    roles: ['claude'],
    provider: 'anthropic',
    trust_domain: 'test/anthropic-opinion',
    task_types: ['linear_opinion_claude']
  }
});

const prPolicy = policy(['readiness', 'critic'], {
  'readiness-test-key': {
    public_key_pem: keys.readiness.publicKey,
    roles: ['readiness'],
    provider: 'openai',
    trust_domain: 'test/pr-readiness',
    task_types: ['pr_readiness_primary']
  },
  'critic-test-key': {
    public_key_pem: keys.critic.publicKey,
    roles: ['critic'],
    provider: 'anthropic',
    trust_domain: 'test/pr-critic',
    task_types: ['pr_readiness_critic']
  }
});

function opinion(role, overrides = {}) {
  const chatgpt = role === 'chatgpt';
  return createSignedAttestation({
    role,
    provider: chatgpt ? 'openai' : 'anthropic',
    subject: LINEAR_SUBJECT,
    policyDigest: POLICY_DIGEST,
    producer: {
      key_id: chatgpt ? 'chatgpt-test-key' : 'claude-test-key',
      trust_domain: chatgpt ? 'test/openai-opinion' : 'test/anthropic-opinion',
      worker_id: chatgpt ? 'test-openai-worker' : 'test-anthropic-worker',
      job_id: chatgpt ? 'test-openai-job' : 'test-anthropic-job',
      task_type: chatgpt ? 'linear_opinion_chatgpt' : 'linear_opinion_claude'
    },
    payload: {
      issue_id: LINEAR_SUBJECT.id,
      revision_digest: LINEAR_SUBJECT.revision_digest,
      recommendation: 'pending',
      summary: 'Credential-free synthetic test-org opinion.',
      blockers: [],
      evidence: ['fiducia-cloud-test:ephemeral-attestation'],
      confidence: 0.999
    },
    privateKeyPem: chatgpt ? keys.chatgpt.privateKey : keys.claude.privateKey,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
    ...overrides
  });
}

function prDecision(role, probability, hours, overrides = {}) {
  const readiness = role === 'readiness';
  return createSignedAttestation({
    role,
    provider: readiness ? 'openai' : 'anthropic',
    subject: PR_SUBJECT,
    policyDigest: POLICY_DIGEST,
    producer: {
      key_id: readiness ? 'readiness-test-key' : 'critic-test-key',
      trust_domain: readiness ? 'test/pr-readiness' : 'test/pr-critic',
      worker_id: readiness ? 'test-readiness-worker' : 'test-critic-worker',
      job_id: readiness ? 'test-readiness-job' : 'test-critic-job',
      task_type: readiness ? 'pr_readiness_primary' : 'pr_readiness_critic'
    },
    payload: {
      pull_request: PR_SUBJECT.id,
      revision_digest: PR_SUBJECT.revision_digest,
      evaluated_head_sha: PR_HEAD,
      readiness_probability: probability,
      continuous_open_hours: hours,
      graph_digest: GRAPH_DIGEST,
      summary: 'Credential-free exact-head test-org decision.',
      blockers: []
    },
    privateKeyPem: readiness ? keys.readiness.privateKey : keys.critic.privateKey,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
    ...overrides
  });
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ReconciliationAttestationError);
    assert.equal(error.code, code);
    return true;
  });
}

const linearOptions = Object.freeze({
  trustPolicy: linearPolicy,
  expectedSubject: LINEAR_SUBJECT,
  expectedPolicyDigest: POLICY_DIGEST,
  now: NOW
});
const prOptions = Object.freeze({
  trustPolicy: prPolicy,
  expectedSubject: PR_SUBJECT,
  expectedPolicyDigest: POLICY_DIGEST,
  expectedHeadSha: PR_HEAD,
  now: NOW
});

test('independent ChatGPT and Claude artifacts verify without model or Linear credentials', () => {
  const result = verifyLinearOpinionAttestations(
    [opinion('chatgpt'), opinion('claude')],
    linearOptions
  );
  assert.equal(result.agrees, true);
  assert.equal(result.opinions.chatgpt.recommendation, 'pending');
  assert.equal(result.opinions.claude.recommendation, 'pending');
});

test('one key or one trust domain cannot satisfy both roles', () => {
  const shared = keyPair();
  const sharedPolicy = policy(['first', 'second'], {
    shared: {
      public_key_pem: shared.publicKey,
      roles: ['first', 'second'],
      provider: 'synthetic',
      trust_domain: 'one-authority',
      task_types: ['first-task', 'second-task']
    }
  });
  const signed = (role, taskType, workerId, jobId) => createSignedAttestation({
    role,
    provider: 'synthetic',
    subject: LINEAR_SUBJECT,
    policyDigest: POLICY_DIGEST,
    producer: {
      key_id: 'shared',
      trust_domain: 'one-authority',
      worker_id: workerId,
      job_id: jobId,
      task_type: taskType
    },
    payload: { role },
    privateKeyPem: shared.privateKey,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000)
  });
  expectCode(() => verifyIndependentAttestationSet([
    signed('first', 'first-task', 'first-worker', 'first-job'),
    signed('second', 'second-task', 'second-worker', 'second-job')
  ], {
    trustPolicy: sharedPolicy,
    expectedSubject: LINEAR_SUBJECT,
    expectedPolicyDigest: POLICY_DIGEST,
    now: NOW
  }), 'independence_violation');
});

test('tampering, provider swapping, and artifact-supplied public keys fail closed', () => {
  const chatgpt = opinion('chatgpt');
  const claude = opinion('claude');

  const tampered = structuredClone(chatgpt);
  tampered.payload.summary = 'changed after signature';
  expectCode(() => verifyLinearOpinionAttestations(
    [tampered, claude],
    linearOptions
  ), 'payload_hash_mismatch');

  const swapped = structuredClone(chatgpt);
  swapped.provider = 'anthropic';
  expectCode(() => verifyLinearOpinionAttestations(
    [swapped, claude],
    linearOptions
  ), 'provider_mismatch');

  const injected = { ...chatgpt, public_key_pem: keys.attacker.publicKey };
  assert.throws(() => verifyLinearOpinionAttestations(
    [injected, claude],
    linearOptions
  ), /public_key_pem/);
});

test('wrong revision, expired artifacts, and untrusted keys fail closed', () => {
  expectCode(() => verifyLinearOpinionAttestations(
    [opinion('chatgpt'), opinion('claude')],
    {
      ...linearOptions,
      expectedSubject: { ...LINEAR_SUBJECT, revision_digest: '9'.repeat(64) }
    }
  ), 'subject_mismatch');

  const expired = opinion('chatgpt', {
    issuedAt: new Date(NOW.getTime() - 20 * 60 * 1000),
    expiresAt: new Date(NOW.getTime() - 10 * 60 * 1000)
  });
  expectCode(() => verifyLinearOpinionAttestations(
    [expired, opinion('claude')],
    linearOptions
  ), 'attestation_expired');

  const untrusted = createSignedAttestation({
    role: 'chatgpt',
    provider: 'openai',
    subject: LINEAR_SUBJECT,
    policyDigest: POLICY_DIGEST,
    producer: {
      key_id: 'attacker',
      trust_domain: 'attacker',
      worker_id: 'attacker-worker',
      job_id: 'attacker-job',
      task_type: 'linear_opinion_chatgpt'
    },
    payload: opinion('chatgpt').payload,
    privateKeyPem: keys.attacker.privateKey,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000)
  });
  expectCode(() => verifyLinearOpinionAttestations(
    [untrusted, opinion('claude')],
    linearOptions
  ), 'untrusted_key');
});

test('PR pair authorizes only strict >0.995, at least 55 hours, and exact head', () => {
  const allowed = evaluatePullRequestMergeAttestations([
    prDecision('readiness', 0.999, 56),
    prDecision('critic', 0.998, 55)
  ], prOptions);
  assert.equal(allowed.authorized, true);

  const equalThreshold = evaluatePullRequestMergeAttestations([
    prDecision('readiness', 0.999, 56),
    prDecision('critic', 0.995, 56)
  ], prOptions);
  assert.equal(equalThreshold.authorized, false);

  const tooYoung = evaluatePullRequestMergeAttestations([
    prDecision('readiness', 0.999, 54.999),
    prDecision('critic', 0.999, 56)
  ], prOptions);
  assert.equal(tooYoung.authorized, false);

  const wrongHead = prDecision('critic', 0.999, 56, {
    payload: {
      ...prDecision('critic', 0.999, 56).payload,
      evaluated_head_sha: '8'.repeat(40)
    }
  });
  expectCode(() => evaluatePullRequestMergeAttestations([
    prDecision('readiness', 0.999, 56),
    wrongHead
  ], prOptions), 'head_mismatch');
});

test('PR graph disagreement and blockers cannot authorize merge', () => {
  const graphMismatch = prDecision('critic', 0.999, 56, {
    payload: {
      ...prDecision('critic', 0.999, 56).payload,
      graph_digest: '7'.repeat(64)
    }
  });
  expectCode(() => evaluatePullRequestMergeAttestations([
    prDecision('readiness', 0.999, 56),
    graphMismatch
  ], prOptions), 'graph_mismatch');

  const blocked = prDecision('critic', 0.999, 56, {
    payload: {
      ...prDecision('critic', 0.999, 56).payload,
      blockers: ['unresolved-review-thread']
    }
  });
  const result = evaluatePullRequestMergeAttestations([
    prDecision('readiness', 0.999, 56),
    blocked
  ], prOptions);
  assert.equal(result.authorized, false);
  assert.deepEqual(result.blockers, ['unresolved-review-thread']);
});
